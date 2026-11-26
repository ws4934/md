import type { AcpActiveSessionSummary } from './acp/host'
import type { PreventableEvent, QuitConfirmCopy } from './quit-guard'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpHost } from './acp/host'
import { formatQuitConfirmCopy, QuitGuard, resolveQuitLocale } from './quit-guard'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT_SCRIPT = path.resolve(__dirname, `../../scripts/fake-acp-agent.mjs`)

const openHosts: AcpHost[] = []
const tempDirs: string[] = []

function makeEvent(): PreventableEvent & { prevented: boolean } {
  const ev = {
    prevented: false,
    preventDefault() {
      ev.prevented = true
    },
  }
  return ev
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

afterEach(async () => {
  while (openHosts.length > 0)
    await openHosts.pop()!.dispose()
  while (tempDirs.length > 0)
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
})

describe(`quit locale resolution and localized copy`, () => {
  it(`resolves explicit UI locale first and falls back to app locale`, () => {
    expect(resolveQuitLocale(`zh-CN`, `en-US`)).toBe(`zh-CN`)
    expect(resolveQuitLocale(`zh-TW`, `zh-CN`)).toBe(`zh-TW`)
    expect(resolveQuitLocale(`ja-JP`, `en-US`)).toBe(`ja-JP`)
    expect(resolveQuitLocale(null, `zh_Hant_HK`)).toBe(`zh-TW`)
    expect(resolveQuitLocale(undefined, `zh-Hans-CN`)).toBe(`zh-CN`)
    expect(resolveQuitLocale(undefined, `ja`)).toBe(`ja-JP`)
    expect(resolveQuitLocale(undefined, `fr-FR`)).toBe(`en-US`)
  })

  it(`formats running-task and waiting-permission copy across all 4 locales`, () => {
    const running: AcpActiveSessionSummary[] = [
      { sessionId: `s1`, agentId: `claude`, agentName: `Claude Code`, waitingPermission: false },
    ]
    const waiting: AcpActiveSessionSummary[] = [
      { sessionId: `s1`, agentId: `claude`, agentName: `Claude Code`, waitingPermission: true },
    ]

    expect(formatQuitConfirmCopy(`zh-CN`, running)).toMatchObject({
      title: `Agent 仍在工作`,
      confirmLabel: `退出`,
      cancelLabel: `取消`,
    })
    expect(formatQuitConfirmCopy(`zh-CN`, running).detail).toContain(`Claude Code`)
    expect(formatQuitConfirmCopy(`zh-CN`, waiting).detail).toContain(`等待你的确认`)

    expect(formatQuitConfirmCopy(`zh-TW`, waiting).detail).toContain(`等待你的確認`)
    expect(formatQuitConfirmCopy(`en-US`, running).detail).toContain(`Claude Code`)
    expect(formatQuitConfirmCopy(`en-US`, waiting).detail).toContain(`waiting for your confirmation`)
    expect(formatQuitConfirmCopy(`ja-JP`, running).title).toBe(`Agent が作業中です`)
    expect(formatQuitConfirmCopy(`ja-JP`, waiting).detail).toContain(`確認待ち`)
  })
})

describe(`quitGuard decision matrix`, () => {
  it(`quits immediately without showing a dialog when no session is active`, async () => {
    const confirmQuit = vi.fn(async () => false)
    const dispose = vi.fn(async () => {})
    const quitApp = vi.fn()
    const forceExit = vi.fn()

    const guard = new QuitGuard({
      getActiveSessions: () => [],
      dispose,
      confirmQuit,
      quitApp,
      forceExit,
    })

    const closeEv = makeEvent()
    guard.handleWindowClose(closeEv)
    expect(closeEv.prevented).toBe(true)

    await flushMicrotasks()
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(quitApp).toHaveBeenCalledTimes(1)
    expect(guard.currentState).toBe(`ready_to_quit`)

    // Subsequent close / before-quit pass straight through.
    const secondBeforeQuit = makeEvent()
    guard.handleBeforeQuit(secondBeforeQuit)
    expect(secondBeforeQuit.prevented).toBe(false)
  })

  it(`asks once when active, stays open on cancel, and disposes + quits on confirm`, async () => {
    let resolvePrompt!: (confirmed: boolean) => void
    const seenCopy: QuitConfirmCopy[] = []
    const confirmQuit = vi.fn((copy: QuitConfirmCopy) => {
      seenCopy.push(copy)
      return new Promise<boolean>((resolve) => {
        resolvePrompt = resolve
      })
    })
    const dispose = vi.fn(async () => {})
    const quitApp = vi.fn()
    const forceExit = vi.fn()

    const guard = new QuitGuard({
      getActiveSessions: () => [
        { sessionId: `s1`, agentId: `claude`, agentName: `Claude Code`, waitingPermission: false },
      ],
      dispose,
      confirmQuit,
      quitApp,
      forceExit,
      getFallbackLocale: () => `zh-CN`,
    })

    // Cmd+Q triggers before-quit AND window close -> only ONE dialog should appear.
    const ev1 = makeEvent()
    const ev2 = makeEvent()
    guard.handleBeforeQuit(ev1)
    guard.handleWindowClose(ev2)
    expect(ev1.prevented).toBe(true)
    expect(ev2.prevented).toBe(true)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    expect(seenCopy[0].title).toBe(`Agent 仍在工作`)

    // User cancels -> stays alive, no dispose, no quit.
    resolvePrompt(false)
    await flushMicrotasks()
    expect(dispose).not.toHaveBeenCalled()
    expect(quitApp).not.toHaveBeenCalled()
    expect(guard.currentState).toBe(`idle`)

    // Second attempt: user confirms -> disposes and quits.
    const ev3 = makeEvent()
    guard.handleWindowClose(ev3)
    expect(confirmQuit).toHaveBeenCalledTimes(2)
    resolvePrompt(true)
    await flushMicrotasks()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(quitApp).toHaveBeenCalledTimes(1)
    expect(guard.currentState).toBe(`ready_to_quit`)
  })

  it(`requestQuit goes through confirm + dispose, then runs its own action instead of quitApp`, async () => {
    let resolvePrompt!: (confirmed: boolean) => void
    const calls: string[] = []
    const confirmQuit = vi.fn(() => new Promise<boolean>((resolve) => {
      resolvePrompt = resolve
    }))
    const dispose = vi.fn(async () => {
      calls.push(`dispose`)
    })
    const quitApp = vi.fn(() => calls.push(`quitApp`))
    const install = vi.fn(() => calls.push(`install`))
    const active = [{ sessionId: `s1`, agentId: `claude`, agentName: `Claude Code`, waitingPermission: false }]
    const makeGuard = () => new QuitGuard({ getActiveSessions: () => active, dispose, confirmQuit, quitApp, forceExit: vi.fn() })

    // Cancelled restart keeps agents running, and a later plain quit does not install.
    const cancelled = makeGuard()
    cancelled.requestQuit(install)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    resolvePrompt(false)
    await flushMicrotasks()
    expect(calls).toEqual([])
    expect(cancelled.currentState).toBe(`idle`)
    cancelled.handleBeforeQuit(makeEvent())
    resolvePrompt(true)
    await flushMicrotasks()
    expect(calls).toEqual([`dispose`, `quitApp`])

    // Confirmed restart disposes agents first; the action's own app.quit() then passes through.
    calls.length = 0
    const confirmed = makeGuard()
    confirmed.requestQuit(install)
    confirmed.requestQuit(install)
    expect(confirmQuit).toHaveBeenCalledTimes(3)
    resolvePrompt(true)
    await flushMicrotasks()
    expect(calls).toEqual([`dispose`, `install`])
    const followUp = makeEvent()
    confirmed.handleBeforeQuit(followUp)
    expect(followUp.prevented).toBe(false)
  })

  it(`skips confirmation on smoke runs and non-interactive shutdown/signals`, async () => {
    const confirmQuit = vi.fn(async () => false)
    const dispose = vi.fn(async () => {})
    const quitApp = vi.fn()
    const forceExit = vi.fn()

    const active = [{ sessionId: `s1`, agentId: `claude`, agentName: `Claude Code`, waitingPermission: true }]

    const smokeGuard = new QuitGuard({
      getActiveSessions: () => active,
      dispose,
      confirmQuit,
      quitApp,
      forceExit,
      isSmokeRun: () => true,
    })
    smokeGuard.handleBeforeQuit(makeEvent())
    await flushMicrotasks()
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(quitApp).toHaveBeenCalledTimes(1)

    // Non-interactive OS shutdown / SIGINT / SIGTERM bypasses confirmation too.
    const signalGuard = new QuitGuard({
      getActiveSessions: () => active,
      dispose,
      confirmQuit,
      quitApp,
      forceExit,
    })
    signalGuard.requestNonInteractiveQuit()
    await flushMicrotasks()
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(quitApp).toHaveBeenCalledTimes(2)

    // Non-interactive signal arriving while a modal sheet is open disposes and force-exits.
    const midConfirmGuard = new QuitGuard({
      getActiveSessions: () => active,
      dispose,
      confirmQuit: () => new Promise(() => {}),
      quitApp,
      forceExit,
    })
    midConfirmGuard.handleWindowClose(makeEvent())
    expect(midConfirmGuard.currentState).toBe(`confirming`)
    midConfirmGuard.requestNonInteractiveQuit()
    await flushMicrotasks()
    expect(dispose).toHaveBeenCalledTimes(3)
    expect(forceExit).toHaveBeenCalledWith(0)
  })

  it(`forces exit when dispose exceeds bounded timeout`, async () => {
    const forceExit = vi.fn()
    const quitApp = vi.fn()

    const guard = new QuitGuard({
      getActiveSessions: () => [],
      dispose: () => new Promise(() => {}), // hangs forever
      confirmQuit: async () => true,
      quitApp,
      forceExit,
      disposeTimeoutMs: 60,
    })

    guard.handleBeforeQuit(makeEvent())
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(forceExit).toHaveBeenCalledWith(0)
    expect(quitApp).not.toHaveBeenCalled()
  })
})

describe(`acpHost active session tracking`, () => {
  it(`treats idle sessions as inactive, and running turns / pending permissions as active`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `md-acp-active-`))
    tempDirs.push(dataDir)

    let pendingPermId: string | null = null
    let resolvePermSeen!: () => void
    const permSeen = new Promise<void>((resolve) => {
      resolvePermSeen = resolve
    })

    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: `fake-active`,
          name: `Fake Active Agent`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: { FAKE_AGENT_REQUIRE_EDIT_PERMISSION: `1` },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `F`, color: `#5B5BD6` },
        },
      ],
      onEvent: (event) => {
        if (event.type === `permission_requested`) {
          pendingPermId = event.request.requestId
          resolvePermSeen()
        }
      },
    })
    openHosts.push(host)

    const started = await host.startSession({
      agentId: `fake-active`,
      permissionLevel: `ask`,
      postId: `p1`,
      postTitle: `Active Test`,
      content: `# Hello`,
    })

    // Started session with no running turn is idle -> NOT active.
    expect(host.hasActiveSession()).toBe(false)
    expect(host.getActiveSessions()).toEqual([])

    // Trigger prompt that pauses waiting for edit permission -> active + waitingPermission.
    const promptPromise = host.prompt({
      sessionId: started.sessionId,
      text: `Edit article`,
      content: `# Hello`,
      postTitle: `Active Test`,
    })
    await permSeen

    expect(host.hasActiveSession()).toBe(true)
    expect(host.getActiveSessions()).toEqual([
      {
        sessionId: started.sessionId,
        agentId: `fake-active`,
        agentName: `Fake Active Agent`,
        waitingPermission: true,
      },
    ])

    // Resolve permission and finish turn -> idle again.
    host.respondPermission({
      sessionId: started.sessionId,
      requestId: pendingPermId!,
      decision: `allow_once`,
    })
    await promptPromise

    expect(host.hasActiveSession()).toBe(false)
    expect(host.getActiveSessions()).toEqual([])
  })
})
