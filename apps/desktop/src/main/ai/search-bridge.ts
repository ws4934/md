import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ResolvedWebSearchConfig } from './config-store'
import type { ImageBridgeConnectionInfo } from './image-bridge'
import type { WebSearchResult } from './search-service'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { MAX_SEARCH_QUERY_CHARS } from '../../agents/shared/search-client'
import { readJsonBody, sendJson, tokensEqual } from './image-bridge'
import { redactSecret } from './sanitize'
import { searchWithFailover } from './search-service'

export interface WebSearchBridgeOptions {
  getConfig: () => Promise<ResolvedWebSearchConfig>
  search?: (params: {
    config: ResolvedWebSearchConfig
    query: string
    abortSignal?: AbortSignal
  }) => Promise<WebSearchResult>
}

const MAX_BODY_BYTES = 16 * 1024
const MAX_CONCURRENT_REQUESTS = 4

/**
 * Localhost-only HTTP bridge so the search MCP server can run web searches
 * without ever receiving the search provider's API key.
 */
export class WebSearchBridge {
  private readonly getConfig: () => Promise<ResolvedWebSearchConfig>
  private readonly searchImpl: NonNullable<WebSearchBridgeOptions[`search`]>
  private readonly token: string
  private server: Server | null = null
  private startPromise: Promise<ImageBridgeConnectionInfo> | null = null
  private connectionInfo: ImageBridgeConnectionInfo | null = null
  private activeRequests = 0
  /** Provider id -> time until which a failed provider is skipped; lives for the app run. */
  private readonly cooldowns = new Map<string, number>()

  constructor(options: WebSearchBridgeOptions) {
    this.getConfig = options.getConfig
    this.searchImpl = options.search ?? (({ config, query, abortSignal }) =>
      searchWithFailover({
        providers: config.providers.filter(p => p.isUsable),
        query,
        abortSignal,
        cooldowns: this.cooldowns,
      }))
    this.token = randomBytes(32).toString(`hex`)
  }

  /** Called after the provider list is saved, so a fixed provider is not skipped for the rest of its cooldown. */
  resetCooldowns(): void {
    this.cooldowns.clear()
  }

  async ensureStarted(): Promise<ImageBridgeConnectionInfo> {
    if (this.connectionInfo)
      return this.connectionInfo
    this.startPromise ??= new Promise<ImageBridgeConnectionInfo>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      this.server = server
      server.once(`error`, (error) => {
        if (this.server === server)
          this.server = null
        this.startPromise = null
        reject(error)
      })
      server.listen(0, `127.0.0.1`, () => {
        if (this.server !== server) {
          server.close()
          reject(new Error(`Search bridge closed before startup completed`))
          return
        }
        const address = server.address()
        if (!address || typeof address === `string`) {
          server.close()
          this.server = null
          this.startPromise = null
          reject(new Error(`Failed to resolve local search bridge port`))
          return
        }
        this.connectionInfo = {
          url: `http://127.0.0.1:${address.port}/search`,
          token: this.token,
        }
        resolve(this.connectionInfo)
      })
    })
    return this.startPromise
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== `POST` || req.url !== `/search`) {
      sendJson(res, 404, { error: `Not found` }, req)
      return
    }

    const authHeader = req.headers.authorization ?? ``
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader)
    if (!match || !tokensEqual(this.token, match[1])) {
      sendJson(res, 401, { error: `Unauthorized` }, req)
      return
    }

    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      sendJson(res, 429, { error: `Too many concurrent web search requests` }, req)
      return
    }

    this.activeRequests += 1
    let config: ResolvedWebSearchConfig | null = null
    const abortController = new AbortController()
    const onClose = () => {
      if (!res.writableEnded)
        abortController.abort()
    }
    res.once(`close`, onClose)

    try {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req, MAX_BODY_BYTES)
      }
      catch (error) {
        if (!res.writableEnded)
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }, req)
        return
      }

      const query = typeof body.query === `string` ? body.query.trim() : ``
      if (!query) {
        sendJson(res, 400, { error: `query is required` })
        return
      }
      if (query.length > MAX_SEARCH_QUERY_CHARS) {
        sendJson(res, 400, { error: `query exceeds maximum length of ${MAX_SEARCH_QUERY_CHARS} characters` })
        return
      }

      config = await this.getConfig()
      if (!config.isConfigured) {
        sendJson(res, 503, { error: `Web search is not configured` })
        return
      }

      const result = await this.searchImpl({ config, query, abortSignal: abortController.signal })
      if (!res.writableEnded)
        sendJson(res, 200, { ...result })
    }
    catch (error) {
      if (!res.writableEnded) {
        const rawMessage = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { error: redactSecret(rawMessage, ...(config?.providers.map(p => p.apiKey) ?? [])) })
      }
    }
    finally {
      this.activeRequests -= 1
      res.off(`close`, onClose)
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.connectionInfo = null
    this.startPromise = null
    if (!server)
      return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      if (typeof server.closeAllConnections === `function`)
        server.closeAllConnections()
    })
  }
}
