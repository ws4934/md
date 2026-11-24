// @vitest-environment jsdom
import type { Ref } from 'vue'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, watch } from 'vue'

Object.assign(globalThis, { defineStore, nextTick, onUnmounted: () => {} })

const state = vi.hoisted(() => ({
  viewMode: `split` as `edit` | `split` | `preview`,
  content: `# Initial`,
  isDirty: false,
  output: `<p>Initial</p>`,
  renderVersion: null as Ref<number> | null,
  exportHTMLSeenDom: ``,
}))

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/stores/ui`, () => ({
  useUIStore: () => ({
    get viewMode() {
      return state.viewMode
    },
    previewDevice: `desktop`,
  }),
}))

vi.mock(`@/stores/theme`, () => ({
  useThemeStore: () => ({
    updateCodeTheme: vi.fn(),
  }),
}))

vi.mock(`@/stores/editor`, () => ({
  useEditorStore: () => ({
    getContent: () => state.content,
  }),
}))

vi.mock(`@/stores/post`, () => ({
  usePostStore: () => ({
    currentPost: { id: `p1`, title: `Test Post` },
  }),
}))

vi.mock(`@/stores/render`, () => ({
  useRenderStore: () => ({
    get isDirty() {
      return state.isDirty
    },
    get output() {
      return state.output
    },
    markDirty: () => {
      state.isDirty = true
    },
    render: (raw: string) => {
      state.output = `<p>${raw}</p>`
      state.isDirty = false
      if (state.renderVersion)
        state.renderVersion.value++
    },
  }),
}))

vi.mock(`@/services/export`, () => ({
  DEFAULT_PNG_SEGMENT_HEIGHT: 1200,
  downloadMD: vi.fn(),
  exportPureHTML: vi.fn(),
  exportPNG: vi.fn(),
  exportPNGSegments: vi.fn(),
  exportPDF: vi.fn(),
  getHtmlContent: () => document.getElementById(`output`)?.innerHTML ?? ``,
  exportHTML: vi.fn(async () => {
    state.exportHTMLSeenDom = document.getElementById(`output`)?.innerHTML ?? ``
  }),
}))

describe(`debounced dirty marking and async export DOM flush`, () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    state.viewMode = `split`
    state.content = `# Initial`
    state.isDirty = false
    state.output = `<p># Initial</p>`
    state.exportHTMLSeenDom = ``
    state.renderVersion = ref(0)
    document.body.innerHTML = `<section id="output"><p># Initial</p></section>`
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ``
  })

  it(`marks renderStore dirty immediately when scheduling a debounced refresh in split mode`, async () => {
    const { useEditorRefresh } = await import(`@/composables/useEditorRefresh`)
    const { scheduleEditorRefresh } = useEditorRefresh({ debounceMs: 300, maxWaitMs: 800 })

    state.content = `# Updated during debounce`
    scheduleEditorRefresh()

    // Before the 300ms debounce timer fires, isDirty must already be true.
    expect(state.isDirty).toBe(true)

    vi.advanceTimersByTime(300)
    expect(state.isDirty).toBe(false)
    expect(state.output).toBe(`<p># Updated during debounce</p>`)
  })

  it(`waits for post-flush DOM patch before reading #output during export`, async () => {
    // Mirror PreviewPanel's flush: 'post' watcher patching #output from renderVersion.
    const stop = watch(state.renderVersion!, () => {
      const el = document.getElementById(`output`)
      if (el)
        el.innerHTML = state.output
    }, { flush: `post` })

    try {
      const { useExportStore } = await import(`./export`)
      const exportStore = useExportStore()

      state.content = `# Fresh Export Content`
      state.isDirty = true

      await exportStore.exportEditorContent2HTML()
      expect(state.exportHTMLSeenDom).toBe(`<p># Fresh Export Content</p>`)

      // editorContent2HTML also awaits the post-flush DOM update.
      state.content = `# Second Fresh Content`
      state.isDirty = true
      const html = await exportStore.editorContent2HTML()
      expect(html).toBe(`<p># Second Fresh Content</p>`)
    }
    finally {
      stop()
    }
  })
})
