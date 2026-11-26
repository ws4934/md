// @vitest-environment jsdom
import type { ComponentRegistry } from '@md/shared'
import type { EmojiPack } from '@md/shared/types/emoji'
import { clearMathSvgCache } from '@md/core/extensions'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, reactive, ref, shallowRef } from 'vue'

// Mirror unplugin-auto-import globals used by Pinia stores under vitest.
Object.assign(globalThis, { defineStore, ref, computed, reactive, shallowRef })

const { componentRegistry, emojiUrls, defaultPackRef, userPackRef } = vi.hoisted(() => ({
  componentRegistry: {} as ComponentRegistry,
  emojiUrls: new Map<string, string>(),
  defaultPackRef: { value: null as EmojiPack | null },
  userPackRef: { value: null as EmojiPack | null },
}))

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/services/emoji/urlResolver`, () => ({
  resolveAssetUrl: (id: string) => emojiUrls.get(id) ?? `https://api.test/emojis/assets/${id}`,
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
    viewMode: `split`,
  }),
}))

vi.mock(`./customComponent`, () => ({
  useCustomComponentStore: () => ({
    get registry() {
      return componentRegistry
    },
  }),
}))

vi.mock(`./emojiPack`, () => {
  const defaultPack = ref<EmojiPack | null>(null)
  const userPack = ref<EmojiPack | null>(null)
  defaultPackRef.value = null
  userPackRef.value = null
  return {
    useEmojiPackStore: () => ({
      get defaultPack() {
        return defaultPack.value
      },
      set defaultPack(val: EmojiPack | null) {
        defaultPack.value = val
      },
      get userPack() {
        return userPack.value
      },
      set userPack(val: EmojiPack | null) {
        userPack.value = val
      },
    }),
  }
})

describe(`useRenderStore cache invalidation`, () => {
  const originalMathJax = window.MathJax

  beforeEach(() => {
    setActivePinia(createPinia())
    clearMathSvgCache()
    for (const key of Object.keys(componentRegistry))
      delete componentRegistry[key]
    emojiUrls.clear()
  })

  afterEach(async () => {
    window.MathJax = originalMathJax
    clearMathSvgCache()
    const { useEmojiPackStore } = await import(`./emojiPack`)
    const emojiStore = useEmojiPackStore()
    emojiStore.defaultPack = null
    emojiStore.userPack = null
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

  it(`invalidates render cache when a custom component toggles inline mode`, async () => {
    const { useRenderStore } = await import(`./render`)
    const renderStore = useRenderStore()
    await renderStore.initRendererInstance()

    componentRegistry.BadgeTag = {
      id: `comp-1`,
      name: `BadgeTag`,
      template: `<span class="badge-tag">{{label}}</span>`,
      props: [{ name: `label`, type: `string` }],
      inline: false,
      updatedAt: 100,
    }

    const doc = `<BadgeTag label="new" />\n\nParagraph`
    renderStore.render(doc)
    expect(renderStore.output).toContain(`<span class="badge-tag">new</span>`)

    // Flip only `inline` (without bumping updatedAt or changing template/props):
    // `mdComponent` skips inline-marked definitions at block level.
    componentRegistry.BadgeTag = {
      ...componentRegistry.BadgeTag,
      inline: true,
    }

    renderStore.render(doc)
    expect(renderStore.output).not.toContain(`<span class="badge-tag">new</span>`)
  })

  it(`re-renders already-settled sticker blocks when custom emoji pack state changes`, async () => {
    const { useRenderStore } = await import(`./render`)
    const { useEmojiPackStore } = await import(`./emojiPack`)
    const renderStore = useRenderStore()
    const emojiStore = useEmojiPackStore()
    await renderStore.initRendererInstance()

    const doc = `<Emoji id="sticker1" alt="wave" width="20%" align="center" />`
    renderStore.render(doc)
    expect(renderStore.output).toContain(`https://api.test/emojis/assets/sticker1`)

    emojiUrls.set(`sticker1`, `https://cdn.test/emojis/sticker1-v2.png`)
    emojiStore.userPack = {
      id: `user-pack`,
      name: `My Pack`,
      source: `user`,
      createdAt: 1,
      updatedAt: 2,
      files: [
        {
          id: `sticker1`,
          name: `wave`,
          mimeType: `image/png`,
          size: 128,
          url: `https://cdn.test/emojis/sticker1-v2.png`,
        },
      ],
    }

    await nextTick()
    expect(renderStore.output).toContain(`https://cdn.test/emojis/sticker1-v2.png`)
  })
})
