import { describe, expect, it } from 'vitest'
import {
  computeCascadingMenuLayout,
  computeFloatingMenuPosition,
  resolveModelPillDisplayMode,
} from './floating-menu'

describe(`floating-menu positioning helpers`, () => {
  it(`shifts single menus cleanly inside viewport bounds at narrow panels and flips vertically when cramped`, () => {
    // 320px right-side panel on a 1100px window: permission menu (316px wide) near right edge.
    const pos = computeFloatingMenuPosition({
      anchor: { left: 860, right: 915, top: 865, bottom: 893, width: 55, height: 28 },
      menu: { width: 316, height: 260 },
      viewport: { width: 1100, height: 920 },
      preferredSide: `top`,
      preferredAlign: `end`,
    })
    expect(pos.side).toBe(`top`)
    expect(pos.left).toBeGreaterThanOrEqual(12)
    expect(pos.left + 316).toBeLessThanOrEqual(1100 - 12)
    expect(pos.top).toBeGreaterThanOrEqual(12)
    expect(pos.top + 260).toBeLessThanOrEqual(865 - 8)

    // Trigger near top edge with preferredSide=top flips to bottom.
    const flipped = computeFloatingMenuPosition({
      anchor: { left: 500, right: 560, top: 40, bottom: 68, width: 60, height: 28 },
      menu: { width: 208, height: 220 },
      viewport: { width: 1100, height: 920 },
      preferredSide: `top`,
    })
    expect(flipped.side).toBe(`bottom`)
    expect(flipped.top).toBe(68 + 8)
  })

  it(`places cascading agent+model submenu to the left inside right-side panel without viewport overflow`, () => {
    // 400px right panel on 1440px window, Antigravity pill at left=1067.
    const layout400 = computeCascadingMenuLayout({
      anchor: { left: 1067, right: 1222, top: 865, bottom: 893, width: 155, height: 28 },
      primary: { width: 260, height: 290 },
      submenu: { width: 240, height: 340 },
      viewport: { width: 1440, height: 920 },
      preferredSide: `top`,
    })
    expect(layout400.stacked).toBe(false)
    expect(layout400.submenuSide).toBe(`left`)
    expect(layout400.submenu).not.toBeNull()
    expect(layout400.submenu!.left).toBeGreaterThanOrEqual(12)
    expect(layout400.submenu!.left + 240).toBeLessThanOrEqual(layout400.primary.left)
    expect(layout400.primary.left + 260).toBeLessThanOrEqual(1440 - 12)
    expect(layout400.submenu!.top).toBeGreaterThanOrEqual(12)

    // 320px panel on 1100px window: still opens side-by-side cleanly inside [12..1088].
    const layout1100 = computeCascadingMenuLayout({
      anchor: { left: 808, right: 1055, top: 833, bottom: 861, width: 247, height: 28 },
      primary: { width: 260, height: 290 },
      submenu: { width: 240, height: 340 },
      viewport: { width: 1100, height: 920 },
      preferredSide: `top`,
    })
    expect(layout1100.stacked).toBe(false)
    expect(layout1100.submenuSide).toBe(`left`)
    expect(layout1100.submenu!.left).toBeGreaterThanOrEqual(12)
    expect(layout1100.primary.left + 260).toBeLessThanOrEqual(1100 - 12)
  })

  it(`opens cascading submenu to the right in hero composer (preferredSide=bottom) and stacks on ultra-narrow viewports`, () => {
    const hero = computeCascadingMenuLayout({
      anchor: { left: 360, right: 540, top: 460, bottom: 488, width: 180, height: 28 },
      primary: { width: 260, height: 290 },
      submenu: { width: 240, height: 320 },
      viewport: { width: 1440, height: 920 },
      preferredSide: `bottom`,
    })
    expect(hero.stacked).toBe(false)
    expect(hero.side).toBe(`bottom`)
    expect(hero.submenuSide).toBe(`right`)
    expect(hero.submenu!.left).toBe(hero.primary.left + 260 + 6)
    expect(hero.submenu!.left + 240).toBeLessThanOrEqual(1440 - 12)

    // Ultra-narrow viewport (480px) cannot fit 260+6+240=506px side-by-side -> stacks cleanly.
    const narrow = computeCascadingMenuLayout({
      anchor: { left: 200, right: 360, top: 700, bottom: 728, width: 160, height: 28 },
      primary: { width: 260, height: 220 },
      submenu: { width: 240, height: 220 },
      viewport: { width: 480, height: 800 },
      preferredSide: `top`,
    })
    expect(narrow.stacked).toBe(true)
    expect(narrow.primary.left).toBeGreaterThanOrEqual(12)
    expect(narrow.primary.left + 260).toBeLessThanOrEqual(480 - 12)
    expect(narrow.submenu!.left).toBeGreaterThanOrEqual(12)
    expect(narrow.submenu!.left + 240).toBeLessThanOrEqual(480 - 12)
  })

  it(`gives priority to model name whenever agent + model do not both fit`, () => {
    // Full agent + model fits cleanly -> show both.
    expect(resolveModelPillDisplayMode({
      availableWidth: 262,
      fullWidth: 252,
      hasModel: true,
      isDefaultModel: false,
    })).toBe(`full`)

    // At 440px panel (222px available) Antigravity CLI + Gemini 3.8 Flash (252px) does not fit -> model wins.
    expect(resolveModelPillDisplayMode({
      availableWidth: 222,
      fullWidth: 252,
      hasModel: true,
      isDefaultModel: false,
    })).toBe(`model-only`)

    // Generic `default` model (Claude Code Default (recommended)) falls back to agent + short Default.
    expect(resolveModelPillDisplayMode({
      availableWidth: 210,
      fullWidth: 278,
      hasModel: true,
      isDefaultModel: true,
    })).toBe(`agent-default`)

    // No model probed yet -> show agent name.
    expect(resolveModelPillDisplayMode({
      availableWidth: 160,
      fullWidth: 120,
      hasModel: false,
      isDefaultModel: false,
    })).toBe(`full`)
  })
})
