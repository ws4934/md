import type { AcpProbeResult } from '@md/shared/types'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AcpSession } from './session'

const COMMAND_QUIET_WINDOW_MS = 600
const COMMAND_POLL_MS = 25
const MAX_COMMAND_WAIT_MS = 1_500
const DEFAULT_PROBE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface ProbeAgentOptions {
  agentId: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  pathOverride?: string
  commandQuietMs?: number
  initializeTimeoutMs?: number
  sessionNewTimeoutMs?: number
  closeTimeoutMs?: number
}

async function waitForAvailableCommands(
  session: AcpSession,
  quietMs: number,
  maxWaitMs: number,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < maxWaitMs) {
    const updatedAt = session.commandsUpdatedAt
    if (updatedAt !== null && Date.now() - updatedAt >= quietMs)
      return
    if (updatedAt === null && Date.now() - startedAt >= quietMs)
      return
    await new Promise(resolve => setTimeout(resolve, COMMAND_POLL_MS))
  }
}

/**
 * Spawns a short-lived probe process with NO_BROWSER=true to discover models,
 * modes, configOptions, and slash commands, then cleanly shuts it down.
 */
export async function probeAcpAgent(options: ProbeAgentOptions): Promise<AcpProbeResult> {
  const quietMs = options.commandQuietMs ?? COMMAND_QUIET_WINDOW_MS
  const session = new AcpSession({
    agentId: options.agentId,
    command: options.command,
    args: options.args,
    cwd: options.cwd ?? os.homedir(),
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
    await waitForAvailableCommands(session, quietMs, Math.max(quietMs * 2, MAX_COMMAND_WAIT_MS))

    return {
      agentId: options.agentId,
      models: session.models,
      currentModelId: session.currentModelId,
      modes: session.modes,
      currentModeId: session.currentModeId,
      commands: session.commands,
      probedAt: Date.now(),
    }
  }
  finally {
    await session.close()
  }
}

export interface ProbeCacheOptions {
  cachePath?: string
  ttlMs?: number
}

export class ProbeCache {
  private readonly cachePath?: string
  private readonly ttlMs: number
  private cache = new Map<string, AcpProbeResult>()
  private inFlight = new Map<string, Promise<AcpProbeResult>>()
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private persistChain: Promise<void> = Promise.resolve()

  constructor(options: ProbeCacheOptions = {}) {
    this.cachePath = options.cachePath
    this.ttlMs = options.ttlMs ?? DEFAULT_PROBE_CACHE_TTL_MS
  }

  private isFresh(entry: AcpProbeResult | undefined): entry is AcpProbeResult {
    if (!entry || entry.error)
      return false
    return Date.now() - entry.probedAt < this.ttlMs
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.cachePath) {
      this.loaded = true
      return
    }
    this.loadPromise ??= (async () => {
      try {
        const raw = await fs.readFile(this.cachePath!, `utf8`)
        const parsed = JSON.parse(raw) as Record<string, AcpProbeResult>
        if (parsed && typeof parsed === `object`) {
          for (const [agentId, entry] of Object.entries(parsed)) {
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
      const payload: Record<string, AcpProbeResult> = {}
      for (const [agentId, entry] of this.cache.entries()) {
        if (this.isFresh(entry))
          payload[agentId] = entry
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
    const merged: AcpProbeResult = {
      agentId: result.agentId,
      models: result.models.length > 0 ? result.models : (prev?.models ?? []),
      currentModelId: result.currentModelId ?? prev?.currentModelId ?? null,
      modes: result.modes.length > 0 ? result.modes : (prev?.modes ?? []),
      currentModeId: result.currentModeId ?? prev?.currentModeId ?? null,
      commands: result.commands.length > 0 ? result.commands : (prev?.commands ?? []),
      probedAt: result.probedAt || Date.now(),
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
