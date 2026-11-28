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
  notebook: {
    label: `手账`,
    value: `notebook`,
    desc: `推荐配色：天空蓝`,
  },
  guofeng: {
    label: `国风`,
    value: `guofeng`,
    desc: `推荐配色：活力橘`,
  },
  morandi: {
    label: `莫兰迪`,
    value: `morandi`,
    desc: `推荐配色：薰衣紫`,
  },
  brief: {
    label: `简报`,
    value: `brief`,
    desc: `推荐配色：经典蓝`,
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
  {
    label: `手账`,
    value: `notebook`,
    desc: `推荐配色：天空蓝`,
  },
  {
    label: `国风`,
    value: `guofeng`,
    desc: `推荐配色：活力橘`,
  },
  {
    label: `莫兰迪`,
    value: `morandi`,
    desc: `推荐配色：薰衣紫`,
  },
  {
    label: `简报`,
    value: `brief`,
    desc: `推荐配色：经典蓝`,
  },
]
