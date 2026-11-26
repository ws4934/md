import type {
  AgentCapabilities,
  ClientConnection,
  ContentBlock,
  CreateTerminalRequest,
  KillTerminalRequest,
  McpServer,
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
  AcpThinkingOption,
  AcpToolCallItem,
  AcpToolKind,
} from '@md/shared/types'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ExtendedNewSessionResponse } from './translator'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { client as createAcpClient, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable'
import {
  parseVariantModelId,
  resolveThinkingLevelForModel,
  resolveWireModelId,
} from '@md/shared/utils/acp-thinking'
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
  deriveThinkingFromConfigOptions,
  findSelectConfigOption,
  isMethodNotFoundError,
  mapPermissionRequest,
  mapPlanToEntries,
  mergeToolCallSnapshot,
  resolveCurrentModelFromConfigOptions,
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
  mcpServers?: McpServer[]
  pathOverride?: string
  initialModelId?: string | null
  initialThinkingLevel?: string | null
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
  chunks: Buffer[]
  totalBytes: number
  truncated: boolean
  outputByteLimit: number | null
  running: boolean
  exitStatus: TerminalExitStatus | null
  waitForExit: Promise<TerminalExitStatus>
}

/**
 * Trims the head of a UTF-8 Buffer ring so total bytes stay within `limit`
 * without splitting a multi-byte UTF-8 sequence.
 */
export function appendUtf8RingChunk(
  ring: { chunks: Buffer[], totalBytes: number, truncated: boolean },
  chunk: Buffer | string,
  limit: number | null,
): void {
  const buf = typeof chunk === `string` ? Buffer.from(chunk, `utf8`) : chunk
  if (buf.byteLength === 0)
    return

  ring.chunks.push(buf)
  ring.totalBytes += buf.byteLength

  if (limit === null || ring.totalBytes <= limit)
    return

  ring.truncated = true
  let excess = ring.totalBytes - limit

  while (excess > 0 && ring.chunks.length > 0) {
    const head = ring.chunks[0]
    if (head.byteLength <= excess) {
      ring.chunks.shift()
      ring.totalBytes -= head.byteLength
      excess -= head.byteLength
    }
    else {
      // Advance past any UTF-8 continuation bytes (10xxxxxx) so the first remaining byte starts a valid code point.
      let cut = excess
      while (cut < head.byteLength && (head[cut] & 0xC0) === 0x80)
        cut++
      if (cut >= head.byteLength) {
        ring.chunks.shift()
        ring.totalBytes -= head.byteLength
      }
      else {
        ring.chunks[0] = head.subarray(cut)
        ring.totalBytes -= cut
      }
      excess = 0
    }
  }
}

export function decodeUtf8Ring(chunks: Buffer[]): string {
  if (chunks.length === 0)
    return ``
  const merged = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
  return new TextDecoder(`utf-8`, { fatal: false }).decode(merged)
}

const DEFAULT_TIMEOUTS: Required<AcpSessionTimeouts> = {
  initializeMs: 20_000,
  sessionNewMs: 20_000,
  sessionLoadMs: 30_000,
  closeMs: 2_000,
}

const DEFAULT_TERMINAL_MAX_BYTES = 256 * 1024
const MAX_TRACKED_TOOL_CALLS = 500
const MAX_EARLY_UPDATES = 1_000
const MAX_STDERR_CHARS = 4_096
const MAX_TERMINALS = 64

export const DEFAULT_CLIENT_CAPABILITIES = {
  // Let the CLI read and write disk directly, matching Paseo's ACP defaults.
  fs: {
    readTextFile: false,
    writeTextFile: false,
  },
  terminal: true,
} as const

function sameThinkingOptions(
  a: readonly AcpThinkingOption[],
  b: readonly AcpThinkingOption[],
): boolean {
  if (a.length !== b.length)
    return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name || a[i].description !== b[i].description)
      return false
  }
  return true
}

export class AcpSession {
  readonly agentId: string
  private readonly options: AcpSessionOptions
  private readonly timeouts: Required<AcpSessionTimeouts>

  private child: ChildProcessWithoutNullStreams | null = null
  private connection: ClientConnection | null = null
  private agentCapabilities: AgentCapabilities | null = null
  private authMethods: Array<{ id: string, name: string }> = []
  private _initializeMeta: Record<string, unknown> | null = null
  private stderrChunks: string[] = []
  private stderrTotalChars = 0
  private processFailureGuard: { promise: Promise<never>, dispose: () => void } | null = null

  private _sessionId: string | null = null
  private _rawModels: AcpModelInfo[] = []
  private _models: AcpModelInfo[] = []
  private _hasModelVariants = false
  private _modelSource: `models` | `configOptions` | `none` = `none`
  private _currentModelId: string | null = null
  private _currentRawModelId: string | null = null
  private _thinkingOptions: AcpThinkingOption[] = []
  private _currentThinkingLevel: string | null = null
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
  private closedIntentionally = false
  private closePromise: Promise<void> | null = null

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

  get currentRawModelId(): string | null {
    return this._currentRawModelId
  }

  get thinkingOptions(): AcpThinkingOption[] {
    return this._thinkingOptions
  }

  get currentThinkingLevel(): string | null {
    return this._currentThinkingLevel
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

  get isTurnActive(): boolean {
    return this.activeTurn
  }

  get hasPendingPermission(): boolean {
    return this.pendingPermissions.size > 0
  }

  get isActive(): boolean {
    return !this.closed && (this.activeTurn || this.pendingPermissions.size > 0)
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
          mcpServers: this.options.mcpServers ?? [],
        }),
        this.timeouts.sessionNewMs,
        `ACP session/new timed out after ${this.timeouts.sessionNewMs}ms`,
      )

      this._sessionId = response.sessionId
      this.applySessionMetadata(response)
      this.replayEarlyUpdates()

      await this.applyInitialModelAndThinking()

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
      const preferred = await this.preferProcessFailure(error)
      const normalized = this.enrichAuthError(preferred)
      await this.close()
      throw normalized
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
          mcpServers: this.options.mcpServers ?? [],
        }),
        this.timeouts.sessionLoadMs,
        `ACP session/load timed out after ${this.timeouts.sessionLoadMs}ms`,
      )

      if (response && typeof response === `object`)
        this.applySessionMetadata(response)
      this.replayEarlyUpdates()
    }
    catch (error) {
      const preferred = await this.preferProcessFailure(error)
      const normalized = this.enrichAuthError(preferred)
      await this.close()
      throw normalized
    }
  }

  async prompt(blocks: ContentBlock[]): Promise<{ stopReason?: string }> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)
    if (this.activeTurn)
      throw new Error(`ACP turn is already in progress`)

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
      const preferred = await this.preferProcessFailure(error)
      this.activeTurn = false
      if (this.closedIntentionally) {
        this.emit({
          type: `turn_finished`,
          sessionId: this._sessionId,
          stopReason: `cancelled`,
        })
        return { stopReason: `cancelled` }
      }
      const normalized = this.enrichAuthError(preferred)
      const message = normalized instanceof Error ? normalized.message : String(normalized)
      this.emit({
        type: `turn_error`,
        sessionId: this._sessionId,
        message,
      })
      throw normalized
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

  private async applyInitialModelAndThinking(): Promise<void> {
    const parsedInit = parseVariantModelId(this.options.initialModelId, this._models)
    const desiredBaseModel = parsedInit.baseModelId
    const desiredThinking = this.options.initialThinkingLevel ?? parsedInit.thinkingLevel ?? null

    if (this._hasModelVariants) {
      if (!desiredBaseModel && !desiredThinking)
        return
      const targetBaseId = desiredBaseModel ?? this._currentModelId
      if (!targetBaseId)
        return
      const resolved = resolveWireModelId(
        targetBaseId,
        desiredThinking ?? this._currentThinkingLevel,
        this._models,
      )
      if (resolved.wireModelId !== this._currentRawModelId) {
        try {
          await this.setModel(resolved.baseModelId, resolved.thinkingLevel)
          return
        }
        catch {
          // Keep the agent's default model if the remembered model is no longer advertised.
        }
      }
      // If a remembered model failed, still honor remembered thinking level on the agent's default model.
      if (desiredThinking && this._currentModelId && this._currentModelId !== targetBaseId) {
        const fallback = resolveWireModelId(this._currentModelId, desiredThinking, this._models)
        if (fallback.wireModelId !== this._currentRawModelId) {
          try {
            await this.setModel(fallback.baseModelId, fallback.thinkingLevel)
          }
          catch {
            // Keep agent's default thinking level if unsupported.
          }
        }
      }
      return
    }

    if (desiredBaseModel && desiredBaseModel !== this._currentModelId) {
      try {
        await this.setModel(desiredBaseModel)
      }
      catch {
        // Keep the agent's default model if the remembered model is no longer advertised.
      }
    }

    if (desiredThinking && this._thinkingOptions.length > 0) {
      const targetLevel = resolveThinkingLevelForModel(this._thinkingOptions, desiredThinking)
      if (targetLevel && targetLevel !== this._currentThinkingLevel) {
        try {
          await this.setThinkingLevel(targetLevel)
        }
        catch {
          // Keep the agent's default thinking level if the requested level is not supported.
        }
      }
    }
  }

  async setModel(
    modelId: string,
    thinkingLevel?: string | null,
  ): Promise<{ modelId: string | null, thinkingLevel: string | null }> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)

    const prevThinkingOptions = this._thinkingOptions
    const prevThinkingLevel = this._currentThinkingLevel
    const modelOption = findSelectConfigOption(this._configOptions, `model`)
    const parsed = this._hasModelVariants
      ? parseVariantModelId(modelId, this._models)
      : { baseModelId: modelId, thinkingLevel: null }
    const effectiveBaseId = parsed.baseModelId ?? modelId
    const effectiveDesiredThinking = thinkingLevel !== undefined
      ? thinkingLevel
      : (parsed.thinkingLevel ?? prevThinkingLevel)
    const resolved = this._hasModelVariants
      ? resolveWireModelId(effectiveBaseId, effectiveDesiredThinking, this._models)
      : { wireModelId: modelId, baseModelId: modelId, thinkingLevel: prevThinkingLevel }

    // Prefer unstable session/set_model when the agent advertised models via `models`.
    if (this._modelSource === `models` || !modelOption) {
      try {
        await this.runBoundedRequest(
          this.connection.agent.request(`session/set_model`, {
            sessionId: this._sessionId,
            modelId: resolved.wireModelId,
          }),
          this.timeouts.sessionNewMs,
          `ACP session/set_model timed out`,
        )
        this._currentRawModelId = resolved.wireModelId
        if (this._currentModelId !== resolved.baseModelId) {
          this._currentModelId = resolved.baseModelId
          this.emit({
            type: `model_changed`,
            sessionId: this._sessionId,
            modelId: this._currentModelId,
          })
        }
        if (this._hasModelVariants) {
          if (this._currentThinkingLevel !== resolved.thinkingLevel) {
            this._currentThinkingLevel = resolved.thinkingLevel
            this.emit({
              type: `thinking_changed`,
              sessionId: this._sessionId,
              thinkingLevel: this._currentThinkingLevel,
            })
          }
        }
        else if (effectiveDesiredThinking && this._thinkingOptions.length > 0) {
          const nextLevel = resolveThinkingLevelForModel(
            this._thinkingOptions,
            effectiveDesiredThinking,
          )
          if (nextLevel && nextLevel !== this._currentThinkingLevel) {
            try {
              await this.setThinkingLevel(nextLevel)
            }
            catch {
              // Keep agent's current thinking level if setting via configOption fails.
            }
          }
        }
        return { modelId: this._currentModelId, thinkingLevel: this._currentThinkingLevel }
      }
      catch (error) {
        if (!modelOption || !isMethodNotFoundError(error))
          throw error
        // Fall through to session/set_config_option when session/set_model is unsupported (-32601).
      }
    }

    if (!modelOption)
      throw new Error(`Agent does not expose model selection`)

    const response = await this.runBoundedRequest(
      this.connection.agent.request(`session/set_config_option`, {
        sessionId: this._sessionId,
        configId: modelOption.id,
        value: resolved.baseModelId,
      }),
      this.timeouts.sessionNewMs,
      `ACP session/set_config_option timed out`,
    )

    if (response?.configOptions) {
      // Defer thinking_changed until any remembered/requested effort override is applied below.
      this.syncFromConfigOptions(response.configOptions, { suppressThinkingEmit: true })
    }
    else if (this._currentModelId !== resolved.baseModelId) {
      this._currentModelId = resolved.baseModelId
      this._currentRawModelId = resolved.wireModelId
      this.emit({
        type: `model_changed`,
        sessionId: this._sessionId,
        modelId: this._currentModelId,
      })
    }

    if (!this._hasModelVariants && this._thinkingOptions.length > 0) {
      const nextLevel = resolveThinkingLevelForModel(
        this._thinkingOptions,
        effectiveDesiredThinking ?? this._currentThinkingLevel,
      )
      if (nextLevel && nextLevel !== this._currentThinkingLevel) {
        try {
          await this.applyThinkingConfigOption(nextLevel, { suppressEmit: true })
        }
        catch {
          // Keep agent's current thinking level if configOption rejects it.
        }
      }
    }

    if (
      !sameThinkingOptions(prevThinkingOptions, this._thinkingOptions)
      || prevThinkingLevel !== this._currentThinkingLevel
    ) {
      this.emit({
        type: `thinking_changed`,
        sessionId: this._sessionId,
        thinkingLevel: this._currentThinkingLevel,
        thinkingOptions: this._hasModelVariants ? undefined : this._thinkingOptions,
      })
    }

    return { modelId: this._currentModelId, thinkingLevel: this._currentThinkingLevel }
  }

  async setThinkingLevel(
    level: string,
  ): Promise<{ thinkingLevel: string | null, modelId: string | null }> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)

    const activeModel = this._currentModelId
      ? this._models.find(m => m.id === this._currentModelId)
      : undefined

    // Data-driven: prefer per-model variant switching when the active model defines effort variants.
    if (activeModel?.thinkingVariantIds && Object.keys(activeModel.thinkingVariantIds).length > 0) {
      const normalized = level.trim().toLowerCase()
      const matched = activeModel.thinkingOptions?.find(opt => opt.id.toLowerCase() === normalized)
      const targetLevel = matched?.id ?? level
      if (!activeModel.thinkingVariantIds[targetLevel])
        throw new Error(`Thinking level "${level}" is not supported by model "${activeModel.id}"`)
      const result = await this.setModel(activeModel.id, targetLevel)
      return { thinkingLevel: result.thinkingLevel, modelId: result.modelId }
    }

    await this.applyThinkingConfigOption(level)
    return { thinkingLevel: this._currentThinkingLevel, modelId: this._currentModelId }
  }

  private async applyThinkingConfigOption(
    level: string,
    options?: { suppressEmit?: boolean },
  ): Promise<void> {
    if (!this.connection || !this._sessionId || this.closed)
      throw new Error(`ACP session is not active`)

    const thoughtOption = findSelectConfigOption(this._configOptions, `thought_level`)
    if (!thoughtOption)
      throw new Error(`Agent does not expose thinking level selection`)

    const suppress = Boolean(options?.suppressEmit)
    const response = await this.runBoundedRequest(
      this.connection.agent.request(`session/set_config_option`, {
        sessionId: this._sessionId,
        configId: thoughtOption.id,
        value: level,
      }),
      this.timeouts.sessionNewMs,
      `ACP session/set_config_option timed out`,
    )

    if (response?.configOptions) {
      this.syncFromConfigOptions(response.configOptions, { suppressThinkingEmit: suppress })
      if (this._currentThinkingLevel === null) {
        this._currentThinkingLevel = level
        if (!suppress) {
          this.emit({
            type: `thinking_changed`,
            sessionId: this._sessionId,
            thinkingLevel: this._currentThinkingLevel,
            thinkingOptions: this._hasModelVariants ? undefined : this._thinkingOptions,
          })
        }
      }
    }
    else if (this._currentThinkingLevel !== level) {
      this._currentThinkingLevel = level
      if (!suppress) {
        this.emit({
          type: `thinking_changed`,
          sessionId: this._sessionId,
          thinkingLevel: this._currentThinkingLevel,
          thinkingOptions: this._hasModelVariants ? undefined : this._thinkingOptions,
        })
      }
    }
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
        if (this._currentModeId !== modeId) {
          this._currentModeId = modeId
          this.emit({
            type: `mode_changed`,
            sessionId: this._sessionId,
            modeId: this._currentModeId,
          })
        }
        return { modeId: this._currentModeId }
      }
      catch (error) {
        if (!modeOption || !isMethodNotFoundError(error))
          throw error
        // Fall through to session/set_config_option when session/set_mode is unsupported (-32601).
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
      this.syncFromConfigOptions(response.configOptions)
    }
    if (this._currentModeId !== modeId) {
      this._currentModeId = modeId
      this.emit({
        type: `mode_changed`,
        sessionId: this._sessionId,
        modeId: this._currentModeId,
      })
    }
    return { modeId: this._currentModeId }
  }

  clearAlwaysAllowedPermissions(): void {
    this.alwaysAllowedKinds.clear()
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

  close(): Promise<void> {
    this.closedIntentionally = true
    return this.beginClose()
  }

  private beginClose(): Promise<void> {
    this.closePromise ??= this.performClose()
    return this.closePromise
  }

  private async performClose(): Promise<void> {
    this.closed = true

    this.cancelAllPendingPermissions()
    this.processFailureGuard?.dispose()
    this.processFailureGuard = null

    const childAlive = Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null)
    if (this.connection && this._sessionId && childAlive) {
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

    const terminalEntries = [...this.terminals.values()]
    this.terminals.clear()
    await Promise.allSettled(
      terminalEntries
        .filter(term => term.running)
        .map(term => terminateProcessTree(term.child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 })),
    )
    for (const term of terminalEntries) {
      term.chunks.length = 0
      term.totalBytes = 0
    }

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
      try {
        child.stdin.end()
      }
      catch {
        // Ignore broken or already-closed stdin pipe.
      }
      await terminateProcessTree(child, { gracefulTimeoutMs: 1_500, forceTimeoutMs: 1_500 })
    }

    if (this._sessionId)
      this.emit({ type: `session_closed`, sessionId: this._sessionId })
  }

  private async connectAndInitialize(): Promise<void> {
    const env = await buildAgentEnv(this.options.env, this.options.pathOverride)
    if (this.closed)
      throw new Error(`ACP session closed during initialization`)

    const child = spawnAgentProcess(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env,
    })
    if (this.closed) {
      await terminateProcessTree(child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 })
      throw new Error(`ACP session closed during initialization`)
    }
    this.child = child
    this.stderrChunks = []
    this.stderrTotalChars = 0

    child.stderr.on(`data`, (chunk: Buffer | string) => {
      const text = chunk.toString()
      const piece = text.length > MAX_STDERR_CHARS ? text.slice(-MAX_STDERR_CHARS) : text
      this.stderrChunks.push(piece)
      this.stderrTotalChars += piece.length
      while (this.stderrTotalChars > MAX_STDERR_CHARS && this.stderrChunks.length > 1) {
        const dropped = this.stderrChunks.shift()!
        this.stderrTotalChars -= dropped.length
      }
    })

    const failureGuard = createChildFailureGuard(child, this.stderrChunks)
    this.processFailureGuard = failureGuard

    // Clean up session state and emit `session_closed` if the CLI exits unexpectedly.
    // Trigger after `failureGuard` settles (+ microtask) so an active `prompt()` emits `turn_error` first.
    failureGuard.promise.catch(() => {
      if (!this.closed && this._sessionId) {
        queueMicrotask(() => {
          if (!this.closed && this._sessionId)
            void this.beginClose()
        })
      }
    })

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
    this.authMethods = (initResponse.authMethods ?? []).map(m => ({ id: m.id, name: m.name || m.id }))
    this._initializeMeta = (initResponse._meta as Record<string, unknown> | null | undefined) ?? null
  }

  private async preferProcessFailure(error: unknown): Promise<unknown> {
    if (this.closedIntentionally || !this.processFailureGuard)
      return error
    const rawMessage = error instanceof Error ? error.message : String(error)
    if (!/ACP connection closed/i.test(rawMessage))
      return error
    // Stdout EOF often wins the race against SIGCHLD `exit` by ~1ms when a CLI crashes; wait briefly for exit/stderr.
    try {
      await Promise.race([
        this.processFailureGuard.promise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100)
          timer.unref?.()
        }),
      ])
      return error
    }
    catch (exitError) {
      return exitError
    }
  }

  private enrichAuthError(error: unknown): unknown {
    const code = typeof error === `object` && error !== null && `code` in error
      ? (error as { code?: unknown }).code
      : undefined
    const rawMessage = error instanceof Error ? error.message : String(error)
    const isAuthRequired = code === -32000 || /authentication required|not logged in/i.test(rawMessage)
    if (!isAuthRequired)
      return error
    const methodsHint = this.authMethods.length > 0
      ? ` (${this.authMethods.map(m => m.name).join(`, `)})`
      : ``
    const cliName = path.basename(this.options.command)
    return new Error(`Authentication required for ${cliName}${methodsHint}. Sign in via your terminal and try again.`)
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
    this._rawModels = modelState.rawModels
    this._models = modelState.models
    this._hasModelVariants = modelState.hasVariants
    this._currentModelId = modelState.currentModelId
    this._currentRawModelId = modelState.currentRawModelId
    this._thinkingOptions = modelState.thinkingOptions
    this._currentThinkingLevel = modelState.currentThinkingLevel
    this._modelSource = modelState.source

    const modeState = deriveModesFromSessionResponse(response)
    this._modes = modeState.modes
    this._currentModeId = modeState.currentModeId
    this._modeSource = modeState.source
  }

  private syncFromConfigOptions(
    configOptions: SessionConfigOption[],
    options?: { suppressThinkingEmit?: boolean },
  ): void {
    if (!this._sessionId)
      return

    const suppressThinking = Boolean(options?.suppressThinkingEmit)
    this._configOptions = configOptions
    const thoughtState = deriveThinkingFromConfigOptions(configOptions)

    if (this._modelSource === `models`) {
      const resolvedRaw = resolveCurrentModelFromConfigOptions(
        configOptions,
        this._rawModels,
        this._currentRawModelId,
      )
      this._currentRawModelId = resolvedRaw

      if (this._hasModelVariants) {
        const parsed = parseVariantModelId(resolvedRaw, this._models)
        const nextBaseId = parsed.baseModelId
        const baseModel = nextBaseId ? this._models.find(m => m.id === nextBaseId) : undefined
        const nextThinking = baseModel?.thinkingVariantIds
          ? (parsed.thinkingLevel ?? thoughtState.currentLevel ?? baseModel.defaultThinkingLevel ?? null)
          : null

        if (nextBaseId !== this._currentModelId) {
          this._currentModelId = nextBaseId
          this.emit({
            type: `model_changed`,
            sessionId: this._sessionId,
            modelId: this._currentModelId,
          })
        }
        if (nextThinking !== this._currentThinkingLevel) {
          this._currentThinkingLevel = nextThinking
          if (!suppressThinking) {
            this.emit({
              type: `thinking_changed`,
              sessionId: this._sessionId,
              thinkingLevel: this._currentThinkingLevel,
            })
          }
        }
      }
      else {
        if (resolvedRaw !== this._currentModelId) {
          this._currentModelId = resolvedRaw
          this.emit({
            type: `model_changed`,
            sessionId: this._sessionId,
            modelId: this._currentModelId,
          })
        }
        const optionsChanged = !sameThinkingOptions(this._thinkingOptions, thoughtState.options)
        const levelChanged = thoughtState.currentLevel !== this._currentThinkingLevel
        if (optionsChanged)
          this._thinkingOptions = thoughtState.options
        if (levelChanged)
          this._currentThinkingLevel = thoughtState.currentLevel
        if (!suppressThinking && (optionsChanged || levelChanged)) {
          this.emit({
            type: `thinking_changed`,
            sessionId: this._sessionId,
            thinkingLevel: this._currentThinkingLevel,
            thinkingOptions: this._thinkingOptions,
          })
        }
      }
    }
    else {
      const derived = deriveModelsFromSessionResponse({
        sessionId: this._sessionId,
        configOptions,
      })
      if (derived.models.length > 0) {
        this._rawModels = derived.rawModels
        this._models = derived.models
        this._hasModelVariants = derived.hasVariants
        this._modelSource = derived.source
      }
      this._currentRawModelId = derived.currentRawModelId
      if (derived.currentModelId !== this._currentModelId) {
        this._currentModelId = derived.currentModelId
        this.emit({
          type: `model_changed`,
          sessionId: this._sessionId,
          modelId: this._currentModelId,
        })
      }
      const optionsChanged = !sameThinkingOptions(this._thinkingOptions, derived.thinkingOptions)
      const levelChanged = derived.currentThinkingLevel !== this._currentThinkingLevel
      if (optionsChanged)
        this._thinkingOptions = derived.thinkingOptions
      if (levelChanged)
        this._currentThinkingLevel = derived.currentThinkingLevel
      if (!suppressThinking && (optionsChanged || levelChanged)) {
        this.emit({
          type: `thinking_changed`,
          sessionId: this._sessionId,
          thinkingLevel: this._currentThinkingLevel,
          thinkingOptions: this._hasModelVariants ? undefined : this._thinkingOptions,
        })
      }
    }

    const derivedModes = deriveModesFromSessionResponse({
      sessionId: this._sessionId,
      configOptions,
    })
    if (this._modeSource !== `modes` && derivedModes.modes.length > 0) {
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
  }

  private replayEarlyUpdates(): void {
    const buffered = this.earlyUpdates.splice(0)
    for (const notification of buffered)
      this.handleSessionUpdate(notification)
  }

  private handleSessionUpdate(params: SessionNotification): void {
    if (!this._sessionId) {
      // Buffer updates arriving before session/new returns so none are lost.
      if (this.earlyUpdates.length >= MAX_EARLY_UPDATES)
        this.earlyUpdates.shift()
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
        if (previous)
          this.toolCalls.delete(update.toolCallId)
        this.toolCalls.set(update.toolCallId, snapshot)
        if (this.toolCalls.size > MAX_TRACKED_TOOL_CALLS) {
          const oldestId = this.toolCalls.keys().next().value
          if (oldestId !== undefined)
            this.toolCalls.delete(oldestId)
        }
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
        this.syncFromConfigOptions(update.configOptions)
        break
      }
      case `current_mode_update`: {
        if (this._currentModeId !== update.currentModeId) {
          this._currentModeId = update.currentModeId
          this.emit({
            type: `mode_changed`,
            sessionId: this._sessionId,
            modeId: this._currentModeId,
          })
        }
        break
      }
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.closed)
      return { outcome: { outcome: `cancelled` } }

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

  private async resolveTerminalCwd(requestedCwd?: string | null): Promise<string> {
    const fallbackRoot = path.resolve(this.options.cwd)
    let canonicalRoot = fallbackRoot
    try {
      canonicalRoot = await fs.realpath(fallbackRoot)
    }
    catch {
      return fallbackRoot
    }

    if (!requestedCwd || !requestedCwd.trim())
      return canonicalRoot

    const candidate = path.resolve(fallbackRoot, requestedCwd)
    try {
      const canonicalCandidate = await fs.realpath(candidate)
      if (
        canonicalCandidate === canonicalRoot
        || canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)
      ) {
        return canonicalCandidate
      }
    }
    catch {
      // Missing/unreadable path falls back safely to the workspace root.
    }

    return canonicalRoot
  }

  private async handleCreateTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    if (this.closed)
      throw RequestError.internalError({ details: `ACP session is closed` })

    const terminalId = randomUUID()
    const extraEnv = Object.fromEntries((params.env ?? []).map(entry => [entry.name, entry.value]))
    const [env, cwd] = await Promise.all([
      buildAgentEnv({ ...this.options.env, ...extraEnv }, this.options.pathOverride),
      this.resolveTerminalCwd(params.cwd),
    ])

    if (this.closed)
      throw RequestError.internalError({ details: `ACP session is closed` })

    const child = spawnAgentProcess(params.command, params.args ?? [], { cwd, env })

    let resolveExit!: (status: TerminalExitStatus) => void
    const waitForExit = new Promise<TerminalExitStatus>((resolve) => {
      resolveExit = resolve
    })

    const entry: ManagedTerminal = {
      id: terminalId,
      child,
      chunks: [],
      totalBytes: 0,
      truncated: false,
      outputByteLimit: params.outputByteLimit ?? DEFAULT_TERMINAL_MAX_BYTES,
      running: true,
      exitStatus: null,
      waitForExit,
    }

    const appendOutput = (chunk: Buffer | string) => {
      appendUtf8RingChunk(entry, chunk, entry.outputByteLimit)
    }
    const detachStreams = () => {
      child.stdout.off(`data`, appendOutput)
      child.stderr.off(`data`, appendOutput)
    }

    child.stdout.on(`data`, appendOutput)
    child.stderr.on(`data`, appendOutput)
    child.once(`error`, (error) => {
      appendOutput(`${error.message}\n`)
      detachStreams()
      entry.running = false
      entry.exitStatus = { exitCode: -1, signal: null }
      resolveExit(entry.exitStatus)
    })
    child.once(`exit`, (code, signal) => {
      detachStreams()
      entry.running = false
      entry.exitStatus = { exitCode: code, signal }
      resolveExit(entry.exitStatus)
    })

    if (this.terminals.size >= MAX_TERMINALS) {
      for (const [id, existing] of this.terminals.entries()) {
        if (!existing.running) {
          existing.chunks.length = 0
          existing.totalBytes = 0
          this.terminals.delete(id)
          break
        }
      }
    }

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
      output: decodeUtf8Ring(entry.chunks),
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
    entry.chunks.length = 0
    entry.totalBytes = 0
    this.terminals.delete(params.terminalId)
    return {}
  }

  private emit(event: AcpHostEvent): void {
    this.options.onEvent?.(event)
  }
}
