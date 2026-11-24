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
import { migrateLegacyPermissionSettings } from '@md/shared/utils/acp-permissions'
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
]

const CUSTOM_AVATAR_COLORS = [`#5B5BD6`, `#0A9E55`, `#D97757`, `#4C7DF0`, `#7A5AF8`, `#A86500`]

const DEFAULT_SETTINGS: AcpSettings = {
  defaultAgentId: `claude`,
  defaultPermissionLevel: `ask`,
  lastModelByAgent: {},
  customAgents: [],
  commandOverrides: {},
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
  onEvent?: (event: AcpHostEvent) => void
}

export class AcpRegistry {
  private readonly settingsPath: string
  private readonly pathOverride?: string
  private readonly extraBuiltinAgents: AcpAgentConfig[]
  private readonly onEvent?: (event: AcpHostEvent) => void

  private settings: AcpSettings = structuredClone(DEFAULT_SETTINGS)
  private loaded = false
  private detectionCache = new Map<string, { installed: boolean, resolvedPath?: string }>()
  private activeInstalls = new Map<string, ActiveInstall>()

  constructor(options: AcpRegistryOptions) {
    this.settingsPath = options.settingsPath
    this.pathOverride = options.pathOverride
    this.extraBuiltinAgents = options.extraBuiltinAgents ?? []
    this.onEvent = options.onEvent
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded)
      return
    this.loaded = true
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
          : DEFAULT_SETTINGS.defaultAgentId,
        defaultPermissionLevel: level,
        lastModelByAgent: { ...(parsed.lastModelByAgent ?? {}) },
        customAgents: Array.isArray(parsed.customAgents) ? parsed.customAgents : [],
        commandOverrides: { ...(parsed.commandOverrides ?? {}) },
      }
      if (migrated)
        await this.persist().catch(() => undefined)
    }
    catch {
      this.settings = structuredClone(DEFAULT_SETTINGS)
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true })
    const tmpPath = `${this.settingsPath}.${randomUUID()}.tmp`
    await fs.writeFile(tmpPath, `${JSON.stringify(this.settings, null, 2)}\n`, `utf8`)
    await fs.rename(tmpPath, this.settingsPath)
  }

  async getSettings(): Promise<AcpSettings> {
    await this.ensureLoaded()
    return structuredClone(this.settings)
  }

  async updateSettings(patch: Partial<AcpSettings>): Promise<AcpSettings> {
    await this.ensureLoaded()
    this.settings = {
      ...this.settings,
      ...patch,
      lastModelByAgent: patch.lastModelByAgent
        ? { ...this.settings.lastModelByAgent, ...patch.lastModelByAgent }
        : this.settings.lastModelByAgent,
      commandOverrides: patch.commandOverrides
        ? { ...this.settings.commandOverrides, ...patch.commandOverrides }
        : this.settings.commandOverrides,
    }
    await this.persist()
    const agents = await this.listAgents()
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

    const override = this.settings.commandOverrides[agentId]
    if (override && override.command.trim()) {
      return {
        command: override.command.trim(),
        args: override.args,
        env: override.env,
      }
    }

    const pathEnv = this.pathOverride ?? await resolveLoginShellPath()

    // Prefer a globally installed ACP adapter binary directly when available to avoid npx latency.
    if (config.id === `claude`) {
      for (const directBin of [`claude-code-acp`, `claude-agent-acp`]) {
        const resolved = await resolveBinaryOnPath(directBin, pathEnv)
        if (resolved)
          return { command: resolved, args: [], env: config.env }
      }
    }
    else if (config.id === `codex`) {
      const resolved = await resolveBinaryOnPath(`codex-acp`, pathEnv)
      if (resolved)
        return { command: resolved, args: [], env: config.env }
    }

    return {
      command: config.command,
      args: config.args,
      env: config.env,
    }
  }

  async detectAgents(): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    const pathEnv = this.pathOverride ?? await resolveLoginShellPath({ force: true })
    const configs = this.getAllConfigs()

    await Promise.all(
      configs.map(async (config) => {
        const override = this.settings.commandOverrides[config.id]
        const binariesToCheck = override?.command
          ? [override.command]
          : (config.detectBinaries?.length ? config.detectBinaries : [config.command])

        let resolvedPath: string | null = null
        for (const bin of binariesToCheck) {
          resolvedPath = await resolveBinaryOnPath(bin, pathEnv)
          if (resolvedPath)
            break
        }
        this.detectionCache.set(config.id, {
          installed: Boolean(resolvedPath),
          resolvedPath: resolvedPath ?? undefined,
        })
      }),
    )

    const statuses = this.buildStatuses()
    this.onEvent?.({ type: `agents_changed`, agents: statuses })
    return statuses
  }

  async listAgents(): Promise<AcpAgentStatus[]> {
    await this.ensureLoaded()
    if (this.detectionCache.size === 0)
      return this.detectAgents()
    return this.buildStatuses()
  }

  private buildStatuses(): AcpAgentStatus[] {
    const configs = this.getAllConfigs()
    return configs.map((config) => {
      const override = this.settings.commandOverrides[config.id]
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
    const stderrTail: string[] = []
    const handleOutput = (chunk: Buffer | string, isErr: boolean) => {
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

    child.stdout.on(`data`, chunk => handleOutput(chunk, false))
    child.stderr.on(`data`, chunk => handleOutput(chunk, true))

    return new Promise((resolve) => {
      const finish = async (ok: boolean, error?: string) => {
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
