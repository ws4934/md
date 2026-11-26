// @vitest-environment jsdom
import type { AcpSlashCommand, DesktopUpdateState } from '@md/shared/types'
import type { AgentTimelineItem } from '@/stores/agent'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import { groupTimelineItems } from '@/lib/agent/timeline-blocks'
import {
  blurFocusedDescendant,
  createPreviewUrl,
  createSlashMenuController,
  createTimelineBlockStabilizer,
  isAllowedExternalHref,
  matchSlashCommands,
  shouldApplyUpdateCheckResult,
  trapTabFocus,
} from './agent-ui-helpers'

function makeVisible(el: HTMLElement) {
  Object.defineProperty(el, `getClientRects`, {
    configurable: true,
    value: () => [{ width: 40, height: 24 }],
  })
}

function keyEvent(
  key: string,
  init: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  const { keyCode, ...rest } = init
  const event = new KeyboardEvent(`keydown`, {
    key,
    bubbles: true,
    cancelable: true,
    ...rest,
  })
  if (keyCode !== undefined) {
    Object.defineProperty(event, `keyCode`, { value: keyCode })
  }
  return event
}

afterEach(() => {
  document.body.replaceChildren()
  document.body.focus()
  vi.restoreAllMocks()
})

describe(`createSlashMenuController & matchSlashCommands`, () => {
  const baseCommands: AcpSlashCommand[] = [
    { name: `review`, description: `Review article` },
    { name: `wechat-minsheng`, description: `Minsheng workflow` },
    { name: `$image-gen`, description: `Codex skill` },
  ]

  it(`sorts prefix matches ahead of substring matches and strips leading $`, () => {
    const matched = matchSlashCommands(`/in`, [
      { name: `minsheng` },
      { name: `intro` },
      { name: `$inline` },
    ])
    expect(matched.map(c => c.name)).toEqual([`intro`, `$inline`, `minsheng`])
  })

  it(`does not open on an unfocused textarea when probe commands arrive asynchronously`, async () => {
    const text = ref(`/we`)
    const commands = ref<AcpSlashCommand[]>([])
    const ctrl = createSlashMenuController({
      text,
      availableCommands: () => commands.value,
      disabled: () => false,
      running: () => false,
      onInsertCommand: vi.fn(),
      onSubmit: vi.fn(),
    })

    ctrl.onFocus()
    ctrl.onBlur()
    expect(ctrl.isCommandMenuOpen.value).toBe(false)

    // Probe resolves after textarea already blurred.
    commands.value = [...baseCommands]
    await nextTick()
    expect(ctrl.isCommandMenuOpen.value).toBe(false)
  })

  it(`keeps Escape dismissal when availableCommands refreshes for the same query, and reopens on query edit`, async () => {
    const text = ref(`/`)
    const commands = ref<AcpSlashCommand[]>([baseCommands[0]])
    const ctrl = createSlashMenuController({
      text,
      availableCommands: () => commands.value,
      disabled: () => false,
      running: () => false,
      onInsertCommand: vi.fn(),
      onSubmit: vi.fn(),
    })

    ctrl.onFocus()
    await nextTick()
    expect(ctrl.isCommandMenuOpen.value).toBe(true)

    const parentEscape = vi.fn()
    window.addEventListener(`keydown`, parentEscape)
    const esc = keyEvent(`Escape`)
    window.dispatchEvent(new CustomEvent(`noop`))
    ctrl.handleKeydown(esc)
    expect(esc.defaultPrevented).toBe(true)
    expect(ctrl.isCommandMenuOpen.value).toBe(false)
    window.removeEventListener(`keydown`, parentEscape)

    // Probe finishes and updates commands while query is still `/`.
    commands.value = [...baseCommands]
    await nextTick()
    expect(ctrl.isCommandMenuOpen.value).toBe(false)

    // User continues typing `/w` -> menu reopens cleanly with prefix match sorted ahead of substring match.
    text.value = `/w`
    await nextTick()
    expect(ctrl.isCommandMenuOpen.value).toBe(true)
    expect(ctrl.matchedCommands.value.map(c => c.name)).toEqual([`wechat-minsheng`, `review`])
  })

  it(`preserves active command selection across background command refreshes and inserts on Tab/Enter`, async () => {
    const text = ref(`/`)
    const commands = ref<AcpSlashCommand[]>([
      { name: `alpha` },
      { name: `wechat-minsheng` },
    ])
    const inserted: AcpSlashCommand[] = []
    const ctrl = createSlashMenuController({
      text,
      availableCommands: () => commands.value,
      disabled: () => false,
      running: () => false,
      onInsertCommand: cmd => inserted.push(cmd),
      onSubmit: vi.fn(),
    })

    ctrl.onFocus()
    await nextTick()
    ctrl.handleKeydown(keyEvent(`ArrowDown`))
    expect(ctrl.commandIndex.value).toBe(1)

    // New command inserted before `wechat-minsheng` when probe updates.
    commands.value = [
      { name: `alpha` },
      { name: `beta` },
      { name: `wechat-minsheng` },
    ]
    await nextTick()
    expect(ctrl.commandIndex.value).toBe(2)

    ctrl.handleKeydown(keyEvent(`Tab`))
    expect(inserted).toEqual([{ name: `wechat-minsheng` }])
  })

  it(`ignores Enter during IME composition (isComposing and keyCode 229)`, async () => {
    const text = ref(`/review`)
    const onInsertCommand = vi.fn()
    const onSubmit = vi.fn()
    const ctrl = createSlashMenuController({
      text,
      availableCommands: () => baseCommands,
      disabled: () => false,
      running: () => false,
      onInsertCommand,
      onSubmit,
    })
    ctrl.onFocus()
    await nextTick()

    ctrl.handleKeydown(keyEvent(`Enter`, { isComposing: true }))
    ctrl.handleKeydown(keyEvent(`Enter`, { keyCode: 229 }))
    expect(onInsertCommand).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()

    // Non-slash plain Enter submits once IME composition finishes.
    text.value = `写一段导语`
    await nextTick()
    ctrl.handleKeydown(keyEvent(`Enter`, { isComposing: true }))
    expect(onSubmit).not.toHaveBeenCalled()

    ctrl.handleKeydown(keyEvent(`Enter`))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe(`createTimelineBlockStabilizer`, () => {
  it(`preserves previous block object references while the tail assistant message streams`, () => {
    const stabilize = createTimelineBlockStabilizer()
    const items = reactive<AgentTimelineItem[]>([
      { type: `user`, id: `u1`, text: `Polish intro`, timestamp: 1 },
      {
        type: `tool_call`,
        id: `t1`,
        tool: { id: `t1`, title: `Read article.md`, toolKind: `read`, status: `completed`, filePath: `article.md` },
        timestamp: 2,
      },
      {
        type: `tool_call`,
        id: `t2`,
        tool: { id: `t2`, title: `Edit article.md`, toolKind: `edit`, status: `completed`, filePath: `article.md`, unifiedDiff: `+hello` },
        timestamp: 3,
      },
      { type: `assistant`, id: `a1`, text: `First`, streaming: true, timestamp: 4 },
    ])

    const firstPass = stabilize(`s1`, groupTimelineItems(items))
    expect(firstPass).toHaveLength(4)

    // Append streamed delta in place (matching useAgentStore.applyChunkDelta).
    const tail = items[3]
    if (tail.type === `assistant`)
      tail.text += ` chunk`

    const secondPass = stabilize(`s1`, groupTimelineItems(items))
    expect(secondPass[0]).toBe(firstPass[0])
    expect(secondPass[1]).toBe(firstPass[1])
    expect(secondPass[2]).toBe(firstPass[2])
    expect(secondPass[3]).not.toBe(firstPass[3])
  })

  it(`does not reuse block references across different session IDs with colliding tool IDs`, () => {
    const stabilize = createTimelineBlockStabilizer()
    const itemA: AgentTimelineItem = {
      type: `tool_call`,
      id: `call_1`,
      tool: { id: `call_1`, title: `Read a.md`, toolKind: `read`, status: `completed` },
      timestamp: 1,
    }
    const itemB: AgentTimelineItem = {
      type: `tool_call`,
      id: `call_1`,
      tool: { id: `call_1`, title: `Read b.md`, toolKind: `read`, status: `completed` },
      timestamp: 2,
    }
    const s1Blocks = stabilize(`session-a`, groupTimelineItems([itemA]))
    const s2Blocks = stabilize(`session-b`, groupTimelineItems([itemB]))
    expect(s1Blocks[0].id).toBe(s2Blocks[0].id)
    expect(s2Blocks[0]).not.toBe(s1Blocks[0])
  })
})

describe(`isAllowedExternalHref`, () => {
  it(`allows http, https, and mailto URLs and blocks relative, file, javascript, and data URLs`, () => {
    expect(isAllowedExternalHref(`https://md.doocs.org/docs`)).toBe(true)
    expect(isAllowedExternalHref(`http://localhost:3000`)).toBe(true)
    expect(isAllowedExternalHref(`mailto:team@example.com`)).toBe(true)

    expect(isAllowedExternalHref(`javascript:alert(1)`)).toBe(false)
    expect(isAllowedExternalHref(`file:///Users/test/secret.txt`)).toBe(false)
    expect(isAllowedExternalHref(`/relative/path.html`)).toBe(false)
    expect(isAllowedExternalHref(`data:text/html,<script>alert(1)</script>`)).toBe(false)
    expect(isAllowedExternalHref(``)).toBe(false)
  })
})

describe(`createPreviewUrl`, () => {
  it(`converts base64 data:image URLs to revocable blob: URLs and leaves https URLs untouched`, () => {
    const createSpy = vi.spyOn(URL, `createObjectURL`).mockReturnValue(`blob:md-preview-1`)
    const revokeSpy = vi.spyOn(URL, `revokeObjectURL`).mockImplementation(() => {})

    const onePxPng = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`
    const managed = createPreviewUrl(onePxPng)
    expect(managed.url).toBe(`blob:md-preview-1`)
    expect(createSpy).toHaveBeenCalledTimes(1)

    managed.revoke?.()
    managed.revoke?.()
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledWith(`blob:md-preview-1`)

    const remote = createPreviewUrl(`https://cdn.example.com/cover.jpg`)
    expect(remote).toEqual({ url: `https://cdn.example.com/cover.jpg`, revoke: null })
  })
})

describe(`trapTabFocus & blurFocusedDescendant`, () => {
  it(`cycles Tab and Shift+Tab inside the modal container and pulls escaped focus back in`, () => {
    const outside = document.createElement(`button`)
    makeVisible(outside)
    const dialog = document.createElement(`div`)
    dialog.setAttribute(`role`, `dialog`)
    const first = document.createElement(`input`)
    const second = document.createElement(`button`)
    makeVisible(first)
    makeVisible(second)
    dialog.append(first, second)
    document.body.append(outside, dialog)

    outside.focus()
    const tabFromOutside = keyEvent(`Tab`)
    expect(trapTabFocus(tabFromOutside, dialog)).toBe(true)
    expect(tabFromOutside.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    second.focus()
    const tabAtEnd = keyEvent(`Tab`)
    expect(trapTabFocus(tabAtEnd, dialog)).toBe(true)
    expect(document.activeElement).toBe(first)

    first.focus()
    const shiftTabAtStart = keyEvent(`Tab`, { shiftKey: true })
    expect(trapTabFocus(shiftTabAtStart, dialog)).toBe(true)
    expect(document.activeElement).toBe(second)
  })

  it(`blurs focused element inside a collapsing panel without disturbing focus outside`, () => {
    const panel = document.createElement(`div`)
    const panelBtn = document.createElement(`button`)
    const editorBtn = document.createElement(`button`)
    panel.append(panelBtn)
    document.body.append(panel, editorBtn)

    panelBtn.focus()
    blurFocusedDescendant(panel)
    expect(document.activeElement).toBe(document.body)

    editorBtn.focus()
    blurFocusedDescendant(panel)
    expect(document.activeElement).toBe(editorBtn)
  })
})

describe(`shouldApplyUpdateCheckResult`, () => {
  it(`does not overwrite a newer downloaded or higher-percent downloading push with a stale check reply`, () => {
    const downloaded: DesktopUpdateState = {
      supported: true,
      mode: `install`,
      currentVersion: `1.0.0`,
      status: `downloaded`,
      version: `1.1.0`,
    }
    const staleDownloading: DesktopUpdateState = {
      supported: true,
      mode: `install`,
      currentVersion: `1.0.0`,
      status: `downloading`,
      version: `1.1.0`,
    }
    expect(shouldApplyUpdateCheckResult(downloaded, staleDownloading)).toBe(false)

    const midDownload: DesktopUpdateState = {
      ...staleDownloading,
      percent: 45,
    }
    expect(shouldApplyUpdateCheckResult(midDownload, staleDownloading)).toBe(false)
    expect(shouldApplyUpdateCheckResult(midDownload, { ...staleDownloading, percent: 80 })).toBe(true)
    expect(shouldApplyUpdateCheckResult(midDownload, downloaded)).toBe(true)
  })
})

describe(`agent SFC template contracts`, () => {
  it(`passes :avatar to AgentAvatar in AgentPanel rather than unsupported :letter/:color props`, () => {
    const panelSrc = fs.readFileSync(path.resolve(__dirname, `./AgentPanel.vue`), `utf8`)
    expect(panelSrc).toContain(`:avatar="selectedAgent.avatar"`)
    expect(panelSrc).not.toContain(`:letter="selectedAgent.avatar.letter"`)
  })
})
