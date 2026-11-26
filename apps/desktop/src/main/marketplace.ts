import type {
  DesktopMarketplaceListParams,
  MarketplaceItemDetail,
  MarketplaceListResponse,
} from '@md/shared/types'

export const DEFAULT_MARKETPLACE_API_URL = `https://md-api.doocs.org`
const REQUEST_TIMEOUT_MS = 15_000
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
    if (parsed.protocol === `https:` || parsed.protocol === `http:`)
      return candidate.replace(/\/+$/, ``)
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
  if (!params)
    return ``
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

/**
 * Main-process proxy for public md-api marketplace endpoints.
 * Electron's `app://md` renderer origin is not on md-api's CORS allowlist, so
 * routing read/install requests through main lets desktop browse and install
 * community themes without weakening browser CORS policy.
 */
export function createDesktopMarketplaceClient(options: DesktopMarketplaceClientOptions = {}) {
  const baseUrl = resolveBaseUrl(options.apiUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  async function requestJson<T>(method: `GET` | `POST`, endpointPath: string): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${endpointPath}`, {
      method,
      headers: {
        Accept: `application/json`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      let message = res.statusText || `HTTP ${res.status}`
      try {
        const body = await res.json() as { error?: unknown }
        if (typeof body?.error === `string` && body.error)
          message = body.error
      }
      catch {
        // Ignore non-JSON error responses.
      }
      throw new Error(message)
    }

    return res.json() as Promise<T>
  }

  return {
    async listThemes(params?: DesktopMarketplaceListParams): Promise<MarketplaceListResponse> {
      return requestJson<MarketplaceListResponse>(`GET`, `/marketplace/themes${buildThemesQuery(params)}`)
    },

    async getItem(id: string): Promise<MarketplaceItemDetail> {
      const safeId = assertValidItemId(id)
      return requestJson<MarketplaceItemDetail>(`GET`, `/marketplace/${encodeURIComponent(safeId)}`)
    },

    async installItem(id: string): Promise<MarketplaceItemDetail> {
      const safeId = assertValidItemId(id)
      return requestJson<MarketplaceItemDetail>(`POST`, `/marketplace/${encodeURIComponent(safeId)}/install`)
    },
  }
}
