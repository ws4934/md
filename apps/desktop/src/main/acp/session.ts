import type {
  AgentCapabilities,
  ClientConnection,
  ContentBlock,
  CreateTerminalRequest,
  KillTerminalRequest,
  PermissionOption,
  ReleaseTerminalRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  TerminalOutputRequest,
  WaitForTerminalExitRequest,
} from '@agentclientprotocol/sdk/unstable'
import type {
  AcpHostEvent,
  AcpModeInfo,
  AcpModelInfo,
  AcpPermissionDecision,
  AcpSlashCommand,
  AcpToolCallItem,
  AcpToolKind,
} from '@md/shared/types'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ExtendedNewSessionResponse } from './translator'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client as createAcpClient, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable'
import { createSafeNdJsonStream } from './ndjson-stream'
import {
  buildAgentEnv,
  createChildFailureGuard,
  spawnAgentProcess,
  terminateProcessTree,
  withTimeout,
} from './process'
import {
  buildPermissionResponse,
  deriveModelsFromSessionResponse,
  deriveModesFromSessionResponse,
  findSelectConfigOption,
  mapPermissionRequest,
  mapPlanToEntries,
  mergeToolCallSnapshot,
  selectAutoAcceptOption,
} from './translator'

export interface AcpSessionTimeouts {
  initializeMs?: number
  sessionNewMs?: number
  sessionLoadMs?: number
  closeMs?: number
}

export interface AcpSessionOptions {
  agentId: string
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  pathOverride?: string
  initialModelId?: string | null
  initialModeId?: string | null
  timeouts?: AcpSessionTimeouts
  resolveAutoPermission?: (toolKind: AcpToolKind, title: string) => `allow` | `reject` | `ask`
  onEvent?: (event: AcpHostEvent) => void
  onNonJsonStdout?: (line: string, error: unknown) => void
}

interface PendingPermission {
  options: PermissionOption[]
  toolKind: AcpToolKind
  resolve: (response: RequestPermissionResponse) => void
}

interface TerminalExitStatus {
  exitCode?: number | null
  signal?: string | null
}

interface ManagedTerminal {
  id: string
  child: ChildProcessWithoutNullStreams
  output: string
  truncated: boolean
  outputByteLimit: number | null
  running: boolean
  exitStatus: TerminalExitStatus | null
  waitForExit: Promise<TerminalExitStatus>
}

const DEFAULT_TIMEOUTS: Required<AcpSessionTimeouts> = {
  initializeMs: 20_000,
  sessionNewMs: 20_000,
  sessionLoadMs: 30_000,
  closeMs: 2_000,
}

const DEFAULT_TERMINAL_MAX_BYTES = 256 * 1024

export const DEFAULT_CLIENT_CAPABILITIES = {
  // Let the CLI read and write disk directly, matching Paseo's ACP defaults.
  fs: {
    readTextFile: false,
    writeTextFile: false,
  },
  terminal: true,
} as const

export class AcpSession {
  readonly agentId: string
  private readonly options: AcpSessionOptions
  private readonly timeouts: Required<AcpSessionTimeouts>

  private child: ChildProcessWithoutNullStreams | null = null
  private connection: ClientConnection | null = null
  private agentCapabilities: AgentCapabilities | null = null
  private _initializeMeta: Record<string, unknown> | null = null
  private stderrChunks: string[] = []
  private processFailureGuard: { promise: Promise<never>, dispose: () => void } | null = null

  private _sessionId: string | null = null
  private _models: AcpModelInfo[] = []
  private _modelSource: `models` | `configOptions` | `none` = `none`
  private _currentModelId: string | null = null
  private _modes: AcpModeInfo[] = []
  private _modeSource: `modes` | `configOptions` | `none` = `none`
  private _currentModeId: string | null = null
  private _configOptions: SessionConfigOption[] = []
  private _commands: AcpSlashCommand[] = []
  private _commandsUpdatedAt: number | null = null

  private earlyUpdates: SessionNotification[] = []
  private toolCalls = new Map<string, AcpToolCallItem>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private alwaysAllowedKinds = new Set<AcpToolKind>()
  private terminals = new Map<string, ManagedTerminal>()

  private activeTurn = false
  private closed = false

  constructor(options: AcpSessionOptions) {
    this.agentId = options.agentId
    this.options = options
    this.timeouts = {
      initializeMs: options.timeouts?.initializeMs ?? DEFAULT_TIMEOUTS.initializeMs,
      sessionNewMs: options.timeouts?.sessionNewMs ?? DEFAULT_TIMEOUTS.sessionNewMs,
      sessionLoadMs: options.timeouts?.sessionLoadMs ?? DEFAULT_TIMEOUTS.sessionLoadMs,
      closeMs: options.timeouts?.closeMs ?? DEFAULT_TIMEOUTS.closeMs,
    }
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  get models(): AcpModelInfo[] {
    return this._models
  }

  get currentModelId(): string | null {
    return this._currentModelId
  }

  get modes(): AcpModeInfo[] {
    return this._modes
  }

  get currentModeId(): string | null {
    return this._currentModeId
  }

  get commands(): AcpSlashCommand[] {
    return this._commands
  }

  get commandsUpdatedAt(): number | null {
    return this._commandsUpdatedAt
  }

  get configOptions(): SessionConfigOption[] {
    return this._configOptions
  }

  get initializeMeta(): Record<string, unknown> | null {
    return this._initializeMeta
  }

  get isClosed(): boolean {
    return this.closed
  }

  get childProcess(): ChildProcess | null {
    return this.child
  }

  async initializeNewSession(): Promise<void> {
    try {
      await this.connectAndInitialize()

      const response = await this.runBoundedRequest(
        this.connection!.agent.request<ExtendedNewSessionResponse>(`session/new`, {
          cwd: this.options.cwd,
          // Always pass mcpServers (even empty) because some agents reject omitted fields.
          mcpServers: [],
        }),
        this.timeouts.sessionNewMs,
        `ACP session/new timed out after ${this.timeouts.sessionNewMs}ms`,
      )

      this._sessionId = response.sessionId
      this.applySessionMetadata(response)
      this.replayEarlyUpdates()

      if (this.options.initialModelId && this.options.initialModelId !== this._currentModelId) {
        try {
          await this.setModel(this.options.initialModelId)
        }
        catch {
          // Keep the agent's default model if the remembered model is no longer advertised.
        }
      }

      if (this.options.initialModeId && this.options.initialModeId !== this._currentModeId) {
        try {
          await this.setMode(this.options.initialModeId)
        }
        catch {
          // Keep the agent's default mode if the requested initial mode is not supported.
        }
      }
    }
    catch (error) {
      await this.close()
      throw error
    }
  }

  async initializeLoadedSession(sessionId: string): Promise<void> {
    try {
      await this.connectAndInitialize()

      this._sessionId = sessionId
      const response = await this.runBoundedRequest(
        this.connection!.agent.request<ExtendedNewSessionResponse>(`session/load`, {
          sessionId,
          cwd: this.options.cwd,
          mcpServers: [],
        }),
        this.timeouts.sessionLoadMs,
        `ACP session/load timed out after ${this.timeouts.sessionLoadMs}ms`,
      )

      if (response && typeof response === `object`)
        this.applySessionMetadata(response)
      this.replayEarlyUpdates()
    }
    catch (error) {
      await this.close()
      throw error
    }
  }

  async prompt(blocks: ContentBlock[]): Promise<{ stopReason?: string }> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)

    this.activeTurn = true
    this.emit({ type: `turn_started`, sessionId: this._sessionId })

    try {
      const result = await Promise.race([
        this.connection.agent.request(`session/prompt`, {
          sessionId: this._sessionId,
          prompt: blocks,
        }),
        ...(this.processFailureGuard ? [this.processFailureGuard.promise] : []),
      ])

      this.activeTurn = false
      this.emit({
        type: `turn_finished`,
        sessionId: this._sessionId,
        stopReason: result?.stopReason,
      })
      return { stopReason: result?.stopReason }
    }
    catch (error) {
      this.activeTurn = false
      const message = error instanceof Error ? error.message : String(error)
      this.emit({
        type: `turn_error`,
        sessionId: this._sessionId,
        message,
      })
      throw error
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this._sessionId || this.closed)
      return

    this.cancelAllPendingPermissions()
    try {
      await withTimeout(
        this.connection.agent.notify(`session/cancel`, { sessionId: this._sessionId }),
        this.timeouts.closeMs,
        `ACP session/cancel timed out after ${this.timeouts.closeMs}ms`,
      )
    }
    catch {
      // Ignore cancel failures if the process is already exiting.
    }
  }

  async setModel(modelId: string): Promise<{ modelId: string | null }> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)

    const modelOption = findSelectConfigOption(this._configOptions, `model`)

    // Prefer unstable session/set_model when the agent advertised models via `models`.
    if (this._modelSource === `models` || !modelOption) {
      try {
        await this.runBoundedRequest(
          this.connection.agent.request(`session/set_model`, {
            sessionId: this._sessionId,
            modelId,
          }),
          this.timeouts.sessionNewMs,
          `ACP session/set_model timed out`,
        )
        this._currentModelId = modelId
        this.emit({
          type: `model_changed`,
          sessionId: this._sessionId,
          modelId: this._currentModelId,
        })
        return { modelId: this._currentModelId }
      }
      catch (error) {
        if (!modelOption)
          throw error
        // Fall through to session/set_config_option when session/set_model is unsupported.
      }
    }

    if (!modelOption)
      throw new Error(`Agent does not expose model selection`)

    const response = await this.runBoundedRequest(
      this.connection.agent.request(`session/set_config_option`, {
        sessionId: this._sessionId,
        configId: modelOption.id,
        value: modelId,
      }),
      this.timeouts.sessionNewMs,
      `ACP session/set_config_option timed out`,
    )

    if (response?.configOptions) {
      this._configOptions = response.configOptions
      const derived = deriveModelsFromSessionResponse({
        sessionId: this._sessionId,
        configOptions: response.configOptions,
      })
      if (derived.models.length > 0)
        this._models = derived.models
      this._currentModelId = derived.currentModelId ?? modelId
    }
    else {
      this._currentModelId = modelId
    }

    this.emit({
      type: `model_changed`,
      sessionId: this._sessionId,
      modelId: this._currentModelId,
    })
    return { modelId: this._currentModelId }
  }

  async setMode(modeId: string): Promise<{ modeId: string | null }> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)

    const modeOption = findSelectConfigOption(this._configOptions, `mode`)

    if (this._modeSource === `modes` || !modeOption) {
      try {
        await this.runBoundedRequest(
          this.connection.agent.request(`session/set_mode`, {
            sessionId: this._sessionId,
            modeId,
          }),
          this.timeouts.sessionNewMs,
          `ACP session/set_mode timed out`,
        )
        this._currentModeId = modeId
        this.emit({
          type: `mode_changed`,
          sessionId: this._sessionId,
          modeId: this._currentModeId,
        })
        return { modeId: this._currentModeId }
      }
      catch (error) {
        if (!modeOption)
          throw error
        // Fall through to session/set_config_option when session/set_mode is unsupported.
      }
    }

    if (!modeOption)
      throw new Error(`Agent does not expose mode selection`)

    const response = await this.runBoundedRequest(
      this.connection.agent.request(`session/set_config_option`, {
        sessionId: this._sessionId,
        configId: modeOption.id,
        value: modeId,
      }),
      this.timeouts.sessionNewMs,
      `ACP session/set_config_option timed out`,
    )

    if (response?.configOptions) {
      this._configOptions = response.configOptions
      const derived = deriveModesFromSessionResponse({
        sessionId: this._sessionId,
        configOptions: response.configOptions,
      })
      if (derived.modes.length > 0)
        this._modes = derived.modes
      this._currentModeId = derived.currentModeId ?? modeId
    }
    else {
      this._currentModeId = modeId
    }

    this.emit({
      type: `mode_changed`,
      sessionId: this._sessionId,
      modeId: this._currentModeId,
    })
    return { modeId: this._currentModeId }
  }

  respondPermission(requestId: string, decision: AcpPermissionDecision, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending)
      return

    this.pendingPermissions.delete(requestId)
    if (decision === `allow_always`)
      this.alwaysAllowedKinds.add(pending.toolKind)

    const response = buildPermissionResponse(pending.options, decision, optionId)
    pending.resolve(response)

    if (this._sessionId) {
      this.emit({
        type: `permission_resolved`,
        sessionId: this._sessionId,
        requestId,
        decision,
      })
    }
  }

  async close(): Promise<void> {
    if (this.closed)
      return
    this.closed = true

    this.cancelAllPendingPermissions()
    this.processFailureGuard?.dispose()
    this.processFailureGuard = null

    if (this.connection && this._sessionId) {
      if (this.activeTurn) {
        try {
          await withTimeout(
            this.connection.agent.notify(`session/cancel`, { sessionId: this._sessionId }),
            this.timeouts.closeMs,
            `ACP session/cancel timed out during close`,
          )
        }
        catch {
          // Best-effort cancel before close.
        }
      }

      if (this.agentCapabilities?.sessionCapabilities?.close) {
        try {
          await withTimeout(
            this.connection.agent.request(`session/close`, { sessionId: this._sessionId }),
            this.timeouts.closeMs,
            `ACP session/close timed out after ${this.timeouts.closeMs}ms`,
          )
        }
        catch {
          // Bounded close: continue to tree-kill if the agent does not answer.
        }
      }
    }

    const terminalKills = [...this.terminals.values()]
      .filter(term => term.running)
      .map(term => terminateProcessTree(term.child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 }))
    await Promise.all(terminalKills)
    this.terminals.clear()

    if (this.connection) {
      try {
        this.connection.close()
      }
      catch {
        // Ignore already-closed connection.
      }
      this.connection = null
    }

    if (this.child) {
      const child = this.child
      this.child = null
      await terminateProcessTree(child, { gracefulTimeoutMs: 1_500, forceTimeoutMs: 1_500 })
    }

    if (this._sessionId)
      this.emit({ type: `session_closed`, sessionId: this._sessionId })
  }

  private async connectAndInitialize(): Promise<void> {
    const env = await buildAgentEnv(this.options.env, this.options.pathOverride)
    const child = spawnAgentProcess(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env,
    })
    this.child = child
    this.stderrChunks = []

    child.stderr.on(`data`, (chunk: Buffer | string) => {
      this.stderrChunks.push(chunk.toString())
      if (this.stderrChunks.length > 200)
        this.stderrChunks.shift()
    })

    this.processFailureGuard = createChildFailureGuard(child, this.stderrChunks)

    const stream = createSafeNdJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      {
        onNonJsonLine: (line, error) => {
          this.options.onNonJsonStdout?.(line, error)
        },
      },
    )

    const acpClient = createAcpClient({ name: `md-desktop` })
      .onNotification(`session/update`, ({ params }) => {
        this.handleSessionUpdate(params)
      })
      .onRequest(`session/request_permission`, ({ params }) => {
        return this.handlePermissionRequest(params)
      })
      .onRequest(`terminal/create`, ({ params }) => {
        return this.handleCreateTerminal(params)
      })
      .onRequest(`terminal/output`, ({ params }) => {
        return this.handleTerminalOutput(params)
      })
      .onRequest(`terminal/wait_for_exit`, ({ params }) => {
        return this.handleWaitForTerminalExit(params)
      })
      .onRequest(`terminal/kill`, ({ params }) => {
        return this.handleKillTerminal(params)
      })
      .onRequest(`terminal/release`, ({ params }) => {
        return this.handleReleaseTerminal(params)
      })

    this.connection = acpClient.connect(stream)

    const initResponse = await this.runBoundedRequest(
      this.connection.agent.request(`initialize`, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { ...DEFAULT_CLIENT_CAPABILITIES.fs },
          terminal: DEFAULT_CLIENT_CAPABILITIES.terminal,
        },
        clientInfo: {
          name: `doocs-md-desktop`,
          version: `2.1.0`,
        },
      }),
      this.timeouts.initializeMs,
      `ACP initialize timed out after ${this.timeouts.initializeMs}ms`,
    )

    this.agentCapabilities = initResponse.agentCapabilities ?? null
    this._initializeMeta = (initResponse._meta as Record<string, unknown> | null | undefined) ?? null
  }

  private async runBoundedRequest<T>(
    request: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    const raced = this.processFailureGuard
      ? Promise.race([request, this.processFailureGuard.promise])
      : request
    return withTimeout(raced, timeoutMs, timeoutMessage)
  }

  private applySessionMetadata(response: ExtendedNewSessionResponse): void {
    this._configOptions = response.configOptions ?? []
    const modelState = deriveModelsFromSessionResponse(response)
    this._models = modelState.models
    this._currentModelId = modelState.currentModelId
    this._modelSource = modelState.source

    const modeState = deriveModesFromSessionResponse(response)
    this._modes = modeState.modes
    this._currentModeId = modeState.currentModeId
    this._modeSource = modeState.source
  }

  private replayEarlyUpdates(): void {
    const buffered = this.earlyUpdates.splice(0)
    for (const notification of buffered)
      this.handleSessionUpdate(notification)
  }

  private handleSessionUpdate(params: SessionNotification): void {
    if (!this._sessionId) {
      // Buffer updates arriving before session/new returns so none are lost.
      this.earlyUpdates.push(params)
      return
    }
    if (params.sessionId !== this._sessionId)
      return

    const update = params.update
    switch (update.sessionUpdate) {
      case `agent_message_chunk`: {
        if (update.content.type === `text` && update.content.text) {
          this.emit({
            type: `message_chunk`,
            sessionId: this._sessionId,
            text: update.content.text,
          })
        }
        break
      }
      case `agent_thought_chunk`: {
        if (update.content.type === `text` && update.content.text) {
          this.emit({
            type: `thought_chunk`,
            sessionId: this._sessionId,
            text: update.content.text,
          })
        }
        break
      }
      case `plan`: {
        this.emit({
          type: `plan`,
          sessionId: this._sessionId,
          entries: mapPlanToEntries(update),
        })
        break
      }
      case `plan_update`: {
        if (update.plan.type === `items`) {
          this.emit({
            type: `plan`,
            sessionId: this._sessionId,
            entries: update.plan.entries.map(item => ({
              content: item.content,
              status: item.status,
              priority: item.priority,
            })),
          })
        }
        break
      }
      case `tool_call`:
      case `tool_call_update`: {
        const previous = this.toolCalls.get(update.toolCallId)
        const snapshot = mergeToolCallSnapshot(previous, update)
        this.toolCalls.set(update.toolCallId, snapshot)
        this.emit({
          type: `tool_call`,
          sessionId: this._sessionId,
          tool: snapshot,
        })
        break
      }
      case `available_commands_update`: {
        this._commandsUpdatedAt = Date.now()
        this._commands = update.availableCommands.map(cmd => ({
          name: cmd.name,
          description: cmd.description,
          inputHint: cmd.input?.hint,
        }))
        this.emit({
          type: `commands_updated`,
          sessionId: this._sessionId,
          commands: this._commands,
        })
        break
      }
      case `config_option_update`: {
        this._configOptions = update.configOptions
        const derived = deriveModelsFromSessionResponse({
          sessionId: this._sessionId,
          configOptions: update.configOptions,
        })
        if (derived.models.length > 0)
          this._models = derived.models
        if (derived.currentModelId !== this._currentModelId) {
          this._currentModelId = derived.currentModelId
          this.emit({
            type: `model_changed`,
            sessionId: this._sessionId,
            modelId: this._currentModelId,
          })
        }

        const derivedModes = deriveModesFromSessionResponse({
          sessionId: this._sessionId,
          configOptions: update.configOptions,
        })
        if (derivedModes.modes.length > 0) {
          this._modes = derivedModes.modes
          this._modeSource = derivedModes.source
        }
        if (derivedModes.currentModeId !== null && derivedModes.currentModeId !== this._currentModeId) {
          this._currentModeId = derivedModes.currentModeId
          this.emit({
            type: `mode_changed`,
            sessionId: this._sessionId,
            modeId: this._currentModeId,
          })
        }
        break
      }
      case `current_mode_update`: {
        this._currentModeId = update.currentModeId
        this.emit({
          type: `mode_changed`,
          sessionId: this._sessionId,
          modeId: this._currentModeId,
        })
        break
      }
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const toolSnapshot = this.toolCalls.get(params.toolCall.toolCallId)
    const mapped = mapPermissionRequest(requestId, this._sessionId ?? params.sessionId, params, toolSnapshot)

    const policy = this.options.resolveAutoPermission?.(mapped.toolKind, mapped.title) ?? `ask`

    if (policy === `reject`)
      return buildPermissionResponse(params.options, `reject`)

    if (policy === `allow` || this.alwaysAllowedKinds.has(mapped.toolKind)) {
      const allowOpt = selectAutoAcceptOption(params.options)
      if (allowOpt) {
        return {
          outcome: {
            outcome: `selected`,
            optionId: allowOpt.optionId,
          },
        }
      }
    }

    const responsePromise = new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, {
        options: params.options,
        toolKind: mapped.toolKind,
        resolve,
      })
    })

    this.emit({
      type: `permission_requested`,
      sessionId: this._sessionId ?? params.sessionId,
      request: mapped,
    })

    return responsePromise
  }

  private cancelAllPendingPermissions(): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      pending.resolve({ outcome: { outcome: `cancelled` } })
      if (this._sessionId) {
        this.emit({
          type: `permission_resolved`,
          sessionId: this._sessionId,
          requestId,
          decision: `cancelled`,
        })
      }
    }
    this.pendingPermissions.clear()
  }

  private isInsideWorkspace(targetPath: string): boolean {
    const workspaceRoot = path.resolve(this.options.cwd)
    const resolved = path.resolve(workspaceRoot, targetPath)
    return resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`)
  }

  private async handleCreateTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    const terminalId = randomUUID()
    const extraEnv = Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value]))
    const env = await buildAgentEnv({ ...this.options.env, ...extraEnv }, this.options.pathOverride)
    const cwd = params.cwd && this.isInsideWorkspace(params.cwd)
      ? path.resolve(this.options.cwd, params.cwd)
      : this.options.cwd

    const child = spawnAgentProcess(params.command, params.args ?? [], { cwd, env })

    let resolveExit!: (status: TerminalExitStatus) => void
    const waitForExit = new Promise<TerminalExitStatus>((resolve) => {
      resolveExit = resolve
    })

    const entry: ManagedTerminal = {
      id: terminalId,
      child,
      output: ``,
      truncated: false,
      outputByteLimit: params.outputByteLimit ?? DEFAULT_TERMINAL_MAX_BYTES,
      running: true,
      exitStatus: null,
      waitForExit,
    }

    const appendOutput = (chunk: Buffer | string) => {
      const text = chunk.toString()
      entry.output += text
      if (entry.outputByteLimit !== null && Buffer.byteLength(entry.output, `utf8`) > entry.outputByteLimit) {
        entry.truncated = true
        entry.output = entry.output.slice(-entry.outputByteLimit)
      }
    }

    child.stdout.on(`data`, appendOutput)
    child.stderr.on(`data`, appendOutput)
    child.once(`error`, (error) => {
      appendOutput(`${error.message}\n`)
      entry.running = false
      entry.exitStatus = { exitCode: -1, signal: null }
      resolveExit(entry.exitStatus)
    })
    child.once(`exit`, (code, signal) => {
      entry.running = false
      entry.exitStatus = { exitCode: code, signal }
      resolveExit(entry.exitStatus)
    })

    this.terminals.set(terminalId, entry)
    return { terminalId }
  }

  private getTerminal(terminalId: string): ManagedTerminal {
    const entry = this.terminals.get(terminalId)
    if (!entry)
      throw RequestError.invalidParams(`Unknown terminalId: ${terminalId}`)
    return entry
  }

  private async handleTerminalOutput(params: TerminalOutputRequest) {
    const entry = this.getTerminal(params.terminalId)
    return {
      output: entry.output,
      truncated: entry.truncated,
      exitStatus: entry.exitStatus ?? undefined,
    }
  }

  private async handleWaitForTerminalExit(params: WaitForTerminalExitRequest) {
    const entry = this.getTerminal(params.terminalId)
    return entry.waitForExit
  }

  private async handleKillTerminal(params: KillTerminalRequest) {
    const entry = this.getTerminal(params.terminalId)
    if (entry.running)
      await terminateProcessTree(entry.child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 })
    return {}
  }

  private async handleReleaseTerminal(params: ReleaseTerminalRequest) {
    const entry = this.getTerminal(params.terminalId)
    if (entry.running)
      await terminateProcessTree(entry.child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 })
    this.terminals.delete(params.terminalId)
    return {}
  }

  private emit(event: AcpHostEvent): void {
    this.options.onEvent?.(event)
  }
}
