import type { AcpAgentConfig, AcpHostEvent, AcpPermissionLevel, AcpToolKind } from '@md/shared/types'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  clampAgentModePermissionLevel,
  evaluatePermissionPolicy,
  getCustomExtraModes,
  mapAcpModeIdToPermissionLevel,
  mapPermissionLevelToAcpModeId,
  migrateLegacyPermissionSettings,
} from '@md/shared/utils/acp-permissions'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpEventBatcher } from './event-batcher'
import { AcpHost, buildPromptText } from './host'
import { createSafeNdJsonStream } from './ndjson-stream'
import { probeAcpAgent, ProbeCache } from './probe'
import { AcpRegistry } from './registry'
import { AcpSession, appendUtf8RingChunk, decodeUtf8Ring, DEFAULT_CLIENT_CAPABILITIES } from './session'
import { buildPermissionResponse, mergeToolCallSnapshot, resolveCurrentModelFromConfigOptions, selectAutoAcceptOption } from './translator'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT_SCRIPT = path.resolve(__dirname, `../../../scripts/fake-acp-agent.mjs`)

const tempDirs: string[] = []
const openSessions: AcpSession[] = []
const openHosts: AcpHost[] = []

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
  while (openHosts.length > 0) {
    const h = openHosts.pop()!
    await h.dispose()
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
  it(`defaults clientCapabilities.fs to readTextFile/writeTextFile false with terminal true`, async () => {
    expect(DEFAULT_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: true,
    })

    const cwd = await makeTempDir(`md-acp-caps-`)
    const session = new AcpSession({
      agentId: `fake-caps`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
    })
    openSessions.push(session)

    await session.initializeNewSession()
    expect(session.initializeMeta?.receivedClientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: true,
    })
  })

  it(`skips junk stdout lines during a real handshake and prompt`, async () => {
    const cwd = await makeTempDir(`md-acp-junk-`)
    const skippedLines: string[] = []
    const session = new AcpSession({
      agentId: `fake`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_JUNK_STDOUT: `1`, FAKE_AGENT_STRINGIFY_IDS: `1` },
      onNonJsonStdout: line => skippedLines.push(line),
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

  it(`round-trips session/request_permission with diff content and supports auto-accept by kind`, async () => {
    const cwd = await makeTempDir(`md-acp-perm-`)
    await fs.writeFile(path.join(cwd, `article.md`), `# Draft`, `utf8`)

    const events: AcpHostEvent[] = []
    const session = new AcpSession({
      agentId: `fake-perm`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_REQUIRE_PERMISSION: `1` },
      resolveAutoPermission: () => `ask`,
      onEvent: (event) => {
        events.push(event)
        if (event.type === `permission_requested`)
          session.respondPermission(event.request.requestId, `allow_once`)
      },
    })
    openSessions.push(session)

    await session.initializeNewSession()
    const result = await session.prompt([{ type: `text`, text: `Draw diagram` }])
    expect(result.stopReason).toBe(`end_turn`)

    const permRequests = events
      .filter((e): e is Extract<AcpHostEvent, { type: `permission_requested` }> => e.type === `permission_requested`)
      .map(e => e.request)
    expect(permRequests.map(r => r.toolKind)).toEqual([`edit`, `execute`])
    expect(permRequests[0].oldText).toBeUndefined()
    expect(permRequests[0].newText).toBeUndefined()
    expect(permRequests[0].unifiedDiff).toContain(`ACP 协作示例`)
    expect(permRequests[0].diffStats?.hasChanges).toBe(true)
    expect(permRequests[1].command).toContain(`npx mmdc`)

    const fullText = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(fullText).toContain(`[permission:opt_allow_once]`)
  })

  it(`maps all tool_call kinds accurately`, async () => {
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
    expect(byId.get(`tc-edit`)?.oldText).toBeUndefined()
    expect(byId.get(`tc-edit`)?.newText).toBeUndefined()
    expect(byId.get(`tc-edit`)?.unifiedDiff).toBe(`-old\n+new`)
    expect(byId.get(`tc-edit`)?.diffStats).toEqual({ added: 1, removed: 1, hasChanges: true })
    expect(byId.get(`tc-delete`)?.toolKind).toBe(`delete`)
    expect(byId.get(`tc-execute`)?.toolKind).toBe(`execute`)
    expect(byId.get(`tc-execute`)?.command).toBe(`npx mmdc -i a.mmd -o a.svg`)
    expect(byId.get(`tc-fetch`)?.toolKind).toBe(`fetch`)
    expect(byId.get(`tc-fetch`)?.detail).toBe(`https://agentclientprotocol.com`)
    expect(byId.get(`tc-think`)?.toolKind).toBe(`think`)
    expect(byId.get(`tc-mode`)?.toolKind).toBe(`switch_mode`)
    expect(byId.get(`tc-move`)?.toolKind).toBe(`move`)
  })

  it(`supports both unstable session/set_model and configOptions model switching`, async () => {
    const cwd = await makeTempDir(`md-acp-models-`)
    await fs.writeFile(path.join(cwd, `article.md`), `# Original`, `utf8`)

    const session = new AcpSession({
      agentId: `fake-models`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd,
      env: { FAKE_AGENT_MODEL_STYLE: `models`, FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0` },
    })
    openSessions.push(session)

    await session.initializeNewSession()
    expect(session.models.map(m => m.id)).toEqual([`opus-5.5`, `sonnet-5.5`, `haiku-5.5`])
    await session.setModel(`sonnet-5.5`)
    expect(session.currentModelId).toBe(`sonnet-5.5`)

    await session.prompt([{ type: `text`, text: `Update article` }])
    const written = await fs.readFile(path.join(cwd, `article.md`), `utf8`)
    expect(written).toContain(`sonnet-5.5`)

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

describe(`acpHost permission levels, ACP modes & article disk sync`, () => {
  it(`enforces the client permission policy matrix across every level and tool kind`, () => {
    const toolKinds: AcpToolKind[] = [
      `read`,
      `search`,
      `think`,
      `edit`,
      `delete`,
      `move`,
      `execute`,
      `fetch`,
      `switch_mode`,
      `other`,
    ]

    const matrix = (level: AcpPermissionLevel, agentHasPlanMode = false) =>
      Object.fromEntries(
        toolKinds.map(kind => [kind, evaluatePermissionPolicy(level, kind, { agentHasPlanMode })]),
      )

    expect(matrix(`ask`)).toEqual({
      read: `allow`,
      search: `allow`,
      think: `allow`,
      edit: `ask`,
      delete: `ask`,
      move: `ask`,
      execute: `ask`,
      fetch: `ask`,
      switch_mode: `ask`,
      other: `ask`,
    })

    expect(matrix(`auto_edits`)).toEqual({
      read: `allow`,
      search: `allow`,
      think: `allow`,
      edit: `allow`,
      delete: `allow`,
      move: `allow`,
      execute: `ask`,
      fetch: `ask`,
      switch_mode: `ask`,
      other: `ask`,
    })

    expect(matrix(`plan`, false)).toEqual({
      read: `allow`,
      search: `allow`,
      think: `allow`,
      edit: `reject`,
      delete: `reject`,
      move: `reject`,
      execute: `reject`,
      fetch: `ask`,
      switch_mode: `ask`,
      other: `ask`,
    })

    expect(matrix(`plan`, true)).toEqual({
      read: `allow`,
      search: `allow`,
      think: `allow`,
      edit: `ask`,
      delete: `ask`,
      move: `ask`,
      execute: `ask`,
      fetch: `ask`,
      switch_mode: `ask`,
      other: `ask`,
    })

    expect(matrix(`bypass`)).toEqual({
      read: `allow`,
      search: `allow`,
      think: `allow`,
      edit: `allow`,
      delete: `allow`,
      move: `allow`,
      execute: `allow`,
      fetch: `allow`,
      switch_mode: `allow`,
      other: `allow`,
    })
  })

  it(`switches ACP modes via session/set_mode, reflects current_mode_update, and enforces per-session permissions`, async () => {
    const dataDir = await makeTempDir(`md-acp-host-perm-`)
    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-claude-modes`,
          name: `Fake Claude Modes`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_PERMISSION: `1`,
            FAKE_AGENT_MODES_STYLE: `claude`,
            FAKE_AGENT_EXTRA_MODES: `1`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `F`, color: `#5B5BD6` },
        },
        {
          id: `fake-no-modes`,
          name: `Fake No Modes`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_PERMISSION: `1`,
            FAKE_AGENT_MODES_STYLE: `none`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `N`, color: `#5B5BD6` },
        },
        {
          id: `fake-push-mode`,
          name: `Fake Push Mode`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_REQUIRE_PERMISSION: `1`,
            FAKE_AGENT_MODES_STYLE: `claude`,
            FAKE_AGENT_PUSH_MODE: `bypassPermissions`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `P`, color: `#5B5BD6` },
        },
        {
          id: `fake-push-restrict`,
          name: `Fake Push Restrict`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_MODES_STYLE: `claude`,
            FAKE_AGENT_PUSH_MODE: `plan`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `R`, color: `#5B5BD6` },
        },
        {
          id: `fake-init-bypass`,
          name: `Fake Init Bypass`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_REQUIRE_PERMISSION: `1`,
            FAKE_AGENT_MODES_STYLE: `claude`,
            FAKE_AGENT_INITIAL_MODE: `bypassPermissions`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `B`, color: `#5B5BD6` },
        },
        {
          id: `fake-early-mode`,
          name: `Fake Early Mode`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_MODES_STYLE: `claude`,
            FAKE_AGENT_EARLY_MODE_UPDATE: `default`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `E`, color: `#5B5BD6` },
        },
        {
          id: `fake-custom-readonly`,
          name: `Fake Custom Readonly`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_MODEL_STYLE: `models`,
            FAKE_AGENT_MODES_STYLE: `custom_only`,
            FAKE_AGENT_INITIAL_MODE: `deep_review`,
            FAKE_AGENT_REJECT_SET_MODE: `1`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `C`, color: `#5B5BD6` },
        },
      ],
      onEvent: (event) => {
        events.push(event)
        if (event.type === `permission_requested`)
          host.respondPermission({ sessionId: event.sessionId, requestId: event.request.requestId, decision: `allow_once` })
      },
    })
    openHosts.push(host)

    // 1. Agent supporting modes: auto_edits switches ACP mode to acceptEdits, auto-allows edit, still asks for execute.
    const started = await host.startSession({
      agentId: `fake-claude-modes`,
      permissionLevel: `auto_edits`,
      postId: `p1`,
      postTitle: `Title`,
      content: `# Hello`,
    })
    expect(started.currentModeId).toBe(`acceptEdits`)
    expect(started.permissionLevel).toBe(`auto_edits`)
    expect(getCustomExtraModes(started.modes).map(m => m.id)).toEqual([`deep_review`])
    expect(mapPermissionLevelToAcpModeId(`plan`, started.modes)).toBe(`plan`)
    expect(mapAcpModeIdToPermissionLevel(`bypassPermissions`)).toBe(`bypass`)

    await host.prompt({
      sessionId: started.sessionId,
      text: `Edit and run command`,
      content: `# Hello`,
      postTitle: `Title`,
    })
    const promptedAutoEdits = events
      .filter((e): e is Extract<AcpHostEvent, { type: `permission_requested` }> => e.type === `permission_requested`)
      .map(e => e.request.toolKind)
    expect(promptedAutoEdits).toEqual([`execute`])

    // 2. Switching live session to bypass calls session/set_mode("bypassPermissions") and never prompts.
    events.length = 0
    const bypassed = await host.setPermissionMode({
      sessionId: started.sessionId,
      permissionLevel: `bypass`,
    })
    expect(bypassed).toEqual({ permissionLevel: `bypass`, modeId: `bypassPermissions` })

    await host.prompt({
      sessionId: started.sessionId,
      text: `Edit and run without prompts`,
      content: `# Hello 2`,
      postTitle: `Title`,
    })
    expect(events.filter(e => e.type === `permission_requested`)).toHaveLength(0)

    const allMessageText = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(allMessageText).toContain(`[modes:acceptEdits,bypassPermissions]`)

    // 3. Switching to a custom extra mode calls session/set_mode with that modeId and defaults client policy to ask.
    const custom = await host.setPermissionMode({
      sessionId: started.sessionId,
      modeId: `deep_review`,
    })
    expect(custom).toEqual({ permissionLevel: `ask`, modeId: `deep_review` })

    // 4. Plan mode on an agent WITHOUT a plan mode auto-rejects edit and execute without prompting.
    events.length = 0
    const noModeSess = await host.startSession({
      agentId: `fake-no-modes`,
      permissionLevel: `plan`,
      postId: `p2`,
      postTitle: `Plan Only`,
      content: `# Original Plan Content`,
    })
    expect(noModeSess.modes).toEqual([])
    await host.prompt({
      sessionId: noModeSess.sessionId,
      text: `Try edit and execute in plan mode`,
      content: `# Original Plan Content`,
      postTitle: `Plan Only`,
    })
    expect(events.filter(e => e.type === `permission_requested`)).toHaveLength(0)
    expect(events.filter(e => e.type === `article_synced`)).toHaveLength(0)
    const planText = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(planText).toContain(`[permission:opt_reject_once]`)

    // 5. Agent-initiated current_mode_update cannot escalate permissions from ask -> bypass;
    //    subsequent execute permission requests must still be surfaced to UI.
    expect(clampAgentModePermissionLevel(`ask`, `bypass`)).toBe(`ask`)
    expect(clampAgentModePermissionLevel(`ask`, `auto_edits`)).toBe(`ask`)
    expect(clampAgentModePermissionLevel(`ask`, `plan`)).toBe(`plan`)
    expect(clampAgentModePermissionLevel(`auto_edits`, `bypass`)).toBe(`auto_edits`)
    expect(clampAgentModePermissionLevel(`bypass`, `ask`)).toBe(`ask`)
    expect(clampAgentModePermissionLevel(`bypass`, null)).toBe(`ask`)
    expect(clampAgentModePermissionLevel(`plan`, null)).toBe(`plan`)

    events.length = 0
    const pushSess = await host.startSession({
      agentId: `fake-push-mode`,
      permissionLevel: `ask`,
      postId: `p3`,
      postTitle: `Push Mode`,
      content: `# Push`,
    })
    // Turn 1: agent emits current_mode_update("bypassPermissions") during the turn.
    await host.prompt({
      sessionId: pushSess.sessionId,
      text: `Trigger mode escalation`,
      content: `# Push`,
      postTitle: `Push Mode`,
    })
    const modeChanged = events.find(
      (e): e is Extract<AcpHostEvent, { type: `mode_changed` }> =>
        e.type === `mode_changed` && e.modeId === `bypassPermissions`,
    )
    expect(modeChanged?.permissionLevel).toBe(`ask`)

    // Turn 2: next execute permission request must STILL be surfaced to UI (not auto-approved).
    events.length = 0
    await host.prompt({
      sessionId: pushSess.sessionId,
      text: `Run command after attempted escalation`,
      content: `# Push 2`,
      postTitle: `Push Mode`,
    })
    const promptedAfterEscalation = events
      .filter((e): e is Extract<AcpHostEvent, { type: `permission_requested` }> => e.type === `permission_requested`)
      .map(e => e.request.toolKind)
    expect(promptedAfterEscalation).toEqual([`execute`])

    // 6. Agent-initiated current_mode_update MAY tighten permissions (ask -> plan).
    events.length = 0
    const restrictSess = await host.startSession({
      agentId: `fake-push-restrict`,
      permissionLevel: `ask`,
      postId: `p4`,
      postTitle: `Push Restrict`,
      content: `# Restrict`,
    })
    await host.prompt({
      sessionId: restrictSess.sessionId,
      text: `Switch to plan`,
      content: `# Restrict`,
      postTitle: `Push Restrict`,
    })
    const restrictedEvent = events.find(
      (e): e is Extract<AcpHostEvent, { type: `mode_changed` }> =>
        e.type === `mode_changed` && e.modeId === `plan`,
    )
    expect(restrictedEvent?.permissionLevel).toBe(`plan`)

    // 7. Agent advertising initial currentModeId="bypassPermissions" cannot override user's `ask` level.
    events.length = 0
    const initBypassSess = await host.startSession({
      agentId: `fake-init-bypass`,
      permissionLevel: `ask`,
      postId: `p5`,
      postTitle: `Init Bypass`,
      content: `# Init`,
    })
    expect(initBypassSess.permissionLevel).toBe(`ask`)
    expect(initBypassSess.currentModeId).toBe(`default`)
    await host.prompt({
      sessionId: initBypassSess.sessionId,
      text: `Run command under ask`,
      content: `# Init`,
      postTitle: `Init Bypass`,
    })
    expect(events.filter(e => e.type === `permission_requested`).map(e => e.request.toolKind)).toEqual([`execute`])

    // 8. Early startup current_mode_update("default") during session/new must not clobber user's requested `bypass`.
    const earlyModeSess = await host.startSession({
      agentId: `fake-early-mode`,
      permissionLevel: `bypass`,
      postId: `p6`,
      postTitle: `Early Mode`,
      content: `# Early`,
    })
    expect(earlyModeSess.permissionLevel).toBe(`bypass`)
    expect(earlyModeSess.currentModeId).toBe(`bypassPermissions`)

    // 9. Explicit canonical permissionLevel on an agent stuck in an unmapped custom mode clears modeId
    //    (so custom mode never masks `bypass` in UI) and tolerates read-only session/set_mode rejection.
    const customReadonlySess = await host.startSession({
      agentId: `fake-custom-readonly`,
      permissionLevel: `bypass`,
      modeId: null,
      postId: `p7`,
      postTitle: `Custom Readonly`,
      content: `# Custom`,
    })
    expect(customReadonlySess.permissionLevel).toBe(`bypass`)
    expect(customReadonlySess.currentModeId).toBeNull()

    const switchedLevel = await host.setPermissionMode({
      sessionId: customReadonlySess.sessionId,
      permissionLevel: `plan`,
      modeId: null,
    })
    expect(switchedLevel).toEqual({ permissionLevel: `plan`, modeId: null })
  })

  it(`syncs article back to editor on completed edit tool call and at turn end`, async () => {
    const dataDir = await makeTempDir(`md-acp-host-sync-`)
    const syncedEvents: Array<Extract<AcpHostEvent, { type: `article_synced` }>> = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-edit`,
          name: `Fake Edit`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: { FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0` },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `F`, color: `#5B5BD6` },
        },
        {
          id: `fake-direct`,
          name: `Fake Direct`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: { FAKE_AGENT_DIRECT_WRITE_ONLY: `1` },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `D`, color: `#5B5BD6` },
        },
      ],
      onEvent: (event) => {
        if (event.type === `article_synced`)
          syncedEvents.push(event)
      },
    })
    openHosts.push(host)

    // 1. Completed edit tool call syncs article once (turn-end read sees unchanged content -> no duplicate).
    const s1 = await host.startSession({
      agentId: `fake-edit`,
      postId: `post-1`,
      postTitle: `Sync Test`,
      content: `# Initial`,
    })
    await host.prompt({
      sessionId: s1.sessionId,
      text: `Edit the article`,
      content: `# Initial`,
      postTitle: `Sync Test`,
    })
    expect(syncedEvents).toHaveLength(1)
    expect(syncedEvents[0].postId).toBe(`post-1`)
    expect(syncedEvents[0].content).toContain(`ACP 协作示例`)

    // 2. Direct write without an edit tool call is still picked up by the turn-end read.
    syncedEvents.length = 0
    const s2 = await host.startSession({
      agentId: `fake-direct`,
      postId: `post-2`,
      postTitle: `Direct Test`,
      content: `# Base`,
    })
    await host.prompt({
      sessionId: s2.sessionId,
      text: `Write directly`,
      content: `# Base`,
      postTitle: `Direct Test`,
    })
    expect(syncedEvents).toHaveLength(1)
    expect(syncedEvents[0].content).toContain(`<!-- turn-end-sync -->`)
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

    await registry.updateSettings({ defaultPermissionLevel: `auto_edits` })
    const afterAdd = await registry.addCustomAgent({
      name: `My Local Agent`,
      command: fakeGemini,
      args: [`--acp`],
    })
    const custom = afterAdd.find(a => a.name === `My Local Agent`)
    expect(custom).toBeDefined()
    expect(custom?.installed).toBe(true)

    const reloaded = new AcpRegistry({
      settingsPath: path.join(dir, `acp-settings.json`),
      pathOverride: binDir,
    })
    const settings = await reloaded.getSettings()
    expect(settings.defaultPermissionLevel).toBe(`auto_edits`)
    expect(settings.customAgents).toHaveLength(1)
  })

  it(`migrates legacy two-toggle settings to defaultPermissionLevel once and strips old keys`, async () => {
    expect(migrateLegacyPermissionSettings({ reviewEditsBeforeWriting: true, askBeforeRunningCommands: true }))
      .toEqual({ level: `ask`, migrated: true })
    expect(migrateLegacyPermissionSettings({ reviewEditsBeforeWriting: false, askBeforeRunningCommands: true }))
      .toEqual({ level: `auto_edits`, migrated: true })
    expect(migrateLegacyPermissionSettings({ reviewEditsBeforeWriting: false, askBeforeRunningCommands: false }))
      .toEqual({ level: `bypass`, migrated: true })
    expect(migrateLegacyPermissionSettings({ defaultPermissionLevel: `plan` }))
      .toEqual({ level: `plan`, migrated: false })
    expect(migrateLegacyPermissionSettings({}))
      .toEqual({ level: `ask`, migrated: false })

    const dir = await makeTempDir(`md-acp-migrate-`)
    const settingsPath = path.join(dir, `acp-settings.json`)
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        defaultAgentId: `codex`,
        reviewEditsBeforeWriting: false,
        askBeforeRunningCommands: true,
        lastModelByAgent: {},
        customAgents: [],
        commandOverrides: {},
      }),
      `utf8`,
    )

    const registry = new AcpRegistry({ settingsPath })
    const loaded = await registry.getSettings()
    expect(loaded.defaultAgentId).toBe(`codex`)
    expect(loaded.defaultPermissionLevel).toBe(`auto_edits`)

    const persistedRaw = JSON.parse(await fs.readFile(settingsPath, `utf8`)) as Record<string, unknown>
    expect(persistedRaw.defaultPermissionLevel).toBe(`auto_edits`)
    expect(`reviewEditsBeforeWriting` in persistedRaw).toBe(false)
    expect(`askBeforeRunningCommands` in persistedRaw).toBe(false)
  })

  it(`streams npm install progress and supports cancellation`, async () => {
    const dir = await makeTempDir(`md-acp-install-`)
    const binDir = path.join(dir, `bin`)
    await fs.mkdir(binDir, { recursive: true })

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

describe(`performance and reliability guards (P-1, P-2, O-1, O-2, O-5)`, () => {
  it(`enforces UTF-8 byte limits on terminal output without splitting multibyte chars (O-1)`, () => {
    const ring = { chunks: [] as Buffer[], totalBytes: 0, truncated: false }
    // 100,000 CJK chars = 300,000 UTF-8 bytes (> 262,144)
    const cjk = `中`.repeat(100_000)
    appendUtf8RingChunk(ring, cjk, 262_144)
    expect(ring.truncated).toBe(true)
    expect(ring.totalBytes).toBeLessThanOrEqual(262_144)
    const decoded = decodeUtf8Ring(ring.chunks)
    expect(Buffer.byteLength(decoded, `utf8`)).toBeLessThanOrEqual(262_144)
    expect(decoded.includes(`\uFFFD`)).toBe(false)
    expect(decoded.startsWith(`中`)).toBe(true)
  })

  it(`coalesces consecutive chunks and flushes ahead of non-chunk events (P-1)`, async () => {
    const emitted: AcpHostEvent[] = []
    const batcher = new AcpEventBatcher({
      batchMs: 25,
      onEmit: ev => emitted.push(ev),
    })

    batcher.push({ type: `message_chunk`, sessionId: `s1`, text: `A` })
    batcher.push({ type: `message_chunk`, sessionId: `s1`, text: `B` })
    batcher.push({ type: `message_chunk`, sessionId: `s1`, text: `C` })
    expect(emitted).toHaveLength(0)

    // Non-chunk event must flush buffered chunks first to preserve ordering.
    batcher.push({ type: `turn_finished`, sessionId: `s1`, stopReason: `end_turn` })
    expect(emitted).toEqual([
      { type: `message_chunk`, sessionId: `s1`, text: `ABC` },
      { type: `turn_finished`, sessionId: `s1`, stopReason: `end_turn` },
    ])

    batcher.push({ type: `message_chunk`, sessionId: `s1`, text: `D` })
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(emitted).toHaveLength(3)
    expect(emitted[2]).toEqual({ type: `message_chunk`, sessionId: `s1`, text: `D` })
    batcher.dispose()
  })

  it(`persists ProbeCache across restarts and expires entries after TTL (P-2)`, async () => {
    const dir = await makeTempDir(`md-acp-probe-cache-`)
    const cachePath = path.join(dir, `probe-cache.json`)

    const cache1 = new ProbeCache({ cachePath, ttlMs: 60_000 })
    cache1.seed({
      agentId: `fake-seeded`,
      models: [{ id: `m1`, name: `Model 1` }],
      currentModelId: `m1`,
      modes: [],
      currentModeId: null,
      commands: [],
      probedAt: Date.now(),
    })
    await cache1.flush()

    // New ProbeCache instance loads from disk without spawning a process.
    const cache2 = new ProbeCache({ cachePath, ttlMs: 60_000 })
    const hit = await cache2.probe({
      agentId: `fake-seeded`,
      command: `/nonexistent/should-not-spawn`,
      args: [],
    })
    expect(hit.models).toEqual([{ id: `m1`, name: `Model 1` }])

    // Expired TTL ignores stale disk cache and attempts fresh probe.
    const expiredCache = new ProbeCache({ cachePath, ttlMs: -1 })
    const miss = await expiredCache.probe({
      agentId: `fake-seeded`,
      command: `/nonexistent/binary`,
      args: [],
    })
    expect(miss.error).toBeTruthy()
  })

  it(`sweeps stale acp-workspaces on startup and cleans up unexpected child exits (O-2)`, async () => {
    const dataDir = await makeTempDir(`md-acp-sweep-`)
    const staleDir = path.join(dataDir, `acp-workspaces`, `stale-crash-dir`)
    await fs.mkdir(staleDir, { recursive: true })
    await fs.writeFile(path.join(staleDir, `article.md`), `stale`, `utf8`)

    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-exit`,
          name: `Fake Exit`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `E`, color: `#5B5BD6` },
        },
      ],
      onEvent: ev => events.push(ev),
    })
    openHosts.push(host)

    // Wait briefly for startup sweep to remove the stale workspace folder.
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(fs.stat(staleDir)).rejects.toThrow()

    const started = await host.startSession({
      agentId: `fake-exit`,
      postId: `p1`,
      postTitle: `Exit Test`,
      content: `# Hi`,
    })
    const remainingDirs = await fs.readdir(path.join(dataDir, `acp-workspaces`))
    expect(remainingDirs).toHaveLength(1)
    const activeWorkspace = path.join(dataDir, `acp-workspaces`, remainingDirs[0])

    // Kill the underlying child process directly to simulate an unexpected CLI crash while idle.
    const managed = (host as unknown as { sessions: Map<string, { session: AcpSession }> }).sessions.get(started.sessionId)
    managed?.session.childProcess?.kill(`SIGKILL`)

    // Wait for child exit cleanup to emit session_closed and delete workspaceDir.
    for (let i = 0; i < 40; i++) {
      if (events.some(e => e.type === `session_closed` && e.sessionId === started.sessionId))
        break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(events.some(e => e.type === `session_closed` && e.sessionId === started.sessionId)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 80))
    await expect(fs.stat(activeWorkspace)).rejects.toThrow()
  })

  it(`serializes concurrent AcpRegistry persist writes so newest state always wins (O-5)`, async () => {
    const dir = await makeTempDir(`md-acp-persist-`)
    const settingsPath = path.join(dir, `acp-settings.json`)
    const registry = new AcpRegistry({ settingsPath, pathOverride: process.env.PATH })

    await Promise.all([
      registry.rememberLastModel(`claude`, `model-1`),
      registry.rememberLastModel(`codex`, `model-2`),
      registry.updateSettings({ defaultPermissionLevel: `auto_edits` }),
      registry.rememberLastModel(`claude`, `model-3`),
    ])

    const saved = JSON.parse(await fs.readFile(settingsPath, `utf8`))
    expect(saved.defaultPermissionLevel).toBe(`auto_edits`)
    expect(saved.lastModelByAgent).toEqual({
      claude: `model-3`,
      codex: `model-2`,
    })
  })
})

describe(`selectAutoAcceptOption`, () => {
  it(`auto-approves with allow once only, never a permanent grant`, () => {
    const once = { optionId: `once`, name: `Allow`, kind: `allow_once` } as const
    const always = { optionId: `always`, name: `Always`, kind: `allow_always` } as const
    const reject = { optionId: `deny`, name: `Deny`, kind: `reject_once` } as const
    expect(selectAutoAcceptOption([always, once])?.optionId).toBe(`once`)
    expect(selectAutoAcceptOption([always])).toBeNull()
    expect(buildPermissionResponse([always, reject], `allow_once`)).toEqual({ outcome: { outcome: `cancelled` } })
    expect(buildPermissionResponse([always, reject], `allow_always`)).toEqual({
      outcome: { outcome: `selected`, optionId: `always` },
    })
  })

  it(`extracts Antigravity PascalCase tool inputs and string rawOutput errors`, () => {
    const execSnap = mergeToolCallSnapshot(undefined, {
      toolCallId: `tc-agy-exec`,
      title: `Build check`,
      kind: `execute`,
      status: `pending`,
      rawInput: { CommandLine: `pnpm test` },
    })
    expect(execSnap.command).toBe(`pnpm test`)

    const editSnap = mergeToolCallSnapshot(undefined, {
      toolCallId: `tc-agy-edit`,
      title: `File article.md`,
      kind: `edit`,
      status: `pending`,
      rawInput: {
        Path: `/tmp/article.md`,
        Target: `Old line`,
        Replacement: ``,
      },
    })
    expect(editSnap.filePath).toBe(`/tmp/article.md`)
    expect(editSnap.unifiedDiff).toBe(`-Old line`)
    expect(editSnap.diffStats).toEqual({ added: 0, removed: 1, hasChanges: true })

    const failedSnap = mergeToolCallSnapshot(editSnap, {
      toolCallId: `tc-agy-edit`,
      status: `failed`,
      rawOutput: `permission check failed for write_file`,
    })
    expect(failedSnap.error).toBe(`permission check failed for write_file`)

    // Codex ACP bracketed reasoning effort (`gpt-6-astra[xhigh]`) also stays intact across config_option_update.
    const codexResolved = resolveCurrentModelFromConfigOptions(
      [
        { id: `model`, name: `Model`, category: `model`, type: `select`, currentValue: `gpt-6-astra`, options: [] },
        { id: `reasoning_effort`, name: `Reasoning`, category: `thought_level`, type: `select`, currentValue: `xhigh`, options: [] },
      ],
      [
        { id: `gpt-6-astra[high]`, name: `6 Astra (High)` },
        { id: `gpt-6-astra[xhigh]`, name: `6 Astra (Xhigh)` },
      ],
      `gpt-6-astra[xhigh]`,
    )
    expect(codexResolved).toBe(`gpt-6-astra[xhigh]`)
  })
})

describe(`antigravity model preservation, client-side bypass rollback, and auth errors`, () => {
  it(`preserves effort-suffixed models.availableModels IDs across config_option_update and remembers them`, async () => {
    const dataDir = await makeTempDir(`md-acp-agy-model-`)
    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-agy`,
          name: `Fake Antigravity`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `agy`,
            FAKE_AGENT_MODES_STYLE: `agy`,
            FAKE_AGENT_INITIAL_MODE: `default`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `A`, color: `#0F9D8A` },
        },
        {
          id: `fake-agy-fail-mode`,
          name: `Fake Antigravity Fail Mode`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `agy`,
            FAKE_AGENT_MODES_STYLE: `agy`,
            FAKE_AGENT_INITIAL_MODE: `plan`,
            FAKE_AGENT_FAIL_SET_MODE_ERROR: `1`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `F`, color: `#0F9D8A` },
        },
        {
          id: `fake-unauth`,
          name: `Fake Unauthenticated CLI`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: { FAKE_AGENT_REQUIRE_AUTH: `1` },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `U`, color: `#0F9D8A` },
        },
        {
          id: `fake-agy-leave-default`,
          name: `Fake Agy Leave Default`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_MODES_STYLE: `agy`,
            FAKE_AGENT_PUSH_MODE: `auto`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `L`, color: `#0F9D8A` },
        },
      ],
      onEvent: ev => events.push(ev),
    })
    openHosts.push(host)

    const started = await host.startSession({
      agentId: `fake-agy`,
      modelId: `gemini-3.8-flash-low`,
      permissionLevel: `bypass`,
      postId: `p-agy`,
      postTitle: `Agy Test`,
      content: `# Draft`,
    })

    // Legacy variant IDs resolve onto grouped base models + thinkingLevel, and config_option_update preserves them.
    expect(started.modelId).toBe(`gemini-3.8-flash`)
    expect(started.thinkingLevel).toBe(`low`)
    expect(started.models.map(m => m.id)).toEqual([
      `gemini-4-neon`,
      `gemini-3.8-flash`,
      `claude-sonnet-5-5`,
      `gpt-oss-120b-medium`,
    ])
    expect(started.models.find(m => m.id === `gemini-3.8-flash`)?.thinkingVariantIds?.low).toBe(`gemini-3.8-flash-low`)
    expect(started.models.find(m => m.id === `gpt-oss-120b-medium`)?.thinkingOptions).toBeUndefined()
    expect(started.permissionLevel).toBe(`bypass`)
    expect(started.currentModeId).toBeNull()

    const settings = await host.getSettings()
    expect(settings.lastModelByAgent[`fake-agy`]).toBe(`gemini-3.8-flash`)
    expect(settings.lastThinkingLevelByAgent[`fake-agy`]).toBe(`low`)

    // Switching to agy's custom `auto` mode sets client policy to `ask` and exposes `auto`, then back to `bypass` runs on `default`.
    const autoMode = await host.setPermissionMode({ sessionId: started.sessionId, modeId: `auto` })
    expect(autoMode).toEqual({ permissionLevel: `ask`, modeId: `auto` })
    const backToBypass = await host.setPermissionMode({ sessionId: started.sessionId, permissionLevel: `bypass`, modeId: null })
    expect(backToBypass).toEqual({ permissionLevel: `bypass`, modeId: null })

    // Adapter error during mode switch (e.g. plan -> bypass) must roll back permissionLevel and rethrow.
    const failSess = await host.startSession({
      agentId: `fake-agy-fail-mode`,
      permissionLevel: `plan`,
      postId: `p-fail`,
      postTitle: `Fail Mode`,
      content: `# Plan`,
    })
    await expect(
      host.setPermissionMode({ sessionId: failSess.sessionId, permissionLevel: `bypass`, modeId: null }),
    ).rejects.toThrow(/Adapter rejected mode transition/)

    // Unauthenticated CLI surfaces advertised auth methods clearly without hanging.
    await expect(
      host.startSession({
        agentId: `fake-unauth`,
        postId: `p-unauth`,
        postTitle: `Unauth`,
        content: `# Hi`,
      }),
    ).rejects.toThrow(/Log in with Google/)

    // Client-side bypass ends as soon as the agent leaves `default` (e.g. switches to `auto`).
    events.length = 0
    const leaveDefaultSess = await host.startSession({
      agentId: `fake-agy-leave-default`,
      permissionLevel: `bypass`,
      postId: `p-leave`,
      postTitle: `Leave Default`,
      content: `# Bypass`,
    })
    expect(leaveDefaultSess.permissionLevel).toBe(`bypass`)
    await host.prompt({
      sessionId: leaveDefaultSess.sessionId,
      text: `Leave default mode`,
      content: `# Bypass`,
      postTitle: `Leave Default`,
    })
    const leftBypassEvent = events.find(
      (e): e is Extract<AcpHostEvent, { type: `mode_changed` }> =>
        e.type === `mode_changed` && e.modeId === `auto`,
    )
    expect(leftBypassEvent?.permissionLevel).toBe(`ask`)
  })
})

describe(`thinking level switching (variants vs configOption) and config_option_update sync`, () => {
  it(`switches thinking level via variant set_model on agy and codex, falls back on model switch, and remembers last level`, async () => {
    const dataDir = await makeTempDir(`md-acp-thinking-variants-`)
    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-agy-think`,
          name: `Fake Agy Think`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `agy`,
            FAKE_AGENT_MODES_STYLE: `agy`,
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `A`, color: `#0F9D8A` },
        },
        {
          id: `fake-agy-push`,
          name: `Fake Agy Push Thought`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `agy`,
            FAKE_AGENT_MODES_STYLE: `agy`,
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_PUSH_THOUGHT: `low`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `P`, color: `#0F9D8A` },
        },
        {
          id: `fake-codex-think`,
          name: `Fake Codex Think`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `codex`,
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `X`, color: `#3A3A38` },
        },
      ],
      onEvent: ev => events.push(ev),
    })
    openHosts.push(host)

    // 1. Agy: start with base model + thinking level -> applies variant via session/set_model.
    const agy1 = await host.startSession({
      agentId: `fake-agy-think`,
      modelId: `gemini-4-neon`,
      thinkingLevel: `xhigh`,
      postId: `p1`,
      postTitle: `Agy Think`,
      content: `# Draft`,
    })
    expect(agy1.modelId).toBe(`gemini-4-neon`)
    expect(agy1.thinkingLevel).toBe(`xhigh`)
    expect(agy1.thinkingOptions).toEqual([])
    expect(agy1.models.find(m => m.id === `gemini-4-neon`)?.thinkingOptions?.map(o => o.id))
      .toEqual([`low`, `medium`, `high`, `xhigh`])

    // 2. Switching to a model that does not support `xhigh` falls back to `medium`.
    const switchedToFlash = await host.setModel({
      sessionId: agy1.sessionId,
      modelId: `gemini-3.8-flash`,
    })
    expect(switchedToFlash).toEqual({ modelId: `gemini-3.8-flash`, thinkingLevel: `medium` })

    // 3. Switching thinking level mid-session sends variant model ID via session/set_model.
    const switchedToLow = await host.setThinkingLevel({
      sessionId: agy1.sessionId,
      thinkingLevel: `low`,
    })
    expect(switchedToLow).toEqual({ modelId: `gemini-3.8-flash`, thinkingLevel: `low` })

    // 4. Switching to standalone model without variants clears thinkingLevel to null while keeping remembered level.
    const switchedToStandalone = await host.setModel({
      sessionId: agy1.sessionId,
      modelId: `gpt-oss-120b-medium`,
    })
    expect(switchedToStandalone).toEqual({ modelId: `gpt-oss-120b-medium`, thinkingLevel: null })

    // Switch back to flash and confirm wire history used variant set_model (zero set_config_option calls).
    await host.setModel({
      sessionId: agy1.sessionId,
      modelId: `gemini-3.8-flash`,
      thinkingLevel: `high`,
    })
    events.length = 0
    await host.prompt({
      sessionId: agy1.sessionId,
      text: `Confirm wire calls`,
      content: `# Draft`,
      postTitle: `Agy Think`,
    })
    const agyReply = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(agyReply).toContain(`[setModels:gemini-4-neon-xhigh,gemini-3.8-flash-medium,gemini-3.8-flash-low,gpt-oss-120b-medium,gemini-3.8-flash-high]`)
    expect(agyReply).toContain(`[setConfigs:]`)

    // 5. New session remembers both lastModelByAgent and lastThinkingLevelByAgent (`gemini-3.8-flash` + `high`).
    const agy2 = await host.startSession({
      agentId: `fake-agy-think`,
      postId: `p2`,
      postTitle: `Agy Remembered`,
      content: `# Remember`,
    })
    expect(agy2.modelId).toBe(`gemini-3.8-flash`)
    expect(agy2.thinkingLevel).toBe(`high`)

    // 6. Agent-pushed config_option_update updates session thinkingLevel and emits thinking_changed.
    events.length = 0
    const agyPush = await host.startSession({
      agentId: `fake-agy-push`,
      modelId: `gemini-4-neon`,
      thinkingLevel: `high`,
      postId: `p3`,
      postTitle: `Agy Push`,
      content: `# Push`,
    })
    expect(agyPush.thinkingLevel).toBe(`high`)
    await host.prompt({
      sessionId: agyPush.sessionId,
      text: `Trigger thought update`,
      content: `# Push`,
      postTitle: `Agy Push`,
    })
    expect(
      events.some(
        e => e.type === `thinking_changed` && e.sessionId === agyPush.sessionId && e.thinkingLevel === `low`,
      ),
    ).toBe(true)

    // 7. Codex bracket variants (`gpt-6-astra[ultra]` -> `gpt-6-luna[medium]` fallback -> `gpt-6-luna[low]`).
    const codex = await host.startSession({
      agentId: `fake-codex-think`,
      modelId: `gpt-6-astra`,
      thinkingLevel: `ultra`,
      postId: `p4`,
      postTitle: `Codex Think`,
      content: `# Codex`,
    })
    expect(codex.modelId).toBe(`gpt-6-astra`)
    expect(codex.thinkingLevel).toBe(`ultra`)
    expect(codex.models.map(m => m.id)).toEqual([`gpt-6-astra`, `gpt-6-luna`])
    expect(codex.models[0].thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`, `xhigh`, `max`, `ultra`])

    const codexSwitched = await host.setModel({
      sessionId: codex.sessionId,
      modelId: `gpt-6-luna`,
    })
    expect(codexSwitched).toEqual({ modelId: `gpt-6-luna`, thinkingLevel: `medium` })

    const codexLow = await host.setThinkingLevel({
      sessionId: codex.sessionId,
      thinkingLevel: `low`,
    })
    expect(codexLow).toEqual({ modelId: `gpt-6-luna`, thinkingLevel: `low` })

    events.length = 0
    await host.prompt({
      sessionId: codex.sessionId,
      text: `Verify codex wire`,
      content: `# Codex`,
      postTitle: `Codex Think`,
    })
    const codexReply = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(codexReply).toContain(`[setModels:gpt-6-astra[ultra],gpt-6-luna[medium],gpt-6-luna[low]]`)
    expect(codexReply).toContain(`[setConfigs:]`)
  })

  it(`applies thinking level via session/set_config_option when an agent exposes thought_level without model variants`, async () => {
    const dataDir = await makeTempDir(`md-acp-thinking-config-`)
    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-cfg-thought`,
          name: `Fake Config Thought`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `config_thought`,
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
            FAKE_AGENT_PUSH_THOUGHT: `low`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `C`, color: `#4C7DF0` },
        },
      ],
      onEvent: ev => events.push(ev),
    })
    openHosts.push(host)

    const started = await host.startSession({
      agentId: `fake-cfg-thought`,
      modelId: `sonnet-5.5`,
      thinkingLevel: `high`,
      postId: `p-cfg`,
      postTitle: `Config Thought`,
      content: `# Config`,
    })

    expect(started.modelId).toBe(`sonnet-5.5`)
    expect(started.thinkingLevel).toBe(`high`)
    expect(started.thinkingOptions.map(o => o.id)).toEqual([`low`, `medium`, `high`])
    expect(started.models[0].thinkingVariantIds).toBeUndefined()

    const switched = await host.setThinkingLevel({
      sessionId: started.sessionId,
      thinkingLevel: `medium`,
    })
    expect(switched).toEqual({ modelId: `sonnet-5.5`, thinkingLevel: `medium` })

    const settings = await host.getSettings()
    expect(settings.lastThinkingLevelByAgent[`fake-cfg-thought`]).toBe(`medium`)

    events.length = 0
    await host.prompt({
      sessionId: started.sessionId,
      text: `Verify config option path`,
      content: `# Config`,
      postTitle: `Config Thought`,
    })
    const reply = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(reply).toContain(`[setModels:sonnet-5.5]`)
    expect(reply).toContain(`[setConfigs:thought_level=high,thought_level=medium]`)
    expect(
      events.some(
        e => e.type === `thinking_changed` && e.sessionId === started.sessionId && e.thinkingLevel === `low`,
      ),
    ).toBe(true)
  })

  it(`preserves configOption thinking catalog across no-effort models and avoids spurious intermediate thinking_changed`, async () => {
    const dataDir = await makeTempDir(`md-acp-claude-cfg-`)
    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-claude-cfg`,
          name: `Fake Claude Config`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {
            FAKE_AGENT_MODEL_STYLE: `claude_cfg`,
            FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`,
          },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `C`, color: `#D97757` },
        },
      ],
      onEvent: ev => events.push(ev),
    })
    openHosts.push(host)

    // Probe discovers 3 effort levels on default model (`opus-5.5`).
    const initialProbe = await host.probeAgent(`fake-claude-cfg`)
    expect(initialProbe.thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`])

    // Starting on no-effort `haiku-5.5` must NOT wipe the cached probe thinkingOptions!
    const haikuSess = await host.startSession({
      agentId: `fake-claude-cfg`,
      modelId: `haiku-5.5`,
      postId: `p-haiku`,
      postTitle: `Haiku`,
      content: `# Haiku`,
    })
    expect(haikuSess.thinkingOptions).toEqual([])
    expect(haikuSess.thinkingLevel).toBeNull()

    const cachedAfterHaiku = await host.probeAgent(`fake-claude-cfg`)
    expect(cachedAfterHaiku.thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`])

    // Switching to sonnet-5.5 with explicit `'low'` must NOT emit an intermediate `'high'` event.
    events.length = 0
    const toSonnet = await host.setModel({
      sessionId: haikuSess.sessionId,
      modelId: `sonnet-5.5`,
      thinkingLevel: `low`,
    })
    expect(toSonnet).toEqual({ modelId: `sonnet-5.5`, thinkingLevel: `low` })
    const thinkingEvents = events.filter(
      (e): e is Extract<AcpHostEvent, { type: `thinking_changed` }> =>
        e.type === `thinking_changed` && e.sessionId === haikuSess.sessionId,
    )
    expect(thinkingEvents.map(e => e.thinkingLevel)).toEqual([`low`])

    // Switching to opus-5.5 without passing thinkingLevel must carry over `'low'` rather than resetting to `'high'`.
    events.length = 0
    const toOpus = await host.setModel({
      sessionId: haikuSess.sessionId,
      modelId: `opus-5.5`,
    })
    expect(toOpus).toEqual({ modelId: `opus-5.5`, thinkingLevel: `low` })
    const opusThinkingEvents = events.filter(
      (e): e is Extract<AcpHostEvent, { type: `thinking_changed` }> =>
        e.type === `thinking_changed` && e.sessionId === haikuSess.sessionId,
    )
    expect(opusThinkingEvents).toEqual([])
  })

  it(`blocks symlink escape in terminal/create cwd while accepting realpaths inside symlinked workspaces`, async () => {
    const outerDir = await makeTempDir(`md-acp-term-cwd-`)
    const realWs = path.join(outerDir, `real-ws`)
    const subDir = path.join(realWs, `nested`)
    const outsideSecret = path.join(outerDir, `outside-secret`)
    const aliasWs = path.join(outerDir, `alias-ws`)
    await fs.mkdir(subDir, { recursive: true })
    await fs.mkdir(outsideSecret, { recursive: true })
    await fs.symlink(outsideSecret, path.join(realWs, `escape-link`))
    await fs.symlink(realWs, aliasWs)

    const session = new AcpSession({
      agentId: `fake-term`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      cwd: aliasWs,
    })
    try {
      await session.initializeNewSession()
      const createTerminal = session as unknown as {
        handleCreateTerminal: (p: { command: string, args: string[], cwd?: string }) => Promise<{ terminalId: string }>
        handleWaitForTerminalExit: (p: { terminalId: string }) => Promise<unknown>
        handleTerminalOutput: (p: { terminalId: string }) => Promise<{ output: string }>
      }

      // 1. Symlink pointing outside workspace must fall back to workspace cwd, never enter outsideSecret.
      const escaped = await createTerminal.handleCreateTerminal.call(session, {
        command: process.execPath,
        args: [`-e`, `process.stdout.write(fs.realpathSync(process.cwd()))`],
        cwd: `escape-link`,
      })
      await createTerminal.handleWaitForTerminalExit.call(session, escaped)
      const escapedOut = await createTerminal.handleTerminalOutput.call(session, escaped)
      expect(escapedOut.output.trim()).toBe(await fs.realpath(realWs))

      // 2. Realpath subdirectory when workspace was opened via symlink (e.g. macOS /var -> /private/var) must succeed.
      const realSubdirPath = await fs.realpath(subDir)
      const validSub = await createTerminal.handleCreateTerminal.call(session, {
        command: process.execPath,
        args: [`-e`, `process.stdout.write(fs.realpathSync(process.cwd()))`],
        cwd: realSubdirPath,
      })
      await createTerminal.handleWaitForTerminalExit.call(session, validSub)
      const validOut = await createTerminal.handleTerminalOutput.call(session, validSub)
      expect(validOut.output.trim()).toBe(realSubdirPath)
    }
    finally {
      await session.close()
    }
  })
})

describe(`buildPromptText`, () => {
  it(`prepends doocs/md writing rules only when requested`, () => {
    const params = { sessionId: `s`, text: `Write an intro`, content: ``, postTitle: `T` }
    const first = buildPromptText(params, `/w/article.md`, true)
    expect(first).toContain(`Article file path: /w/article.md`)
    expect(first).toContain(`[!NOTE]`)
    expect(first).toContain(`<TipBlock`)
    expect(first.endsWith(`Write an intro`)).toBe(true)
    expect(buildPromptText(params, `/w/article.md`, false)).not.toContain(`[Writing rules]`)
  })
})

describe(`skills in agent workspaces`, () => {
  function fakeAgent(id: string, env: Record<string, string>): AcpAgentConfig {
    return {
      id,
      name: id,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      env: { FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `0`, ...env },
      detectBinaries: [process.execPath],
      builtin: true,
      avatar: { letter: `F`, color: `#5B5BD6` },
    }
  }

  async function readPrompts(promptsPath: string): Promise<string[][]> {
    return (await fs.readFile(promptsPath, `utf8`)).trim().split(`\n`).map(line => JSON.parse(line) as string[])
  }

  async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() > deadline)
        throw new Error(`waitFor timed out`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  async function makeSkillsDir(): Promise<string> {
    const skillsDir = await makeTempDir(`md-acp-skills-src-`)
    await fs.mkdir(path.join(skillsDir, `demo-skill`))
    await fs.writeFile(path.join(skillsDir, `demo-skill`, `SKILL.md`), `---\nname: demo-skill\n---\n`)
    return skillsDir
  }

  it(`installs bundled skills for sessions and per-probe workspaces`, async () => {
    const dataDir = await makeTempDir(`md-acp-skills-`)
    const host = new AcpHost({
      dataDir,
      skillsDir: await makeSkillsDir(),
      // Announce after the 600ms quiet window to cover slow first announcements.
      extraBuiltinAgents: [fakeAgent(`fake-skills`, { FAKE_AGENT_EMIT_COMMANDS: `1`, FAKE_AGENT_COMMANDS_DELAY_MS: `900` })],
    })
    openHosts.push(host)

    const probe = await host.probeAgent(`fake-skills`)
    expect(probe.commands.map(c => c.name)).toEqual([`outline`, `polish`, `demo-skill`])
    expect(probe.commandsAnnounced).toBe(true)
    // The probe workspace is removed once the probe closes.
    expect(await fs.readdir(path.join(dataDir, `acp-workspaces`))).toEqual([])

    await host.startSession({ agentId: `fake-skills`, postId: `p`, postTitle: `T`, content: `` })
    const [workspaceId] = await fs.readdir(path.join(dataDir, `acp-workspaces`))
    const workspaceDir = path.join(dataDir, `acp-workspaces`, workspaceId)
    for (const dir of [`.claude/skills`, `.agents/skills`, `.qwen/skills`])
      expect(await fs.readdir(path.join(workspaceDir, dir))).toEqual([`demo-skill`])
    expect((await fs.readdir(workspaceDir)).sort()).toEqual([`.agents`, `.claude`, `.qwen`, `article.md`])
  })

  it(`probes off the home directory even when the bundle is missing`, async () => {
    const dataDir = await makeTempDir(`md-acp-skills-missing-`)
    const host = new AcpHost({
      dataDir,
      skillsDir: path.join(dataDir, `missing-skills`),
      extraBuiltinAgents: [fakeAgent(`fake-skills`, { FAKE_AGENT_EMIT_COMMANDS: `1` })],
    })
    openHosts.push(host)

    // Probing in the home directory would pick up the user's own `~/.claude/skills`.
    const probe = await host.probeAgent(`fake-skills`)
    expect(probe.commands.map(c => c.name)).toEqual([`outline`, `polish`])
    // Skills failed to install, so the list may be incomplete and is retried sooner.
    expect(probe.commandsAnnounced).toBe(false)
  })

  it(`sends command turns as their own first block with context, attachments and rules in a second block`, async () => {
    const dataDir = await makeTempDir(`md-acp-turns-`)
    const promptsPath = path.join(dataDir, `prompts.jsonl`)
    const events: AcpHostEvent[] = []
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [fakeAgent(`fake-skilled`, { FAKE_AGENT_EMIT_COMMANDS: `1`, FAKE_AGENT_RECORD_PROMPTS: promptsPath })],
      onEvent: event => events.push(event),
    })
    openHosts.push(host)

    const { sessionId } = await host.startSession({ agentId: `fake-skilled`, postId: `p`, postTitle: `T`, content: `` })
    await waitFor(() => events.some(e => e.type === `commands_updated`))
    await host.prompt({ sessionId, text: `/outline 存款`, content: ``, postTitle: `T`, attachments: [`/ref/a.md`] })
    await host.prompt({ sessionId, text: `Polish it`, content: ``, postTitle: `T` })
    await host.prompt({ sessionId, text: `Shorter`, content: ``, postTitle: `T` })

    const [commandTurn, normalTurn, laterTurn] = await readPrompts(promptsPath)
    expect(commandTurn[0]).toBe(`/outline 存款`)
    expect(commandTurn[1]).toContain(`Attached reference files:\n- /ref/a.md`)
    expect(commandTurn[1]).toContain(`[Writing rules]`)
    // A command may be handled locally, so the first normal turn still carries the rules.
    expect(normalTurn).toHaveLength(1)
    expect(normalTurn[0]).toContain(`[Writing rules]`)
    expect(normalTurn[0].endsWith(`Polish it`)).toBe(true)
    expect(laterTurn[0]).toContain(`[Context]`)
    expect(laterTurn[0]).not.toContain(`[Writing rules]`)
  }, 20_000)

  it(`recognizes commands from the probe before the session announces its own`, async () => {
    const dataDir = await makeTempDir(`md-acp-turns-early-`)
    const promptsPath = path.join(dataDir, `prompts.jsonl`)
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [fakeAgent(`fake-late`, { FAKE_AGENT_EMIT_COMMANDS: `1`, FAKE_AGENT_COMMANDS_DELAY_MS: `900`, FAKE_AGENT_RECORD_PROMPTS: promptsPath })],
    })
    openHosts.push(host)

    await host.probeAgent(`fake-late`)
    const { sessionId } = await host.startSession({ agentId: `fake-late`, postId: `p`, postTitle: `T`, content: `` })
    await host.prompt({ sessionId, text: `/outline 存款`, content: ``, postTitle: `T` })

    const [[command, context]] = await readPrompts(promptsPath)
    expect(command).toBe(`/outline 存款`)
    expect(context).toContain(`[Context]`)
  }, 20_000)

  it(`never treats a leading path as a command`, async () => {
    const dataDir = await makeTempDir(`md-acp-turns-plain-`)
    const promptsPath = path.join(dataDir, `prompts.jsonl`)
    const host = new AcpHost({ dataDir, extraBuiltinAgents: [fakeAgent(`fake-plain`, { FAKE_AGENT_RECORD_PROMPTS: promptsPath })] })
    openHosts.push(host)

    const { sessionId } = await host.startSession({ agentId: `fake-plain`, postId: `p`, postTitle: `T`, content: `` })
    for (const text of [`/Users/me/notes.md 是什么`, `Shorter`])
      await host.prompt({ sessionId, text, content: ``, postTitle: `T` })

    const [[first], [second]] = await readPrompts(promptsPath)
    expect(first).toContain(`[Writing rules]`)
    expect(first.endsWith(`/Users/me/notes.md 是什么`)).toBe(true)
    expect(second).toContain(`[Context]`)
    expect(second).not.toContain(`[Writing rules]`)
  })
})

describe(`probeCache versioning and pending commands`, () => {
  const cached = {
    agentId: `fake-cache`,
    models: [{ id: `m`, name: `m` }],
    currentModelId: `m`,
    modes: [],
    currentModeId: null,
    commands: [{ name: `cached` }],
    probedAt: Date.now(),
  }

  it(`drops persisted entries written by another app version`, async () => {
    const dir = await makeTempDir(`md-acp-probe-version-`)
    const cachePath = path.join(dir, `cache.json`)
    const writer = new ProbeCache({ cachePath, appVersion: `1.0.0` })
    writer.seed(cached)
    await writer.flush()

    const options = {
      agentId: `fake-cache`,
      command: process.execPath,
      args: [FAKE_AGENT_SCRIPT],
      env: { FAKE_AGENT_EMIT_COMMANDS: `1` },
      cwd: dir,
      commandQuietMs: 50,
    }
    const sameVersion = await new ProbeCache({ cachePath, appVersion: `1.0.0` }).probe(options)
    expect(sameVersion.commands.map(c => c.name)).toEqual([`cached`])
    const upgraded = await new ProbeCache({ cachePath, appVersion: `1.1.0` }).probe(options)
    expect(upgraded.commands.map(c => c.name)).toEqual([`outline`, `polish`])
  })

  it(`marks probes that never saw a command announcement and expires them sooner`, async () => {
    const dir = await makeTempDir(`md-acp-probe-pending-`)
    const silent = await probeAcpAgent({ agentId: `fake-silent`, command: process.execPath, args: [FAKE_AGENT_SCRIPT], cwd: dir, commandQuietMs: 20 })
    expect(silent.commandsAnnounced).toBe(false)

    const cache = new ProbeCache()
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000
    cache.seed({ ...cached, agentId: `pending`, commandsAnnounced: false, probedAt: tenMinutesAgo })
    cache.seed({ ...cached, agentId: `announced`, commandsAnnounced: true, probedAt: tenMinutesAgo })
    expect(cache.get(`pending`)).toBeUndefined()
    expect(cache.get(`announced`)).toBeDefined()
  })

  it(`treats session-start seeds as "commands unknown" without extending pending entries`, () => {
    const cache = new ProbeCache()
    const unknown = { ...cached, commands: [], commandsAnnounced: false, probedAt: Date.now() }

    cache.seed({ ...unknown, agentId: `fresh` })
    expect(cache.get(`fresh`)?.commandsAnnounced).toBe(false)

    const tenMinutesAgo = Date.now() - 10 * 60 * 1000
    cache.seed({ ...cached, agentId: `stale-pending`, commandsAnnounced: false, probedAt: tenMinutesAgo })
    cache.seed({ ...unknown, agentId: `stale-pending` })
    expect(cache.get(`stale-pending`)).toBeUndefined()

    cache.seed({ ...cached, agentId: `known`, commandsAnnounced: true })
    cache.seed({ ...unknown, agentId: `known` })
    expect(cache.get(`known`)?.commands).toEqual(cached.commands)
    expect(cache.get(`known`)?.commandsAnnounced).toBe(true)
  })
})

describe(`readWorkspaceImage`, () => {
  it(`reads images inside the session workspace and refuses anything else`, async () => {
    const dataDir = await makeTempDir(`md-acp-ws-image-`)
    const outside = await makeTempDir(`md-acp-ws-outside-`)
    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [{
        id: `fake-images`,
        name: `Fake Images`,
        command: process.execPath,
        args: [FAKE_AGENT_SCRIPT],
        detectBinaries: [process.execPath],
        builtin: true,
        avatar: { letter: `I`, color: `#5B5BD6` },
      }],
    })
    openHosts.push(host)
    const { sessionId } = await host.startSession({ agentId: `fake-images`, postId: `p`, postTitle: `T`, content: `` })
    const [workspaceId] = await fs.readdir(path.join(dataDir, `acp-workspaces`))
    const workspaceDir = path.join(dataDir, `acp-workspaces`, workspaceId)
    await fs.mkdir(path.join(workspaceDir, `images`))
    await fs.writeFile(path.join(workspaceDir, `images`, `my chart.png`), Buffer.from([1, 2, 3]))
    await fs.writeFile(path.join(outside, `secret.png`), Buffer.from([9]))
    await fs.symlink(path.join(outside, `secret.png`), path.join(workspaceDir, `images`, `link.png`))
    await fs.writeFile(path.join(workspaceDir, `notes.txt`), `x`)

    const image = await host.readWorkspaceImage({ sessionId, path: `images/my%20chart.png` })
    expect(image).toMatchObject({ mimeType: `image/png`, filename: `my chart.png` })
    expect([...image.data]).toEqual([1, 2, 3])

    await expect(host.readWorkspaceImage({ sessionId, path: `images/link.png` })).rejects.toThrow(/outside/)
    await expect(host.readWorkspaceImage({ sessionId, path: path.join(outside, `secret.png`) })).rejects.toThrow(/outside/)
    await expect(host.readWorkspaceImage({ sessionId, path: `../../secret.png` })).rejects.toThrow()
    await expect(host.readWorkspaceImage({ sessionId, path: `notes.txt` })).rejects.toThrow(/Unsupported/)
  })
})
