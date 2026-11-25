import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ResolvedImageGenConfig } from './config-store'
import type { GeneratedDesktopImage } from './image-service'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { generateDesktopImage } from './image-service'

export interface ImageBridgeConnectionInfo {
  url: string
  token: string
}

export interface ImageGenBridgeOptions {
  getConfig: () => Promise<ResolvedImageGenConfig>
  generate?: (params: {
    config: ResolvedImageGenConfig
    prompt: string
    size?: string
    quality?: string
    abortSignal?: AbortSignal
  }) => Promise<GeneratedDesktopImage>
}

const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': `application/json; charset=utf-8`,
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, `utf8`)
  const actualBuf = Buffer.from(actual, `utf8`)
  if (expectedBuf.length !== actualBuf.length)
    return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on(`data`, (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body too large`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on(`end`, () => {
      try {
        const raw = Buffer.concat(chunks).toString(`utf8`)
        const parsed = raw ? JSON.parse(raw) : {}
        if (typeof parsed !== `object` || parsed === null || Array.isArray(parsed)) {
          reject(new Error(`Expected JSON object`))
          return
        }
        resolve(parsed as Record<string, unknown>)
      }
      catch {
        reject(new Error(`Invalid JSON body`))
      }
    })
    req.on(`error`, reject)
  })
}

/**
 * Localhost-only HTTP bridge so child processes (API agent and image MCP server)
 * can request generated images without ever receiving the image API key.
 */
export class ImageGenBridge {
  private readonly getConfig: () => Promise<ResolvedImageGenConfig>
  private readonly generateImpl: NonNullable<ImageGenBridgeOptions[`generate`]>
  private readonly token: string
  private server: Server | null = null
  private startPromise: Promise<ImageBridgeConnectionInfo> | null = null
  private connectionInfo: ImageBridgeConnectionInfo | null = null

  constructor(options: ImageGenBridgeOptions) {
    this.getConfig = options.getConfig
    this.generateImpl = options.generate ?? (({ config, prompt, size, quality, abortSignal }) =>
      generateDesktopImage({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        prompt,
        size: size ?? config.size,
        quality: quality ?? config.quality,
        abortSignal,
      }))
    this.token = randomBytes(32).toString(`hex`)
  }

  getConnectionInfo(): ImageBridgeConnectionInfo | null {
    return this.connectionInfo
  }

  async ensureStarted(): Promise<ImageBridgeConnectionInfo> {
    if (this.connectionInfo)
      return this.connectionInfo
    this.startPromise ??= new Promise<ImageBridgeConnectionInfo>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res)
      })
      server.once(`error`, (error) => {
        this.startPromise = null
        reject(error)
      })
      server.listen(0, `127.0.0.1`, () => {
        const address = server.address()
        if (!address || typeof address === `string`) {
          server.close()
          this.startPromise = null
          reject(new Error(`Failed to resolve local image bridge port`))
          return
        }
        this.server = server
        this.connectionInfo = {
          url: `http://127.0.0.1:${address.port}/generate`,
          token: this.token,
        }
        resolve(this.connectionInfo)
      })
    })
    return this.startPromise
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== `POST` || req.url !== `/generate`) {
      sendJson(res, 404, { error: `Not found` })
      return
    }

    const authHeader = req.headers.authorization ?? ``
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader)
    if (!match || !tokensEqual(this.token, match[1])) {
      sendJson(res, 401, { error: `Unauthorized` })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    }
    catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const prompt = typeof body.prompt === `string` ? body.prompt.trim() : ``
    if (!prompt) {
      sendJson(res, 400, { error: `prompt is required` })
      return
    }

    const config = await this.getConfig()
    if (!config.isConfigured) {
      sendJson(res, 503, { error: `Image generation is not configured` })
      return
    }

    const size = typeof body.size === `string` && body.size.trim() ? body.size.trim() : config.size
    const quality = typeof body.quality === `string` && body.quality.trim() ? body.quality.trim() : config.quality

    const abortController = new AbortController()
    const onClose = () => {
      if (!res.writableEnded)
        abortController.abort()
    }
    res.once(`close`, onClose)

    try {
      const result = await this.generateImpl({
        config,
        prompt,
        size,
        quality,
        abortSignal: abortController.signal,
      })
      if (!res.writableEnded) {
        sendJson(res, 200, {
          base64: result.base64,
          mimeType: result.mimeType,
        })
      }
    }
    catch (error) {
      if (!res.writableEnded) {
        sendJson(res, 502, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    finally {
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
