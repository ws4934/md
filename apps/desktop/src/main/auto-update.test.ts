import type { UpdateEnvironment } from './auto-update'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  areUpdateStatesEqual,
  createInitialUpdateState,
  createUpdatePromptGate,
  readMacAutoInstallFlag,
  reduceUpdateState,
  releasePageUrl,
  resolveUpdateMode,
  UPDATE_COPY,
} from './auto-update'
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

describe(`reduceUpdateState`, () => {
  it(`stays idle and ignores all events when updates are unsupported`, () => {
    const initial = createInitialUpdateState(`2.1.0`, null)
    expect(initial).toEqual({
      supported: false,
      mode: null,
      currentVersion: `2.1.0`,
      status: `idle`,
    })

    expect(reduceUpdateState(initial, { type: `checking` })).toBe(initial)
    expect(reduceUpdateState(initial, { type: `available`, version: `2.2.0` })).toBe(initial)
    expect(reduceUpdateState(initial, { type: `not-available` })).toBe(initial)
    expect(reduceUpdateState(initial, { type: `download-progress`, percent: 50 })).toBe(initial)
    expect(reduceUpdateState(initial, { type: `downloaded`, version: `2.2.0` })).toBe(initial)
    expect(reduceUpdateState(initial, { type: `error`, message: `offline` })).toBe(initial)
  })

  it(`transitions checking → not-available`, () => {
    const initial = createInitialUpdateState(`2.1.0`, `install`)
    const checking = reduceUpdateState(initial, { type: `checking` })
    expect(checking).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `checking`,
    })

    const upToDate = reduceUpdateState(checking, { type: `not-available` })
    expect(upToDate).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `not-available`,
    })
  })

  it(`exposes releaseUrl for available updates in notify mode and omits unsafe URLs`, () => {
    const checking = reduceUpdateState(createInitialUpdateState(`2.1.0`, `notify`), { type: `checking` })

    const available = reduceUpdateState(checking, {
      type: `available`,
      version: `2.2.0`,
      fileUrl: `https://github.com/doocs/md/releases/download/desktop-v2.2.0/md-2.2.0-mac-arm64.zip`,
    })
    expect(available).toEqual({
      supported: true,
      mode: `notify`,
      currentVersion: `2.1.0`,
      status: `available`,
      version: `2.2.0`,
      releaseUrl: `https://github.com/doocs/md/releases/tag/desktop-v2.2.0`,
    })

    const withoutSafeUrl = reduceUpdateState(checking, {
      type: `available`,
      version: `2.2.0`,
      fileUrl: `javascript:/releases/download/x/y.zip`,
    })
    expect(withoutSafeUrl).toEqual({
      supported: true,
      mode: `notify`,
      currentVersion: `2.1.0`,
      status: `available`,
      version: `2.2.0`,
    })
  })

  it(`tracks download progress and downloaded state in install mode`, () => {
    const checking = reduceUpdateState(createInitialUpdateState(`2.1.0`, `install`), { type: `checking` })
    const available = reduceUpdateState(checking, {
      type: `available`,
      version: `2.2.0`,
      fileUrl: `https://github.com/doocs/md/releases/download/desktop-v2.2.0/md-2.2.0.exe`,
    })
    expect(available).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `downloading`,
      version: `2.2.0`,
    })

    const progress1 = reduceUpdateState(available, { type: `download-progress`, percent: 42.6 })
    expect(progress1).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `downloading`,
      version: `2.2.0`,
      percent: 43,
    })

    const clamped = reduceUpdateState(progress1, { type: `download-progress`, percent: 150 })
    expect(clamped.percent).toBe(100)

    const nonFinite = reduceUpdateState(progress1, { type: `download-progress`, percent: Number.NaN })
    expect(nonFinite.percent).toBe(43)

    const downloaded = reduceUpdateState(progress1, { type: `downloaded`, version: `2.2.0` })
    expect(downloaded).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `downloaded`,
      version: `2.2.0`,
    })
  })

  it(`records errors and clears stale fields on retry`, () => {
    const downloading = reduceUpdateState(
      reduceUpdateState(createInitialUpdateState(`2.1.0`, `install`), { type: `available`, version: `2.2.0` }),
      { type: `download-progress`, percent: 30 },
    )

    const errored = reduceUpdateState(downloading, { type: `error`, message: `  net::ERR_INTERNET_DISCONNECTED  ` })
    expect(errored).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `error`,
      error: `net::ERR_INTERNET_DISCONNECTED`,
    })

    const retrying = reduceUpdateState(errored, { type: `checking` })
    expect(retrying).toEqual({
      supported: true,
      mode: `install`,
      currentVersion: `2.1.0`,
      status: `checking`,
    })

    expect(areUpdateStatesEqual(retrying, { ...retrying })).toBe(true)
    expect(areUpdateStatesEqual(retrying, errored)).toBe(false)
  })

  it(`ignores late download-progress after downloaded/error and ignores download events in notify mode`, () => {
    const downloading = reduceUpdateState(createInitialUpdateState(`2.1.0`, `install`), {
      type: `available`,
      version: `2.2.0`,
    })
    const downloaded = reduceUpdateState(downloading, { type: `downloaded`, version: `2.2.0` })
    expect(reduceUpdateState(downloaded, { type: `download-progress`, percent: 99 })).toBe(downloaded)

    const errored = reduceUpdateState(downloading, { type: `error`, message: `network lost` })
    expect(reduceUpdateState(errored, { type: `download-progress`, percent: 50 })).toBe(errored)

    const notifyAvailable = reduceUpdateState(createInitialUpdateState(`2.1.0`, `notify`), {
      type: `available`,
      version: `2.2.0`,
      fileUrl: `https://github.com/doocs/md/releases/download/desktop-v2.2.0/md-2.2.0-mac-arm64.zip`,
    })
    expect(reduceUpdateState(notifyAvailable, { type: `download-progress`, percent: 40 })).toBe(notifyAvailable)
    expect(reduceUpdateState(notifyAvailable, { type: `downloaded`, version: `2.2.0` })).toBe(notifyAvailable)
  })
})
