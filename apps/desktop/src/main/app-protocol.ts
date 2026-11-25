import fs from 'node:fs/promises'
import path from 'node:path'

export const APP_SCHEME = `app`
export const APP_HOST = `md`

export function isSafeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== `string`)
    return null
  const trimmed = raw.trim()
  if (!trimmed)
    return null
  try {
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== `https:` && parsed.protocol !== `http:`) || !parsed.hostname)
      return null
    return trimmed
  }
  catch {
    return null
  }
}

export type AppProtocolResolution
  = | { status: 200, filePath: string }
    | { status: 400 | 403 | 404, body: string }

/**
 * Resolves an `app://md/...` request strictly inside `rendererRoot`, rejecting
 * foreign hosts, malformed percent-encoding, `..` traversal, and symlinks pointing
 * outside `rendererRoot`. Missing asset paths fall back to SPA `index.html`.
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

  if (url.hostname !== APP_HOST)
    return { status: 404, body: `Not Found` }

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  }
  catch {
    return { status: 400, body: `Bad Request` }
  }

  if (pathname === `/` || pathname === ``)
    pathname = `/index.html`

  const resolvedRoot = path.resolve(rendererRoot)
  const candidate = path.resolve(resolvedRoot, `.${pathname}`)
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`))
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
      if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`))
        return { status: 403, body: `Forbidden` }
      return { status: 200, filePath: realCandidate }
    }
  }
  catch {
    // Missing asset falls back to SPA index.html below.
  }

  return { status: 200, filePath: path.join(realRoot, `index.html`) }
}
