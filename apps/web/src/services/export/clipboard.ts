import type { WeChatCssVarValues } from './clipboard-dom'
import type { JuiceWorkerRequest, JuiceWorkerResponse } from './juice.worker'
import { inlineEmojiImagesAsBase64 } from '@/lib/export/inlineEmojiImages'
import { stripUnresolvedAsyncPlaceholders, waitForPreviewReady } from '@/lib/preview/preview-ready'
import { useEditorStore } from '@/stores/editor'
import { useRenderStore } from '@/stores/render'
import { useThemeStore } from '@/stores/theme'
import { useUIStore } from '@/stores/ui'
import {
  applyWeChatCssVarReplacements,
  applyWeChatStructureFixes,
  createEmptyNode,
  modifyHtmlStructureInPlace,
  promoteSvgHtmlLabels,
  sanitizeHtmlCssForJuice,
  solveWeChatImage,
  stripFontFamilyForJuiceFallback,
  stripInvalidCssForJuice,
} from './clipboard-dom'
import { getStylesToAdd } from './share-styles'
import { prepareDiagramSvgsForWeChat, prepareMathFormulasForWeChat, sanitizeSvgsForWeChat } from './wechat-svg'

export { modifyHtmlStructure, solveWeChatImage } from './clipboard-dom'

const JUICE_OPTIONS = {
  inlinePseudoElements: true,
  preserveImportant: true,
  resolveCSSVariables: false,
} as const

let juiceWorker: Worker | null = null
let juiceWorkerUnavailable = false
let nextJuiceJobId = 1
const pendingJuiceJobs = new Map<number, {
  resolve: (html: string) => void
  reject: (err: Error) => void
}>()

function getJuiceWorker(): Worker | null {
  if (juiceWorkerUnavailable || typeof Worker === `undefined`)
    return null
  if (juiceWorker)
    return juiceWorker
  try {
    const worker = new Worker(new URL(`./juice.worker.ts`, import.meta.url), { type: `module` })
    worker.addEventListener(`message`, (event: MessageEvent<JuiceWorkerResponse>) => {
      const { id, html, error } = event.data
      const pending = pendingJuiceJobs.get(id)
      if (!pending)
        return
      pendingJuiceJobs.delete(id)
      if (error)
        pending.reject(new Error(error))
      else
        pending.resolve(html ?? ``)
    })
    const failAllWorkerJobs = (reason: string) => {
      juiceWorker = null
      juiceWorkerUnavailable = true
      const err = new Error(reason)
      for (const pending of pendingJuiceJobs.values())
        pending.reject(err)
      pendingJuiceJobs.clear()
      worker.terminate()
    }
    worker.addEventListener(`error`, event => failAllWorkerJobs(event.message || `Juice worker failed`))
    worker.addEventListener(`messageerror`, () => failAllWorkerJobs(`Juice worker message deserialization failed`))
    juiceWorker = worker
    return worker
  }
  catch {
    juiceWorkerUnavailable = true
    return null
  }
}

async function mergeCssOnMainThread(html: string, vars: WeChatCssVarValues): Promise<string> {
  const { default: juice } = await import(`juice`)
  const sanitized = sanitizeHtmlCssForJuice(html)
  const attempts = [
    () => juice(sanitized, JUICE_OPTIONS),
    () => juice(sanitized, { ...JUICE_OPTIONS, inlinePseudoElements: false }),
    () => juice(stripFontFamilyForJuiceFallback(sanitized), { ...JUICE_OPTIONS, inlinePseudoElements: false }),
  ]

  for (const attempt of attempts) {
    try {
      return applyWeChatCssVarReplacements(attempt(), vars)
    }
    catch (error) {
      console.warn(`WeChat copy: juice failed, trying fallback`, error)
    }
  }

  return applyWeChatCssVarReplacements(sanitized, vars)
}

async function mergeCssOffThread(html: string, vars: WeChatCssVarValues): Promise<string> {
  const worker = getJuiceWorker()
  if (!worker)
    return mergeCssOnMainThread(html, vars)

  try {
    return await new Promise<string>((resolve, reject) => {
      const id = nextJuiceJobId++
      pendingJuiceJobs.set(id, { resolve, reject })
      const payload: JuiceWorkerRequest = { id, html, vars }
      worker.postMessage(payload)
    })
  }
  catch {
    return mergeCssOnMainThread(html, vars)
  }
}

/**
 * Prepare clipboard HTML for WeChat.
 * Diagrams are exported in light theme structure, but dark ink colors are remapped
 * to currentColor so WeChat reader dark mode can follow text color.
 */
export async function processClipboardContent(primaryColor: string) {
  const outputElement = document.getElementById(`output`)
  if (!outputElement) {
    return {
      html: ``,
      plainText: ``,
      hasPendingAsyncContent: false,
    }
  }

  const renderStore = useRenderStore()
  const editorStore = useEditorStore()
  const themeStore = useThemeStore()
  const uiStore = useUIStore()
  const content = editorStore.getContent()
  const wechatThemeMode = `light` as const
  const rerenderForLight = uiStore.isDark

  // Always flush dirty preview (e.g. edited while hidden in `edit` view mode) before cloning.
  if (rerenderForLight || renderStore.isDirty || !renderStore.output) {
    themeStore.updateCodeTheme()
    renderStore.render(content, { themeMode: wechatThemeMode, force: rerenderForLight })
  }

  const previewReady = await waitForPreviewReady(undefined, { themeMode: wechatThemeMode })

  try {
    const clipboardDiv = outputElement.cloneNode(true) as HTMLElement
    stripUnresolvedAsyncPlaceholders(clipboardDiv)
    prepareDiagramSvgsForWeChat(clipboardDiv)
    await inlineEmojiImagesAsBase64(clipboardDiv)

    const stylesToAdd = await getStylesToAdd()
    stripInvalidCssForJuice(clipboardDiv)

    const rawInputHtml = stylesToAdd ? stylesToAdd + clipboardDiv.innerHTML : clipboardDiv.innerHTML
    const inlinedHtml = await mergeCssOffThread(rawInputHtml, {
      primaryColor,
      fontFamily: themeStore.fontFamily,
      fontSize: themeStore.fontSize,
      lineHeight: themeStore.lineHeight,
      blockSpacing: themeStore.blockSpacing,
    })

    // Single main-thread parse after worker inlining + CSS variable substitution.
    clipboardDiv.innerHTML = inlinedHtml
    modifyHtmlStructureInPlace(clipboardDiv)
    clipboardDiv.querySelectorAll(`a[href^="#"]`).forEach(a => a.removeAttribute(`href`))

    solveWeChatImage(clipboardDiv)

    const beforeNode = createEmptyNode()
    const afterNode = createEmptyNode()
    clipboardDiv.insertBefore(beforeNode, clipboardDiv.firstChild)
    clipboardDiv.appendChild(afterNode)

    promoteSvgHtmlLabels(clipboardDiv)
    sanitizeSvgsForWeChat(clipboardDiv)
    prepareMathFormulasForWeChat(clipboardDiv)
    applyWeChatStructureFixes(clipboardDiv)

    return {
      html: clipboardDiv.innerHTML,
      plainText: clipboardDiv.textContent || ``,
      hasPendingAsyncContent: !previewReady,
    }
  }
  finally {
    if (rerenderForLight) {
      if (uiStore.viewMode === `edit`)
        renderStore.markDirty()
      else
        renderStore.render(content, { themeMode: `dark`, force: true })
    }
  }
}
