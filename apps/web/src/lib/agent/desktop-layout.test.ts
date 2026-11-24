import { describe, expect, it } from 'vitest'
import {
  clampLayoutWidth,
  computeEditorMinPercent,
  computeMainMinPercent,
  DEFAULT_DESKTOP_LAYOUT_WIDTHS,
  DESKTOP_LAYOUT_LIMITS,
  normalizeDesktopLayoutWidths,
} from './desktop-layout'

describe(`desktop-layout helpers`, () => {
  it(`clamps panel widths to their documented pixel constraints`, () => {
    expect(clampLayoutWidth(120, 200, 360, 248)).toBe(200)
    expect(clampLayoutWidth(500, 200, 360, 248)).toBe(360)
    expect(clampLayoutWidth(284.6, 200, 360, 248)).toBe(285)
    expect(clampLayoutWidth(Number.NaN, 200, 360, 248)).toBe(248)
    expect(clampLayoutWidth(undefined, 200, 360, 248)).toBe(248)
  })

  it(`normalizes persisted layout widths with defaults and bounds`, () => {
    expect(normalizeDesktopLayoutWidths(null)).toEqual(DEFAULT_DESKTOP_LAYOUT_WIDTHS)
    expect(normalizeDesktopLayoutWidths({ sidebar: 50, preview: 999, agent: 100 })).toEqual({
      sidebar: DESKTOP_LAYOUT_LIMITS.sidebar.min,
      preview: DESKTOP_LAYOUT_LIMITS.preview.max,
      agent: DESKTOP_LAYOUT_LIMITS.agent.min,
    })
    expect(normalizeDesktopLayoutWidths({ sidebar: 300, preview: 520, agent: 460 })).toEqual({
      sidebar: 300,
      preview: 520,
      agent: 460,
    })
  })

  it(`computes outer main min percent without overflowing 100% on narrow windows`, () => {
    // 1440px split mode with sidebar + agent open -> desired main min is 640px (44.44%)
    const wide = computeMainMinPercent({
      containerWidth: 1440,
      isSidebarOpen: true,
      isAgentOpen: true,
      viewMode: `split`,
      isNewArticleHero: false,
    })
    expect(wide).toBeCloseTo((640 / 1440) * 100, 3)

    // 960px split mode with sidebar (min 200) + agent (min 320) -> remaining is 440px (< 640px), so cap cleanly
    const narrow = computeMainMinPercent({
      containerWidth: 960,
      isSidebarOpen: true,
      isAgentOpen: true,
      viewMode: `split`,
      isNewArticleHero: false,
    })
    expect(narrow + ((200 + 320) / 960) * 100).toBeLessThanOrEqual(100.001)
    expect(narrow).toBeCloseTo((440 / 960) * 100, 3)
  })

  it(`computes editor min percent for edit, split, and preview modes`, () => {
    expect(computeEditorMinPercent({ containerWidth: 800, viewMode: `edit` })).toBe(100)
    expect(computeEditorMinPercent({ containerWidth: 800, viewMode: `preview` })).toBe(0)
    expect(computeEditorMinPercent({ containerWidth: 800, viewMode: `split` })).toBeCloseTo(40, 3)
    // Narrow 500px inner container -> preview min 320px leaves 180px (36%) for editor without exceeding 100%
    expect(computeEditorMinPercent({ containerWidth: 500, viewMode: `split` })).toBeCloseTo(36, 3)
  })
})
