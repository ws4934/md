import type { CSSProperties } from 'vue'

export interface ViewportRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface FloatingSize {
  width: number
  height: number
}

export interface FloatingMenuPosition {
  left: number
  top: number
  side: `top` | `bottom`
  maxHeight: number
  maxWidth: number
}

export interface CascadingPanelBox {
  left: number
  top: number
  maxHeight: number
  maxWidth: number
}

export interface CascadingMenuLayout {
  side: `top` | `bottom`
  stacked: boolean
  submenuSide: `left` | `right` | `bottom`
  primary: CascadingPanelBox
  submenu: CascadingPanelBox | null
}

export type ModelPillDisplayMode = `full` | `model-only` | `agent-default`

export type FloatingBoxStyle = Pick<CSSProperties, `left` | `top` | `maxHeight` | `maxWidth`>

const DEFAULT_OFFSET = 8
const DEFAULT_PADDING = 12
const DEFAULT_GAP = 6
const MIN_PANEL_HEIGHT = 120
const MIN_PANEL_WIDTH = 160

function clamp(value: number, min: number, max: number): number {
  if (max < min)
    return min
  return Math.min(max, Math.max(min, value))
}

function chooseVerticalSide(
  anchor: ViewportRect,
  neededHeight: number,
  viewportHeight: number,
  preferredSide: `top` | `bottom`,
  offset: number,
  padding: number,
): { side: `top` | `bottom`, maxHeight: number } {
  const spaceAbove = Math.max(0, anchor.top - offset - padding)
  const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - offset - padding)

  let side: `top` | `bottom`
  if (preferredSide === `top`) {
    side = neededHeight <= spaceAbove || spaceAbove >= spaceBelow ? `top` : `bottom`
  }
  else {
    side = neededHeight <= spaceBelow || spaceBelow >= spaceAbove ? `bottom` : `top`
  }

  const available = side === `top` ? spaceAbove : spaceBelow
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, Math.floor(Math.min(available, viewportHeight - padding * 2)))
  return { side, maxHeight }
}

/**
 * Computes fixed viewport coordinates for a teleported floating menu with
 * vertical flip and horizontal/vertical viewport clamping.
 */
export function computeFloatingMenuPosition(params: {
  anchor: ViewportRect
  menu: FloatingSize
  viewport: FloatingSize
  preferredSide: `top` | `bottom`
  preferredAlign?: `start` | `end` | `center`
  offset?: number
  padding?: number
}): FloatingMenuPosition {
  const {
    anchor,
    menu,
    viewport,
    preferredSide,
    preferredAlign = `start`,
    offset = DEFAULT_OFFSET,
    padding = DEFAULT_PADDING,
  } = params

  const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(viewport.width - padding * 2))
  const effWidth = Math.min(menu.width, maxWidth)

  const { side, maxHeight } = chooseVerticalSide(
    anchor,
    menu.height,
    viewport.height,
    preferredSide,
    offset,
    padding,
  )
  const effHeight = Math.min(menu.height, maxHeight)

  let rawLeft: number
  if (preferredAlign === `end`)
    rawLeft = anchor.right - effWidth
  else if (preferredAlign === `center`)
    rawLeft = anchor.left + (anchor.width - effWidth) / 2
  else
    rawLeft = anchor.left

  const left = Math.round(clamp(rawLeft, padding, viewport.width - padding - effWidth))

  const rawTop = side === `top`
    ? anchor.top - offset - effHeight
    : anchor.bottom + offset
  const top = Math.round(clamp(rawTop, padding, viewport.height - padding - effHeight))

  return {
    left,
    top,
    side,
    maxHeight,
    maxWidth,
  }
}

/**
 * Computes viewport-safe fixed coordinates for a primary menu + optional cascading submenu
 * (e.g. Agent list + Models list). Opens the submenu on whichever side has room, shifts
 * inside viewport bounds, and stacks vertically only on ultra-narrow viewports.
 */
export function computeCascadingMenuLayout(params: {
  anchor: ViewportRect
  primary: FloatingSize
  submenu: FloatingSize | null
  viewport: FloatingSize
  preferredSide: `top` | `bottom`
  gap?: number
  offset?: number
  padding?: number
}): CascadingMenuLayout {
  const {
    anchor,
    primary,
    submenu,
    viewport,
    preferredSide,
    gap = DEFAULT_GAP,
    offset = DEFAULT_OFFSET,
    padding = DEFAULT_PADDING,
  } = params

  if (!submenu) {
    const pos = computeFloatingMenuPosition({
      anchor,
      menu: primary,
      viewport,
      preferredSide,
      preferredAlign: `start`,
      offset,
      padding,
    })
    return {
      side: pos.side,
      stacked: false,
      submenuSide: preferredSide === `top` ? `left` : `right`,
      primary: {
        left: pos.left,
        top: pos.top,
        maxHeight: pos.maxHeight,
        maxWidth: pos.maxWidth,
      },
      submenu: null,
    }
  }

  const availableViewportWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(viewport.width - padding * 2))
  const sideBySideWidth = primary.width + gap + submenu.width

  if (sideBySideWidth <= availableViewportWidth) {
    const spaceRightOfPrimary = viewport.width - padding - (anchor.left + primary.width + gap)
    const spaceLeftOfPrimary = Math.min(anchor.left, viewport.width - padding - primary.width) - padding - gap

    let submenuSide: `left` | `right`
    if (preferredSide === `bottom`) {
      submenuSide = spaceRightOfPrimary >= submenu.width
        ? `right`
        : spaceLeftOfPrimary >= submenu.width
          ? `left`
          : spaceRightOfPrimary >= spaceLeftOfPrimary
            ? `right`
            : `left`
    }
    else {
      submenuSide = spaceLeftOfPrimary >= submenu.width
        ? `left`
        : spaceRightOfPrimary >= submenu.width
          ? `right`
          : spaceLeftOfPrimary >= spaceRightOfPrimary
            ? `left`
            : `right`
    }

    let primaryLeft: number
    let submenuLeft: number
    if (submenuSide === `left`) {
      const minPrimaryLeft = padding + submenu.width + gap
      const maxPrimaryLeft = viewport.width - padding - primary.width
      primaryLeft = Math.round(clamp(anchor.left, minPrimaryLeft, maxPrimaryLeft))
      submenuLeft = Math.round(primaryLeft - gap - submenu.width)
    }
    else {
      const minPrimaryLeft = padding
      const maxPrimaryLeft = viewport.width - padding - primary.width - gap - submenu.width
      primaryLeft = Math.round(clamp(anchor.left, minPrimaryLeft, maxPrimaryLeft))
      submenuLeft = Math.round(primaryLeft + primary.width + gap)
    }

    const tallest = Math.max(primary.height, submenu.height)
    const { side, maxHeight } = chooseVerticalSide(
      anchor,
      tallest,
      viewport.height,
      preferredSide,
      offset,
      padding,
    )
    const effPrimaryH = Math.min(primary.height, maxHeight)
    const effSubmenuH = Math.min(submenu.height, maxHeight)

    let primaryTop: number
    let submenuTop: number
    if (side === `top`) {
      const bottomEdge = clamp(
        anchor.top - offset,
        padding + Math.max(effPrimaryH, effSubmenuH),
        viewport.height - padding,
      )
      primaryTop = Math.round(bottomEdge - effPrimaryH)
      submenuTop = Math.round(bottomEdge - effSubmenuH)
    }
    else {
      const topEdge = clamp(
        anchor.bottom + offset,
        padding,
        viewport.height - padding - Math.max(effPrimaryH, effSubmenuH),
      )
      primaryTop = Math.round(topEdge)
      submenuTop = Math.round(topEdge)
    }

    return {
      side,
      stacked: false,
      submenuSide,
      primary: {
        left: primaryLeft,
        top: primaryTop,
        maxHeight,
        maxWidth: availableViewportWidth,
      },
      submenu: {
        left: submenuLeft,
        top: submenuTop,
        maxHeight,
        maxWidth: availableViewportWidth,
      },
    }
  }

  // Ultra-narrow viewport fallback: stack primary + submenu vertically within viewport bounds.
  const totalHeight = primary.height + gap + submenu.height
  const { side, maxHeight } = chooseVerticalSide(
    anchor,
    totalHeight,
    viewport.height,
    preferredSide,
    offset,
    padding,
  )
  const eachMaxHeight = Math.max(MIN_PANEL_HEIGHT, Math.floor((maxHeight - gap) / 2))
  const effPrimaryH = Math.min(primary.height, eachMaxHeight)
  const effSubmenuH = Math.min(submenu.height, eachMaxHeight)
  const stackedH = effPrimaryH + gap + effSubmenuH

  const effPrimaryW = Math.min(primary.width, availableViewportWidth)
  const effSubmenuW = Math.min(submenu.width, availableViewportWidth)
  const primaryLeft = Math.round(clamp(anchor.left, padding, viewport.width - padding - effPrimaryW))
  const submenuLeft = Math.round(clamp(anchor.left, padding, viewport.width - padding - effSubmenuW))

  const rawTop = side === `top` ? anchor.top - offset - stackedH : anchor.bottom + offset
  const stackTop = Math.round(clamp(rawTop, padding, viewport.height - padding - stackedH))

  return {
    side,
    stacked: true,
    submenuSide: `bottom`,
    primary: {
      left: primaryLeft,
      top: stackTop,
      maxHeight: eachMaxHeight,
      maxWidth: availableViewportWidth,
    },
    submenu: {
      left: submenuLeft,
      top: stackTop + effPrimaryH + gap,
      maxHeight: eachMaxHeight,
      maxWidth: availableViewportWidth,
    },
  }
}

/**
 * Decides how to render the agent/model trigger pill:
 * - Show both agent + model only when the full combination fits cleanly without truncating the model.
 * - Otherwise, let the model name win (avatar identifies the agent; tooltip shows full agent · model),
 *   except for generic `default` models where agent + short localized "Default" stays clearest.
 */
export function resolveModelPillDisplayMode(params: {
  availableWidth: number | null
  fullWidth: number
  hasModel: boolean
  isDefaultModel: boolean
}): ModelPillDisplayMode {
  const { availableWidth, fullWidth, hasModel, isDefaultModel } = params
  if (!hasModel)
    return `full`
  if (availableWidth === null || availableWidth <= 0 || fullWidth <= 0)
    return isDefaultModel ? `agent-default` : `model-only`
  if (fullWidth <= availableWidth)
    return `full`
  return isDefaultModel ? `agent-default` : `model-only`
}

export function isFloatingAnchorHidden(anchor: Pick<ViewportRect, `width` | `height`>): boolean {
  return anchor.width <= 0 && anchor.height <= 0
}

export function toFloatingBoxStyle(
  box: Pick<CascadingPanelBox, `left` | `top` | `maxHeight` | `maxWidth`>,
  maxHeightCap?: number,
): FloatingBoxStyle {
  const cappedHeight = maxHeightCap !== undefined
    ? Math.min(maxHeightCap, box.maxHeight)
    : box.maxHeight
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    maxHeight: `${cappedHeight}px`,
    maxWidth: `${box.maxWidth}px`,
  }
}

/**
 * Scrolls the `[data-active="true"]` option inside a scrollable menu container into
 * comfortable vertical view, or resets `scrollTop = 0` when no active option exists
 * (e.g. when hovering a non-selected agent in a cascading menu).
 */
export function scrollActiveOptionIntoView(container: HTMLElement | null | undefined): void {
  if (!container)
    return
  const active = container.querySelector<HTMLElement>(`[data-active="true"]`)
  if (!active) {
    container.scrollTop = 0
    return
  }

  const containerHeight = container.clientHeight
  const scrollHeight = container.scrollHeight
  if (containerHeight <= 0 || scrollHeight <= containerHeight)
    return

  const containerRect = container.getBoundingClientRect()
  const activeRect = active.getBoundingClientRect()
  const useRects = containerRect.height > 0 && activeRect.height > 0
  const itemTop = useRects
    ? activeRect.top - containerRect.top + container.scrollTop
    : active.offsetTop
  const itemHeight = useRects ? activeRect.height : active.offsetHeight

  const viewTop = container.scrollTop
  const viewBottom = viewTop + containerHeight
  if (itemTop < viewTop || itemTop + itemHeight > viewBottom) {
    const centered = itemTop - (containerHeight - itemHeight) / 2
    container.scrollTop = Math.round(clamp(centered, 0, scrollHeight - containerHeight))
  }
}
