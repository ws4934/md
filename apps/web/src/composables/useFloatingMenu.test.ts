// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, onBeforeUnmount, ref, watch } from 'vue'

Object.assign(globalThis, {
  ref,
  nextTick,
  onBeforeUnmount,
  watch,
})

describe(`useFloatingMenu`, () => {
  const originalRaf = globalThis.requestAnimationFrame
  const originalCaf = globalThis.cancelAnimationFrame

  beforeEach(() => {
    let nextId = 1
    const callbacks = new Map<number, FrameRequestCallback>()
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextId++
      callbacks.set(id, cb)
      return id
    })
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      callbacks.delete(id)
    })
    ;(globalThis as unknown as { __flushRaf: () => void }).__flushRaf = () => {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const cb of pending)
        cb(16)
    }
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCaf
    delete (globalThis as unknown as { __flushRaf?: () => void }).__flushRaf
  })

  it(`cancels pending settle requestAnimationFrame when closed before the next frame`, async () => {
    const { useFloatingMenu } = await import(`./useFloatingMenu`)

    const trigger = document.createElement(`button`)
    vi.spyOn(trigger, `getBoundingClientRect`).mockReturnValue({
      left: 10,
      right: 90,
      top: 10,
      bottom: 40,
      width: 80,
      height: 30,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    })
    document.body.appendChild(trigger)

    const isOpen = ref(false)
    const triggerRef = ref<HTMLElement | null>(trigger)
    const menuRef = ref<HTMLElement | null>(document.createElement(`div`))
    const onReposition = vi.fn()
    const onClose = vi.fn(() => { isOpen.value = false })

    const scope = effectScope()
    scope.run(() => {
      useFloatingMenu({
        isOpen,
        triggerRef,
        menuRefs: [menuRef],
        onReposition,
        onClose,
      })
    })

    isOpen.value = true
    await nextTick()
    await nextTick()
    expect(onReposition).toHaveBeenCalledTimes(1)

    // Close immediately before the post-mount settle frame runs.
    isOpen.value = false
    await nextTick()
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled()

    onReposition.mockClear()
    ;(globalThis as unknown as { __flushRaf: () => void }).__flushRaf()
    expect(onReposition).not.toHaveBeenCalled()

    scope.stop()
    trigger.remove()
  })
})
