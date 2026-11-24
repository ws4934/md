import type { ContentBlock } from '@agentclientprotocol/sdk/unstable'
import type {
  AcpAgentConfig,
  AcpAgentStatus,
  AcpHostEvent,
  AcpPermissionDecision,
  AcpProbeResult,
  AcpPromptParams,
  AcpSettings,
  AcpStartSessionParams,
  AcpStartSessionResult,
  AcpToolKind,
} from '@md/shared/types'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ProbeCache } from './probe'
import { AcpRegistry } from './registry'
import { AcpSession } from './session'

interface ManagedSession {
  session: AcpSession
  postId: string
  workspaceDir: string
  articlePath: string
  lastSyncedContent: string
  syncChain: Promise<void>
}

export interface AcpHostOptions {
  dataDir: string
  pathOverride?: string
  extraBuiltinAgents?: AcpAgentConfig[]
  onEvent?: (event: AcpHostEvent) => void
}

function isEditToolKind(kind: AcpToolKind): boolean {
  return kind === `edit` || kind === `delete` || kind === `move`
}

export class AcpHost {
  private readonly workspacesRoot: string
  private readonly pathOverride?: string
  private readonly registry: AcpRegistry
  private readonly probeCache = new ProbeCache()
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly onEvent?: (event: AcpHostEvent) => void

  private currentReviewEdits = true
  private currentAskBeforeCommands = true

  constructor(options: AcpHostOptions) {
    this.workspacesRoot = path.join(options.dataDir, `acp-workspaces`)
    this.pathOverride = options.pathOverride
    this.onEvent = options.onEvent
    this.registry = new AcpRegistry({
      settingsPath: path.join(options.dataDir, `acp-settings.json`),
      pathOverride: options.pathOverride,
      extraBuiltinAgents: options.extraBuiltinAgents,
      onEvent: options.onEvent,
    })
  }

  listAgents(): Promise<AcpAgentStatus[]> {
    return this.registry.listAgents()
  }

  detectAgents(): Promise<AcpAgentStatus[]> {
    this.probeCache.invalidate()
    return this.registry.detectAgents()
  }

  getSettings(): Promise<AcpSettings> {
    return this.registry.getSettings()
  }

  async updateSettings(patch: Partial<AcpSettings>): Promise<AcpSettings> {
    if (patch.commandOverrides)
      this.probeCache.invalidate()
    const updated = await this.registry.updateSettings(patch)
    this.currentReviewEdits = updated.reviewEditsBeforeWriting
    this.currentAskBeforeCommands = updated.askBeforeRunningCommands
    return updated
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
    this.currentReviewEdits = settings.reviewEditsBeforeWriting
    this.currentAskBeforeCommands = settings.askBeforeRunningCommands

    const launch = await this.registry.resolveLaunchSpec(params.agentId)
    const workspaceId = randomUUID()
    const workspaceDir = path.join(this.workspacesRoot, workspaceId)
    const articlePath = path.join(workspaceDir, `article.md`)

    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.writeFile(articlePath, params.content, `utf8`)

    const initialModelId = params.modelId ?? settings.lastModelByAgent[params.agentId] ?? null

    const session = new AcpSession({
      agentId: params.agentId,
      command: launch.command,
      args: launch.args,
      cwd: workspaceDir,
      env: launch.env,
      pathOverride: this.pathOverride,
      initialModelId,
      shouldAutoAcceptPermission: (toolKind) => {
        if (isEditToolKind(toolKind))
          return !this.currentReviewEdits
        if (toolKind === `execute`)
          return !this.currentAskBeforeCommands
        if (toolKind === `read` || toolKind === `search` || toolKind === `think`)
          return true
        return false
      },
      onEvent: (event) => {
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

    await session.initializeNewSession()
    const sessionId = session.sessionId!
    this.sessions.set(sessionId, {
      session,
      postId: params.postId,
      workspaceDir,
      articlePath,
      lastSyncedContent: params.content,
      syncChain: Promise.resolve(),
    })

    if (session.currentModelId)
      await this.registry.rememberLastModel(params.agentId, session.currentModelId)

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
      commands: session.commands,
    }
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

    const settings = await this.registry.getSettings()
    this.currentReviewEdits = settings.reviewEditsBeforeWriting
    this.currentAskBeforeCommands = settings.askBeforeRunningCommands

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

  async setModel(params: { sessionId: string, modelId: string }): Promise<{ modelId: string | null }> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)
    const result = await managed.session.setModel(params.modelId)
    if (result.modelId)
      await this.registry.rememberLastModel(managed.session.agentId, result.modelId)
    return result
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
    await managed.session.close()
    await fs.rm(managed.workspaceDir, { recursive: true, force: true }).catch(() => undefined)
  }

  async dispose(): Promise<void> {
    await this.registry.cancelAllInstalls()
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)))
  }
}
