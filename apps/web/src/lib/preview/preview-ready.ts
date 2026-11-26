import {
  hydratePendingInfographicDiagrams,
  hydratePendingMermaidDiagrams,
  hydratePendingPlantUmlDiagrams,
} from '@md/core/extensions'
import {
  highlightPendingBlocks,
  isAsyncDiagramPending,
  MD_DIAGRAM_STATE,
  MD_DIAGRAM_STATE_ATTR,
} from '@md/core/utils'
import { nextTick } from 'vue'
import { delay } from '@/lib/delay'

const PREVIEW_READY_TIMEOUT_MS = 20_000
const PREVIEW_POLL_INTERVAL_MS = 250
const ASYNC_DIAGRAM_SELECTOR = `.mermaid-diagram, .plantuml-diagram, .infographic-diagram`

export interface WaitForPreviewReadyOptions {
  themeMode?: `light` | `dark`
}

function resolveInfographicOptions(options?: WaitForPreviewReadyOptions) {
  return options?.themeMode ? { themeMode: options.themeMode } : undefined
}

function isDiagramStillLoading(output: HTMLElement): boolean {
  for (const el of output.querySelectorAll<HTMLElement>(ASYNC_DIAGRAM_SELECTOR)) {
    if (isAsyncDiagramPending(el))
      return true
  }

  return false
}

function isMathStillLoading(output: HTMLElement): boolean {
  if (output.querySelector(`.katex-fallback`))
    return true

  for (const el of output.querySelectorAll<HTMLElement>(`.katex-block, .katex-inline`)) {
    if (!el.querySelector(`svg, mjx-container`))
      return true
  }

  return false
}

function isCodeStillHighlighting(output: HTMLElement): boolean {
  for (const el of output.querySelectorAll<HTMLElement>(`code[data-language-pending]`)) {
    if (el.getAttribute(`data-language-pending`))
      return true
  }

  return false
}

async function hydratePendingCodeBlocks(output: HTMLElement): Promise<void> {
  if (!isCodeStillHighlighting(output))
    return
  const { hljs } = await import(`@md/core/renderer`)
  highlightPendingBlocks(hljs, output)
}

/** Wait for async diagrams and math in preview; returns false on timeout. */
export async function waitForPreviewReady(
  timeoutMs = PREVIEW_READY_TIMEOUT_MS,
  options?: WaitForPreviewReadyOptions,
): Promise<boolean> {
  // Wait for Vue to sync renderStore.output into #output (avoid stale DOM)
  await nextTick()
  await nextTick()

  const output = document.getElementById(`output`)
  if (!output)
    return false

  const infographicOptions = resolveInfographicOptions(options)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await hydratePendingCodeBlocks(output)
    hydratePendingMermaidDiagrams(output)
    hydratePendingPlantUmlDiagrams(output)
    hydratePendingInfographicDiagrams(output, infographicOptions)

    if (!isDiagramStillLoading(output) && !isMathStillLoading(output) && !isCodeStillHighlighting(output))
      return true

    await delay(PREVIEW_POLL_INTERVAL_MS)
  }

  await hydratePendingCodeBlocks(output)
  hydratePendingMermaidDiagrams(output)
  hydratePendingPlantUmlDiagrams(output)
  hydratePendingInfographicDiagrams(output, infographicOptions)
  return !isDiagramStillLoading(output) && !isMathStillLoading(output) && !isCodeStillHighlighting(output)
}

/** Strip unresolved async placeholders so copy/export omit loading text. */
export function stripUnresolvedAsyncPlaceholders(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(ASYNC_DIAGRAM_SELECTOR).forEach((el) => {
    if (el.querySelector(`svg, img`))
      return

    if (el.getAttribute(MD_DIAGRAM_STATE_ATTR) === MD_DIAGRAM_STATE.loading)
      el.remove()
  })

  root.querySelectorAll<HTMLElement>(`.katex-pending`).forEach((el) => {
    if (!el.querySelector(`svg, mjx-container`))
      el.remove()
  })
}
