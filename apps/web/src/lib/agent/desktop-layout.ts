export interface DesktopLayoutWidths {
  sidebar: number
  preview: number
  agent: number
}

export const DESKTOP_LAYOUT_LIMITS = {
  sidebar: { min: 200, max: 360, default: 248 },
  editor: { min: 320 },
  preview: { min: 320, max: 720, default: 400 },
  agent: { min: 320, max: 640, default: 400 },
} as const

export const DEFAULT_DESKTOP_LAYOUT_WIDTHS: DesktopLayoutWidths = {
  sidebar: DESKTOP_LAYOUT_LIMITS.sidebar.default,
  preview: DESKTOP_LAYOUT_LIMITS.preview.default,
  agent: DESKTOP_LAYOUT_LIMITS.agent.default,
}

export function clampLayoutWidth(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== `number` || !Number.isFinite(value))
    return fallback
  return Math.round(Math.min(max, Math.max(min, value)))
}

export function normalizeDesktopLayoutWidths(
  raw?: Partial<DesktopLayoutWidths> | null,
): DesktopLayoutWidths {
  return {
    sidebar: clampLayoutWidth(
      raw?.sidebar,
      DESKTOP_LAYOUT_LIMITS.sidebar.min,
      DESKTOP_LAYOUT_LIMITS.sidebar.max,
      DESKTOP_LAYOUT_LIMITS.sidebar.default,
    ),
    preview: clampLayoutWidth(
      raw?.preview,
      DESKTOP_LAYOUT_LIMITS.preview.min,
      DESKTOP_LAYOUT_LIMITS.preview.max,
      DESKTOP_LAYOUT_LIMITS.preview.default,
    ),
    agent: clampLayoutWidth(
      raw?.agent,
      DESKTOP_LAYOUT_LIMITS.agent.min,
      DESKTOP_LAYOUT_LIMITS.agent.max,
      DESKTOP_LAYOUT_LIMITS.agent.default,
    ),
  }
}

export function pxToPercent(px: number, containerPx: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(containerPx) || containerPx <= 0)
    return 0
  return (px / containerPx) * 100
}

/**
 * Computes a safe minimum percentage for the flexible main column so the editor
 * stays >= 320px (and split mode keeps room for both editor and preview) while
 * ensuring outer panel min-sizes never exceed 100% on narrow windows.
 */
export function computeMainMinPercent(params: {
  containerWidth: number
  isSidebarOpen: boolean
  isAgentOpen: boolean
  viewMode: `edit` | `split` | `preview`
  isNewArticleHero: boolean
}): number {
  const { containerWidth, isSidebarOpen, isAgentOpen, viewMode, isNewArticleHero } = params
  if (!Number.isFinite(containerWidth) || containerWidth <= 0)
    return 25

  const siblingMinPx
    = (isSidebarOpen ? DESKTOP_LAYOUT_LIMITS.sidebar.min : 0)
      + (isAgentOpen ? DESKTOP_LAYOUT_LIMITS.agent.min : 0)
  const maxAllowedMainPct = Math.max(0, 100 - pxToPercent(siblingMinPx, containerWidth))

  const desiredMainMinPx = !isNewArticleHero && viewMode === `split`
    ? DESKTOP_LAYOUT_LIMITS.editor.min + DESKTOP_LAYOUT_LIMITS.preview.min
    : DESKTOP_LAYOUT_LIMITS.editor.min

  return Math.min(maxAllowedMainPct, pxToPercent(desiredMainMinPx, containerWidth))
}

/**
 * Computes the editor panel's percentage min-size inside the editor|preview splitter
 * so the editor cannot shrink below 320px in split mode.
 */
export function computeEditorMinPercent(params: {
  containerWidth: number
  viewMode: `edit` | `split` | `preview`
}): number {
  const { containerWidth, viewMode } = params
  if (viewMode === `preview`)
    return 0
  if (viewMode === `edit`)
    return 100
  if (!Number.isFinite(containerWidth) || containerWidth <= 0)
    return 35

  const previewMinPct = pxToPercent(DESKTOP_LAYOUT_LIMITS.preview.min, containerWidth)
  const maxAllowedEditorPct = Math.max(0, 100 - previewMinPct)
  return Math.min(maxAllowedEditorPct, pxToPercent(DESKTOP_LAYOUT_LIMITS.editor.min, containerWidth))
}
