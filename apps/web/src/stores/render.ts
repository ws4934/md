import type { RenderedBlock } from '@md/core/utils'
import type { RendererAPI } from '@md/shared/types'
import { t } from '@/i18n/translate'
import { resolveAssetUrl } from '@/services/emoji/urlResolver'
import { useCustomComponentStore } from './customComponent'
import { useThemeStore } from './theme'
import { useUIStore } from './ui'

export interface RenderOptions {
  themeMode?: 'light' | 'dark'
  /** Bypass fingerprint skip (export / clipboard / forced refresh) */
  force?: boolean
}

interface LazyCoreUtils {
  assembleRenderedBlocksHtml: (typeof import('@md/core/utils'))[`assembleRenderedBlocksHtml`]
  isMathJaxReady: (typeof import('@md/core/utils'))[`isMathJaxReady`]
  renderMarkdownIncremental: (typeof import('@md/core/utils'))[`renderMarkdownIncremental`]
}

/** Markdown rendering, HTML output, and heading extraction. */
export const useRenderStore = defineStore(`render`, () => {
  const renderedBlocks = shallowRef<RenderedBlock[]>([])
  const renderVersion = ref(0)
  const hasRendered = ref(false)
  const isDirty = ref(false)

  let coreUtils: LazyCoreUtils | null = null

  // Assembled lazily on demand so keystrokes never join multi-MB HTML strings
  // unless an explicit consumer (copy / publish / export) reads `output`.
  const output = computed(() => {
    if (!hasRendered.value)
      return ``
    if (coreUtils)
      return coreUtils.assembleRenderedBlocksHtml(renderedBlocks.value)
    let inner = ``
    for (let i = 0; i < renderedBlocks.value.length; i++)
      inner += renderedBlocks.value[i].html
    return `<section class="container">${inner}</section>`
  })

  const readingTime = reactive({
    chars: 0,
    words: 0,
    minutes: 0,
  })

  const titleList = ref<{
    url: string
    title: string
    level: number
  }[]>([])

  let renderer: RendererAPI | null = null
  let lastOptionsFingerprint = ``
  let lastContent = ``
  let lastMathReady = false
  let initPromise: Promise<RendererAPI> | null = null
  let pendingRender: { content: string, options?: RenderOptions } | null = null

  const getRenderer = () => renderer

  function markDirty() {
    isDirty.value = true
  }

  const buildDiagramMessages = () => ({
    mermaidLoading: t(`store.diagram.mermaidLoading`),
    mermaidError: t(`store.diagram.mermaidError`),
    plantumlLoading: t(`store.diagram.plantumlLoading`),
    plantumlError: t(`store.diagram.plantumlError`),
    infographicLoading: t(`store.diagram.infographicLoading`),
    infographicError: t(`store.diagram.infographicError`),
  })

  const buildCountMessages = () => ({
    // Keep placeholders; core replaces them with actual counts.
    summary: t(`store.count.summary`, {
      words: `{words}`,
      minutes: `{minutes}`,
    }),
  })

  const buildRenderMessages = () => ({
    footnoteTitle: t(`store.render.footnoteTitle`),
    unknownComponent: t(`store.render.unknownComponent`),
    katexLoading: t(`store.render.katexLoading`),
  })

  function buildComponentFingerprint(
    componentStore: ReturnType<typeof useCustomComponentStore>,
  ): string {
    return Object.keys(componentStore.registry)
      .sort()
      .map((name) => {
        const def = componentStore.registry[name]
        return [
          name,
          def.updatedAt ?? 0,
          def.template,
          JSON.stringify(def.props ?? []),
        ].join(`\u0002`)
      })
      .join(`\u0001`)
  }

  /** Fingerprint of render options only — content is compared by reference/equality separately. */
  function buildOptionsFingerprint(
    themeMode: 'light' | 'dark',
    themeStore: ReturnType<typeof useThemeStore>,
    componentStore: ReturnType<typeof useCustomComponentStore>,
  ): string {
    return [
      themeMode,
      themeStore.isCiteStatus ? `1` : `0`,
      themeStore.legend,
      themeStore.isCountStatus ? `1` : `0`,
      themeStore.isMacCodeBlock ? `1` : `0`,
      themeStore.isShowLineNumber ? `1` : `0`,
      buildComponentFingerprint(componentStore),
      t(`store.count.summary`, { words: `{words}`, minutes: `{minutes}` }),
      t(`store.render.footnoteTitle`),
      t(`store.render.unknownComponent`),
      t(`store.render.katexLoading`),
      t(`store.diagram.mermaidLoading`),
      t(`store.diagram.mermaidError`),
      t(`store.diagram.plantumlLoading`),
      t(`store.diagram.plantumlError`),
      t(`store.diagram.infographicLoading`),
      t(`store.diagram.infographicError`),
    ].join(`\u0001`)
  }

  const render = (content: string, options?: RenderOptions) => {
    if (!renderer || !coreUtils) {
      pendingRender = { content, options }
      return
    }

    const themeStore = useThemeStore()
    const uiStore = useUIStore()
    const componentStore = useCustomComponentStore()
    const themeMode = options?.themeMode ?? (uiStore.isDark ? `dark` : `light`)
    const optionsFingerprint = buildOptionsFingerprint(themeMode, themeStore, componentStore)
    const mathReady = coreUtils.isMathJaxReady()

    if (
      !options?.force
      && content === lastContent
      && optionsFingerprint === lastOptionsFingerprint
      && mathReady === lastMathReady
    ) {
      isDirty.value = false
      return
    }

    // isUseIndent / isUseJustify are applied via CSS variables, not renderer options
    renderer.reset({
      citeStatus: themeStore.isCiteStatus,
      legend: themeStore.legend,
      countStatus: themeStore.isCountStatus,
      isMacCodeBlock: themeStore.isMacCodeBlock,
      isShowLineNumber: themeStore.isShowLineNumber,
      themeMode,
      components: componentStore.registry,
      diagramMessages: buildDiagramMessages(),
      countMessages: buildCountMessages(),
      renderMessages: buildRenderMessages(),
      assetResolver: resolveAssetUrl,
    })

    const result = coreUtils.renderMarkdownIncremental(content, renderer, optionsFingerprint)

    readingTime.chars = content.length
    readingTime.words = result.readingTime.words
    readingTime.minutes = Math.ceil(result.readingTime.minutes)

    titleList.value = result.headings.map((heading, i) => ({
      url: `#${i}`,
      title: heading.text,
      level: heading.level,
    }))

    renderedBlocks.value = result.blocks
    hasRendered.value = true
    renderVersion.value++

    lastContent = content
    lastOptionsFingerprint = optionsFingerprint
    lastMathReady = mathReady
    isDirty.value = false
  }

  function flushPendingRender() {
    if (!pendingRender || !renderer)
      return
    const next = pendingRender
    pendingRender = null
    render(next.content, next.options)
  }

  /** Init renderer; theme CSS is injected via useThemeStore().applyCurrentTheme(). */
  const initRendererInstance = async (options?: {
    isMacCodeBlock?: boolean
    isShowLineNumber?: boolean
  }) => {
    initPromise ??= Promise.all([
      import(`@md/core/renderer`),
      import(`@md/core/utils`),
    ]).then(([{ initRenderer }, utils]) => {
      coreUtils = utils
      renderer = initRenderer(options || {})
      lastOptionsFingerprint = ``
      lastContent = ``
      lastMathReady = false
      return renderer
    }).catch((error) => {
      initPromise = null
      throw error
    })

    await initPromise
    flushPendingRender()
    return renderer
  }

  return {
    // State
    output,
    renderedBlocks,
    renderVersion,
    isDirty,
    readingTime,
    titleList,

    // Actions
    initRendererInstance,
    getRenderer,
    markDirty,
    render,
  }
})
