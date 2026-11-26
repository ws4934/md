import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ResolvedImageGenConfig } from './config-store'
import type { GeneratedDesktopImage } from './image-service'
import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { generateDesktopImage } from './image-service'
import { redactSecret } from './sanitize'

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
    referenceImages?: Uint8Array[]
    abortSignal?: AbortSignal
  }) => Promise<GeneratedDesktopImage>
}

const MAX_REFERENCE_IMAGES = 4
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_REFERENCE_BASE64_CHARS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES / 3) * 4
// Sized for up to 4 max-size base64 reference images plus prompt and JSON framing.
const MAX_BODY_BYTES = MAX_REFERENCE_IMAGES * MAX_REFERENCE_BASE64_CHARS + 256 * 1024
const BODY_READ_TIMEOUT_MS = 15_000
const MAX_PROMPT_CHARS = 8_000
const MAX_PARAM_CHARS = 64
const MAX_CONCURRENT_REQUESTS = 4
const ALLOWED_REFERENCE_MEDIA_TYPES = new Set([`image/png`, `image/jpeg`, `image/webp`])
const BASE64_RE = /^[A-Z0-9+/]+={0,2}$/i

function parseReferenceImages(raw: unknown): Uint8Array[] | undefined {
  if (raw === undefined)
    return undefined
  if (!Array.isArray(raw))
    throw new TypeError(`referenceImages must be an array`)
  if (raw.length === 0)
    return undefined
  if (raw.length > MAX_REFERENCE_IMAGES)
    throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are allowed`)

  const decoded: Uint8Array[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== `object` || item === null || Array.isArray(item))
      throw new Error(`referenceImages[${i}] must be an object`)

    const { base64, mediaType } = item as Record<string, unknown>
    if (typeof mediaType !== `string` || !ALLOWED_REFERENCE_MEDIA_TYPES.has(mediaType))
      throw new Error(`referenceImages[${i}].mediaType must be one of image/png, image/jpeg, image/webp`)

    if (typeof base64 !== `string` || base64.length === 0)
      throw new Error(`referenceImages[${i}].base64 must be a non-empty base64 string`)
    if (base64.length > MAX_REFERENCE_BASE64_CHARS)
      throw new Error(`referenceImages[${i}] exceeds maximum size of 8 MB`)
    if (base64.length % 4 !== 0 || !BASE64_RE.test(base64))
      throw new Error(`referenceImages[${i}].base64 is not valid base64`)

    const buf = Buffer.from(base64, `base64`)
    if (buf.byteLength === 0)
      throw new Error(`referenceImages[${i}] is empty`)
    if (buf.byteLength > MAX_REFERENCE_IMAGE_BYTES)
      throw new Error(`referenceImages[${i}] exceeds maximum size of 8 MB`)

    decoded.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  }
  return decoded
}

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
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(`Request body timed out`))
        req.destroy()
      }
    }, BODY_READ_TIMEOUT_MS)
    const cleanup = () => clearTimeout(timer)

    req.on(`data`, (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true
          cleanup()
          reject(new Error(`Request body too large`))
          req.destroy()
        }
        return
      }
      chunks.push(chunk)
    })
    req.on(`end`, () => {
      if (settled)
        return
      settled = true
      cleanup()
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
    req.on(`error`, (error) => {
      if (settled)
        return
      settled = true
      cleanup()
      reject(error)
    })
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
  private activeRequests = 0

  constructor(options: ImageGenBridgeOptions) {
    this.getConfig = options.getConfig
    this.generateImpl = options.generate ?? (({ config, prompt, size, quality, referenceImages, abortSignal }) =>
      generateDesktopImage({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        prompt,
        size: size ?? config.size,
        quality: quality ?? config.quality,
        referenceImages,
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
    if (prompt.length > MAX_PROMPT_CHARS) {
      sendJson(res, 400, { error: `prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters` })
      return
    }

    const rawSize = typeof body.size === `string` ? body.size.trim() : ``
    const rawQuality = typeof body.quality === `string` ? body.quality.trim() : ``
    if (rawSize.length > MAX_PARAM_CHARS || rawQuality.length > MAX_PARAM_CHARS) {
      sendJson(res, 400, { error: `size or quality parameter is too long` })
      return
    }

    let referenceImages: Uint8Array[] | undefined
    try {
      referenceImages = parseReferenceImages(body.referenceImages)
    }
    catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      sendJson(res, 429, { error: `Too many concurrent image generation requests` })
      return
    }

    this.activeRequests += 1
    let config: ResolvedImageGenConfig | null = null
    const abortController = new AbortController()
    const onClose = () => {
      if (!res.writableEnded)
        abortController.abort()
    }
    res.once(`close`, onClose)

    try {
      config = await this.getConfig()
      if (!config.isConfigured) {
        sendJson(res, 503, { error: `Image generation is not configured` })
        return
      }

      const size = rawSize || config.size
      const quality = rawQuality || config.quality

      const result = await this.generateImpl({
        config,
        prompt,
        size,
        quality,
        ...(referenceImages ? { referenceImages } : {}),
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
        const rawMessage = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, {
          error: redactSecret(rawMessage, config?.apiKey),
        })
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
