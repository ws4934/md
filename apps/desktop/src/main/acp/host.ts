import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk/unstable'
import type {
  AcpAgentConfig,
  AcpAgentStatus,
  AcpHostEvent,
  AcpPermissionDecision,
  AcpPermissionLevel,
  AcpProbeResult,
  AcpPromptParams,
  AcpSettings,
  AcpSlashCommand,
  AcpStartSessionParams,
  AcpStartSessionResult,
  AcpWorkspaceImage,
} from '@md/shared/types'
import type { IpCharacterStore } from '../ip-characters'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, readdirSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
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
import { buildArticleWritingRules } from './writing-rules'

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
  ipSnapshotChain: Promise<void>
  activeTurnPromise: Promise<void> | null
  cleanupPromise: Promise<void> | null
  promptInFlight: boolean
  closing: boolean
  writingRulesSent: boolean
  imageGenEnabled: boolean
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
  resolveAgentAvailability?: (agentId: string) => boolean | null | Promise<boolean | null>
  /** Optional fast-path probe resolver for agents whose metadata lives in-process (e.g. api-model). */
  resolveDirectProbe?: (agentId: string) => AcpProbeResult | null | Promise<AcpProbeResult | null>
  /** Runtime-only env vars injected when spawning a session or probe (never returned in AcpAgentStatus). */
  resolveAgentRuntimeEnv?: (
    agentId: string,
    context: { workspaceDir?: string, forProbe?: boolean },
  ) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>
  resolveSessionMcpServers?: (agentId: string, workspaceDir: string) => McpServer[] | Promise<McpServer[]>
  isImageGenConfigured?: () => boolean | Promise<boolean>
  /** App version; persisted probe results from other versions are discarded. */
  appVersion?: string
  /** Directory of `<name>/SKILL.md` skills (the effective set) copied into every agent workspace and the probe cwd. */
  skillsDir?: string
  ipCharacters?: IpCharacterStore
  onEvent?: (event: AcpHostEvent) => void
}

/**
 * Agent CLIs load project skills natively from their cwd: Claude Code reads `.claude/skills`,
 * Codex / OpenCode / Gemini CLI / Antigravity CLI read `.agents/skills`, older Qwen Code only `.qwen/skills`.
 */
const SKILL_DIRS = [`.claude/skills`, `.agents/skills`, `.qwen/skills`]

/**
 * Copies the bundled skills where agent CLIs discover them. Skills are optional, so failures only warn;
 * returns whether every copy succeeded.
 */
async function installBundledSkills(dir: string, skillsDir: string | undefined): Promise<boolean> {
  if (!skillsDir)
    return true
  const results = await Promise.allSettled(SKILL_DIRS.map(target =>
    fs.cp(skillsDir, path.join(dir, target), { recursive: true }),
  ))
  const failure = results.find(result => result.status === `rejected`)
  if (failure)
    console.warn(`[acp] failed to install bundled skills:`, failure.reason)
  return !failure
}

/**
 * Short hash of bundled `<name>/SKILL.md` files so probe caches invalidate when skills change
 * without an app version bump (e.g. dev builds or local packaging).
 */
export function fingerprintBundledSkills(skillsDir: string | undefined): string {
  if (!skillsDir)
    return ``
  try {
    const names = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort()
    const hash = createHash(`sha256`)
    for (const name of names) {
      try {
        const content = readFileSync(path.join(skillsDir, name, `SKILL.md`), `utf8`)
        hash.update(`${name}\0${content}\0`)
      }
      catch {
        // Skip entries without a readable SKILL.md.
      }
    }
    return hash.digest(`hex`).slice(0, 12)
  }
  catch {
    return ``
  }
}

/** Codex lists skills as `$name`; other agents list slash commands as bare names typed with `/`. */
function commandToken(command: AcpSlashCommand): string {
  return command.name.startsWith(`$`) || command.name.startsWith(`/`) ? command.name : `/${command.name}`
}

function isPathInside(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target.startsWith(prefix)
}

function isCommandTurn(text: string, commands: AcpSlashCommand[]): boolean {
  const head = text.trimStart().split(/\s/, 1)[0]
  return commands.some(command => commandToken(command) === head)
}

const MAX_ARTICLE_BYTES = 10 * 1024 * 1024
const MAX_WORKSPACE_IMAGE_BYTES = 10 * 1024 * 1024
const WORKSPACE_IMAGE_MIME: Record<string, string> = {
  '.png': `image/png`,
  '.jpg': `image/jpeg`,
  '.jpeg': `image/jpeg`,
  '.gif': `image/gif`,
  '.webp': `image/webp`,
}

function formatAttachments(params: AcpPromptParams): string | null {
  const attachments = params.attachments?.filter(Boolean) ?? []
  return attachments.length > 0
    ? `Attached reference files:\n${attachments.map(p => `- ${p}`).join(`\n`)}`
    : null
}

function articleContextLines(postTitle: string | undefined, articlePath: string, attachmentsText?: string | null): string[] {
  return [
    `[Context] You are editing the open Markdown article in doocs/md.`,
    `Article title: ${postTitle || `Untitled`}`,
    `Article file path: ${articlePath}`,
    ...(attachmentsText ? [attachmentsText] : []),
    `Edit "${articlePath}" directly on disk to update the article.`,
  ]
}

/** Article context for a turn; the writing rules ride on the first turn only (agents keep them in history). */
export function buildPromptContext(
  params: AcpPromptParams,
  articlePath: string,
  includeRules: boolean,
  options?: { imageGenEnabled?: boolean },
): string {
  const header = articleContextLines(params.postTitle, articlePath, formatAttachments(params)).join(`\n`)
  return includeRules ? `${header}\n\n${buildArticleWritingRules(options)}` : header
}

export function buildPromptText(
  params: AcpPromptParams,
  articlePath: string,
  includeRules: boolean,
  options?: { imageGenEnabled?: boolean },
): string {
  return `${buildPromptContext(params, articlePath, includeRules, options)}\n\n${params.text}`
}

/**
 * Agents only run a command when it starts the prompt, so command turns send the user's text as its
 * own first block and the article context as a second block (also keeps attachments out of arguments).
 * A command may be handled locally without the model seeing the context, so only a normal turn counts
 * as having delivered the writing rules.
 */
function buildTurn(
  managed: ManagedSession,
  params: AcpPromptParams,
  commands: AcpSlashCommand[],
): { blocks: ContentBlock[], deliversRules: boolean } {
  const includeRules = !managed.writingRulesSent
  const context = buildPromptContext(params, managed.articlePath, includeRules, { imageGenEnabled: managed.imageGenEnabled })
  if (isCommandTurn(params.text, commands))
    return { blocks: [{ type: `text`, text: params.text }, { type: `text`, text: context }], deliversRules: false }
  return { blocks: [{ type: `text`, text: `${context}\n\n${params.text}` }], deliversRules: includeRules }
}

export class AcpHost {
  private readonly workspacesRoot: string
  private readonly pathOverride?: string
  private readonly registry: AcpRegistry
  private readonly probeCache: ProbeCache
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly activeWorkspaceDirs = new Set<string>()
  private readonly resolveAgentAvailability?: AcpHostOptions[`resolveAgentAvailability`]
  private readonly resolveDirectProbe?: AcpHostOptions[`resolveDirectProbe`]
  private readonly resolveAgentRuntimeEnv?: AcpHostOptions[`resolveAgentRuntimeEnv`]
  private readonly resolveSessionMcpServers?: AcpHostOptions[`resolveSessionMcpServers`]
  private readonly isImageGenConfigured?: AcpHostOptions[`isImageGenConfigured`]
  private readonly skillsDir?: string
  private readonly ipCharacters?: IpCharacterStore
  private readonly onEvent?: (event: AcpHostEvent) => void

  constructor(options: AcpHostOptions) {
    this.workspacesRoot = path.join(options.dataDir, `acp-workspaces`)
    this.skillsDir = options.skillsDir
    this.ipCharacters = options.ipCharacters
    this.pathOverride = options.pathOverride
    this.resolveAgentAvailability = options.resolveAgentAvailability
    this.resolveDirectProbe = options.resolveDirectProbe
    this.resolveAgentRuntimeEnv = options.resolveAgentRuntimeEnv
    this.resolveSessionMcpServers = options.resolveSessionMcpServers
    this.isImageGenConfigured = options.isImageGenConfigured
    this.onEvent = options.onEvent
    this.probeCache = new ProbeCache({
      cachePath: path.join(options.dataDir, `acp-probe-cache.json`),
      appVersion: [options.appVersion, fingerprintBundledSkills(options.skillsDir)].filter(Boolean).join(`+`) || undefined,
    })
    this.registry = new AcpRegistry({
      settingsPath: path.join(options.dataDir, `acp-settings.json`),
      pathOverride: options.pathOverride,
      extraBuiltinAgents: options.extraBuiltinAgents,
      resolveAgentAvailability: options.resolveAgentAvailability,
      onEvent: options.onEvent,
    })
    // Best-effort cleanup of orphaned workspace folders left by prior crashes / SIGKILLs.
    void this.sweepStaleWorkspaces()
  }

  /** Each probe gets its own workspace with the same skills as sessions, so draft commands match. */
  private readonly probeWorkspace = {
    create: async (): Promise<{ dir: string, complete: boolean }> => {
      const dir = path.join(this.workspacesRoot, `probe-${randomUUID()}`)
      this.activeWorkspaceDirs.add(dir)
      try {
        await fs.mkdir(dir, { recursive: true })
      }
      catch (error) {
        this.activeWorkspaceDirs.delete(dir)
        throw error
      }
      return { dir, complete: await installBundledSkills(dir, this.skillsDir) }
    },
    dispose: async (dir: string): Promise<void> => {
      this.activeWorkspaceDirs.delete(dir)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    },
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

  /** Omit `agentId` to drop every agent's probe, e.g. after the skill set changed. */
  invalidateAgentProbe(agentId?: string): void {
    this.probeCache.invalidate(agentId)
  }

  refreshAgentAvailability(): Promise<AcpAgentStatus[]> {
    return this.registry.refreshAvailability()
  }

  async probeAgent(agentId: string, options?: { force?: boolean }): Promise<AcpProbeResult> {
    const availability = await this.resolveAgentAvailability?.(agentId) ?? null
    if (availability === false) {
      return {
        agentId,
        models: [],
        currentModelId: null,
        modes: [],
        currentModeId: null,
        commands: [],
        probedAt: Date.now(),
        error: `Agent is not configured`,
      }
    }

    const directProbe = await this.resolveDirectProbe?.(agentId) ?? null
    if (directProbe) {
      this.probeCache.seed(directProbe)
      return directProbe
    }

    const launch = await this.registry.resolveLaunchSpec(agentId)
    const runtimeEnv = await this.resolveAgentRuntimeEnv?.(agentId, { forProbe: true })
    const mergedEnv = runtimeEnv ? { ...launch.env, ...runtimeEnv } : launch.env
    return this.probeCache.probe(
      {
        agentId,
        command: launch.command,
        args: launch.args,
        env: mergedEnv,
        workspace: this.probeWorkspace,
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

    let mergedEnv = launch.env
    let mcpServers: McpServer[] = []
    let imageGenEnabled = false
    try {
      await fs.mkdir(workspaceDir, { recursive: true })
      await this.writeWorkspaceArticle(workspaceDir, params.content)
      imageGenEnabled = Boolean(await this.isImageGenConfigured?.())
      await installBundledSkills(workspaceDir, this.skillsDir)
      if (this.ipCharacters) {
        try {
          await this.ipCharacters.writeWorkspaceSnapshot(workspaceDir)
        }
        catch (error) {
          console.warn(`[acp] failed to write IP character snapshot:`, error)
        }
      }
      const runtimeEnv = await this.resolveAgentRuntimeEnv?.(params.agentId, {
        workspaceDir,
        forProbe: false,
      })
      if (runtimeEnv)
        mergedEnv = { ...launch.env, ...runtimeEnv }
      mcpServers = await this.resolveSessionMcpServers?.(params.agentId, workspaceDir) ?? []
    }
    catch (error) {
      this.activeWorkspaceDirs.delete(workspaceDir)
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

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
      env: mergedEnv,
      mcpServers,
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
            const prevLevel = permissionState.level
            const mappedLevel = mapAcpModeIdToPermissionLevel(event.modeId)
            // Agent-originated mode updates may keep or restrict permissions, never escalate.
            permissionState.level = clampAgentModePermissionLevel(permissionState.level, mappedLevel)
            if (permissionState.level !== `bypass`)
              permissionState.clientBypassModeId = null
            if (permissionState.level !== prevLevel && (permissionState.level === `ask` || permissionState.level === `plan`))
              sessionRef.current?.clearAlwaysAllowedPermissions()
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
            void this.cleanupSessionWorkspace(managed)
          }
        }

        this.onEvent?.(event)
        // Read the article file back into the editor after an edit-kind tool completes.
        if (event.type === `tool_call` && event.tool.status === `completed` && isEditToolKind(event.tool.toolKind)) {
          const managed = this.sessions.get(event.sessionId)
          if (managed && !managed.closing)
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
      ipSnapshotChain: Promise.resolve(),
      activeTurnPromise: null,
      cleanupPromise: null,
      promptInFlight: false,
      closing: false,
      writingRulesSent: false,
      imageGenEnabled,
      permissionState,
    })

    // Feed session capabilities into the persistent probe cache so picker opens skip re-probing.
    if (
      session.models.length > 0
      || session.modes.length > 0
      || session.thinkingOptions.length > 0
    ) {
      // Draft commands come from probes only; a session's announcements can be mode- or session-specific.
      this.probeCache.seed({
        agentId: params.agentId,
        models: session.models,
        currentModelId: session.currentModelId,
        thinkingOptions: session.thinkingOptions,
        currentThinkingLevel: session.currentThinkingLevel,
        modes: session.modes,
        currentModeId: session.currentModeId,
        commands: [],
        commandsAnnounced: false,
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

  private cleanupSessionWorkspace(managed: ManagedSession): Promise<void> {
    managed.cleanupPromise ??= (async () => {
      await managed.activeTurnPromise?.catch(() => undefined)
      await managed.syncChain.catch(() => undefined)
      await managed.ipSnapshotChain.catch(() => undefined)
      this.activeWorkspaceDirs.delete(managed.workspaceDir)
      await fs.rm(managed.workspaceDir, { recursive: true, force: true }).catch(() => undefined)
    })()
    return managed.cleanupPromise
  }

  /**
   * Writes `<workspace>/article.md` via a temp file + rename inside the canonical workspace
   * so an agent-planted symlink is replaced rather than followed.
   */
  private async writeWorkspaceArticle(workspaceDir: string, content: string): Promise<void> {
    const [rootsReal, workspaceReal] = await Promise.all([
      fs.realpath(this.workspacesRoot),
      fs.realpath(workspaceDir),
    ])
    if (!isPathInside(rootsReal, workspaceReal))
      throw new Error(`Article workspace is outside the workspaces root`)

    const targetPath = path.join(workspaceReal, `article.md`)
    const tmpPath = path.join(workspaceReal, `.article.md.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tmpPath, content, { encoding: `utf8`, flag: `wx` })
      if (process.platform === `win32`) {
        const existing = await fs.lstat(targetPath).catch(() => null)
        if (existing?.isSymbolicLink())
          await fs.unlink(targetPath).catch(() => undefined)
      }
      await fs.rename(tmpPath, targetPath)
    }
    catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async readWorkspaceArticle(managed: ManagedSession): Promise<string | null> {
    const lstat = await fs.lstat(managed.articlePath)
    if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.size > MAX_ARTICLE_BYTES)
      return null

    const [rootsReal, workspaceReal, articleReal] = await Promise.all([
      fs.realpath(this.workspacesRoot),
      fs.realpath(managed.workspaceDir),
      fs.realpath(managed.articlePath),
    ])
    if (!isPathInside(rootsReal, workspaceReal) || !isPathInside(workspaceReal, articleReal))
      return null

    const fh = await fs.open(articleReal, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      const stat = await fh.stat()
      if (!stat.isFile() || stat.size > MAX_ARTICLE_BYTES)
        return null
      const buf = await fh.readFile()
      if (buf.byteLength > MAX_ARTICLE_BYTES)
        return null
      return buf.toString(`utf8`)
    }
    finally {
      await fh.close()
    }
  }

  /**
   * Reads `<workspace>/article.md` and emits `article_synced` only when disk content changed.
   * Serialized per session so rapid edit completions never emit out-of-order snapshots.
   */
  private syncArticleFromDisk(managed: ManagedSession): Promise<void> {
    managed.syncChain = managed.syncChain.then(async () => {
      if (managed.closing)
        return
      const sessionId = managed.session.sessionId
      if (!sessionId)
        return
      try {
        const diskContent = await this.readWorkspaceArticle(managed)
        if (diskContent === null || managed.closing || diskContent === managed.lastSyncedContent)
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
    if (!managed || managed.closing || managed.session.isClosed)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)
    if (managed.promptInFlight || managed.session.isTurnActive)
      throw new Error(`ACP turn is already in progress for session: ${params.sessionId}`)

    managed.promptInFlight = true
    let finishTurn!: () => void
    managed.activeTurnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve
    })

    try {
      // Wait for any queued sync read before overwriting the session's article file.
      await managed.syncChain.catch(() => undefined)
      await this.writeWorkspaceArticle(managed.workspaceDir, params.content)
      managed.lastSyncedContent = params.content

      // Until the session announces its own commands, the probe's list (what the draft menu offered) decides.
      let commands: AcpSlashCommand[]
      if (managed.session.commandsUpdatedAt !== null) {
        commands = managed.session.commands
      }
      else {
        await this.probeCache.ensureLoaded()
        commands = this.probeCache.get(managed.session.agentId)?.commands ?? []
      }
      const { blocks, deliversRules } = buildTurn(managed, params, commands)

      try {
        const result = await managed.session.prompt(blocks)
        if (deliversRules && !managed.closing)
          managed.writingRulesSent = true
        return result
      }
      finally {
        if (!managed.closing) {
          // Read the article file back once more at turn end in case edits bypassed a tool_call update.
          await this.syncArticleFromDisk(managed)
          if (this.ipCharacters) {
            try {
              await this.ipCharacters.applyWorkspaceSelection(managed.workspaceDir)
            }
            catch (error) {
              console.warn(`[acp] failed to apply IP character selection:`, error)
            }
          }
        }
      }
    }
    finally {
      managed.promptInFlight = false
      managed.activeTurnPromise = null
      finishTurn()
    }
  }

  async refreshIpSnapshots(): Promise<void> {
    if (!this.ipCharacters)
      return
    const store = this.ipCharacters
    const managedList = [...this.sessions.values()].filter(m => !m.closing && !m.session.isClosed)
    await Promise.all(
      managedList.map((managed) => {
        managed.ipSnapshotChain = managed.ipSnapshotChain.then(async () => {
          if (managed.closing || managed.session.isClosed)
            return
          try {
            await fs.access(managed.workspaceDir)
            if (managed.closing || managed.session.isClosed)
              return
            await store.writeWorkspaceSnapshot(managed.workspaceDir)
          }
          catch (error) {
            console.warn(`[acp] failed to refresh IP character snapshot:`, error)
          }
        })
        return managed.ipSnapshotChain
      }),
    )
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
      if (managed.permissionState.level === `ask` || managed.permissionState.level === `plan`)
        managed.session.clearAlwaysAllowedPermissions()
    }
    else if (params.modeId) {
      const mapped = mapAcpModeIdToPermissionLevel(params.modeId)
      // Default unknown custom modes to `ask` so switching away from `bypass` stays safe.
      managed.permissionState.level = mapped ?? `ask`
      managed.permissionState.clientBypassModeId = null
      if (managed.session.modes.some(m => m.id === params.modeId)) {
        targetModeId = params.modeId
      }
      else if (managed.permissionState.level !== `bypass`) {
        targetModeId = resolveNativeModeIdForLevel(
          managed.permissionState.level,
          managed.session.modes,
          managed.session.currentModeId,
        )
      }

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

      managed.permissionState.clientBypassModeId
        = managed.permissionState.level === `bypass`
          && mapPermissionLevelToAcpModeId(`bypass`, managed.session.modes) === null
          ? managed.session.currentModeId
          : null
      if (managed.permissionState.level === `ask` || managed.permissionState.level === `plan`)
        managed.session.clearAlwaysAllowedPermissions()
    }

    return {
      permissionLevel: managed.permissionState.level,
      modeId: this.resolveExposedModeId(
        managed.session.currentModeId,
        managed.permissionState.level,
        params.modeId,
      ),
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

  /** Reads an image file the agent wrote inside its own workspace; anything outside it is refused. */
  async readWorkspaceImage(params: { sessionId: string, path: string }): Promise<AcpWorkspaceImage> {
    const managed = this.sessions.get(params.sessionId)
    if (!managed || managed.closing)
      throw new Error(`Unknown ACP session: ${params.sessionId}`)
    if (typeof params.path !== `string` || !params.path.trim() || params.path.includes(`\0`))
      throw new Error(`Image is outside the session workspace: ${params.path}`)

    let relPath = params.path
    try {
      relPath = decodeURI(relPath)
    }
    catch {
      // Keep the raw path when it is not valid percent-encoding.
    }
    if (
      relPath.includes(`\0`)
      || path.isAbsolute(relPath)
      || relPath.startsWith(`/`)
      || relPath.startsWith(`\\`)
      || /^[a-z]:/i.test(relPath)
      || relPath.split(/[\\/]/).includes(`..`)
    ) {
      throw new Error(`Image is outside the session workspace: ${params.path}`)
    }

    const requestedMime = WORKSPACE_IMAGE_MIME[path.extname(relPath).toLowerCase()]
    if (!requestedMime)
      throw new Error(`Unsupported image type: ${params.path}`)

    // Validate before and after realpath so UNC/external paths are never probed and symlinks cannot escape.
    const root = await fs.realpath(managed.workspaceDir)
    const candidate = path.resolve(root, relPath)
    if (!isPathInside(root, candidate))
      throw new Error(`Image is outside the session workspace: ${params.path}`)

    const target = await fs.realpath(candidate)
    if (!isPathInside(root, target))
      throw new Error(`Image is outside the session workspace: ${params.path}`)

    const mimeType = WORKSPACE_IMAGE_MIME[path.extname(target).toLowerCase()]
    if (!mimeType)
      throw new Error(`Unsupported image type: ${params.path}`)

    const fh = await fs.open(target, `r`)
    try {
      const stat = await fh.stat()
      if (!stat.isFile() || stat.size > MAX_WORKSPACE_IMAGE_BYTES)
        throw new Error(`Image is not a file or exceeds ${MAX_WORKSPACE_IMAGE_BYTES / 1024 / 1024} MB: ${params.path}`)
      const data = await fh.readFile()
      return { data: new Uint8Array(data), mimeType, filename: path.basename(target) }
    }
    finally {
      await fh.close()
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed)
      return
    managed.closing = true
    this.sessions.delete(sessionId)
    try {
      await managed.session.close()
    }
    finally {
      await this.cleanupSessionWorkspace(managed)
    }
  }

  getActiveSessions(): AcpActiveSessionSummary[] {
    const active: AcpActiveSessionSummary[] = []
    for (const [sessionId, managed] of this.sessions.entries()) {
      if (managed.closing || !managed.session.isActive)
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
    await this.probeCache.dispose()
  }
}
