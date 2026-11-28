/** CSS theme strings for JavaScript consumers */

import type { MarketplaceThemeKey } from '../../types/marketplace'
import baseCSS from './base.css?raw'
import briefCSS from './brief.css?raw'
import defaultCSS from './default.css?raw'
import freshCSS from './fresh.css?raw'
import graceCSS from './grace.css?raw'
import guofengCSS from './guofeng.css?raw'
import inkCSS from './ink.css?raw'
import magazineCSS from './magazine.css?raw'
import morandiCSS from './morandi.css?raw'
import notebookCSS from './notebook.css?raw'
import simpleCSS from './simple.css?raw'
import warmCSS from './warm.css?raw'

export const baseCSSContent = baseCSS

export const themeMap = {
  default: defaultCSS,
  grace: graceCSS,
  simple: simpleCSS,
  fresh: freshCSS,
  magazine: magazineCSS,
  warm: warmCSS,
  ink: inkCSS,
  notebook: notebookCSS,
  guofeng: guofengCSS,
  morandi: morandiCSS,
  brief: briefCSS,
} as const

export type BuiltinThemeName = keyof typeof themeMap

/** Built-in theme id, or marketplace theme key (`mp:<id>`). */
export type ThemeName = BuiltinThemeName | MarketplaceThemeKey

export function isBuiltinThemeName(name: string): name is BuiltinThemeName {
  return Object.keys(themeMap).includes(name)
}
