import type { Ref } from 'vue'

/**
 * Manages viewport-repositioning listeners and outside-click / Escape dismissal
 * for teleported floating menus (which live outside their trigger's DOM tree).
 */
export function useFloatingMenu(params: {
  isOpen: Ref<boolean>
  triggerRef: Ref<HTMLElement | null>
  menuRefs: Array<Ref<HTMLElement | null>>
  onReposition: () => void
  onClose: () => void
}): void {
  const { isOpen, triggerRef, menuRefs, onReposition, onClose } = params

  let resizeObserver: ResizeObserver | null = null
  let rafId = 0

  function scheduleReposition() {
    if (!isOpen.value)
      return
    if (rafId)
      return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (isOpen.value)
        onReposition()
    })
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
    }
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
    document.removeEventListener(`pointerdown`, handlePointerDown, true)
    document.removeEventListener(`keydown`, handleKeyDown, true)
  }

  watch(isOpen, (open) => {
    if (!open) {
      detachAll()
      return
    }
    window.addEventListener(`resize`, scheduleReposition)
    window.addEventListener(`scroll`, scheduleReposition, true)
    document.addEventListener(`pointerdown`, handlePointerDown, true)
    document.addEventListener(`keydown`, handleKeyDown, true)
    nextTick(() => {
      if (!isOpen.value)
        return
      onReposition()
      attachObservers()
      // Re-run once on the next frame in case fonts/layout settled after Teleport mount.
      scheduleReposition()
    })
  })

  // Re-attach ResizeObserver whenever an optional submenu ref mounts/unmounts while open.
  watch(menuRefs, () => {
    if (!isOpen.value)
      return
    nextTick(() => {
      if (!isOpen.value)
        return
      attachObservers()
      onReposition()
    })
  })

  onBeforeUnmount(() => {
    detachAll()
  })
}
