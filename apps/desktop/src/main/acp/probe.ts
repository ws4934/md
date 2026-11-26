import type { AcpProbeResult } from '@md/shared/types'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hasVariantModels } from '@md/shared/utils/acp-thinking'
import { AcpSession } from './session'

const COMMAND_QUIET_WINDOW_MS = 600
const COMMAND_POLL_MS = 25
const MAX_COMMAND_WAIT_MS = 1_500
// Agents may announce commands well after `session/new`; wait this many quiet windows for the first batch.
const FIRST_COMMANDS_WAIT_FACTOR = 5
const DEFAULT_PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
// A probe that never saw `available_commands_update` may have just been too early; retry it sooner.
const COMMANDS_PENDING_TTL_MS = 5 * 60 * 1000
// Bump when cached probe metadata changes shape or meaning (v3: commands come from probes only).
const PROBE_CACHE_SCHEMA_VERSION = 3

interface PersistedProbeCache {
  schemaVersion: number
  appVersion?: string
  entries: Record<string, AcpProbeResult>
}

export interface ProbeAgentOptions {
  agentId: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  /** Per-probe workspace, created before spawning and disposed after the probe closes (overrides `cwd`). */
  workspace?: {
    /** `complete: false` marks the result's commands as possibly incomplete (e.g. skills failed to install). */
    create: () => Promise<{ dir: string, complete: boolean }>
    dispose: (dir: string) => Promise<void>
  }
  pathOverride?: string
  commandQuietMs?: number
  initializeTimeoutMs?: number
  sessionNewTimeoutMs?: number
  closeTimeoutMs?: number
}

async function waitForAvailableCommands(
  session: AcpSession,
  quietMs: number,
  firstWaitMs: number,
  settleMaxMs: number,
): Promise<void> {
  const sleep = () => new Promise(resolve => setTimeout(resolve, COMMAND_POLL_MS))
  const startedAt = Date.now()
  while (session.commandsUpdatedAt === null) {
    if (Date.now() - startedAt >= firstWaitMs)
      return
    await sleep()
  }
  // Commands may arrive in several batches; settle once the stream goes quiet.
  const settleStartedAt = Date.now()
  while (Date.now() - settleStartedAt < settleMaxMs) {
    if (Date.now() - (session.commandsUpdatedAt ?? 0) >= quietMs)
      return
    await sleep()
  }
}

/**
 * Spawns a short-lived probe process with NO_BROWSER=true to discover models,
 * modes, configOptions, and slash commands, then cleanly shuts it down.
 */
export async function probeAcpAgent(options: ProbeAgentOptions): Promise<AcpProbeResult> {
  const quietMs = options.commandQuietMs ?? COMMAND_QUIET_WINDOW_MS
  const workspace = options.workspace ? await options.workspace.create() : null
  const workspaceDir = workspace?.dir ?? null
  const session = new AcpSession({
    agentId: options.agentId,
    command: options.command,
    args: options.args,
    cwd: workspaceDir ?? options.cwd ?? os.homedir(),
    env: {
      // Prevent agents like Gemini CLI from launching an interactive browser auth flow during probe.
      NO_BROWSER: `true`,
      ...options.env,
    },
    pathOverride: options.pathOverride,
    timeouts: {
      initializeMs: options.initializeTimeoutMs ?? 15_000,
      sessionNewMs: options.sessionNewTimeoutMs ?? 15_000,
      closeMs: options.closeTimeoutMs ?? 2_000,
    },
  })

  try {
    await session.initializeNewSession()
    await waitForAvailableCommands(session, quietMs, quietMs * FIRST_COMMANDS_WAIT_FACTOR, Math.max(quietMs * 2, MAX_COMMAND_WAIT_MS))

    return {
      agentId: options.agentId,
      models: session.models,
      currentModelId: session.currentModelId,
      thinkingOptions: session.thinkingOptions,
      currentThinkingLevel: session.currentThinkingLevel,
      modes: session.modes,
      currentModeId: session.currentModeId,
      commands: session.commands,
      commandsAnnounced: session.commandsUpdatedAt !== null && workspace?.complete !== false,
      probedAt: Date.now(),
    }
  }
  finally {
    await session.close()
    if (workspaceDir)
      await options.workspace!.dispose(workspaceDir)
  }
}

export interface ProbeCacheOptions {
  cachePath?: string
  ttlMs?: number
  /** Cache identity (app version plus bundled-skills fingerprint); persisted entries from another identity are dropped. */
  appVersion?: string
}

export class ProbeCache {
  private readonly cachePath?: string
  private readonly ttlMs: number
  private readonly appVersion?: string
  private cache = new Map<string, AcpProbeResult>()
  private inFlight = new Map<string, Promise<AcpProbeResult>>()
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private persistChain: Promise<void> = Promise.resolve()

  constructor(options: ProbeCacheOptions = {}) {
    this.cachePath = options.cachePath
    this.ttlMs = options.ttlMs ?? DEFAULT_PROBE_CACHE_TTL_MS
    this.appVersion = options.appVersion
  }

  private isFresh(entry: AcpProbeResult | undefined): entry is AcpProbeResult {
    if (!entry || entry.error)
      return false
    const ttlMs = entry.commandsAnnounced === false ? Math.min(this.ttlMs, COMMANDS_PENDING_TTL_MS) : this.ttlMs
    return Date.now() - entry.probedAt < ttlMs
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.cachePath) {
      this.loaded = true
      return
    }
    this.loadPromise ??= (async () => {
      try {
        const raw = await fs.readFile(this.cachePath!, `utf8`)
        const parsed = JSON.parse(raw) as Partial<PersistedProbeCache>
        if (
          parsed
          && typeof parsed === `object`
          && parsed.schemaVersion === PROBE_CACHE_SCHEMA_VERSION
          && parsed.appVersion === this.appVersion
          && parsed.entries
          && typeof parsed.entries === `object`
        ) {
          for (const [agentId, entry] of Object.entries(parsed.entries)) {
            if (entry && typeof entry === `object` && this.isFresh(entry) && !this.cache.has(agentId))
              this.cache.set(agentId, entry)
          }
        }
      }
      catch {
        // Missing or unreadable probe cache is non-fatal.
      }
      finally {
        this.loaded = true
      }
    })()
    await this.loadPromise
  }

  private schedulePersist(): void {
    if (!this.cachePath)
      return
    const targetPath = this.cachePath
    this.persistChain = this.persistChain.then(async () => {
      const entries: Record<string, AcpProbeResult> = {}
      for (const [agentId, entry] of this.cache.entries()) {
        if (this.isFresh(entry))
          entries[agentId] = entry
      }
      const payload: PersistedProbeCache = {
        schemaVersion: PROBE_CACHE_SCHEMA_VERSION,
        appVersion: this.appVersion,
        entries,
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      const tmpPath = `${targetPath}.${randomUUID()}.tmp`
      await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, `utf8`)
      await fs.rename(tmpPath, targetPath)
    }).catch(() => undefined)
  }

  get(agentId: string): AcpProbeResult | undefined {
    const existing = this.cache.get(agentId)
    return this.isFresh(existing) ? existing : undefined
  }

  /**
   * Feeds discovered metadata (e.g. from `startSession`) into the probe cache so
   * subsequent agent picker opens avoid spawning a redundant probe process.
   */
  seed(result: AcpProbeResult): void {
    if (result.error)
      return
    const prev = this.cache.get(result.agentId)
    const models = result.models.length > 0 ? result.models : (prev?.models ?? [])
    const thinkingOptions = hasVariantModels(models)
      ? []
      : (result.thinkingOptions && result.thinkingOptions.length > 0
          ? result.thinkingOptions
          : prev?.thinkingOptions)
    // `commandsAnnounced: false` with no commands (e.g. a session start) means "commands unknown":
    // keep the previous list and never extend a pending entry's short TTL.
    const commandsKnown = result.commandsAnnounced !== false || result.commands.length > 0
    const merged: AcpProbeResult = {
      agentId: result.agentId,
      models,
      currentModelId: result.currentModelId ?? prev?.currentModelId ?? null,
      thinkingOptions,
      currentThinkingLevel: result.currentThinkingLevel ?? prev?.currentThinkingLevel ?? null,
      modes: result.modes.length > 0 ? result.modes : (prev?.modes ?? []),
      currentModeId: result.currentModeId ?? prev?.currentModeId ?? null,
      commands: commandsKnown ? result.commands : (prev?.commands ?? []),
      commandsAnnounced: commandsKnown ? result.commandsAnnounced : (prev?.commandsAnnounced ?? false),
      probedAt: !commandsKnown && prev?.commandsAnnounced === false ? prev.probedAt : (result.probedAt || Date.now()),
    }
    this.cache.set(result.agentId, merged)
    this.schedulePersist()
  }

  invalidate(agentId?: string): void {
    if (agentId)
      this.cache.delete(agentId)
    else
      this.cache.clear()
    this.schedulePersist()
  }

  async flush(): Promise<void> {
    await this.persistChain
  }

  async probe(
    options: ProbeAgentOptions,
    cacheOptions: { force?: boolean } = {},
  ): Promise<AcpProbeResult> {
    await this.ensureLoaded()

    if (!cacheOptions.force) {
      const existing = this.cache.get(options.agentId)
      if (this.isFresh(existing))
        return existing
    }

    const pending = this.inFlight.get(options.agentId)
    if (pending)
      return pending

    const task = probeAcpAgent(options)
      .then((result) => {
        this.cache.set(options.agentId, result)
        this.schedulePersist()
        return result
      })
      .catch((error) => {
        const failed: AcpProbeResult = {
          agentId: options.agentId,
          models: [],
          currentModelId: null,
          modes: [],
          currentModeId: null,
          commands: [],
          probedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
        return failed
      })
      .finally(() => {
        this.inFlight.delete(options.agentId)
      })

    this.inFlight.set(options.agentId, task)
    return task
  }
}
