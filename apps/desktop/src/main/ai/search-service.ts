import { readBoundedResponseText } from './remote-models'
import { redactSecret, validateHttpBaseUrl } from './sanitize'

export interface WebSearchSource {
  title: string
  url: string
}

export interface WebSearchResult {
  answer: string
  sources: WebSearchSource[]
  queries: string[]
}

export interface SearchWebParams {
  baseUrl: string
  apiKey: string
  model: string
  query: string
  abortSignal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Per provider, so a dead provider does not stall the failover chain for long. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 45_000
/** How long a failed provider is skipped by later searches while another provider is available. */
export const PROVIDER_COOLDOWN_MS = 5 * 60_000
const MAX_SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ANSWER_CHARS = 20_000
const MAX_SOURCES = 20
const SOURCES_INCLUDE = `web_search_call.action.sources`
const SEARCH_INSTRUCTION = `Search the web for the query below and answer concisely in the language of the query. Base the answer on what the search finds and cite the sources you used.`

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === `object` && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function trimmedString(value: unknown): string {
  return typeof value === `string` ? value.trim() : ``
}

/** Only http(s) URLs reach the agent; tracking params are dropped so citation and action URLs dedupe. */
function normalizeSourceUrl(raw: unknown): string | null {
  const trimmed = trimmedString(raw)
  if (!trimmed)
    return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== `http:` && parsed.protocol !== `https:`)
      return null
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith(`utm_`))
        parsed.searchParams.delete(key)
    }
    return parsed.href
  }
  catch {
    return null
  }
}

/** Responses API hosted tool; `web_search_preview` is the older name some providers still require. */
export type WebSearchToolType = `web_search` | `web_search_preview`

export function buildWebSearchRequestBody(params: {
  model: string
  toolType: WebSearchToolType
  query: string
  includeSources: boolean
}): Record<string, unknown> {
  return {
    model: params.model,
    input: `${SEARCH_INSTRUCTION}\n\nQuery: ${params.query}`,
    tools: [{ type: params.toolType }],
    ...(params.includeSources ? { include: [SOURCES_INCLUDE] } : {}),
  }
}

export function parseWebSearchResponse(payload: unknown): WebSearchResult {
  const root = asRecord(payload)
  const answers: string[] = []
  const citations: Array<{ url: unknown, title: unknown }> = []
  const actionSources: Array<{ url: unknown, title: unknown }> = []
  const queries: string[] = []

  for (const rawItem of asArray(root?.output)) {
    const item = asRecord(rawItem)
    if (!item)
      continue
    if (item.type === `web_search_call`) {
      const action = asRecord(item.action)
      const actionQueries = [action?.query, ...asArray(action?.queries)]
      for (const q of actionQueries) {
        const query = trimmedString(q)
        if (query && !queries.includes(query))
          queries.push(query)
      }
      for (const rawSource of asArray(action?.sources)) {
        const source = asRecord(rawSource)
        if (source)
          actionSources.push({ url: source.url, title: source.title })
      }
      continue
    }
    if (item.type !== `message`)
      continue
    for (const rawPart of asArray(item.content)) {
      const part = asRecord(rawPart)
      if (!part || (part.type !== undefined && part.type !== `output_text`))
        continue
      const text = trimmedString(part.text)
      if (text)
        answers.push(text)
      for (const rawAnnotation of asArray(part.annotations)) {
        const annotation = asRecord(rawAnnotation)
        if (annotation?.type === `url_citation`)
          citations.push({ url: annotation.url, title: annotation.title })
      }
    }
  }

  // Some providers only fill the SDK-style convenience field.
  if (answers.length === 0 && trimmedString(root?.output_text))
    answers.push(trimmedString(root?.output_text))

  const sources: WebSearchSource[] = []
  const byUrl = new Map<string, WebSearchSource>()
  for (const candidate of [...citations, ...actionSources]) {
    const url = normalizeSourceUrl(candidate.url)
    if (!url)
      continue
    const rawTitle = trimmedString(candidate.title)
    // Some providers label citations only by their footnote number ("1", "[2]"); that is not a title.
    const title = /^\[?\d+\]?$/.test(rawTitle) ? `` : rawTitle
    const existing = byUrl.get(url)
    if (existing) {
      if (!existing.title && title)
        existing.title = title
      continue
    }
    if (sources.length >= MAX_SOURCES)
      continue
    const source = { title, url }
    byUrl.set(url, source)
    sources.push(source)
  }

  return {
    answer: answers.join(`\n\n`).slice(0, MAX_ANSWER_CHARS),
    sources,
    queries,
  }
}

function readErrorDetail(json: unknown, text: string): { message: string, param: string } {
  const apiErr = asRecord(json)?.error
  if (typeof apiErr === `string`)
    return { message: apiErr, param: `` }
  const errRec = asRecord(apiErr)
  return {
    message: trimmedString(errRec?.message) || text.slice(0, 200),
    param: trimmedString(errRec?.param),
  }
}

export async function searchWeb(params: SearchWebParams): Promise<WebSearchResult> {
  const rawBaseUrl = params.baseUrl.trim()
  const apiKey = params.apiKey.trim()
  const model = params.model.trim()
  const query = params.query.trim()

  if (!rawBaseUrl || !apiKey || !model)
    throw new Error(`Web search is not fully configured (baseUrl, apiKey, and model are required)`)
  if (!query)
    throw new Error(`Search query is required`)

  const baseUrl = validateHttpBaseUrl(rawBaseUrl)
  const fetchImpl = params.fetchImpl ?? fetch
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
  const signal = params.abortSignal
    ? AbortSignal.any([timeoutSignal, params.abortSignal])
    : timeoutSignal

  const post = async (toolType: WebSearchToolType, includeSources: boolean) => {
    const response = await fetchImpl(`${baseUrl}/responses`, {
      method: `POST`,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `application/json`,
        'Accept': `application/json`,
      },
      body: JSON.stringify(buildWebSearchRequestBody({ model, toolType, query, includeSources })),
      signal,
    })
    const text = await readBoundedResponseText(response, MAX_SEARCH_RESPONSE_BYTES)
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : {}
    }
    catch {}
    return { status: response.status, ok: response.ok, text, json }
  }

  try {
    let toolType: WebSearchToolType = `web_search`
    let includeSources = true
    let res = await post(toolType, includeSources)
    // Providers that do not know `include` or the newer tool name reject the whole request;
    // drop each in turn, at most once.
    for (let retries = 0; retries < 2 && !res.ok && (res.status === 400 || res.status === 422); retries++) {
      const { message, param } = readErrorDetail(res.json, res.text)
      if (includeSources && (param === `include` || /\binclude\b/i.test(message)))
        includeSources = false
      else if (toolType === `web_search` && (param.startsWith(`tools`) || /\btools?\b|web_search/i.test(message)))
        toolType = `web_search_preview`
      else
        break
      res = await post(toolType, includeSources)
    }
    if (!res.ok) {
      const { message } = readErrorDetail(res.json, res.text)
      throw new Error(`HTTP ${res.status}${message ? `: ${message}` : ``}`)
    }
    if (res.json === null)
      throw new Error(`Provider returned non-JSON response`)

    const result = parseWebSearchResponse(res.json)
    if (!result.answer && result.sources.length === 0) {
      const { message } = readErrorDetail(res.json, ``)
      throw new Error(message || `Provider returned no answer or sources (does it support the Responses API web_search tool?)`)
    }
    return result
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(redactSecret(message, apiKey))
    if (error instanceof Error && error.name)
      wrapped.name = error.name
    throw wrapped
  }
}

export interface WebSearchProviderTarget {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

function providerLabel(provider: WebSearchProviderTarget): string {
  if (provider.name.trim())
    return provider.name.trim()
  try {
    return new URL(provider.baseUrl).host
  }
  catch {
    return provider.baseUrl || provider.id
  }
}

/**
 * Tries `providers` in order until one returns a result. A failed provider is put on
 * `cooldowns` (provider id -> retry-after timestamp) and skipped by later calls, unless
 * every provider is cooling down, in which case all are tried in order again.
 * A caller abort stops the chain immediately.
 */
export async function searchWithFailover(params: {
  providers: WebSearchProviderTarget[]
  query: string
  cooldowns: Map<string, number>
  abortSignal?: AbortSignal
  timeoutMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
}): Promise<WebSearchResult> {
  const now = params.now ?? Date.now
  const startedAt = now()
  const ready = params.providers.filter(p => !((params.cooldowns.get(p.id) ?? 0) > startedAt))
  const order = ready.length > 0 ? ready : params.providers
  if (order.length === 0)
    throw new Error(`No usable web search provider is configured`)

  const failures: string[] = []
  for (const provider of order) {
    try {
      const result = await searchWeb({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        query: params.query,
        abortSignal: params.abortSignal,
        timeoutMs: params.timeoutMs,
        fetchImpl: params.fetchImpl,
      })
      params.cooldowns.delete(provider.id)
      return result
    }
    catch (error) {
      if (params.abortSignal?.aborted)
        throw error
      params.cooldowns.set(provider.id, now() + PROVIDER_COOLDOWN_MS)
      failures.push(`${providerLabel(provider)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const message = `Web search failed on every provider tried: ${failures.join(`; `)}`
  throw new Error(redactSecret(message, ...params.providers.map(p => p.apiKey)))
}
