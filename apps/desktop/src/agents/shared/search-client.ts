export const MAX_SEARCH_QUERY_CHARS = 1_000

export interface BridgeWebSearchResult {
  answer: string
  sources: Array<{ title: string, url: string }>
  queries: string[]
}

const DEFAULT_BRIDGE_TIMEOUT_MS = 100_000
const MAX_BRIDGE_RESPONSE_BYTES = 1024 * 1024

export async function searchViaBridge(params: {
  bridgeUrl: string
  bridgeToken: string
  query: string
  abortSignal?: AbortSignal
}): Promise<BridgeWebSearchResult> {
  const query = params.query.trim()
  if (!query)
    throw new Error(`query is required`)
  if (query.length > MAX_SEARCH_QUERY_CHARS)
    throw new Error(`query exceeds maximum length of ${MAX_SEARCH_QUERY_CHARS} characters`)

  const timeoutSignal = AbortSignal.timeout(DEFAULT_BRIDGE_TIMEOUT_MS)
  const signal = params.abortSignal
    ? AbortSignal.any([timeoutSignal, params.abortSignal])
    : timeoutSignal

  const response = await fetch(params.bridgeUrl, {
    method: `POST`,
    headers: {
      'Content-Type': `application/json`,
      'Authorization': `Bearer ${params.bridgeToken}`,
    },
    body: JSON.stringify({ query }),
    signal,
  })

  const declaredLength = Number(response.headers.get(`content-length`))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BRIDGE_RESPONSE_BYTES)
    throw new Error(`Search result exceeds maximum size of 1 MB`)

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }
  catch {
    payload = {}
  }

  if (!response.ok) {
    const errMsg = typeof payload.error === `string` ? payload.error : text.slice(0, 200)
    throw new Error(errMsg || `Search bridge returned HTTP ${response.status}`)
  }

  const sources = Array.isArray(payload.sources)
    ? payload.sources.filter((s): s is { title: string, url: string } =>
        typeof s === `object` && s !== null && typeof s.url === `string` && typeof s.title === `string`)
    : []
  return {
    answer: typeof payload.answer === `string` ? payload.answer : ``,
    sources,
    queries: Array.isArray(payload.queries) ? payload.queries.filter((q): q is string => typeof q === `string`) : [],
  }
}

/** Answer first, then a numbered source list the agent can cite in the article's reference card. */
export function formatWebSearchResult(result: BridgeWebSearchResult): string {
  const answer = result.answer.trim() || `(The provider returned no answer text.)`
  if (result.sources.length === 0)
    return `${answer}\n\nSources: none returned by the provider.`
  const lines = result.sources.map((source, i) => `${i + 1}. ${source.title ? `${source.title} - ` : ``}${source.url}`)
  return `${answer}\n\nSources:\n${lines.join(`\n`)}`
}
