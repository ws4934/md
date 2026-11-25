import type {
  DesktopAiProtocol,
  DesktopListRemoteModelsResult,
  DesktopRemoteModelInfo,
} from '@md/shared/types'
import { DEFAULT_PROTOCOL_BASE_URLS } from '@md/shared/types'

const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const MAX_PAGINATION_PAGES = 5
const ANTHROPIC_API_VERSION = `2023-06-01`

function dedupeModels(models: DesktopRemoteModelInfo[]): DesktopRemoteModelInfo[] {
  const seen = new Set<string>()
  const result: DesktopRemoteModelInfo[] = []
  for (const item of models) {
    const id = item.id.trim()
    if (!id || seen.has(id))
      continue
    seen.add(id)
    const name = item.name?.trim()
    result.push(name && name !== id ? { id, name } : { id })
  }
  return result
}

function redactSecretInError(message: string, secret?: string): string {
  let cleaned = message.replace(/([?&]key=)[^&\s]+/gi, `$1***`)
  if (secret && secret.length >= 6)
    cleaned = cleaned.split(secret).join(`***`)
  return cleaned
}

export function parseOpenAiModelsResponse(payload: unknown): DesktopRemoteModelInfo[] {
  const rawList = Array.isArray(payload)
    ? payload
    : (typeof payload === `object` && payload !== null && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : [])

  const models: DesktopRemoteModelInfo[] = []
  for (const entry of rawList) {
    if (typeof entry === `string` && entry.trim()) {
      models.push({ id: entry.trim() })
      continue
    }
    if (typeof entry !== `object` || entry === null)
      continue
    const rec = entry as Record<string, unknown>
    const id = typeof rec.id === `string` ? rec.id.trim() : ``
    if (!id)
      continue
    const name = typeof rec.name === `string` && rec.name.trim() ? rec.name.trim() : undefined
    models.push(name && name !== id ? { id, name } : { id })
  }
  return dedupeModels(models)
}

export function parseAnthropicModelsResponse(payload: unknown): {
  models: DesktopRemoteModelInfo[]
  hasMore: boolean
  lastId?: string
} {
  if (typeof payload !== `object` || payload === null)
    return { models: [], hasMore: false }
  const rec = payload as Record<string, unknown>
  const rawList = Array.isArray(rec.data) ? rec.data : []

  const models: DesktopRemoteModelInfo[] = []
  for (const entry of rawList) {
    if (typeof entry !== `object` || entry === null)
      continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === `string` ? item.id.trim() : ``
    if (!id)
      continue
    const displayName = typeof item.display_name === `string` && item.display_name.trim()
      ? item.display_name.trim()
      : undefined
    models.push(displayName && displayName !== id ? { id, name: displayName } : { id })
  }

  return {
    models: dedupeModels(models),
    hasMore: rec.has_more === true,
    lastId: typeof rec.last_id === `string` && rec.last_id.trim() ? rec.last_id.trim() : undefined,
  }
}

export function parseGoogleModelsResponse(payload: unknown): {
  models: DesktopRemoteModelInfo[]
  nextPageToken?: string
} {
  if (typeof payload !== `object` || payload === null)
    return { models: [] }
  const rec = payload as Record<string, unknown>
  const rawList = Array.isArray(rec.models) ? rec.models : []

  const models: DesktopRemoteModelInfo[] = []
  for (const entry of rawList) {
    if (typeof entry !== `object` || entry === null)
      continue
    const item = entry as Record<string, unknown>
    const rawName = typeof item.name === `string` ? item.name.trim() : ``
    if (!rawName)
      continue

    // Keep only models capable of generateContent when the provider advertises supported methods.
    if (Array.isArray(item.supportedGenerationMethods)) {
      const supportsGenerate = item.supportedGenerationMethods.some(
        method => typeof method === `string` && method === `generateContent`,
      )
      if (!supportsGenerate)
        continue
    }

    const id = rawName.replace(/^models\//, ``).trim()
    if (!id)
      continue
    const displayName = typeof item.displayName === `string` && item.displayName.trim()
      ? item.displayName.trim()
      : undefined
    models.push(displayName && displayName !== id ? { id, name: displayName } : { id })
  }

  return {
    models: dedupeModels(models),
    nextPageToken: typeof rec.nextPageToken === `string` && rec.nextPageToken.trim()
      ? rec.nextPageToken.trim()
      : undefined,
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    }
    catch {
      json = null
    }
    if (!response.ok) {
      const apiErr = typeof json === `object` && json !== null && `error` in json
        ? (json as { error?: { message?: string } | string }).error
        : undefined
      const detail = typeof apiErr === `string`
        ? apiErr
        : (typeof apiErr === `object` && apiErr !== null && typeof apiErr.message === `string`
            ? apiErr.message
            : text.slice(0, 200))
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ``}`)
    }
    if (json === null)
      throw new Error(`Provider returned non-JSON response`)
    return json
  }
  finally {
    clearTimeout(timer)
  }
}

export async function fetchRemoteModels(options: {
  protocol: DesktopAiProtocol
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<DesktopListRemoteModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const baseUrl = (options.baseUrl.trim() || DEFAULT_PROTOCOL_BASE_URLS[options.protocol]).replace(/\/+$/, ``)
  const apiKey = options.apiKey.trim()

  if (!apiKey) {
    return {
      ok: false,
      models: [],
      error: `API key is required to fetch models`,
    }
  }

  try {
    if (options.protocol === `openai-compatible`) {
      const payload = await fetchJsonWithTimeout(
        `${baseUrl}/models`,
        {
          method: `GET`,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: `application/json`,
          },
        },
        fetchImpl,
        timeoutMs,
      )
      return {
        ok: true,
        models: parseOpenAiModelsResponse(payload),
      }
    }

    if (options.protocol === `anthropic`) {
      const collected: DesktopRemoteModelInfo[] = []
      let afterId: string | undefined
      for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
        const query = new URLSearchParams({ limit: `100` })
        if (afterId)
          query.set(`after_id`, afterId)
        const payload = await fetchJsonWithTimeout(
          `${baseUrl}/models?${query.toString()}`,
          {
            method: `GET`,
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': ANTHROPIC_API_VERSION,
              'Accept': `application/json`,
            },
          },
          fetchImpl,
          timeoutMs,
        )
        const parsed = parseAnthropicModelsResponse(payload)
        collected.push(...parsed.models)
        if (!parsed.hasMore || !parsed.lastId)
          break
        afterId = parsed.lastId
      }
      return {
        ok: true,
        models: dedupeModels(collected),
      }
    }

    // Native Google Gemini API: GET {base}/models?key=...
    const collected: DesktopRemoteModelInfo[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      const query = new URLSearchParams({
        key: apiKey,
        pageSize: `100`,
      })
      if (pageToken)
        query.set(`pageToken`, pageToken)
      const payload = await fetchJsonWithTimeout(
        `${baseUrl}/models?${query.toString()}`,
        {
          method: `GET`,
          headers: {
            Accept: `application/json`,
          },
        },
        fetchImpl,
        timeoutMs,
      )
      const parsed = parseGoogleModelsResponse(payload)
      collected.push(...parsed.models)
      if (!parsed.nextPageToken)
        break
      pageToken = parsed.nextPageToken
    }
    return {
      ok: true,
      models: dedupeModels(collected),
    }
  }
  catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      models: [],
      error: redactSecretInError(rawMessage, apiKey),
    }
  }
}
