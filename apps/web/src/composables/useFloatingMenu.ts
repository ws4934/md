import type { CSSProperties, Ref, WatchSource } from 'vue'
import {
  computeFloatingMenuPosition,
  isFloatingAnchorHidden,
  scrollActiveOptionIntoView,
  toFloatingBoxStyle,
} from '@/lib/agent/floating-menu'

function getFocusableMenuButtons(panel: HTMLElement | null | undefined): HTMLButtonElement[] {
  if (!panel)
    return []
  return Array.from(panel.querySelectorAll<HTMLButtonElement>(`button:not(:disabled)`))
}

function focusPreferredButton(panel: HTMLElement | null | undefined, fallbackEdge: `first` | `last` = `first`): void {
  const buttons = getFocusableMenuButtons(panel)
  if (buttons.length === 0)
    return
  const active = buttons.find(btn => btn.dataset.active === `true`)
  const target = active ?? (fallbackEdge === `last` ? buttons[buttons.length - 1] : buttons[0])
  target?.focus()
}

/**
 * Manages viewport-repositioning listeners, active-item scrolling, keyboard navigation,
 * hidden/disabled auto-dismissal, and outside-click / Escape dismissal for teleported menus.
 */
export function useFloatingMenu(params: {
  isOpen: Ref<boolean>
  triggerRef: Ref<HTMLElement | null>
  menuRefs: Array<Ref<HTMLElement | null>>
  onReposition: () => void
  onClose: () => void
  disabled?: Ref<boolean> | (() => boolean)
  closeOnChange?: WatchSource<unknown>
}): void {
  const { isOpen, triggerRef, menuRefs, onReposition, onClose, disabled, closeOnChange } = params

  let resizeObserver: ResizeObserver | null = null
  let rafId = 0

  function isTriggerUnavailable(): boolean {
    const trigger = triggerRef.value
    if (!trigger || !trigger.isConnected)
      return true
    if (trigger.closest(`[aria-hidden="true"], [data-aria-hidden="true"]`))
      return true
    return isFloatingAnchorHidden(trigger.getBoundingClientRect())
  }

  function runRepositionOrClose(): boolean {
    if (!isOpen.value)
      return false
    if (isTriggerUnavailable()) {
      onClose()
      return false
    }
    onReposition()
    return true
  }

  function scheduleReposition() {
    if (!isOpen.value || rafId)
      return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      runRepositionOrClose()
    })
  }

  function handleWindowBlur() {
    if (isOpen.value)
      onClose()
  }

  function handlePointerDown(event: PointerEvent) {
    if (!isOpen.value)
      return
    const target = event.target as Node | null
    if (!target)
      return
    if (triggerRef.value?.contains(target))
      return
    for (const refEl of menuRefs) {
      if (refEl.value?.contains(target))
        return
    }
    onClose()
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (!isOpen.value)
      return

    if (event.key === `Escape`) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      triggerRef.value?.focus()
      return
    }

    const activeEl = document.activeElement as HTMLElement | null
    const mountedPanels = menuRefs.map(r => r.value).filter((el): el is HTMLElement => Boolean(el))
    if (mountedPanels.length === 0)
      return

    const currentPanelIdx = mountedPanels.findIndex(panel => activeEl && panel.contains(activeEl))

    if ((event.key === `ArrowLeft` || event.key === `ArrowRight`) && mountedPanels.length > 1) {
      event.preventDefault()
      const primary = mountedPanels[0]
      const submenu = mountedPanels[1]
      const primaryLeft = primary.getBoundingClientRect().left
      const submenuLeft = submenu.getBoundingClientRect().left
      const leftPanel = submenuLeft < primaryLeft ? submenu : primary
      const rightPanel = submenuLeft < primaryLeft ? primary : submenu
      const targetPanel = event.key === `ArrowLeft` ? leftPanel : rightPanel
      if (activeEl && targetPanel.contains(activeEl))
        return
      focusPreferredButton(targetPanel)
      return
    }

    if (
      event.key !== `ArrowDown`
      && event.key !== `ArrowUp`
      && event.key !== `Home`
      && event.key !== `End`
    ) {
      return
    }

    event.preventDefault()
    const targetPanel = currentPanelIdx >= 0
      ? mountedPanels[currentPanelIdx]
      : mountedPanels[mountedPanels.length - 1]
    const buttons = getFocusableMenuButtons(targetPanel)
    if (buttons.length === 0)
      return

    const focusedIdx = activeEl ? buttons.indexOf(activeEl as HTMLButtonElement) : -1
    if (event.key === `Home`) {
      buttons[0].focus()
      return
    }
    if (event.key === `End`) {
      buttons[buttons.length - 1].focus()
      return
    }

    if (focusedIdx === -1) {
      focusPreferredButton(targetPanel, event.key === `ArrowUp` ? `last` : `first`)
      return
    }

    const delta = event.key === `ArrowDown` ? 1 : -1
    const nextIdx = (focusedIdx + delta + buttons.length) % buttons.length
    buttons[nextIdx].focus()
  }

  function attachObservers() {
    if (typeof ResizeObserver === `undefined`)
      return
    resizeObserver?.disconnect()
    resizeObserver = new ResizeObserver(() => scheduleReposition())
    if (triggerRef.value)
      resizeObserver.observe(triggerRef.value)
    for (const refEl of menuRefs) {
      if (refEl.value)
        resizeObserver.observe(refEl.value)
    }
  }

  function detachAll() {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    resizeObserver?.disconnect()
    resizeObserver = null
    window.removeEventListener(`resize`, scheduleReposition)
    window.removeEventListener(`scroll`, scheduleReposition, true)
    window.removeEventListener(`blur`, handleWindowBlur)
    document.removeEventListener(`pointerdown`, handlePointerDown, true)
    document.removeEventListener(`keydown`, handleKeyDown, true)
  }

  if (disabled) {
    watch(disabled, (isDisabled) => {
      if (isDisabled && isOpen.value)
        onClose()
    })
  }

  if (closeOnChange) {
    watch(closeOnChange, () => {
      if (isOpen.value)
        onClose()
    })
  }

  watch(isOpen, (open) => {
    if (!open) {
      detachAll()
      return
    }
    window.addEventListener(`resize`, scheduleReposition)
    window.addEventListener(`scroll`, scheduleReposition, true)
    window.addEventListener(`blur`, handleWindowBlur)
    document.addEventListener(`pointerdown`, handlePointerDown, true)
    document.addEventListener(`keydown`, handleKeyDown, true)
    nextTick(() => {
      if (!runRepositionOrClose())
        return
      attachObservers()
      for (const refEl of menuRefs)
        scrollActiveOptionIntoView(refEl.value)
      // Re-run once on the next frame in case fonts/maxHeight settled after Teleport mount.
      requestAnimationFrame(() => {
        if (!runRepositionOrClose())
          return
        for (const refEl of menuRefs)
          scrollActiveOptionIntoView(refEl.value)
      })
    })
  })

  // Re-attach ResizeObserver whenever an optional submenu ref mounts/unmounts while open.
  watch(menuRefs, () => {
    if (!isOpen.value)
      return
    nextTick(() => {
      if (!runRepositionOrClose())
        return
      attachObservers()
      for (const refEl of menuRefs)
        scrollActiveOptionIntoView(refEl.value)
    })
  })

  onBeforeUnmount(() => {
    detachAll()
  })
}

export function useSingleFloatingMenu(params: {
  triggerRef: Ref<HTMLElement | null>
  menuRef: Ref<HTMLElement | null>
  placement: () => `up` | `down`
  disabled?: () => boolean
  closeOnChange?: WatchSource<unknown>
  menuWidth: number
  estimateHeight: () => number
  preferredAlign?: `start` | `end` | `center`
}): {
  isOpen: Ref<boolean>
  menuStyle: Ref<CSSProperties>
  closeMenu: () => void
  toggleMenu: () => void
} {
  const { triggerRef, menuRef } = params
  const isOpen = ref(false)
  const menuStyle = ref<CSSProperties>({})

  function updateMenuPosition() {
    const trigger = triggerRef.value
    if (!trigger)
      return
    const anchor = trigger.getBoundingClientRect()
    const rect = menuRef.value?.getBoundingClientRect()
    const pos = computeFloatingMenuPosition({
      anchor,
      menu: {
        width: rect?.width || params.menuWidth,
        height: rect?.height || params.estimateHeight(),
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      preferredSide: params.placement() === `up` ? `top` : `bottom`,
      preferredAlign: params.preferredAlign ?? `start`,
    })
    menuStyle.value = toFloatingBoxStyle(pos)
  }

  function closeMenu() {
    isOpen.value = false
  }

  function toggleMenu() {
    if (params.disabled?.())
      return
    if (isOpen.value) {
      closeMenu()
      return
    }
    updateMenuPosition()
    isOpen.value = true
  }

  useFloatingMenu({
    isOpen,
    triggerRef,
    menuRefs: [menuRef],
    onReposition: updateMenuPosition,
    onClose: closeMenu,
    disabled: params.disabled,
    closeOnChange: params.closeOnChange,
  })

  return {
    isOpen,
    menuStyle,
    closeMenu,
    toggleMenu,
  }
}
