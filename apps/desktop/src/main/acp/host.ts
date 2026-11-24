import type { ContentBlock } from '@agentclientprotocol/sdk/unstable'
import type {
  AcpAgentConfig,
  AcpAgentStatus,
  AcpHostEvent,
  AcpPermissionDecision,
  AcpPermissionLevel,
  AcpProbeResult,
  AcpPromptParams,
  AcpSettings,
  AcpStartSessionParams,
  AcpStartSessionResult,
} from '@md/shared/types'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  agentHasPlanMode,
  clampAgentModePermissionLevel,
  evaluatePermissionPolicy,
  isEditToolKind,
  mapAcpModeIdToPermissionLevel,
  mapPermissionLevelToAcpModeId,
  resolveNativeModeIdForLevel,
} from '@md/shared/utils/acp-permissions'
import { ProbeCache } from './probe'
import { AcpRegistry } from './registry'
import { AcpSession } from './session'
import { isMethodNotFoundError } from './translator'

export interface AcpActiveSessionSummary {
  sessionId: string
  agentId: string
  agentName: string
  waitingPermission: boolean
}

interface ManagedSession {
  session: AcpSession
  agentName: string
  postId: string
  workspaceDir: string
  articlePath: string
  lastSyncedContent: string
  syncChain: Promise<void>
  permissionState: {
    level: AcpPermissionLevel
    applyingHostMode: boolean
    clientBypassModeId: string | null
  }
}

export interface AcpHostOptions {
  dataDir: string
  pathOverride?: string
  extraBuiltinAgents?: AcpAgentConfig[]
  onEvent?: (event: AcpHostEvent) => void
}

export class AcpHost {
  private readonly workspacesRoot: string
  private readonly pathOverride?: string
  private readonly registry: AcpRegistry
  private readonly probeCache: ProbeCache
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly activeWorkspaceDirs = new Set<string>()
  private readonly onEvent?: (event: AcpHostEvent) => void

  constructor(options: AcpHostOptions) {
    this.workspacesRoot = path.join(options.dataDir, `acp-workspaces`)
    this.pathOverride = options.pathOverride
    this.onEvent = options.onEvent
    this.probeCache = new ProbeCache({
      cachePath: path.join(options.dataDir, `acp-probe-cache.json`),
    })
    this.registry = new AcpRegistry({
      settingsPath: path.join(options.dataDir, `acp-settings.json`),
      pathOverride: options.pathOverride,
      extraBuiltinAgents: options.extraBuiltinAgents,
      onEvent: options.onEvent,
    })
    // Best-effort cleanup of orphaned workspace folders left by prior crashes / SIGKILLs.
    void this.sweepStaleWorkspaces()
  }

  private async sweepStaleWorkspaces(): Promise<void> {
    try {
      const entries = await fs.readdir(this.workspacesRoot, { withFileTypes: true })
      await Promise.all(
        entries
          .filter(entry => entry.isDirectory())
          .map((entry) => {
            const fullPath = path.join(this.workspacesRoot, entry.name)
            if (this.activeWorkspaceDirs.has(fullPath))
              return Promise.resolve()
            return fs.rm(fullPath, { recursive: true, force: true }).catch(() => undefined)
          }),
      )
    }
    catch {
      // Directory may not exist yet on first launch.
    }
  }

  listAgents(): Promise<AcpAgentStatus[]> {
    return this.registry.listAgents()
  }

  detectAgents(options: { force?: boolean } = { force: true }): Promise<AcpAgentStatus[]> {
    const force = options.force !== false
    if (force)
      this.probeCache.invalidate()
    return this.registry.detectAgents({ forceShell: force })
  }

  getSettings(): Promise<AcpSettings> {
    return this.registry.getSettings()
  }

  async updateSettings(patch: Partial<AcpSettings>): Promise<AcpSettings> {
    if (patch.commandOverrides)
      this.probeCache.invalidate()
    return this.registry.updateSettings(patch)
  }

  addCustomAgent(agent: {
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
  }): Promise<AcpAgentStatus[]> {
    return this.registry.addCustomAgent(agent)
  }

  removeCustomAgent(agentId: string): Promise<AcpAgentStatus[]> {
    this.probeCache.invalidate(agentId)
    return this.registry.removeCustomAgent(agentId)
  }

  async installAgent(agentId: string): Promise<{ ok: boolean, error?: string }> {
    const result = await this.registry.installAgent(agentId)
    if (result.ok)
      this.probeCache.invalidate(agentId)
    return result
  }

  cancelInstall(agentId: string): Promise<void> {
    return this.registry.cancelInstall(agentId)
  }

  async probeAgent(agentId: string, options?: { force?: boolean }): Promise<AcpProbeResult> {
    const launch = await this.registry.resolveLaunchSpec(agentId)
    return this.probeCache.probe(
      {
        agentId,
        command: launch.command,
        args: launch.args,
        env: launch.env,
        pathOverride: this.pathOverride,
      },
      options,
    )
  }

  async startSession(params: AcpStartSessionParams): Promise<AcpStartSessionResult> {
    const settings = await this.registry.getSettings()

    const launch = await this.registry.resolveLaunchSpec(params.agentId)
    const agentConfig = await this.registry.getAgentConfig(params.agentId)
    const agentName = agentConfig?.name ?? params.agentId
    const workspaceId = randomUUID()
    const workspaceDir = path.join(this.workspacesRoot, workspaceId)
    const articlePath = path.join(workspaceDir, `article.md`)

    this.activeWorkspaceDirs.add(workspaceDir)
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.writeFile(articlePath, params.content, `utf8`)

    const initialModelId = params.modelId ?? settings.lastModelByAgent[params.agentId] ?? null
    const initialThinkingLevel = params.thinkingLevel ?? settings.lastThinkingLevelByAgent[params.agentId] ?? null
    const initialLevel: AcpPermissionLevel
      = params.permissionLevel
        ?? mapAcpModeIdToPermissionLevel(params.modeId)
        ?? settings.defaultPermissionLevel
    // Suppress boot-time mode clamping until initializeNewSession + initial setMode complete.
    const permissionState = {
      level: initialLevel,
      applyingHostMode: true,
      clientBypassModeId: null as string | null,
    }

    const sessionRef: { current: AcpSession | null } = { current: null }
    const session = new AcpSession({
      agentId: params.agentId,
      command: launch.command,
      args: launch.args,
      cwd: workspaceDir,
      env: launch.env,
      pathOverride: this.pathOverride,
      initialModelId,
      initialThinkingLevel,
      resolveAutoPermission: (toolKind) => {
        return evaluatePermissionPolicy(permissionState.level, toolKind, {
          agentHasPlanMode: agentHasPlanMode(sessionRef.current?.modes ?? []),
        })
      },
      onEvent: (event) => {
        if (event.type === `mode_changed`) {
          const modes = sessionRef.current?.modes ?? []
          const isClientBypass = permissionState.level === `bypass`
            && mapPermissionLevelToAcpModeId(`bypass`, modes) === null
          // Client-side bypass holds while the agent stays on the native mode it entered bypass on.
          const onClientBypassMode = isClientBypass && event.modeId === permissionState.clientBypassModeId
          if (!permissionState.applyingHostMode && !onClientBypassMode) {
            const mappedLevel = mapAcpModeIdToPermissionLevel(event.modeId)
            // Agent-originated mode updates may keep or restrict permissions, never escalate.
            permissionState.level = clampAgentModePermissionLevel(permissionState.level, mappedLevel)
            if (permissionState.level !== `bypass`)
              permissionState.clientBypassModeId = null
          }
          this.onEvent?.({
            ...event,
            permissionLevel: permissionState.level,
          })
          return
        }

        if (event.type === `session_closed`) {
          const managed = this.sessions.get(event.sessionId)
          if (managed) {
            this.sessions.delete(event.sessionId)
            this.activeWorkspaceDirs.delete(managed.workspaceDir)
            void fs.rm(managed.workspaceDir, { recursive: true, force: true }).catch(() => undefined)
          }
        }

        this.onEvent?.(event)
        // Read the article file back into the editor after an edit-kind tool completes.
        if (event.type === `tool_call` && event.tool.status === `completed` && isEditToolKind(event.tool.toolKind)) {
          const managed = this.sessions.get(event.sessionId)
          if (managed)
            void this.syncArticleFromDisk(managed)
        }
      },
      onNonJsonStdout: (line) => {
        console.warn(`[acp:${params.agentId}] skipped non-JSON stdout:`, line.slice(0, 200))
      },
    })
    sessionRef.current = session

    try {
      await session.initializeNewSession()
    }
    catch (error) {
      this.activeWorkspaceDirs.delete(workspaceDir)
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    const sessionId = session.sessionId!
    this.sessions.set(sessionId, {
      session,
      agentName,
      postId: params.postId,
      workspaceDir,
      articlePath,
      lastSyncedContent: params.content,
      syncChain: Promise.resolve(),
      permissionState,
    })

    // Feed session capabilities into the persistent probe cache so picker opens skip re-probing.
    if (
      session.models.length > 0
      || session.modes.length > 0
      || session.commands.length > 0
      || session.thinkingOptions.length > 0
    ) {
      this.probeCache.seed({
        agentId: params.agentId,
        models: session.models,
        currentModelId: session.currentModelId,
        thinkingOptions: session.thinkingOptions,
        currentThinkingLevel: session.currentThinkingLevel,
        modes: session.modes,
        currentModeId: session.currentModeId,
        commands: session.commands,
        probedAt: Date.now(),
      })
    }

    const targetModeId
      = (params.modeId && session.modes.some(m => m.id === params.modeId) ? params.modeId : null)
        ?? resolveNativeModeIdForLevel(permissionState.level, session.modes, session.currentModeId)

    try {
      if (targetModeId && targetModeId !== session.currentModeId) {
        try {
          await session.setMode(targetModeId)
        }
        catch {
          // Keep client-side enforcement even if the agent declines the initial mode switch.
        }
      }
    }
    finally {
      permissionState.clientBypassModeId
        = permissionState.level === `bypass` && mapPermissionLevelToAcpModeId(`bypass`, session.modes) === null
          ? session.currentModeId
          : null
      permissionState.applyingHostMode = false
    }

    if (session.currentModelId)
      await this.registry.rememberLastModel(params.agentId, session.currentModelId)
    if (session.currentThinkingLevel)
      await this.registry.rememberLastThinkingLevel(params.agentId, session.currentThinkingLevel)

    const effectiveModeId = this.resolveExposedModeId(
      session.currentModeId,
      permissionState.level,
      params.modeId,
    )

    this.onEvent?.({
      type: `session_created`,
      sessionId,
      agentId: params.agentId,
      modelId: session.currentModelId,
      postId: params.postId,
      title: params.postTitle,
    })

    return {
      sessionId,
      modelId: session.currentModelId,
      models: session.models,
      thinkingLevel: session.currentThinkingLevel,
      thinkingOptions: session.thinkingOptions,
      modes: session.modes,
      currentModeId: effectiveModeId,
      permissionLevel: permissionState.level,
      commands: session.commands,
    }
  }

  /**
   * Expose `currentModeId` only when it was explicitly requested as a custom mode
   * or maps to the effective `permissionLevel`, preventing an unmapped default mode
   * (e.g. `build` or `deep_review`) from masking `bypass`/`plan` in the UI picker.
   */
  private resolveExposedModeId(
    currentModeId: string | null,
    permissionLevel: AcpPermissionLevel,
    requestedModeId?: string | null,
  ): string | null {
    if (!currentModeId)
      return null
    if (requestedModeId && currentModeId === requestedModeId)
      return currentModeId
    return mapAcpModeIdToPermissionLevel(currentModeId) === permissionLevel ? currentModeId : null
  }

  /**
   * Reads `<workspace>/article.md` and emits `article_synced` only when disk content changed.
   * Serialized per session so rapid edit completions never emit out-of-order snapshots.
   */
  private syncArticleFromDisk(managed: ManagedSession): Promise<void> {
    managed.syncChain = managed.syncChain.then(async () => {
      const sessionId = managed.session.sessionId
      if (!sessionId)
        return
      try {
        const diskContent = await fs.readFile(managed.articlePath, `utf8`)
        if (diskContent === managed.lastSyncedContent)
          return
        managed.lastSyncedContent = diskContent
        this.onEvent?.({
          type: `article_synced`,
          sessionId,
          postId: managed.postId,
          content: diskContent,
        })
      }
      catch {
        // Ignore missing/unreadable article file (e.g. session already disposed).
      }
    })
    return managed.syncChain
  }

  async prompt(params: AcpPromptParams): Promise<{ stopReason?: string }> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)

    // Write the current editor content to the session's article file before each turn.
    await fs.writeFile(managed.articlePath, params.content, `utf8`)
    managed.lastSyncedContent = params.content

    const attachments = params.attachments?.filter(Boolean) ?? []
    const contextHeader = [
      `[Context] You are editing the open Markdown article in doocs/md.`,
      `Article title: ${params.postTitle || `Untitled`}`,
      `Article file path: ${managed.articlePath}`,
      ...(attachments.length > 0
        ? [`Attached reference files:\n${attachments.map(p => `- ${p}`).join(`\n`)}`]
        : []),
      `Edit "${managed.articlePath}" directly on disk to update the article.`,
    ].join(`\n`)

    const blocks: ContentBlock[] = [
      {
        type: `text`,
        text: `${contextHeader}\n\n${params.text}`,
      },
    ]

    try {
      return await managed.session.prompt(blocks)
    }
    finally {
      // Read the article file back once more at turn end in case edits bypassed a tool_call update.
      await this.syncArticleFromDisk(managed)
    }
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed)
      return
    await managed.session.cancel()
  }

  async setModel(params: {
    sessionId: string
    modelId: string
    thinkingLevel?: string | null
  }): Promise<{ modelId: string | null, thinkingLevel: string | null }> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)
    const result = await managed.session.setModel(params.modelId, params.thinkingLevel)
    if (result.modelId)
      await this.registry.rememberLastModel(managed.session.agentId, result.modelId)
    if (result.thinkingLevel)
      await this.registry.rememberLastThinkingLevel(managed.session.agentId, result.thinkingLevel)
    return result
  }

  async setThinkingLevel(params: {
    sessionId: string
    thinkingLevel: string
  }): Promise<{ thinkingLevel: string | null, modelId: string | null }> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)
    const result = await managed.session.setThinkingLevel(params.thinkingLevel)
    if (result.thinkingLevel)
      await this.registry.rememberLastThinkingLevel(managed.session.agentId, result.thinkingLevel)
    if (result.modelId)
      await this.registry.rememberLastModel(managed.session.agentId, result.modelId)
    return result
  }

  async setPermissionMode(params: {
    sessionId: string
    permissionLevel?: AcpPermissionLevel
    modeId?: string | null
  }): Promise<{ permissionLevel: AcpPermissionLevel, modeId: string | null }> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)

    const previousLevel = managed.permissionState.level
    const previousBypassModeId = managed.permissionState.clientBypassModeId
    let targetModeId: string | null = null

    if (params.permissionLevel) {
      managed.permissionState.level = params.permissionLevel
      targetModeId
        = (params.modeId && managed.session.modes.some(m => m.id === params.modeId) ? params.modeId : null)
          ?? resolveNativeModeIdForLevel(
            params.permissionLevel,
            managed.session.modes,
            managed.session.currentModeId,
          )

      if (targetModeId && targetModeId !== managed.session.currentModeId) {
        const leavingNativeBypass
          = params.permissionLevel !== `bypass`
            && mapAcpModeIdToPermissionLevel(managed.session.currentModeId) === `bypass`
        managed.permissionState.applyingHostMode = true
        try {
          await managed.session.setMode(targetModeId)
        }
        catch (error) {
          // Only tolerate `-32601 Method not found` for read-only mode lists when not stuck in native bypass.
          if (!isMethodNotFoundError(error) || leavingNativeBypass) {
            managed.permissionState.level = previousLevel
            managed.permissionState.clientBypassModeId = previousBypassModeId
            throw error
          }
        }
        finally {
          managed.permissionState.applyingHostMode = false
        }
      }

      managed.permissionState.clientBypassModeId
        = managed.permissionState.level === `bypass`
          && mapPermissionLevelToAcpModeId(`bypass`, managed.session.modes) === null
          ? managed.session.currentModeId
          : null

      return {
        permissionLevel: managed.permissionState.level,
        modeId: this.resolveExposedModeId(
          managed.session.currentModeId,
          managed.permissionState.level,
          params.modeId,
        ),
      }
    }

    if (params.modeId) {
      const mapped = mapAcpModeIdToPermissionLevel(params.modeId)
      // Default unknown custom modes to `ask` so switching away from `bypass` stays safe.
      managed.permissionState.level = mapped ?? `ask`
      managed.permissionState.clientBypassModeId = null
      if (managed.session.modes.some(m => m.id === params.modeId))
        targetModeId = params.modeId

      if (targetModeId && targetModeId !== managed.session.currentModeId) {
        managed.permissionState.applyingHostMode = true
        try {
          await managed.session.setMode(targetModeId)
        }
        catch (error) {
          managed.permissionState.level = previousLevel
          managed.permissionState.clientBypassModeId = previousBypassModeId
          throw error
        }
        finally {
          managed.permissionState.applyingHostMode = false
        }
      }
    }

    return {
      permissionLevel: managed.permissionState.level,
      modeId: managed.session.currentModeId,
    }
  }

  respondPermission(params: {
    sessionId: string
    requestId: string
    decision: AcpPermissionDecision
    optionId?: string
  }): void {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      return
    managed.session.respondPermission(params.requestId, params.decision, params.optionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed)
      return
    this.sessions.delete(sessionId)
    this.activeWorkspaceDirs.delete(managed.workspaceDir)
    await managed.session.close()
    await fs.rm(managed.workspaceDir, { recursive: true, force: true }).catch(() => undefined)
  }

  getActiveSessions(): AcpActiveSessionSummary[] {
    const active: AcpActiveSessionSummary[] = []
    for (const [sessionId, managed] of this.sessions.entries()) {
      if (!managed.session.isActive)
        continue
      active.push({
        sessionId,
        agentId: managed.session.agentId,
        agentName: managed.agentName,
        waitingPermission: managed.session.hasPendingPermission,
      })
    }
    return active
  }

  hasActiveSession(): boolean {
    return this.getActiveSessions().length > 0
  }

  async dispose(): Promise<void> {
    await this.registry.cancelAllInstalls()
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)))
    await this.probeCache.flush()
  }
}
