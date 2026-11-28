import type { IConfigOption } from '../types'
import type { ThemeName } from './theme-css'

export {
  baseCSSContent,
  type BuiltinThemeName,
  isBuiltinThemeName,
  themeMap,
  type ThemeName,
} from './theme-css'

export const themeOptionsMap = {
  default: {
    label: `经典`,
    value: `default`,
    desc: ``,
  },
  grace: {
    label: `优雅`,
    value: `grace`,
    desc: `@brzhang`,
  },
  simple: {
    label: `简洁`,
    value: `simple`,
    desc: `@okooo5km`,
  },
  fresh: {
    label: `清新`,
    value: `fresh`,
    desc: `推荐配色：翡翠绿`,
  },
  magazine: {
    label: `杂志`,
    value: `magazine`,
    desc: `推荐配色：经典蓝`,
  },
  warm: {
    label: `暖阳`,
    value: `warm`,
    desc: `推荐配色：玫瑰金`,
  },
  ink: {
    label: `墨白`,
    value: `ink`,
    desc: `推荐配色：石墨黑`,
  },
}

export const themeOptions: IConfigOption<ThemeName>[] = [
  {
    label: `经典`,
    value: `default`,
    desc: ``,
  },
  {
    label: `优雅`,
    value: `grace`,
    desc: `@brzhang`,
  },
  {
    label: `简洁`,
    value: `simple`,
    desc: `@okooo5km`,
  },
  {
    label: `清新`,
    value: `fresh`,
    desc: `推荐配色：翡翠绿`,
  },
  {
    label: `杂志`,
    value: `magazine`,
    desc: `推荐配色：经典蓝`,
  },
  {
    label: `暖阳`,
    value: `warm`,
    desc: `推荐配色：玫瑰金`,
  },
  {
    label: `墨白`,
    value: `ink`,
    desc: `推荐配色：石墨黑`,
  },
]
