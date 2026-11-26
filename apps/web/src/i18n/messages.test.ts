import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { computed } from 'vue'
import { ensureLocaleMessages, setupI18n } from './index'
import enUS from './messages/en-US/index'
import jaJP from './messages/ja-JP/index'
import zhCN from './messages/zh-CN/index'
import zhTW from './messages/zh-TW/index'

function flattenMessages(obj: Record<string, unknown>, prefix = ``): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const nextKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === `object` && !Array.isArray(value))
      Object.assign(result, flattenMessages(value as Record<string, unknown>, nextKey))
    else
      result[nextKey] = String(value ?? ``)
  }
  return result
}

function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory())
      out.push(...collectSourceFiles(fullPath))
    else if (/\.(?:vue|ts)$/.test(entry.name) && !entry.name.endsWith(`.test.ts`))
      out.push(fullPath)
  }
  return out
}

describe(`i18n message catalogs`, () => {
  const catalogs = {
    'zh-CN': flattenMessages(zhCN),
    'zh-TW': flattenMessages(zhTW),
    'en-US': flattenMessages(enUS),
    'ja-JP': flattenMessages(jaJP),
  } as const

  it(`has identical keys and {placeholder} tokens across zh-CN, zh-TW, en-US, and ja-JP`, () => {
    const baseKeys = Object.keys(catalogs[`zh-CN`]).sort()
    expect(Object.keys(catalogs[`zh-TW`]).sort()).toEqual(baseKeys)
    expect(Object.keys(catalogs[`en-US`]).sort()).toEqual(baseKeys)
    expect(Object.keys(catalogs[`ja-JP`]).sort()).toEqual(baseKeys)

    for (const key of baseKeys) {
      const basePlaceholders = extractPlaceholders(catalogs[`zh-CN`][key])
      expect(extractPlaceholders(catalogs[`zh-TW`][key]), `${key} in zh-TW`).toEqual(basePlaceholders)
      expect(extractPlaceholders(catalogs[`en-US`][key]), `${key} in en-US`).toEqual(basePlaceholders)
      expect(extractPlaceholders(catalogs[`ja-JP`][key]), `${key} in ja-JP`).toEqual(basePlaceholders)
    }
  })

  it(`resolves every static t('...') key referenced in components and configs`, () => {
    const srcRoot = path.resolve(__dirname, `..`)
    const files = [
      ...collectSourceFiles(path.join(srcRoot, `components`)),
      ...collectSourceFiles(path.join(srcRoot, `configs`)),
      path.join(srcRoot, `App.vue`),
    ]

    const missing: string[] = []
    for (const file of files) {
      const content = fs.readFileSync(file, `utf8`)
      for (const match of content.matchAll(/\bt\(\s*([`'"])([^$`'"]+)\1/g)) {
        const key = match[2]
        if (!(key in catalogs[`zh-CN`]))
          missing.push(`${path.relative(srcRoot, file)}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it(`re-evaluates locale-dependent computed translations when switching locales`, async () => {
    const i18n = await setupI18n(`zh-CN`)
    const label = computed(() => {
      const localeRef = i18n.global.locale
      if (typeof localeRef !== `string`)
        void localeRef.value
      return (i18n.global.t as (key: string) => string)(`keyboard.goToLine`)
    })

    expect(label.value).toBe(`跳转到行`)

    await ensureLocaleMessages(i18n, `en-US`)
    if (typeof i18n.global.locale === `string`)
      i18n.global.locale = `en-US`
    else
      i18n.global.locale.value = `en-US`

    expect(label.value).toBe(`Go to line`)
  })
})
