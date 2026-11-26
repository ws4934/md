import type {
  DesktopMarketplaceListParams,
  MarketplaceItemDetail,
  MarketplaceListResponse,
} from '@md/shared/types'

export const DEFAULT_MARKETPLACE_API_URL = `https://md-api.doocs.org`
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_CHARS = 5 * 1024 * 1024
const SAFE_ITEM_ID_RE = /^[\w-]{1,128}$/
const MAX_QUERY_LENGTH = 64
const MAX_PAGE_SIZE = 50

export interface DesktopMarketplaceClientOptions {
  apiUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function resolveBaseUrl(raw?: string): string {
  const candidate = (raw ?? ``).trim()
  if (!candidate)
    return DEFAULT_MARKETPLACE_API_URL
  try {
    const parsed = new URL(candidate)
    if (
      (parsed.protocol === `https:` || parsed.protocol === `http:`)
      && parsed.hostname
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
    ) {
      return candidate.replace(/\/+$/, ``)
    }
  }
  catch {
    // Fall back to default official endpoint if env override is invalid.
  }
  return DEFAULT_MARKETPLACE_API_URL
}

function assertValidItemId(id: unknown): string {
  if (typeof id !== `string` || !SAFE_ITEM_ID_RE.test(id))
    throw new Error(`Invalid marketplace item id`)
  return id
}

function buildThemesQuery(params?: DesktopMarketplaceListParams): string {
  if (params === undefined || params === null)
    return ``
  if (typeof params !== `object` || Array.isArray(params))
    throw new TypeError(`Invalid marketplace list parameters`)
  const search = new URLSearchParams()
  if (typeof params.q === `string`) {
    const q = params.q.trim().slice(0, MAX_QUERY_LENGTH)
    if (q)
      search.set(`q`, q)
  }
  if (params.sort === `popular` || params.sort === `newest`)
    search.set(`sort`, params.sort)
  if (typeof params.page === `number` && Number.isFinite(params.page) && params.page >= 1)
    search.set(`page`, String(Math.floor(params.page)))
  if (typeof params.pageSize === `number` && Number.isFinite(params.pageSize) && params.pageSize >= 1)
    search.set(`pageSize`, String(Math.min(MAX_PAGE_SIZE, Math.floor(params.pageSize))))
  const qs = search.toString()
  return qs ? `?${qs}` : ``
}

function extractUpstreamErrorMessage(rawText: string, fallback: string): string {
  if (!rawText)
    return fallback
  try {
    const body = JSON.parse(rawText) as { error?: unknown, message?: unknown }
    if (typeof body?.error === `string` && body.error.trim())
      return body.error.trim()
    if (typeof body?.error === `object` && body.error !== null) {
      const nested = (body.error as { message?: unknown }).message
      if (typeof nested === `string` && nested.trim())
        return nested.trim()
    }
    if (typeof body?.message === `string` && body.message.trim())
      return body.message.trim()
  }
  catch {
    // Ignore non-JSON error responses.
  }
  return fallback
}

/**
 * Main-process proxy for public md-api marketplace endpoints.
 * Electron's `app://md` renderer origin is not on md-api's CORS allowlist, so
 * routing read/install requests through main lets desktop browse and install
 * community themes without weakening browser CORS policy.
 */
export function createDesktopMarketplaceClient(options: DesktopMarketplaceClientOptions = {}) {
  const baseUrl = resolveBaseUrl(options.apiUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = typeof options.timeoutMs === `number` && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : REQUEST_TIMEOUT_MS

  async function requestJson<T>(method: `GET` | `POST`, endpointPath: string): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${endpointPath}`, {
        method,
        headers: {
          Accept: `application/json`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    catch (error) {
      const name = (error as { name?: string } | null)?.name
      if (name === `TimeoutError` || name === `AbortError`)
        throw new Error(`Marketplace request timed out`)
      throw error instanceof Error ? error : new Error(String(error))
    }

    const rawText = await res.text()
    if (rawText.length > MAX_RESPONSE_CHARS)
      throw new Error(`Marketplace response exceeds maximum size`)

    if (!res.ok) {
      const fallback = res.statusText.trim() || `HTTP ${res.status}`
      throw new Error(extractUpstreamErrorMessage(rawText, fallback))
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    }
    catch {
      throw new Error(`Invalid marketplace JSON response`)
    }
    if (!parsed || typeof parsed !== `object` || Array.isArray(parsed))
      throw new Error(`Invalid marketplace response payload`)
    return parsed as T
  }

  return {
    async listThemes(params?: DesktopMarketplaceListParams): Promise<MarketplaceListResponse> {
      const query = buildThemesQuery(params)
      const data = await requestJson<MarketplaceListResponse>(`GET`, `/marketplace/themes${query}`)
      if (!Array.isArray(data.items))
        throw new TypeError(`Invalid marketplace response payload`)
      return data
    },

    async getItem(id: string): Promise<MarketplaceItemDetail> {
      const safeId = assertValidItemId(id)
      const detail = await requestJson<MarketplaceItemDetail>(`GET`, `/marketplace/${encodeURIComponent(safeId)}`)
      if (typeof detail.id !== `string` || typeof detail.payload !== `string`)
        throw new TypeError(`Invalid marketplace response payload`)
      return detail
    },

    async installItem(id: string): Promise<MarketplaceItemDetail> {
      const safeId = assertValidItemId(id)
      const detail = await requestJson<MarketplaceItemDetail>(`POST`, `/marketplace/${encodeURIComponent(safeId)}/install`)
      if (typeof detail.id !== `string` || typeof detail.payload !== `string`)
        throw new TypeError(`Invalid marketplace response payload`)
      return detail
    },
  }
}
