import type { AcpSlashCommand, DesktopUpdateState } from '@md/shared/types'
import type { Ref } from 'vue'
import type { TimelineDisplayBlock } from '@/lib/agent/timeline-blocks'
import { computed, ref, watch } from 'vue'

export function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

export function isAllowedExternalHref(rawHref: string | null | undefined): boolean {
  const trimmed = rawHref?.trim()
  if (!trimmed || !/^(?:https?:\/\/|mailto:)/i.test(trimmed))
    return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === `http:` || parsed.protocol === `https:` || parsed.protocol === `mailto:`
  }
  catch {
    return false
  }
}

export function commandToken(command: AcpSlashCommand): string {
  return command.name.startsWith(`$`) ? command.name : `/${command.name}`
}

export function parseSlashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text)
  return match ? match[1].toLowerCase() : null
}

export function matchSlashCommands(
  text: string,
  available: readonly AcpSlashCommand[],
  disabled = false,
): AcpSlashCommand[] {
  const query = parseSlashQuery(text)
  if (query === null || disabled)
    return []
  const key = (c: AcpSlashCommand) => c.name.replace(/^\$/, ``).toLowerCase()
  return available
    .filter(c => key(c).includes(query))
    .sort((a, b) => Number(!key(a).startsWith(query)) - Number(!key(b).startsWith(query)))
}

export function createSlashMenuController(options: {
  text: Ref<string>
  availableCommands: () => readonly AcpSlashCommand[]
  disabled: () => boolean
  running: () => boolean
  onInsertCommand: (command: AcpSlashCommand) => void
  onSubmit: () => void
}) {
  const isFocused = ref(false)
  const commandIndex = ref(0)
  const dismissedForQuery = ref<string | null>(null)

  const slashQuery = computed(() => parseSlashQuery(options.text.value))
  const matchedCommands = computed(() =>
    matchSlashCommands(options.text.value, options.availableCommands(), options.disabled()),
  )

  const isCommandMenuOpen = computed(() =>
    isFocused.value
    && slashQuery.value !== null
    && dismissedForQuery.value !== slashQuery.value
    && matchedCommands.value.length > 0,
  )

  // Only reset Escape dismissal when the user's slash query itself changes, so background probe
  // completions neither reopen an Escape-dismissed menu nor open on an unfocused textarea.
  watch(slashQuery, () => {
    dismissedForQuery.value = null
    commandIndex.value = 0
  })

  watch(matchedCommands, (next, prev) => {
    if (next.length === 0) {
      commandIndex.value = 0
      return
    }
    const prevActiveName = prev?.[commandIndex.value]?.name
    if (prevActiveName) {
      const preservedIdx = next.findIndex(c => c.name === prevActiveName)
      if (preservedIdx !== -1) {
        commandIndex.value = preservedIdx
        return
      }
    }
    if (commandIndex.value >= next.length)
      commandIndex.value = 0
  })

  function onFocus() {
    isFocused.value = true
  }

  function onBlur() {
    isFocused.value = false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (isImeComposing(event))
      return
    // Modified keys (e.g. Shift+Enter newline, Shift+Tab focus) keep their default behavior.
    if (isCommandMenuOpen.value && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const list = matchedCommands.value
      const count = list.length
      if (count > 0 && (event.key === `ArrowDown` || event.key === `ArrowUp`)) {
        event.preventDefault()
        commandIndex.value = (commandIndex.value + (event.key === `ArrowDown` ? 1 : -1) + count) % count
        return
      }
      if (count > 0 && (event.key === `Enter` || event.key === `Tab`)) {
        event.preventDefault()
        const target = list[Math.min(commandIndex.value, count - 1)]
        if (target)
          options.onInsertCommand(target)
        return
      }
      if (event.key === `Escape`) {
        event.preventDefault()
        event.stopPropagation()
        dismissedForQuery.value = slashQuery.value
        return
      }
    }
    if (event.key === `Enter` && !event.shiftKey) {
      event.preventDefault()
      if (!options.running())
        options.onSubmit()
    }
  }

  return {
    isFocused,
    commandIndex,
    slashQuery,
    matchedCommands,
    isCommandMenuOpen,
    onFocus,
    onBlur,
    handleKeydown,
  }
}

interface StabilizedBlockSnapshot {
  block: TimelineDisplayBlock
  signature: unknown[]
}

function getBlockSignature(block: TimelineDisplayBlock): unknown[] {
  switch (block.kind) {
    case `user`:
      return [block.kind, block.item, block.isTurnStart, block.item.text, block.item.attachments]
    case `assistant`:
      return [block.kind, block.item, block.item.text, block.item.thought, block.item.streaming, block.item.thoughtDurationMs]
    case `plan`:
      return [block.kind, block.item, block.item.entries, block.item.timestamp, block.item.entries.length, ...block.item.entries.map(e => `${e.status}:${e.content}`)]
    case `edit_tool`:
      return [block.kind, block.item, block.item.tool, block.item.tool.status, block.item.tool.error, block.item.tool.unifiedDiff]
    case `permission`:
      return [block.kind, block.item, block.item.request, block.item.resolvedOutcome]
    case `tool_group`:
      return [
        block.kind,
        block.hasRunning,
        block.hasFailed,
        block.failedCount,
        block.followedByContent,
        block.items.length,
        ...block.items.flatMap(entry => [entry, entry.tool, entry.tool.status, entry.tool.detail, entry.tool.error]),
      ]
    case `error_group`:
      return [block.kind, block.items.length, ...block.items.flatMap(entry => [entry, entry.message])]
  }
}

function signaturesMatch(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length)
    return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i]))
      return false
  }
  return true
}

/**
 * Reuses previous `TimelineDisplayBlock` wrapper references when captured snapshot values have not
 * changed, and allocates a fresh wrapper whenever an underlying reactive item mutates in place so
 * `v-memo` on `<AgentTimelineItem>` updates changed blocks while skipping unchanged ones.
 */
export function createTimelineBlockStabilizer() {
  let cachedSessionId: string | null | undefined
  let cachedById = new Map<string, StabilizedBlockSnapshot>()

  return function stabilize(
    sessionId: string | null | undefined,
    blocks: TimelineDisplayBlock[],
  ): TimelineDisplayBlock[] {
    if (sessionId !== cachedSessionId) {
      cachedSessionId = sessionId
      cachedById = new Map()
    }
    const nextCache = new Map<string, StabilizedBlockSnapshot>()
    const stabilized = blocks.map((block) => {
      const sig = getBlockSignature(block)
      const prev = cachedById.get(block.id)
      if (prev && signaturesMatch(prev.signature, sig)) {
        nextCache.set(block.id, prev)
        return prev.block
      }
      const freshBlock = prev?.block === block ? ({ ...block } as TimelineDisplayBlock) : block
      nextCache.set(block.id, { block: freshBlock, signature: sig })
      return freshBlock
    })
    cachedById = nextCache
    return stabilized
  }
}

const DATA_IMAGE_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i

export interface ManagedPreviewUrl {
  url: string
  revoke: (() => void) | null
}

/**
 * Converts base64 `data:image/...` strings into compact `blob:` object URLs so multi-megabyte
 * payloads are not retained inside Vue reactive state or serialized into DOM `src` attributes.
 */
export function createPreviewUrl(source: string | null | undefined): ManagedPreviewUrl {
  if (!source)
    return { url: ``, revoke: null }
  const match = DATA_IMAGE_URL_RE.exec(source.trim())
  if (!match || typeof URL === `undefined` || typeof URL.createObjectURL !== `function` || typeof atob !== `function`)
    return { url: source, revoke: null }

  try {
    const mimeType = match[1]
    const binary = atob(match[2].replace(/\s+/g, ``))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++)
      bytes[i] = binary.charCodeAt(i)
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    let revoked = false
    return {
      url: objectUrl,
      revoke: () => {
        if (!revoked) {
          revoked = true
          URL.revokeObjectURL(objectUrl)
        }
      },
    }
  }
  catch {
    return { url: source, revoke: null }
  }
}

const FOCUSABLE_SELECTOR = [
  `a[href]`,
  `button:not(:disabled)`,
  `input:not(:disabled)`,
  `select:not(:disabled)`,
  `textarea:not(:disabled)`,
  `[tabindex]:not([tabindex="-1"])`,
].join(`, `)

export function getFocusableDescendants(container: HTMLElement | null): HTMLElement[] {
  if (!container)
    return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    el => !el.hasAttribute(`disabled`) && !el.closest(`[inert], [aria-hidden="true"]`) && el.getClientRects().length > 0,
  )
}

export function trapTabFocus(event: KeyboardEvent, container: HTMLElement | null): boolean {
  if (event.key !== `Tab` || !container)
    return false
  // Yield focus management when a portaled popover/select or child dialog is open above container.
  const openOverlay = document.querySelector(`[data-reka-popper-content-wrapper], [role="dialog"]`)
  if (openOverlay && openOverlay !== container && !container.contains(openOverlay))
    return false

  const focusables = getFocusableDescendants(container)
  if (focusables.length === 0) {
    event.preventDefault()
    container.focus()
    return true
  }

  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement as HTMLElement | null

  if (!active || !container.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return true
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}

export function blurFocusedDescendant(container: HTMLElement | null | undefined): void {
  const active = typeof document !== `undefined` ? document.activeElement : null
  if (container && active instanceof HTMLElement && container.contains(active))
    active.blur()
}

export function shouldApplyUpdateCheckResult(
  current: DesktopUpdateState | null,
  next: DesktopUpdateState,
): boolean {
  if (!current)
    return true
  // Do not regress when an IPC push already advanced the same version further while `check()` resolved.
  if (current.status === `downloaded` && next.status !== `downloaded` && (!next.version || next.version === current.version))
    return false
  if (
    current.status === `downloading`
    && next.status === `downloading`
    && (!next.version || next.version === current.version)
    && typeof current.percent === `number`
    && (typeof next.percent !== `number` || next.percent < current.percent)
  ) {
    return false
  }
  return true
}
