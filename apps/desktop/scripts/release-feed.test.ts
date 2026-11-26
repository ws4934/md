import { parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider.js'
import { describe, expect, it } from 'vitest'
import { absolutizeFeed, mergeFeeds } from './release-feed'

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
  })
})
