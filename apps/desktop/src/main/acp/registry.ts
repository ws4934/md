import type {
  AcpAgentConfig,
  AcpAgentStatus,
  AcpHostEvent,
  AcpInstallProgress,
  AcpSettings,
} from '@md/shared/types'
import type { Buffer } from 'node:buffer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import {
  createDefaultAcpSettings,
  DEFAULT_ACP_SETTINGS,
  isAcpPermissionLevel,
  migrateLegacyPermissionSettings,
} from '@md/shared/utils/acp-permissions'
import { buildAgentEnv, resolveBinaryOnPath, resolveLoginShellPath, spawnAgentProcess, terminateProcessTree } from './process'

export const BUILTIN_AGENTS: AcpAgentConfig[] = [
  {
    id: `claude`,
    name: `Claude Code`,
    command: `npx`,
    args: [`-y`, `@zed-industries/claude-code-acp`],
    installPackage: `@zed-industries/claude-code-acp`,
    detectBinaries: [`claude-code-acp`, `claude-agent-acp`, `claude`],
    builtin: true,
    avatar: { letter: `C`, color: `#D97757` },
  },
  {
    id: `codex`,
    name: `Codex CLI`,
    command: `npx`,
    args: [`-y`, `@zed-industries/codex-acp`],
    installPackage: `@zed-industries/codex-acp`,
    detectBinaries: [`codex-acp`, `codex`],
    builtin: true,
    avatar: { letter: `X`, color: `#3A3A38` },
  },
  {
    id: `gemini`,
    name: `Gemini CLI`,
    command: `gemini`,
    args: [`--experimental-acp`],
    installPackage: `@google/gemini-cli`,
    detectBinaries: [`gemini`],
    builtin: true,
    avatar: { letter: `G`, color: `#4C7DF0` },
  },
  {
    id: `qwen`,
    name: `Qwen Code`,
    command: `qwen`,
    args: [`--experimental-acp`],
    installPackage: `@qwen-code/qwen-code`,
    detectBinaries: [`qwen`],
    builtin: true,
    avatar: { letter: `Q`, color: `#7A5AF8` },
  },
  {
    id: `opencode`,
    name: `OpenCode`,
    command: `opencode`,
    args: [`acp`],
    installPackage: `opencode-ai`,
    detectBinaries: [`opencode`],
    builtin: true,
    avatar: { letter: `O`, color: `#8A877F` },
  },
  {
    // Native binary from the Antigravity installer (no npm package), speaks ACP via `agy acp`.
    id: `antigravity`,
    name: `Antigravity CLI`,
    command: `agy`,
    args: [`acp`],
    detectBinaries: [`agy`],
    builtin: true,
    avatar: { letter: `A`, color: `#0F9D8A` },
  },
]

const CUSTOM_AVATAR_COLORS = [`#5B5BD6`, `#0A9E55`, `#D97757`, `#4C7DF0`, `#7A5AF8`, `#A86500`]

const DIRECT_ADAPTER_BINARIES: Record<string, readonly string[]> = {
  claude: [`claude-code-acp`, `claude-agent-acp`],
  codex: [`codex-acp`],
}

interface DetectionEntry {
  installed: boolean
  resolvedPath?: string
  directAdapterPath?: string
}

interface ActiveInstall {
  child: ChildProcessWithoutNullStreams
  cancelled: boolean
  progress: AcpInstallProgress
}

export interface AcpRegistryOptions {
  settingsPath: string
  pathOverride?: string
  extraBuiltinAgents?: AcpAgentConfig[]
  resolveAgentAvailability?: (agentId: string) => boolean | null | Promise<boolean | null>
  onEvent?: (event: AcpHostEvent) => void
}

export class AcpRegistry {
  private readonly settingsPath: string
  private readonly pathOverride?: string
  private readonly extraBuiltinAgents: AcpAgentConfig[]
  private readonly resolveAgentAvailability?: AcpRegistryOptions[`resolveAgentAvailability`]
  private readonly onEvent?: (event: AcpHostEvent) => void

  private settings: AcpSettings = createDefaultAcpSettings()
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private detectionCache = new Map<string, DetectionEntry>()
  private activeInstalls = new Map<string, ActiveInstall>()
  private persistChain: Promise<void> = Promise.resolve()

  constructor(options: AcpRegistryOptions) {
    this.settingsPath = options.settingsPath
    this.pathOverride = options.pathOverride
    this.extraBuiltinAgents = options.extraBuiltinAgents ?? []
    this.resolveAgentAvailability = options.resolveAgentAvailability
    this.onEvent = options.onEvent
  }

  private getReservedBuiltinIds(): Set<string> {
    return new Set([
      ...BUILTIN_AGENTS.map(a => a.id),
      ...this.extraBuiltinAgents.map(a => a.id),
      API_MODEL_AGENT_ID,
    ])
  }

  private sanitizeCustomAgents(raw: unknown): AcpAgentConfig[] {
    if (!Array.isArray(raw))
      return []
    const reserved = this.getReservedBuiltinIds()
    const seen = new Set<string>()
    const valid: AcpAgentConfig[] = []
    for (const item of raw) {
      if (!item || typeof item !== `object` || Array.isArray(item))
        continue
      const entry = item as Partial<AcpAgentConfig>
      const id = typeof entry.id === `string` ? entry.id.trim() : ``
      const name = typeof entry.name === `string` ? entry.name.trim() : ``
      const command = typeof entry.command === `string` ? entry.command.trim() : ``
      // Never allow custom agents to collide with built-in IDs (especially `api-model` which gets runtime secrets).
      if (!id || !name || !command || reserved.has(id) || seen.has(id))
        continue
      seen.add(id)
      const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === `string`) : []
      const letter = typeof entry.avatar?.letter === `string` && entry.avatar.letter ? entry.avatar.letter : (name[0]?.toUpperCase() || `A`)
      const color = typeof entry.avatar?.color === `string` && entry.avatar.color ? entry.avatar.color : CUSTOM_AVATAR_COLORS[0]
      valid.push({
        id,
        name,
        command,
        args,
        ...(entry.env && typeof entry.env === `object` && !Array.isArray(entry.env) ? { env: { ...entry.env } } : {}),
        detectBinaries: Array.isArray(entry.detectBinaries) && entry.detectBinaries.length > 0
          ? entry.detectBinaries.filter((b): b is string => typeof b === `string`)
          : [command],
        builtin: false,
        avatar: { letter, color },
      })
    }
    return valid
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded)
      return
    this.loadPromise ??= (async () => {
      try {
        const raw = await fs.readFile(this.settingsPath, `utf8`)
        const parsed = JSON.parse(raw) as Partial<AcpSettings> & {
          reviewEditsBeforeWriting?: unknown
          askBeforeRunningCommands?: unknown
        }
        const { level, migrated } = migrateLegacyPermissionSettings(parsed)
        this.settings = {
          defaultAgentId: typeof parsed.defaultAgentId === `string` && parsed.defaultAgentId.trim()
            ? parsed.defaultAgentId
            : DEFAULT_ACP_SETTINGS.defaultAgentId,
          defaultPermissionLevel: level,
          lastModelByAgent: { ...(parsed.lastModelByAgent ?? {}) },
          lastThinkingLevelByAgent: { ...(parsed.lastThinkingLevelByAgent ?? {}) },
          customAgents: this.sanitizeCustomAgents(parsed.customAgents),
          commandOverrides: { ...(parsed.commandOverrides ?? {}) },
        }
        // Built-in API agent receives decrypted keys in runtime env; never allow overriding its command.
        delete this.settings.commandOverrides[API_MODEL_AGENT_ID]
        if (migrated)
          await this.persist().catch(() => undefined)
      }
      catch {
        this.settings = createDefaultAcpSettings()
      }
      finally {
        this.loaded = true
      }
    })()
    await this.loadPromise
  }

  private async writeAtomic(): Promise<void> {
    const snapshot = `${JSON.stringify(this.settings, null, 2)}\n`
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true })
    const tmpPath = `${this.settingsPath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmpPath, snapshot, `utf8`)
      await fs.rename(tmpPath, this.settingsPath)
    }
    catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private persist(): Promise<void> {
    // Serialize atomic writes so concurrent settings/lastModel updates never clobber newer state.
    this.persistChain = this.persistChain.catch(() => undefined).then(() => this.writeAtomic())
    return this.persistChain
  }

  async getSettings(): Promise<AcpSettings> {
    await this.ensureLoaded()
    return structuredClone(this.settings)
  }

  async updateSettings(patch: Partial<AcpSettings>): Promise<AcpSettings> {
    await this.ensureLoaded()
    const mergedOverrides = { ...this.settings.commandOverrides }
    if (patch.commandOverrides) {
      for (const [agentId, override] of Object.entries(patch.commandOverrides)) {
        if (!override || typeof override.command !== `string` || !override.command.trim())
          delete mergedOverrides[agentId]
        else
          mergedOverrides[agentId] = override
      }
    }
    delete mergedOverrides[API_MODEL_AGENT_ID]

    this.settings = {
      defaultAgentId: typeof patch.defaultAgentId === `string` && patch.defaultAgentId.trim()
        ? patch.defaultAgentId.trim()
        : this.settings.defaultAgentId,
      defaultPermissionLevel: isAcpPermissionLevel(patch.defaultPermissionLevel)
        ? patch.defaultPermissionLevel
        : this.settings.defaultPermissionLevel,
      customAgents: patch.customAgents !== undefined
        ? this.sanitizeCustomAgents(patch.customAgents)
        : this.settings.customAgents,
      lastModelByAgent: patch.lastModelByAgent
        ? { ...this.settings.lastModelByAgent, ...patch.lastModelByAgent }
        : this.settings.lastModelByAgent,
      lastThinkingLevelByAgent: patch.lastThinkingLevelByAgent
        ? { ...this.settings.lastThinkingLevelByAgent, ...patch.lastThinkingLevelByAgent }
        : this.settings.lastThinkingLevelByAgent,
      commandOverrides: mergedOverrides,
    }
    await this.persist()
    const agents = patch.commandOverrides
      ? await this.detectAgents({ forceShell: false })
      : await this.listAgents()
    if (!patch.commandOverrides)
      this.onEvent?.({ type: `agents_changed`, agents })
    return structuredClone(this.settings)
  }

  async rememberLastModel(agentId: string, modelId: string): Promise<void> {
    await this.ensureLoaded()
    if (this.settings.lastModelByAgent[agentId] === modelId)
      return
    this.settings.lastModelByAgent[agentId] = modelId
    await this.persist()
  }

  async rememberLastThinkingLevel(agentId: string, level: string): Promise<void> {
    await this.ensureLoaded()
    if (this.settings.lastThinkingLevelByAgent[agentId] === level)
      return
    this.settings.lastThinkingLevelByAgent[agentId] = level
    await this.persist()
  }

  getAllConfigs(): AcpAgentConfig[] {
    return [...BUILTIN_AGENTS, ...this.extraBuiltinAgents, ...this.settings.customAgents]
  }

  async getAgentConfig(agentId: string): Promise<AcpAgentConfig | null> {
    await this.ensureLoaded()
    return this.getAllConfigs().find(a => a.id === agentId) ?? null
  }

  /**
   * Resolves the concrete command and args to spawn for an agent, honoring any
   * user override and preferring a directly installed ACP adapter binary over npx.
   */
  async resolveLaunchSpec(agentId: string): Promise<{
    command: string
    args: string[]
    env?: Record<string, string>
  }> {
    await this.ensureLoaded()
    const config = this.getAllConfigs().find(a => a.id === agentId)
    if (!config)
      throw new Error(`Unknown ACP agent: ${agentId}`)

    const override = agentId === API_MODEL_AGENT_ID ? undefined : this.settings.commandOverrides[agentId]
    if (override && override.command.trim()) {
      return {
        command: override.command.trim(),
        args: override.args,
        env: override.env,
      }
    }

    const detected = this.detectionCache.get(agentId)
    if (detected) {
      if (detected.directAdapterPath)
        return { command: detected.directAdapterPath, args: [], env: config.env }
      return {
        command: config.command,
        args: config.args,
        env: config.env,
      }
    }

    const pathEnv = this.pathOverride ?? await resolveLoginShellPath()

    // Prefer a globally installed ACP adapter binary directly when available to avoid npx latency.
    const directBins = DIRECT_ADAPTER_BINARIES[config.id]
    if (directBins) {
      for (const directBin of directBins) {
        const resolved = await resolveBinaryOnPath(directBin, pathEnv)
        if (resolved)
          return { command: resolved, args: [], env: config.env }
      }
    }

    return {
      command: config.command,
      args: config.args,
      env: config.env,
    }
  }

  async detectAgents(options: { forceShell?: boolean } = {}): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    const pathEnv = this.pathOverride ?? await resolveLoginShellPath({ force: options.forceShell === true })
    const configs = this.getAllConfigs()

    await Promise.all(
      configs.map(async (config) => {
        const availabilityOverride = await this.resolveAgentAvailability?.(config.id) ?? null
        if (availabilityOverride !== null) {
          this.detectionCache.set(config.id, {
            installed: availabilityOverride,
            resolvedPath: availabilityOverride ? config.command : undefined,
          })
          return
        }

        const override = this.settings.commandOverrides[config.id]
        const binariesToCheck = override?.command
          ? [override.command]
          : (config.detectBinaries?.length ? config.detectBinaries : [config.command])
        const directAdapterSet = override?.command
          ? null
          : (DIRECT_ADAPTER_BINARIES[config.id] ? new Set(DIRECT_ADAPTER_BINARIES[config.id]) : null)

        let resolvedPath: string | null = null
        let directAdapterPath: string | undefined
        for (const bin of binariesToCheck) {
          resolvedPath = await resolveBinaryOnPath(bin, pathEnv)
          if (resolvedPath) {
            if (directAdapterSet?.has(bin))
              directAdapterPath = resolvedPath
            break
          }
        }
        this.detectionCache.set(config.id, {
          installed: Boolean(resolvedPath),
          resolvedPath: resolvedPath ?? undefined,
          directAdapterPath,
        })
      }),
    )

    const statuses = this.buildStatuses()
    this.onEvent?.({ type: `agents_changed`, agents: statuses })
    return statuses
  }

  private async applyDynamicAvailability(): Promise<void> {
    if (!this.resolveAgentAvailability)
      return
    const configs = this.getAllConfigs()
    await Promise.all(
      configs.map(async (config) => {
        const availabilityOverride = await this.resolveAgentAvailability?.(config.id) ?? null
        if (availabilityOverride !== null) {
          this.detectionCache.set(config.id, {
            installed: availabilityOverride,
            resolvedPath: availabilityOverride ? config.command : undefined,
          })
        }
      }),
    )
  }

  /**
   * Re-evaluates dynamic availability overrides (e.g. built-in API agent config)
   * without re-scanning PATH or spawning a login shell.
   */
  async refreshAvailability(): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    if (this.detectionCache.size === 0)
      return this.detectAgents({ forceShell: false })

    await this.applyDynamicAvailability()
    const statuses = this.buildStatuses()
    this.onEvent?.({ type: `agents_changed`, agents: statuses })
    return statuses
  }

  async listAgents(): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    if (this.detectionCache.size === 0)
      return this.detectAgents({ forceShell: false })
    await this.applyDynamicAvailability()
    return this.buildStatuses()
  }

  private buildStatuses(): AcpAgentStatus[] {
    const configs = this.getAllConfigs()
    return configs.map((config) => {
      const override = config.id === API_MODEL_AGENT_ID ? undefined : this.settings.commandOverrides[config.id]
      const detected = this.detectionCache.get(config.id)
      const activeInstall = this.activeInstalls.get(config.id)
      return {
        id: config.id,
        name: config.name,
        builtin: config.builtin,
        installed: detected?.installed ?? false,
        resolvedPath: detected?.resolvedPath,
        command: override?.command || config.command,
        args: override?.args ?? config.args,
        env: override?.env ?? config.env,
        installPackage: config.installPackage,
        avatar: config.avatar,
        isDefault: this.settings.defaultAgentId === config.id,
        installing: Boolean(activeInstall),
        installProgress: activeInstall?.progress,
      }
    })
  }

  async addCustomAgent(input: {
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
  }): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    const trimmedName = input.name.trim()
    const trimmedCommand = input.command.trim()
    if (!trimmedName || !trimmedCommand)
      throw new Error(`Agent name and command are required`)

    const id = `custom-${randomUUID().slice(0, 8)}`
    const color = CUSTOM_AVATAR_COLORS[this.settings.customAgents.length % CUSTOM_AVATAR_COLORS.length]
    const letter = trimmedName[0]?.toUpperCase() || `A`

    this.settings.customAgents.push({
      id,
      name: trimmedName,
      command: trimmedCommand,
      args: input.args,
      env: input.env,
      detectBinaries: [trimmedCommand],
      builtin: false,
      avatar: { letter, color },
    })

    await this.persist()
    return this.detectAgents()
  }

  async removeCustomAgent(agentId: string): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    this.settings.customAgents = this.settings.customAgents.filter(a => a.id !== agentId)
    delete this.settings.commandOverrides[agentId]
    delete this.settings.lastModelByAgent[agentId]
    delete this.settings.lastThinkingLevelByAgent[agentId]
    if (this.settings.defaultAgentId === agentId)
      this.settings.defaultAgentId = `claude`
    this.detectionCache.delete(agentId)
    await this.persist()
    return this.detectAgents()
  }

  async installAgent(agentId: string): Promise<{ ok: boolean, error?: string }> {
    await this.ensureLoaded()
    const config = this.getAllConfigs().find(a => a.id === agentId)
    if (!config?.installPackage)
      return { ok: false, error: `No install package configured for ${agentId}` }

    if (this.activeInstalls.has(agentId))
      return { ok: false, error: `Installation already in progress` }

    const npmPath = await resolveBinaryOnPath(`npm`, this.pathOverride)
    if (!npmPath)
      return { ok: false, error: `npm was not found on PATH` }

    const commandDisplay = `npm install -g ${config.installPackage}`
    const env = await buildAgentEnv(undefined, this.pathOverride)
    const child = spawnAgentProcess(npmPath, [`install`, `-g`, config.installPackage, `--loglevel=http`], {
      cwd: os.homedir(),
      env,
    })

    const active: ActiveInstall = {
      child,
      cancelled: false,
      progress: {
        percent: 5,
        command: commandDisplay,
        line: commandDisplay,
      },
    }
    this.activeInstalls.set(agentId, active)
    this.emitInstallProgress(agentId, active.progress)
    this.onEvent?.({ type: `agents_changed`, agents: this.buildStatuses() })

    let lineCount = 0
    let settled = false
    const stderrTail: string[] = []
    const handleOutput = (chunk: Buffer | string, isErr: boolean) => {
      if (settled)
        return
      const text = chunk.toString()
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line)
          continue
        lineCount += 1
        if (isErr) {
          stderrTail.push(line)
          if (stderrTail.length > 20)
            stderrTail.shift()
        }
        // npm does not emit deterministic numeric percentages; estimate progress smoothly up to 92%.
        const nextPercent = Math.min(92, Math.max(active.progress.percent, Math.round(8 + (1 - Math.exp(-lineCount / 18)) * 84)))
        active.progress = {
          percent: nextPercent,
          command: commandDisplay,
          line,
        }
        this.emitInstallProgress(agentId, active.progress)
      }
    }

    const onStdout = (chunk: Buffer | string) => handleOutput(chunk, false)
    const onStderr = (chunk: Buffer | string) => handleOutput(chunk, true)
    child.stdout.on(`data`, onStdout)
    child.stderr.on(`data`, onStderr)

    return new Promise((resolve) => {
      const finish = async (ok: boolean, error?: string) => {
        if (settled)
          return
        settled = true
        child.stdout.off(`data`, onStdout)
        child.stderr.off(`data`, onStderr)
        this.activeInstalls.delete(agentId)
        this.emitInstallProgress(
          agentId,
          {
            percent: ok ? 100 : active.progress.percent,
            command: commandDisplay,
            line: error ?? active.progress.line,
          },
          true,
          error,
        )
        await this.detectAgents()
        resolve({ ok, error })
      }

      child.once(`error`, (error) => {
        void finish(false, error.message)
      })

      child.once(`exit`, (code) => {
        if (active.cancelled) {
          void finish(false, `Installation cancelled`)
          return
        }
        if (code === 0) {
          void finish(true)
          return
        }
        const message = stderrTail.slice(-3).join(` `) || `npm exited with code ${code ?? `unknown`}`
        void finish(false, message)
      })
    })
  }

  async cancelInstall(agentId: string): Promise<void> {
    const active = this.activeInstalls.get(agentId)
    if (!active)
      return
    active.cancelled = true
    await terminateProcessTree(active.child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 1_000 })
  }

  async cancelAllInstalls(): Promise<void> {
    await Promise.all([...this.activeInstalls.keys()].map(id => this.cancelInstall(id)))
  }

  private emitInstallProgress(
    agentId: string,
    progress: AcpInstallProgress,
    done = false,
    error?: string,
  ): void {
    this.onEvent?.({
      type: `install_progress`,
      agentId,
      percent: progress.percent,
      command: progress.command,
      line: progress.line,
      done,
      error,
    })
  }
}
