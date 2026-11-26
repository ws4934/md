import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// electron-builder dumps update feeds with js-yaml: top-level scalars plus a single `files:` list.
// They are edited as text (no YAML dependency) so sha512 / size / quoted releaseDate stay byte-identical.

/** Concatenates the `files` of per-arch feeds; the first feed keeps version, releaseDate and legacy `path`/`sha512`. */
export function mergeFeeds(feeds: string[]): string {
  const versions = new Set(feeds.map(feed => /^version: (.+)$/m.exec(feed)?.[1]))
  if (versions.size !== 1)
    throw new Error(`Feed versions differ: ${[...versions].join(`, `)}`)
  const parts = feeds.map(splitFiles)
  return [...parts[0].head, `files:`, ...parts.flatMap(part => part.files), ...parts[0].tail, ``].join(`\n`)
}

/** Resolves every file `url` and the legacy `path` against `baseUrl`, because the feed is served from another release. */
export function absolutizeFeed(feed: string, baseUrl: string): string {
  return feed.replace(/^(path: | +(?:- )?url: )(.+)$/gm, (_, key: string, value: string) =>
    `${key}${new URL(value.replace(/^(['"])(.*)\1$/, `$2`), `${baseUrl}/`).href}`)
}

function splitFiles(feed: string) {
  const lines = feed.trimEnd().split(`\n`)
  const start = lines.indexOf(`files:`)
  if (start < 0)
    throw new Error(`Feed has no files list`)
  let end = start + 1
  while (lines[end]?.startsWith(` `))
    end++
  return { head: lines.slice(0, start), files: lines.slice(start + 1, end), tail: lines.slice(end) }
}

/** Rewrites the feeds in `dir` in place: per-arch mac feeds → `latest-mac.yml`, all URLs absolute. */
async function main(dir: string | undefined, baseUrl: string | undefined): Promise<void> {
  if (!dir || !baseUrl)
    throw new Error(`Usage: tsx scripts/release-feed.ts <dir> <baseUrl>`)
  const read = (name: string) => fs.readFile(path.join(dir, name), `utf8`)
  const feeds = {
    // x64 first: its zip becomes the legacy `path`, which also runs on Apple silicon.
    'latest-mac.yml': mergeFeeds([await read(`latest-mac-x64.yml`), await read(`latest-mac-arm64.yml`)]),
    'latest.yml': await read(`latest.yml`),
    'latest-linux.yml': await read(`latest-linux.yml`),
  }
  for (const [name, feed] of Object.entries(feeds))
    await fs.writeFile(path.join(dir, name), absolutizeFeed(feed, baseUrl))
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main(process.argv[2], process.argv[3]).catch((error) => {
    console.error(`[md-desktop] release feed failed:`, error)
    process.exit(1)
  })
}
