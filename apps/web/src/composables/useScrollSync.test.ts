// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, toValue, watchEffect } from 'vue'

Object.assign(globalThis, {
  toValue,
  watchEffect,
})

describe(`useScrollSync`, () => {
  const originalRaf = globalThis.requestAnimationFrame
  const originalCaf = globalThis.cancelAnimationFrame
  let flushRaf: () => void

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
    flushRaf = () => {
      for (let guard = 0; guard < 10 && callbacks.size > 0; guard++) {
        const frame = [...callbacks.values()]
        callbacks.clear()
        for (const cb of frame)
          cb(16)
      }
    }
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCaf
  })

  it(`recomputes preview block offsets when scrollHeight changes without DOM childList mutations or after re-enabling`, async () => {
    const { useScrollSync } = await import(`./useScrollSync`)

    const preview = document.createElement(`div`)
    const output = document.createElement(`section`)
    output.id = `output`
    const container = document.createElement(`section`)
    container.className = `container`
    const p1 = document.createElement(`p`)
    const p2 = document.createElement(`p`)
    container.append(p1, p2)
    output.appendChild(container)
    preview.appendChild(output)

    let currentPreviewScrollHeight = 1000
    let p2OffsetTop = 200
    Object.defineProperty(preview, `clientHeight`, { value: 400, configurable: true })
    Object.defineProperty(preview, `scrollHeight`, { get: () => currentPreviewScrollHeight, configurable: true })
    Object.defineProperty(p1, `offsetParent`, { get: () => preview, configurable: true })
    Object.defineProperty(p2, `offsetParent`, { get: () => preview, configurable: true })
    Object.defineProperty(p1, `offsetTop`, { value: 0, configurable: true })
    Object.defineProperty(p2, `offsetTop`, { get: () => p2OffsetTop, configurable: true })

    const scroller = document.createElement(`div`)
    Object.defineProperty(scroller, `clientHeight`, { value: 400, configurable: true })
    Object.defineProperty(scroller, `scrollHeight`, { value: 1000, configurable: true })
    scroller.scrollTop = 300

    const docLines = [`Block 1`, ``, `Block 2`]
    const fakeView = {
      scrollDOM: scroller,
      state: {
        doc: {
          lines: docLines.length,
          iterLines: () => docLines,
          line: (n: number) => ({ text: docLines[n - 1] ?? ``, from: n * 10 }),
          lineAt: () => ({ number: 3 }),
        },
      },
      lineBlockAtHeight: () => ({ from: 20 }),
      lineBlockAt: () => ({ top: 300 }),
    }

    const enableScrollSync = ref(true)
    const scope = effectScope()
    scope.run(() => {
      useScrollSync(() => fakeView as never, () => preview, enableScrollSync)
    })
    await nextTick()

    scroller.dispatchEvent(new Event(`scroll`))
    flushRaf()
    expect(preview.scrollTop).toBe(200)

    // Simulate an image finishing load inside p1: scrollHeight and p2.offsetTop grow without childList mutations.
    currentPreviewScrollHeight = 1400
    p2OffsetTop = 520
    scroller.scrollTop = 320
    scroller.dispatchEvent(new Event(`scroll`))
    flushRaf()
    expect(preview.scrollTop).toBe(520)

    // Toggle scroll sync off, replace DOM while observer is detached, then re-enable.
    enableScrollSync.value = false
    await nextTick()
    p2OffsetTop = 410
    enableScrollSync.value = true
    await nextTick()
    scroller.scrollTop = 340
    scroller.dispatchEvent(new Event(`scroll`))
    flushRaf()
    expect(preview.scrollTop).toBe(410)

    scope.stop()
  })
})
