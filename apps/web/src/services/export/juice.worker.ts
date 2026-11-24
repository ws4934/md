import type { WeChatCssVarValues } from './clipboard-dom'
import juice from 'juice'
import {
  applyWeChatCssVarReplacements,
  sanitizeHtmlCssForJuice,
  stripFontFamilyForJuiceFallback,
} from './clipboard-dom'

export interface JuiceWorkerRequest {
  id: number
  html: string
  vars: WeChatCssVarValues
}

export interface JuiceWorkerResponse {
  id: number
  html?: string
  error?: string
}

const JUICE_OPTIONS = {
  inlinePseudoElements: true,
  preserveImportant: true,
  resolveCSSVariables: false,
} as const

function inlineCss(html: string): string {
  const sanitized = sanitizeHtmlCssForJuice(html)
  const attempts = [
    () => juice(sanitized, JUICE_OPTIONS),
    () => juice(sanitized, { ...JUICE_OPTIONS, inlinePseudoElements: false }),
    () => juice(stripFontFamilyForJuiceFallback(sanitized), { ...JUICE_OPTIONS, inlinePseudoElements: false }),
  ]

  for (const attempt of attempts) {
    try {
      return attempt()
    }
    catch {
      // Try progressively more lenient juice options.
    }
  }

  return sanitized
}

globalThis.addEventListener(`message`, (event: MessageEvent<JuiceWorkerRequest>) => {
  const { id, html, vars } = event.data
  try {
    const inlined = inlineCss(html)
    const replaced = applyWeChatCssVarReplacements(inlined, vars)
    const response: JuiceWorkerResponse = { id, html: replaced }
    globalThis.postMessage(response)
  }
  catch (error) {
    const response: JuiceWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    }
    globalThis.postMessage(response)
  }
})
