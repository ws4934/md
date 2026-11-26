import fs from 'node:fs/promises'
import path from 'node:path'

export const APP_SCHEME = `app`
export const APP_HOST = `md`

const MAX_EXTERNAL_URL_LENGTH = 4096

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1F || code === 0x7F)
      return true
  }
  return false
}

function isContainedInRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === `` || (!rel.startsWith(`..`) && !path.isAbsolute(rel))
}

export function isSafeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== `string`)
    return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LENGTH || hasAsciiControlChar(trimmed))
    return null
  try {
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== `https:` && parsed.protocol !== `http:`) || !parsed.hostname)
      return null
    if (parsed.username || parsed.password)
      return null
    return parsed.toString()
  }
  catch {
    return null
  }
}

export function isTrustedRendererUrl(raw: unknown, devServerUrl?: string): boolean {
  if (typeof raw !== `string` || !raw)
    return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  }
  catch {
    return false
  }

  const devTrimmed = devServerUrl?.trim()
  if (devTrimmed) {
    try {
      const devParsed = new URL(devTrimmed)
      if ((devParsed.protocol === `http:` || devParsed.protocol === `https:`) && devParsed.origin === parsed.origin)
        return true
    }
    catch {
      // Ignore malformed dev server URL and fall back to app://md check.
    }
  }

  return parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST && !parsed.port
}

export type AppProtocolResolution
  = | { status: 200, filePath: string }
    | { status: 400 | 403 | 404, body: string }

/**
 * Resolves an `app://md/...` request strictly inside `rendererRoot`, rejecting
 * foreign schemes/hosts, malformed percent-encoding, null bytes, `..` traversal,
 * and symlinks pointing outside `rendererRoot`. Missing asset paths fall back to SPA `index.html`.
 */
export async function resolveAppProtocolTarget(
  requestUrl: string,
  rendererRoot: string,
): Promise<AppProtocolResolution> {
  let url: URL
  try {
    url = new URL(requestUrl)
  }
  catch {
    return { status: 400, body: `Bad Request` }
  }

  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST)
    return { status: 404, body: `Not Found` }

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  }
  catch {
    return { status: 400, body: `Bad Request` }
  }

  if (pathname.includes(`\0`))
    return { status: 400, body: `Bad Request` }

  if (pathname === `/` || pathname === ``)
    pathname = `/index.html`

  const resolvedRoot = path.resolve(rendererRoot)
  const candidate = path.resolve(resolvedRoot, `.${pathname}`)
  if (!isContainedInRoot(resolvedRoot, candidate))
    return { status: 403, body: `Forbidden` }

  let realRoot = resolvedRoot
  try {
    realRoot = await fs.realpath(resolvedRoot)
  }
  catch {
    return { status: 404, body: `Not Found` }
  }

  try {
    const stat = await fs.stat(candidate)
    if (stat.isFile()) {
      const realCandidate = await fs.realpath(candidate)
      if (!isContainedInRoot(realRoot, realCandidate))
        return { status: 403, body: `Forbidden` }
      return { status: 200, filePath: realCandidate }
    }
  }
  catch {
    // Missing asset falls back to SPA index.html below.
  }

  const indexCandidate = path.join(realRoot, `index.html`)
  try {
    const indexStat = await fs.stat(indexCandidate)
    if (!indexStat.isFile())
      return { status: 404, body: `Not Found` }
    const realIndex = await fs.realpath(indexCandidate)
    if (!isContainedInRoot(realRoot, realIndex))
      return { status: 403, body: `Forbidden` }
    return { status: 200, filePath: realIndex }
  }
  catch {
    return { status: 404, body: `Not Found` }
  }
}
