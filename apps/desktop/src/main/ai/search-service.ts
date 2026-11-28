import type { DesktopWebSearchToolType } from '@md/shared/types'
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
  toolType: DesktopWebSearchToolType
  query: string
  abortSignal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_SEARCH_TIMEOUT_MS = 90_000
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

export function buildWebSearchRequestBody(params: {
  model: string
  toolType: DesktopWebSearchToolType
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
    const title = trimmedString(candidate.title)
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

  const post = async (includeSources: boolean) => {
    const response = await fetchImpl(`${baseUrl}/responses`, {
      method: `POST`,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `application/json`,
        'Accept': `application/json`,
      },
      body: JSON.stringify(buildWebSearchRequestBody({ model, toolType: params.toolType, query, includeSources })),
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
    let res = await post(true)
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      const { message, param } = readErrorDetail(res.json, res.text)
      // Providers that do not know `include` reject the whole request; retry once without it.
      if (param === `include` || /\binclude\b/i.test(message))
        res = await post(false)
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
      throw new Error(message || `Provider returned no answer or sources (does it support the Responses API ${params.toolType} tool?)`)
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
