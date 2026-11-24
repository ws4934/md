import type { AcpProbeResult } from '@md/shared/types'
import os from 'node:os'
import { AcpSession } from './session'

const COMMAND_QUIET_WINDOW_MS = 600
const COMMAND_POLL_MS = 25
const MAX_COMMAND_WAIT_MS = 1_500

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

export class ProbeCache {
  private cache = new Map<string, AcpProbeResult>()
  private inFlight = new Map<string, Promise<AcpProbeResult>>()

  get(agentId: string): AcpProbeResult | undefined {
    return this.cache.get(agentId)
  }

  invalidate(agentId?: string): void {
    if (agentId)
      this.cache.delete(agentId)
    else
      this.cache.clear()
  }

  async probe(
    options: ProbeAgentOptions,
    cacheOptions: { force?: boolean } = {},
  ): Promise<AcpProbeResult> {
    if (!cacheOptions.force) {
      const existing = this.cache.get(options.agentId)
      if (existing && !existing.error)
        return existing
    }

    const pending = this.inFlight.get(options.agentId)
    if (pending)
      return pending

    const task = probeAcpAgent(options)
      .then((result) => {
        this.cache.set(options.agentId, result)
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
