import type { AcpHostEvent } from '@md/shared/types'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createSafeNdJsonStream } from './ndjson-stream'
import { probeAcpAgent } from './probe'
import { AcpRegistry } from './registry'
import { AcpSession } from './session'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT_SCRIPT = path.resolve(__dirname, `../../../scripts/fake-acp-agent.mjs`)

const tempDirs: string[] = []
const openSessions: AcpSession[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (openSessions.length > 0) {
    const s = openSessions.pop()!
    await s.close()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe(`createSafeNdJsonStream`, () => {
  it(`skips non-JSON lines and normalizes stringified numeric response IDs`, async () => {
    const skipped: string[] = []
    const encoder = new TextEncoder()
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`Loading CLI...\nnot { json\n"bare string"\n`))
        controller.enqueue(encoder.encode(`{"jsonrpc":"2.0","id":"42","result":{"ok":true}}\n`))
        controller.close()
      },
    })
    const output = new WritableStream<Uint8Array>()
    const stream = createSafeNdJsonStream(output, input, {
      onNonJsonLine: line => skipped.push(line),
    })

    const reader = stream.readable.getReader()
    const first = await reader.read()
    const second = await reader.read()

    expect(skipped).toEqual([`Loading CLI...`, `not { json`, `"bare string"`])
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ jsonrpc: `2.0`, id: 42, result: { ok: true } })
    expect(second.done).toBe(true)
  })
})

describe(`acpSession`, () => {
  it(`skips junk stdout lines during a real handshake and prompt`, async () => {
    const cwd = await makeTempDir(`md-acp-junk-`)
    const articlePath = path.join(cwd, `article.md`)
    await fs.writeFile(articlePath, `# Hello`, `utf8`)

    const skippedLines: string[] = []
    const events: AcpHostEvent[] = []
    const session = new AcpSession({
      agentId: `fake`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      articlePath,
      initialArticleContent: `# Hello`,
      env: { FAKE_AGENT_JUNK_STDOUT: `1`, FAKE_AGENT_STRINGIFY_IDS: `1` },
      onNonJsonStdout: line => skippedLines.push(line),
      onEvent: e => events.push(e),
    })
    openSessions.push(session)

    await session.initializeNewSession()
    expect(session.sessionId).toBe(`fake_sess_01`)
    expect(skippedLines.length).toBeGreaterThanOrEqual(2)
  })

  it(`rejects with a hard timeout when child hangs on initialize or session/new`, async () => {
    const cwd = await makeTempDir(`md-acp-hang-`)

    const initHang = new AcpSession({
      agentId: `fake-hang-init`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_HANG_METHOD: `initialize` },
      timeouts: { initializeMs: 200, sessionNewMs: 200, closeMs: 200 },
    })
    openSessions.push(initHang)

    await expect(initHang.initializeNewSession()).rejects.toThrow(/initialize timed out/i)
    expect(initHang.isClosed).toBe(true)

    const newSessionHang = new AcpSession({
      agentId: `fake-hang-new`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_HANG_METHOD: `session/new` },
      timeouts: { initializeMs: 2_000, sessionNewMs: 200, closeMs: 200 },
    })
    openSessions.push(newSessionHang)

    await expect(newSessionHang.initializeNewSession()).rejects.toThrow(/session\/new timed out/i)
    expect(newSessionHang.isClosed).toBe(true)
  })

  it(`buffers early session/update notifications and replays them after session/new`, async () => {
    const cwd = await makeTempDir(`md-acp-early-`)
    const events: AcpHostEvent[] = []

    const session = new AcpSession({
      agentId: `fake-early`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_EARLY_UPDATE: `1` },
      onEvent: e => events.push(e),
    })
    openSessions.push(session)

    await session.initializeNewSession()

    const replayed = events.find(
      e => e.type === `message_chunk` && e.text === `EARLY_UPDATE_MESSAGE`,
    )
    expect(replayed).toBeDefined()
  })

  it(`round-trips session/request_permission and supports auto-accept`, async () => {
    const cwd = await makeTempDir(`md-acp-perm-`)
    const articlePath = path.join(cwd, `article.md`)
    await fs.writeFile(articlePath, `# Draft`, `utf8`)

    const events: AcpHostEvent[] = []
    const session = new AcpSession({
      agentId: `fake-perm`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      articlePath,
      initialArticleContent: `# Draft`,
      env: { FAKE_AGENT_REQUIRE_PERMISSION: `1` },
      shouldAutoAcceptPermission: () => false,
      onEvent: (event) => {
        events.push(event)
        if (event.type === `permission_requested`) {
          expect(event.request.toolKind).toBe(`execute`)
          expect(event.request.command).toContain(`npx mmdc`)
          session.respondPermission(event.request.requestId, `allow_once`)
        }
      },
    })
    openSessions.push(session)

    await session.initializeNewSession()
    const result = await session.prompt([{ type: `text`, text: `Draw diagram` }])
    expect(result.stopReason).toBe(`end_turn`)

    const fullText = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(fullText).toContain(`[permission:opt_allow_once]`)
    expect(events.some(e => e.type === `permission_requested`)).toBe(true)
    expect(events.some(e => e.type === `permission_resolved` && e.decision === `allow_once`)).toBe(true)

    // Now test auto-accept: no permission_requested event is emitted.
    const autoEvents: AcpHostEvent[] = []
    const autoSession = new AcpSession({
      agentId: `fake-auto-perm`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      articlePath,
      initialArticleContent: `# Draft`,
      env: { FAKE_AGENT_REQUIRE_PERMISSION: `1` },
      shouldAutoAcceptPermission: kind => kind === `execute`,
      onEvent: e => autoEvents.push(e),
    })
    openSessions.push(autoSession)

    await autoSession.initializeNewSession()
    await autoSession.prompt([{ type: `text`, text: `Draw diagram` }])
    expect(autoEvents.some(e => e.type === `permission_requested`)).toBe(false)
    const autoText = autoEvents
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(autoText).toContain(`[permission:opt_allow_once]`)
  })

  it(`maps all tool_call kinds and plan updates accurately`, async () => {
    const cwd = await makeTempDir(`md-acp-tools-`)
    const events: AcpHostEvent[] = []

    const session = new AcpSession({
      agentId: `fake-tools`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_ALL_TOOL_KINDS: `1` },
      onEvent: e => events.push(e),
    })
    openSessions.push(session)

    await session.initializeNewSession()
    await session.prompt([{ type: `text`, text: `Emit tools` }])

    const completedTools = events
      .filter((e): e is Extract<AcpHostEvent, { type: `tool_call` }> => e.type === `tool_call` && e.tool.status === `completed`)
      .map(e => e.tool)

    const byId = new Map(completedTools.map(t => [t.id, t]))
    expect(byId.get(`tc-read`)?.toolKind).toBe(`read`)
    expect(byId.get(`tc-read`)?.filePath).toBe(`outline.md`)
    expect(byId.get(`tc-search`)?.toolKind).toBe(`search`)
    expect(byId.get(`tc-search`)?.detail).toBe(`ACP`)
    expect(byId.get(`tc-edit`)?.toolKind).toBe(`edit`)
    expect(byId.get(`tc-edit`)?.oldText).toBe(`old`)
    expect(byId.get(`tc-edit`)?.newText).toBe(`new`)
    expect(byId.get(`tc-delete`)?.toolKind).toBe(`delete`)
    expect(byId.get(`tc-delete`)?.newText).toBe(``)
    expect(byId.get(`tc-execute`)?.toolKind).toBe(`execute`)
    expect(byId.get(`tc-execute`)?.command).toBe(`npx mmdc -i a.mmd -o a.svg`)
    expect(byId.get(`tc-fetch`)?.toolKind).toBe(`fetch`)
    expect(byId.get(`tc-fetch`)?.detail).toBe(`https://agentclientprotocol.com`)
    expect(byId.get(`tc-think`)?.toolKind).toBe(`think`)
    expect(byId.get(`tc-mode`)?.toolKind).toBe(`switch_mode`)
    expect(byId.get(`tc-move`)?.toolKind).toBe(`move`)
  })

  it(`routes open article writes to callback and supports both model switching protocols`, async () => {
    const cwd = await makeTempDir(`md-acp-models-`)
    const articlePath = path.join(cwd, `article.md`)
    await fs.writeFile(articlePath, `# Original`, `utf8`)

    const writes: Array<{ base: string, proposed: string }> = []
    const session = new AcpSession({
      agentId: `fake-models`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      articlePath,
      initialArticleContent: `# Original`,
      env: { FAKE_AGENT_MODEL_STYLE: `models` },
      onArticleWrite: (base, proposed) => writes.push({ base, proposed }),
    })
    openSessions.push(session)

    await session.initializeNewSession()
    expect(session.models.map(m => m.id)).toEqual([`opus-5.5`, `sonnet-5.5`, `haiku-5.5`])
    await session.setModel(`sonnet-5.5`)
    expect(session.currentModelId).toBe(`sonnet-5.5`)

    await session.prompt([{ type: `text`, text: `Update article` }])
    expect(writes).toHaveLength(1)
    expect(writes[0].base).toBe(`# Original`)
    expect(writes[0].proposed).toContain(`sonnet-5.5`)

    // Also verify configOptions-based model switching.
    const cfgSession = new AcpSession({
      agentId: `fake-config-models`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_MODEL_STYLE: `configOptions` },
    })
    openSessions.push(cfgSession)

    await cfgSession.initializeNewSession()
    expect(cfgSession.models.map(m => m.id)).toEqual([`opus-5.5`, `sonnet-5.5`, `haiku-5.5`])
    const switched = await cfgSession.setModel(`haiku-5.5`)
    expect(switched.modelId).toBe(`haiku-5.5`)
  })
})

describe(`probeAcpAgent and AcpRegistry`, () => {
  it(`probes models, modes, and available commands then closes cleanly`, async () => {
    const cwd = await makeTempDir(`md-acp-probe-`)
    const result = await probeAcpAgent({
      agentId: `fake-probe`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: {
        FAKE_AGENT_MODEL_STYLE: `both`,
        FAKE_AGENT_EMIT_COMMANDS: `1`,
      },
      commandQuietMs: 120,
    })

    expect(result.models.length).toBe(3)
    expect(result.currentModelId).toBe(`opus-5.5`)
    expect(result.commands.map(c => c.name)).toEqual([`outline`, `polish`])
  })

  it(`detects binaries on PATH and persists custom agents & settings`, async () => {
    const dir = await makeTempDir(`md-acp-reg-`)
    const binDir = path.join(dir, `bin`)
    await fs.mkdir(binDir, { recursive: true })

    const fakeGemini = path.join(binDir, process.platform === `win32` ? `gemini.cmd` : `gemini`)
    await fs.writeFile(fakeGemini, `#!/bin/sh\necho ok\n`, { mode: 0o755 })

    const registry = new AcpRegistry({
      settingsPath: path.join(dir, `acp-settings.json`),
      pathOverride: binDir,
    })

    const detected = await registry.detectAgents()
    expect(detected.find(a => a.id === `gemini`)?.installed).toBe(true)
    expect(detected.find(a => a.id === `qwen`)?.installed).toBe(false)

    await registry.updateSettings({ reviewEditsBeforeWriting: false })
    const afterAdd = await registry.addCustomAgent({
      name: `My Local Agent`,
      command: fakeGemini,
      args: [`--acp`],
    })
    const custom = afterAdd.find(a => a.name === `My Local Agent`)
    expect(custom).toBeDefined()
    expect(custom?.installed).toBe(true)

    // Reload from disk to verify persistence.
    const reloaded = new AcpRegistry({
      settingsPath: path.join(dir, `acp-settings.json`),
      pathOverride: binDir,
    })
    const settings = await reloaded.getSettings()
    expect(settings.reviewEditsBeforeWriting).toBe(false)
    expect(settings.customAgents).toHaveLength(1)
  })

  it(`streams npm install progress and supports cancellation`, async () => {
    const dir = await makeTempDir(`md-acp-install-`)
    const binDir = path.join(dir, `bin`)
    await fs.mkdir(binDir, { recursive: true })

    // Create a fake npm executable that emits progress lines and waits so cancel can interrupt it.
    const fakeNpm = path.join(binDir, `npm`)
    await fs.writeFile(
      fakeNpm,
      `#!/bin/sh\necho "http fetch GET 200 https://registry.npmjs.org/@google/gemini-cli"\necho "idealTree buildDeps"\nsleep 10\n`,
      { mode: 0o755 },
    )

    const progressEvents: Array<Extract<AcpHostEvent, { type: `install_progress` }>> = []
    let cancelTriggered = false
    const registry = new AcpRegistry({
      settingsPath: path.join(dir, `acp-settings.json`),
      pathOverride: `${binDir}${path.delimiter}${process.env.PATH ?? ``}`,
      onEvent: (event) => {
        if (event.type === `install_progress`) {
          progressEvents.push(event)
          if (!cancelTriggered && event.percent > 5 && !event.done) {
            cancelTriggered = true
            void registry.cancelInstall(`gemini`)
          }
        }
      },
    })

    const result = await registry.installAgent(`gemini`)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cancel/i)
    expect(progressEvents.length).toBeGreaterThanOrEqual(2)
    expect(progressEvents.some(e => e.command.includes(`@google/gemini-cli`))).toBe(true)
    expect(progressEvents.some(e => e.done)).toBe(true)
  })

  it(`closes cleanly within close timeout even if child hangs on session/close`, async () => {
    const cwd = await makeTempDir(`md-acp-close-hang-`)
    const session = new AcpSession({
      agentId: `fake-hang-close`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_HANG_METHOD: `session/close` },
      timeouts: { initializeMs: 2_000, sessionNewMs: 2_000, closeMs: 200 },
    })
    openSessions.push(session)

    await session.initializeNewSession()
    const startedAt = Date.now()
    await session.close()
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(session.isClosed).toBe(true)
  })
})
