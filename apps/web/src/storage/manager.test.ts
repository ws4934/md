// @vitest-environment jsdom
import type { StorageEngine } from './engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { StorageManager } from './manager'

function createMockEngine(initial: Record<string, string> = {}): StorageEngine & {
  data: Map<string, string>
  setCalls: Array<[string, string]>
} {
  const data = new Map<string, string>(Object.entries(initial))
  const setCalls: Array<[string, string]> = []
  return {
    data,
    setCalls,
    supportsSyncRead: () => true,
    getSync: key => data.get(key) ?? null,
    get: async key => data.get(key) ?? null,
    set: async (key, value) => {
      setCalls.push([key, value])
      data.set(key, value)
    },
    remove: async (key) => {
      data.delete(key)
    },
    has: async key => data.has(key),
    clear: async () => {
      data.clear()
    },
    keys: async () => [...data.keys()],
  }
}

describe(`storageManager.reactive`, () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it(`registers a single pagehide listener and deduplicates reactive refs/watchers per key`, async () => {
    const addListenerSpy = vi.spyOn(window, `addEventListener`)
    const mgr = new StorageManager()
    const engine = createMockEngine()
    mgr.setEngine(engine)

    const refA1 = mgr.reactive(`shared_key`, `init`)
    const refA2 = mgr.reactive(`shared_key`, `init`)
    const refB = mgr.reactive(`other_key`, 1)

    expect(refA1).toBe(refA2)
    const pagehideRegistrations = addListenerSpy.mock.calls.filter(([event]) => event === `pagehide`)
    expect(pagehideRegistrations).toHaveLength(1)

    refA1.value = `next`
    await nextTick()
    expect(mgr.getSync(`shared_key`)).toBe(`next`)

    await vi.advanceTimersByTimeAsync(350)
    expect(engine.setCalls.filter(([key]) => key === `shared_key`)).toHaveLength(1)

    refA2.value = `before-hide`
    refB.value = 42
    await nextTick()

    window.dispatchEvent(new Event(`pagehide`))
    const backup = JSON.parse(localStorage.getItem(`MD__pending_writes_backup`) ?? `{}`)
    expect(backup).toEqual({
      shared_key: `before-hide`,
      other_key: `42`,
    })

    addListenerSpy.mockRestore()
  })

  it(`stops the per-key watcher once all owning effect scopes dispose`, async () => {
    const mgr = new StorageManager()
    const engine = createMockEngine({ scoped_key: `v1` })
    mgr.setEngine(engine)

    const scope1 = effectScope()
    const scope2 = effectScope()
    const r1 = scope1.run(() => mgr.reactive(`scoped_key`, `default`))!
    const r2 = scope2.run(() => mgr.reactive(`scoped_key`, `default`))!
    expect(r1).toBe(r2)
    expect(r1.value).toBe(`v1`)

    // Disposing only one consumer scope keeps the shared watcher active.
    scope1.stop()
    r2.value = `v2`
    await nextTick()
    await vi.advanceTimersByTimeAsync(350)
    expect(engine.data.get(`scoped_key`)).toBe(`v2`)

    // Disposing the last consumer scope cleans up the entry and watcher.
    scope2.stop()
    const prevSetCount = engine.setCalls.length
    r2.value = `stale-after-stop`
    await nextTick()
    await vi.advanceTimersByTimeAsync(350)
    expect(engine.setCalls).toHaveLength(prevSetCount)
  })
})
