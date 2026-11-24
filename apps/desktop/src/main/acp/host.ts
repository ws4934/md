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
  private readonly probeCache = new ProbeCache()
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly onEvent?: (event: AcpHostEvent) => void

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
      articlePath,
      initialArticleContent: params.content,
      initialModelId,
      shouldAutoAcceptPermission: (toolKind) => {
        if (toolKind === `execute`)
          return !this.currentAskBeforeCommands
        if (toolKind === `read` || toolKind === `search` || toolKind === `think`)
          return true
        return false
      },
      onArticleWrite: (baseContent, proposedContent) => {
        if (!session.sessionId)
          return
        this.onEvent?.({
          type: `article_edit`,
          sessionId: session.sessionId,
          proposal: {
            editId: randomUUID(),
            sessionId: session.sessionId,
            postId: params.postId,
            baseContent,
            proposedContent,
            autoApplied: !this.currentReviewEdits,
          },
        })
      },
      onEvent: (event) => {
        this.onEvent?.(event)
      },
      onNonJsonStdout: (line) => {
        console.warn(`[acp:${params.agentId}] skipped non-JSON stdout:`, line.slice(0, 200))
      },
    })

    // Snapshot latest permission settings for synchronous permission checks.
    this.currentReviewEdits = settings.reviewEditsBeforeWriting
    this.currentAskBeforeCommands = settings.askBeforeRunningCommands

    await session.initializeNewSession()
    const sessionId = session.sessionId!
    this.sessions.set(sessionId, {
      session,
      postId: params.postId,
      workspaceDir,
      articlePath,
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

  private currentReviewEdits = true
  private currentAskBeforeCommands = true

  async syncArticleContent(params: { sessionId: string, content: string }): Promise<void> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      return
    managed.session.updateArticleContent(params.content)
    await fs.writeFile(managed.articlePath, params.content, `utf8`)
  }

  async prompt(params: AcpPromptParams): Promise<{ stopReason?: string }> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)

    const settings = await this.registry.getSettings()
    this.currentReviewEdits = settings.reviewEditsBeforeWriting
    this.currentAskBeforeCommands = settings.askBeforeRunningCommands

    managed.session.updateArticleContent(params.content)
    await fs.writeFile(managed.articlePath, params.content, `utf8`)

    const attachments = params.attachments?.filter(Boolean) ?? []
    if (attachments.length > 0)
      managed.session.allowReadPaths(attachments)

    const contextHeader = [
      `[Context] You are editing the open Markdown article in doocs/md.`,
      `Article title: ${params.postTitle || `Untitled`}`,
      `Article file path: ${managed.articlePath}`,
      ...(attachments.length > 0
        ? [`Attached reference files:\n${attachments.map(p => `- ${p}`).join(`\n`)}`]
        : []),
      `Use read/write file tools on "${managed.articlePath}" to inspect and update the article directly.`,
    ].join(`\n`)

    const blocks: ContentBlock[] = [
      {
        type: `text`,
        text: `${contextHeader}\n\n${params.text}`,
      },
    ]

    return managed.session.prompt(blocks)
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
