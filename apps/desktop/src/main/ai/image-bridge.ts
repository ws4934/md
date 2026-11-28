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
const DRAIN_SLACK_BYTES = 16 * 1024 * 1024
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

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  reqToClose?: IncomingMessage,
): void {
  const payload = JSON.stringify(body)
  const shouldClose = Boolean(reqToClose && !reqToClose.complete)
  res.writeHead(statusCode, {
    'Content-Type': `application/json; charset=utf-8`,
    'Content-Length': Buffer.byteLength(payload),
    ...(shouldClose ? { Connection: `close` } : {}),
  })
  res.end(payload)
  if (shouldClose && reqToClose) {
    // Allow loopback clients to read the HTTP error response before tearing down an unread upload stream.
    const destroyTimer = setTimeout(() => {
      if (!reqToClose.destroyed)
        reqToClose.destroy()
    }, 200)
    destroyTimer.unref()
    res.once(`close`, () => clearTimeout(destroyTimer))
  }
}

export function tokensEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, `utf8`)
  const actualBuf = Buffer.from(actual, `utf8`)
  if (expectedBuf.length !== actualBuf.length)
    return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

export function readJsonBody(req: IncomingMessage, maxBodyBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const maxDrainBytes = maxBodyBytes + DRAIN_SLACK_BYTES
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers[`content-length`])
    let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBodyBytes
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const stopReading = () => {
      req.off(`data`, onData)
      req.off(`end`, onEnd)
      req.off(`error`, onError)
      chunks.length = 0
      req.pause()
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        stopReading()
        reject(new Error(`Request body timed out`))
      }
    }, BODY_READ_TIMEOUT_MS)
    const cleanup = () => clearTimeout(timer)

    function onData(chunk: Buffer) {
      total += chunk.length
      if (total > maxBodyBytes) {
        tooLarge = true
        chunks.length = 0
        if (total > maxDrainBytes && !settled) {
          settled = true
          cleanup()
          stopReading()
          reject(new Error(`Request body too large`))
        }
        return
      }
      if (!tooLarge)
        chunks.push(chunk)
    }

    function onEnd() {
      if (settled)
        return
      settled = true
      cleanup()
      if (tooLarge) {
        chunks.length = 0
        reject(new Error(`Request body too large`))
        return
      }
      try {
        const raw = Buffer.concat(chunks).toString(`utf8`)
        chunks.length = 0
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
    }

    function onError(error: Error) {
      if (settled)
        return
      settled = true
      cleanup()
      chunks.length = 0
      reject(error)
    }

    req.on(`data`, onData)
    req.on(`end`, onEnd)
    req.on(`error`, onError)
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
          reject(new Error(`Image bridge closed before startup completed`))
          return
        }
        const address = server.address()
        if (!address || typeof address === `string`) {
          server.close()
          this.server = null
          this.startPromise = null
          reject(new Error(`Failed to resolve local image bridge port`))
          return
        }
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
      sendJson(res, 404, { error: `Not found` }, req)
      return
    }

    const authHeader = req.headers.authorization ?? ``
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader)
    if (!match || !tokensEqual(this.token, match[1])) {
      sendJson(res, 401, { error: `Unauthorized` }, req)
      return
    }

    // Enforce concurrency before buffering/decoding up to 43 MB of request payload.
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      sendJson(res, 429, { error: `Too many concurrent image generation requests` }, req)
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
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      }
      catch (error) {
        if (!res.writableEnded)
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }, req)
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
