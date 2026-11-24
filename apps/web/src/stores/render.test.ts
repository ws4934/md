// @vitest-environment jsdom
import { clearMathSvgCache } from '@md/core/extensions'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, reactive, ref, shallowRef } from 'vue'

// Mirror unplugin-auto-import globals used by Pinia stores under vitest.
Object.assign(globalThis, { defineStore, ref, computed, reactive, shallowRef })

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/services/emoji/urlResolver`, () => ({
  resolveAssetUrl: () => `about:blank`,
}))

vi.mock(`./theme`, () => ({
  useThemeStore: () => ({
    isCiteStatus: false,
    legend: `alt`,
    isCountStatus: false,
    isMacCodeBlock: false,
    isShowLineNumber: false,
  }),
}))

vi.mock(`./ui`, () => ({
  useUIStore: () => ({
    isDark: false,
  }),
}))

vi.mock(`./customComponent`, () => ({
  useCustomComponentStore: () => ({
    registry: {},
  }),
}))

describe(`useRenderStore MathJax readiness invalidation`, () => {
  const originalMathJax = window.MathJax

  beforeEach(() => {
    setActivePinia(createPinia())
    clearMathSvgCache()
  })

  afterEach(() => {
    window.MathJax = originalMathJax
    clearMathSvgCache()
  })

  it(`re-renders pending math without force once MathJax becomes ready`, async () => {
    const { useRenderStore } = await import(`./render`)
    const renderStore = useRenderStore()
    await renderStore.initRendererInstance()

    const doc = `Inline formula $a + b = c$`
    window.MathJax = undefined as unknown as MathJaxGlobal

    renderStore.render(doc)
    expect(renderStore.output).toContain(`katex-pending`)

    // Simulate MathJax finishing async load, then calling render(doc) without force.
    window.MathJax = {
      texReset() {},
      tex2svg(tex: string) {
        const container = document.createElement(`div`)
        const svg = document.createElementNS(`http://www.w3.org/2000/svg`, `svg`)
        svg.appendChild(document.createElementNS(`http://www.w3.org/2000/svg`, `g`))
        svg.textContent = tex
        container.appendChild(svg)
        return container as unknown as ReturnType<MathJaxGlobal[`tex2svg`]>
      },
    }

    renderStore.render(doc)
    expect(renderStore.output).not.toContain(`katex-pending`)
    expect(renderStore.output).toContain(`<svg`)
  })
})
