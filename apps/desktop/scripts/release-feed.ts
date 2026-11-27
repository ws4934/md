import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// electron-builder dumps update feeds with js-yaml: top-level scalars plus a single `files:` list.
// They are edited as text (no YAML dependency) so sha512 / size / quoted releaseDate stay byte-identical.

function normalizeLf(text: string): string {
  return text.replace(/\r\n|\r/g, `\n`)
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith(`'`) && trimmed.endsWith(`'`))
    return trimmed.slice(1, -1).replace(/''/g, `'`)
  if (trimmed.length >= 2 && trimmed.startsWith(`"`) && trimmed.endsWith(`"`))
    return trimmed.slice(1, -1)
  return trimmed
}

export function readFeedVersion(feed: string): string {
  const match = /^version:([^\r\n]+)$/m.exec(normalizeLf(feed))
  const version = match ? unquoteYamlScalar(match[1]) : ``
  if (!version)
    throw new Error(`Feed has no version`)
  return version
}

function parseStableSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version.trim())
  if (!match)
    return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Guard for the rolling `desktop-latest` feed: prereleases never publish there,
 * and re-running or patching an older release line must never downgrade a newer stable feed.
 */
export function shouldUpdateLatestFeed(
  currentFeed: string | null | undefined,
  nextVersion: string,
): boolean {
  const next = parseStableSemver(nextVersion)
  if (!next)
    return false
  if (!currentFeed || !currentFeed.trim())
    return true
  const current = parseStableSemver(readFeedVersion(currentFeed))
  if (!current)
    return true
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i])
      return next[i] > current[i]
  }
  return true
}

/** Concatenates the `files` of per-arch feeds; the first feed keeps version, releaseDate and legacy `path`/`sha512`. */
export function mergeFeeds(feeds: string[]): string {
  if (feeds.length === 0)
    throw new Error(`No feeds provided`)
  const normalizedFeeds = feeds.map(normalizeLf)
  const versions = new Set(normalizedFeeds.map(readFeedVersion))
  if (versions.size !== 1)
    throw new Error(`Feed versions differ: ${[...versions].join(`, `)}`)
  const parts = normalizedFeeds.map(splitFiles)
  return [...parts[0].head, `files:`, ...parts.flatMap(part => part.files), ...parts[0].tail, ``].join(`\n`)
}

/** Resolves every file `url` and the legacy `path` against `baseUrl`, because the feed is served from another release. */
export function absolutizeFeed(feed: string, baseUrl: string): string {
  const normalizedBase = `${baseUrl.replace(/\/+$/, ``)}/`
  return normalizeLf(feed).replace(/^(path: | +(?:- )?url: )(.+)$/gm, (_, key: string, value: string) =>
    `${key}${new URL(unquoteYamlScalar(value), normalizedBase).href}`)
}

function splitFiles(feed: string) {
  const lines = normalizeLf(feed).trimEnd().split(`\n`)
  const start = lines.indexOf(`files:`)
  if (start < 0)
    throw new Error(`Feed has no files list`)
  let end = start + 1
  while (lines[end]?.startsWith(` `))
    end++
  return { head: lines.slice(0, start), files: lines.slice(start + 1, end), tail: lines.slice(end) }
}

/** Rewrites the feeds in `dir` in place: per-arch mac feeds → `latest-mac.yml`, all URLs absolute. */
async function main(args: string[]): Promise<void> {
  if (args[0] === `--should-update-latest`) {
    const [, currentPath, nextPath] = args
    if (!currentPath || !nextPath)
      throw new Error(`Usage: tsx scripts/release-feed.ts --should-update-latest <currentFeed> <nextFeed>`)
    const currentFeed = await fs.readFile(currentPath, `utf8`).catch(() => ``)
    const nextVersion = readFeedVersion(await fs.readFile(nextPath, `utf8`))
    process.stdout.write(`${shouldUpdateLatestFeed(currentFeed, nextVersion)}\n`)
    return
  }

  const [dir, baseUrl] = args
  if (!dir || !baseUrl)
    throw new Error(`Usage: tsx scripts/release-feed.ts <dir> <baseUrl>`)
  const read = (name: string) => fs.readFile(path.join(dir, name), `utf8`)
  const feeds = {
    // x64 first: its zip becomes the legacy `path`, which also runs on Apple silicon.
    'latest-mac.yml': mergeFeeds([await read(`latest-mac-x64.yml`), await read(`latest-mac-arm64.yml`)]),
    'latest.yml': await read(`latest.yml`),
  }
  for (const [name, feed] of Object.entries(feeds))
    await fs.writeFile(path.join(dir, name), absolutizeFeed(feed, baseUrl))
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[md-desktop] release feed failed:`, error)
    process.exit(1)
  })
}
