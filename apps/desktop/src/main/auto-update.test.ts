import type { UpdateEnvironment } from './auto-update'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUpdatePromptGate, readMacAutoInstallFlag, releasePageUrl, resolveUpdateMode, UPDATE_COPY } from './auto-update'
import { resolveQuitLocale } from './quit-guard'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0)
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
})

const packagedMac: UpdateEnvironment = {
  isPackaged: true,
  isSmokeRun: false,
  platform: `darwin`,
  isAppImage: false,
  macAutoInstall: false,
}

describe(`resolveUpdateMode`, () => {
  it(`never runs in dev or smoke runs`, () => {
    expect(resolveUpdateMode({ ...packagedMac, isPackaged: false })).toBeNull()
    expect(resolveUpdateMode({ ...packagedMac, isSmokeRun: true })).toBeNull()
    expect(resolveUpdateMode({ ...packagedMac, platform: `win32`, isSmokeRun: true })).toBeNull()
  })

  it(`only notifies on unsigned macOS and installs on signed macOS, Windows and AppImage`, () => {
    expect(resolveUpdateMode(packagedMac)).toBe(`notify`)
    expect(resolveUpdateMode({ ...packagedMac, macAutoInstall: true })).toBe(`install`)
    expect(resolveUpdateMode({ ...packagedMac, platform: `win32` })).toBe(`install`)
    expect(resolveUpdateMode({ ...packagedMac, platform: `linux`, isAppImage: true })).toBe(`install`)
    expect(resolveUpdateMode({ ...packagedMac, platform: `linux` })).toBeNull()
  })
})

describe(`readMacAutoInstallFlag`, () => {
  async function appDirWith(pkg: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `md-update-`))
    tempDirs.push(dir)
    await fs.writeFile(path.join(dir, `package.json`), JSON.stringify(pkg))
    return dir
  }

  it(`is true only when CI injected the flag`, async () => {
    expect(readMacAutoInstallFlag(await appDirWith({ mdAutoInstallUpdates: true }))).toBe(true)
    expect(readMacAutoInstallFlag(await appDirWith({ mdAutoInstallUpdates: `true` }))).toBe(true)
    expect(readMacAutoInstallFlag(await appDirWith({ mdAutoInstallUpdates: false }))).toBe(false)
    expect(readMacAutoInstallFlag(await appDirWith({ name: `@md/desktop` }))).toBe(false)
    expect(readMacAutoInstallFlag(await appDirWith(null))).toBe(false)
    expect(readMacAutoInstallFlag(path.join(os.tmpdir(), `md-update-missing-${Date.now()}`))).toBe(false)
  })
})

describe(`releasePageUrl`, () => {
  it(`maps a release asset URL to its release page`, () => {
    expect(releasePageUrl(`https://github.com/doocs/md/releases/download/desktop-v2.2.0/md-2.2.0-mac-arm64.zip`))
      .toBe(`https://github.com/doocs/md/releases/tag/desktop-v2.2.0`)
    expect(releasePageUrl(`https://github.com/someone/fork/releases/download/desktop-v3.0.0-beta.1/md-3.0.0-beta.1-mac-x64.zip`))
      .toBe(`https://github.com/someone/fork/releases/tag/desktop-v3.0.0-beta.1`)
  })

  it(`rejects anything that is not an http(s) release asset URL`, () => {
    expect(releasePageUrl(undefined)).toBeNull()
    expect(releasePageUrl(`md-2.2.0-mac-arm64.zip`)).toBeNull()
    expect(releasePageUrl(`https://example.com/downloads/md-2.2.0.zip`)).toBeNull()
    expect(releasePageUrl(`javascript:/releases/download/x/y.zip`)).toBeNull()
    expect(releasePageUrl(`file:///releases/download/x/y.zip`)).toBeNull()
  })
})

describe(`createUpdatePromptGate`, () => {
  it(`prompts once per version for background checks but always for manual checks`, () => {
    const shouldPrompt = createUpdatePromptGate()
    expect(shouldPrompt(`2.2.0`, false)).toBe(true)
    expect(shouldPrompt(`2.2.0`, false)).toBe(false)
    expect(shouldPrompt(`2.2.0`, true)).toBe(true)
    expect(shouldPrompt(`2.3.0`, false)).toBe(true)
    expect(shouldPrompt(`2.3.0`, false)).toBe(false)

    // A manual prompt also counts as shown for later background checks.
    const manualFirst = createUpdatePromptGate()
    expect(manualFirst(`2.2.0`, true)).toBe(true)
    expect(manualFirst(`2.2.0`, false)).toBe(false)
  })
})

describe(`update dialog copy`, () => {
  const locales = [`zh-CN`, `zh-TW`, `en-US`, `ja-JP`] as const
  const englishKeys = Object.keys(UPDATE_COPY[`en-US`]).sort()

  it(`covers exactly the 4 UI locales the quit guard resolves to`, () => {
    expect(Object.keys(UPDATE_COPY).sort()).toEqual([...locales].sort())
    for (const raw of [`zh-CN`, `zh_Hant_HK`, `en-GB`, `ja`, `fr-FR`])
      expect(UPDATE_COPY[resolveQuitLocale(raw)]).toBeDefined()
  })

  it.each(locales)(`%s has every string, non-empty, with the version interpolated`, (locale) => {
    const copy = UPDATE_COPY[locale]
    expect(Object.keys(copy).sort()).toEqual(englishKeys)
    for (const [key, value] of Object.entries(copy)) {
      const text = typeof value === `function` ? value(`9.8.7`) : value
      expect(text.trim(), `${locale}.${key}`).not.toBe(``)
      if (typeof value === `function`)
        expect(text, `${locale}.${key}`).toContain(`9.8.7`)
    }
    if (locale !== `en-US`)
      expect(copy.menuLabel).not.toBe(UPDATE_COPY[`en-US`].menuLabel)
  })
})
