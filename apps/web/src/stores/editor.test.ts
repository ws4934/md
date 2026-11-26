// @vitest-environment jsdom
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'

Object.assign(globalThis, {
  defineStore,
  ref,
  shallowRef,
  toast: { success: vi.fn(), error: vi.fn() },
})

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

describe(`useEditorStore.applyMinimalContent`, () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it(`dispatches only the minimal changed range, preserves scrollTop, and never splits UTF-16 surrogate pairs`, async () => {
    const { useEditorStore } = await import(`./editor`)
    const editorStore = useEditorStore()

    let docText = `Prefix 😀🚀 Suffix`
    const dispatched: Array<{ from: number, to: number, insert: string }> = []
    const scrollDOM = { scrollTop: 180 }

    editorStore.editor = {
      get state() {
        return {
          doc: {
            length: docText.length,
            toString: () => docText,
          },
        }
      },
      scrollDOM,
      dispatch: (tr: { changes: { from: number, to: number, insert: string } }) => {
        dispatched.push(tr.changes)
        docText = docText.slice(0, tr.changes.from) + tr.changes.insert + docText.slice(tr.changes.to)
        scrollDOM.scrollTop = 0
      },
    } as never

    // 😀 (\uD83D\uDE00) -> 😎 (\uD83D\uDE0E) shares high surrogate 0xD83D;
    // 🚀 (\uD83D\uDE80) -> 🛸 (\uD83D\uDEF8); 🠀/🧿: test shared low surrogate too (\uD83D\uDE00 vs \uD83E\uDE00 = 🪀).
    editorStore.applyMinimalContent(`Prefix 😎🪀 Suffix`)

    expect(docText).toBe(`Prefix 😎🪀 Suffix`)
    expect(scrollDOM.scrollTop).toBe(180)
    expect(dispatched).toHaveLength(1)
    const [{ from, to, insert }] = dispatched
    expect(from).toBe(`Prefix `.length)
    expect(to).toBe(`Prefix 😀🚀`.length)
    expect(insert).toBe(`😎🪀`)
    // Verify insert contains no lone surrogates.
    const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(insert)
    expect(hasLoneSurrogate).toBe(false)
  })
})
