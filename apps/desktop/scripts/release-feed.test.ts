import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider.js'
import { afterEach, describe, expect, it } from 'vitest'
import { copyBundledSkills } from './build'
import { createShutdownController, exitCodeFromProcessExit, waitForServer } from './dev'
import { absolutizeFeed, mergeFeeds, shouldUpdateLatestFeed } from './release-feed'

// Shaped exactly like electron-builder 26 output (zip before dmg, quoted releaseDate, base64 sha512).
const MAC_ARM64 = `version: 2.1.0
files:
  - url: md-2.1.0-mac-arm64.zip
    sha512: Evh8E9B1kXYzFryTqO3ojEkyuU5k/VM8UCdRySM8TKftOUxcWY2/kPOUSl8DVYpHybEsDIS6YpaZfv7z2P5qRg==
    size: 118734512
  - url: md-2.1.0-mac-arm64.dmg
    sha512: UwFDoESMKx4oUy0TNYOHTGp/hLsQQtBYwlNHxwydAr9HW4Gk6pEFsKGUcy+n9pa21zTQ9NjAMJtb2tajsYcs0w==
    size: 121634816
path: md-2.1.0-mac-arm64.zip
sha512: Evh8E9B1kXYzFryTqO3ojEkyuU5k/VM8UCdRySM8TKftOUxcWY2/kPOUSl8DVYpHybEsDIS6YpaZfv7z2P5qRg==
releaseDate: '2026-11-25T08:41:07.512Z'
`

const MAC_X64 = `version: 2.1.0
files:
  - url: md-2.1.0-mac-x64.zip
    sha512: GJZyV9b4VzNHbKsOMZH8pCcXC6bM+0mTYRHvIpxTYs39T0L7gHuDLY3pnukoftkbt7tangDN4+jNDztKxWlkeQ==
    size: 123985120
  - url: md-2.1.0-mac-x64.dmg
    sha512: kw2nxh1tn9Sgk4NJsoB3Yw7VFwqpiKZmjdvM0H/0ohE/p+UfUCxymAmbPpuZ9s9MbXAliWu7rNSsWPqwV/gEOw==
    size: 127381504
path: md-2.1.0-mac-x64.zip
sha512: GJZyV9b4VzNHbKsOMZH8pCcXC6bM+0mTYRHvIpxTYs39T0L7gHuDLY3pnukoftkbt7tangDN4+jNDztKxWlkeQ==
releaseDate: '2026-11-25T08:43:52.090Z'
`

const LINUX = `version: 2.1.0
files:
  - url: md-2.1.0-linux-x86_64.AppImage
    sha512: +96dcByBwqHVtLz9opkiihX5RUj1sJGKkGFVra6o0/jE5O74BIyhpaIxYlsxC4G7RMwuY4GB4gIetV+n+LQTHg==
    size: 131270444
    blockMapSize: 139712
path: md-2.1.0-linux-x86_64.AppImage
sha512: +96dcByBwqHVtLz9opkiihX5RUj1sJGKkGFVra6o0/jE5O74BIyhpaIxYlsxC4G7RMwuY4GB4gIetV+n+LQTHg==
releaseDate: '2026-11-25T08:38:02.215Z'
`

const FEED_URL = new URL(`https://github.com/doocs/md/releases/download/desktop-latest/`)
const BASE = `https://github.com/doocs/md/releases/download/desktop-v2.1.0`

// Parse with electron-updater's own reader so the assertions match what the app will see.
const read = (feed: string) => parseUpdateInfo(feed, `latest-mac.yml`, FEED_URL) as any

describe(`release feed`, () => {
  it(`merges both mac arches and keeps the first feed's metadata`, () => {
    const info = read(mergeFeeds([MAC_X64, MAC_ARM64]))
    expect(info.files.map((file: any) => file.url)).toEqual([
      `md-2.1.0-mac-x64.zip`,
      `md-2.1.0-mac-x64.dmg`,
      `md-2.1.0-mac-arm64.zip`,
      `md-2.1.0-mac-arm64.dmg`,
    ])
    expect(info.files[2]).toEqual({ url: `md-2.1.0-mac-arm64.zip`, sha512: read(MAC_ARM64).sha512, size: 118734512 })
    expect(info).toMatchObject({
      version: `2.1.0`,
      path: `md-2.1.0-mac-x64.zip`,
      sha512: read(MAC_X64).sha512,
      releaseDate: `2026-11-25T08:43:52.090Z`,
    })
  })

  it(`refuses to merge feeds of different versions`, () => {
    expect(() => mergeFeeds([MAC_X64, MAC_ARM64.replaceAll(`2.1.0`, `2.1.1`)])).toThrow(/versions differ/)
  })

  it(`points files and the legacy path at the versioned release`, () => {
    const mac = absolutizeFeed(mergeFeeds([MAC_X64, MAC_ARM64]), BASE)
    expect(resolveFiles(read(mac), FEED_URL).map(file => file.url.href)).toEqual([
      `${BASE}/md-2.1.0-mac-x64.zip`,
      `${BASE}/md-2.1.0-mac-x64.dmg`,
      `${BASE}/md-2.1.0-mac-arm64.zip`,
      `${BASE}/md-2.1.0-mac-arm64.dmg`,
    ])

    const linux = absolutizeFeed(LINUX, BASE)
    expect(read(linux)).toEqual({
      ...read(LINUX),
      files: [{ ...read(LINUX).files[0], url: `${BASE}/md-2.1.0-linux-x86_64.AppImage` }],
      path: `${BASE}/md-2.1.0-linux-x86_64.AppImage`,
    })
    expect(absolutizeFeed(linux, BASE)).toBe(linux)
    expect(absolutizeFeed(`path: 'md 2.1.0.exe'\n`, BASE)).toBe(`path: ${BASE}/md%202.1.0.exe\n`)
    // Trailing slash on baseUrl must not produce `//` in download URLs
    expect(absolutizeFeed(`path: 'md 2.1.0.exe'\n`, `${BASE}/`)).toBe(`path: ${BASE}/md%202.1.0.exe\n`)
    // CRLF feeds (e.g. from Windows) normalize cleanly without corrupting quoted filenames
    expect(absolutizeFeed(`version: 2.1.0\r\nfiles:\r\n  - url: 'md 2.1.0.exe'\r\npath: 'md 2.1.0.exe'\r\n`, BASE)).toBe(
      `version: 2.1.0\nfiles:\n  - url: ${BASE}/md%202.1.0.exe\npath: ${BASE}/md%202.1.0.exe\n`,
    )
    expect(read(mergeFeeds([MAC_X64.replace(/\n/g, `\r\n`), MAC_ARM64])).files).toHaveLength(4)
  })

  it(`prevents downgrading or publishing prereleases to desktop-latest`, () => {
    expect(() => mergeFeeds([])).toThrow(/No feeds/)
    expect(() => mergeFeeds([`files:\n  - url: a.zip\n`])).toThrow(/no version/)

    expect(shouldUpdateLatestFeed(``, `2.1.0`)).toBe(true)
    expect(shouldUpdateLatestFeed(LINUX, `2.1.0`)).toBe(true)
    expect(shouldUpdateLatestFeed(LINUX, `2.2.0`)).toBe(true)
    expect(shouldUpdateLatestFeed(LINUX, `2.0.9`)).toBe(false)
    expect(shouldUpdateLatestFeed(LINUX, `2.2.0-beta.1`)).toBe(false)
  })
})

describe(`desktop build & dev script helpers`, () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)))
  })

  it(`copies bundled skills dereferencing symlinks, stripping .DS_Store, and validating SKILL.md`, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `md-build-skills-`))
    tempDirs.push(tmp)
    const srcRoot = path.join(tmp, `src-skills`)
    const destRoot = path.join(tmp, `dist-skills`)
    const sharedRef = path.join(tmp, `shared-ref.md`)
    await fs.writeFile(sharedRef, `# Shared Ref\n`, `utf8`)

    const skillDir = path.join(srcRoot, `demo-skill`)
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, `SKILL.md`), `---\nname: demo-skill\n---\n`, `utf8`)
    await fs.writeFile(path.join(skillDir, `.DS_Store`), `junk`, `utf8`)
    await fs.symlink(sharedRef, path.join(skillDir, `ref.md`))

    // Stale directory in destRoot must be removed
    await fs.mkdir(path.join(destRoot, `stale-skill`), { recursive: true })

    await copyBundledSkills(srcRoot, destRoot, [`demo-skill`])

    expect(await fs.readdir(destRoot)).toEqual([`demo-skill`])
    const copiedEntries = await fs.readdir(path.join(destRoot, `demo-skill`))
    expect(copiedEntries.sort()).toEqual([`SKILL.md`, `ref.md`])
    const refStat = await fs.lstat(path.join(destRoot, `demo-skill`, `ref.md`))
    expect(refStat.isSymbolicLink()).toBe(false)

    // Missing SKILL.md fails fast
    await fs.mkdir(path.join(srcRoot, `broken-skill`), { recursive: true })
    await expect(copyBundledSkills(srcRoot, destRoot, [`broken-skill`])).rejects.toThrow()
  })

  it(`deduplicates concurrent dev shutdown calls, awaits cleanup, and aborts waitForServer cleanly`, async () => {
    let cleanupCalls = 0
    let releaseCleanup!: () => void
    const exitedCodes: number[] = []

    const controller = createShutdownController(
      () => {
        cleanupCalls++
        return new Promise<void>((resolve) => {
          releaseCleanup = resolve
        })
      },
      code => exitedCodes.push(code),
    )

    const p1 = controller.shutdown(0)
    const p2 = controller.shutdown(1)
    expect(controller.isShuttingDown).toBe(true)
    expect(cleanupCalls).toBe(1)
    expect(exitedCodes).toEqual([])

    // waitForServer stops immediately when shouldAbort() is true
    await expect(
      waitForServer(`http://127.0.0.1:9/`, {
        timeoutMs: 10_000,
        shouldAbort: () => controller.isShuttingDown,
      }),
    ).rejects.toThrow(/Aborted/)

    releaseCleanup()
    await Promise.all([p1, p2])
    expect(exitedCodes).toEqual([0])

    expect(exitCodeFromProcessExit(0, null, 1)).toBe(0)
    expect(exitCodeFromProcessExit(null, `SIGABRT`, 0)).toBe(1)
    expect(exitCodeFromProcessExit(null, null, 0)).toBe(0)
  })
})
