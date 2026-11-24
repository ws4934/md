import type {
  WeChatMpCredentials,
  WeChatPublishProgressEvent,
  WeChatPublishRequest,
  WeChatPublishResult,
  WeChatUploadImageRequest,
  WeChatUploadImageResult,
} from '@md/shared/types'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractUploadableImageUrls, normalizeImageSource, rewriteHtmlImageSources } from '@md/shared/utils/wechat-html-images'
import {
  buildWeChatAddMaterialUrl,
  buildWeChatDraftAddUrl,
  buildWeChatFreePublishGetUrl,
  buildWeChatFreePublishSubmitUrl,
  buildWeChatStableTokenBody,
  buildWeChatStableTokenUrl,
  buildWeChatUploadImgUrl,
  isWeChatTokenExpiredError,
  resolveWeChatApiOrigin,
  shouldUseWeChatUploadImg,
} from '@md/shared/utils/wechat-mp'
import {
  extractIpFromWeChatError,
  mapPublishFailureStatus,
  mapWeChatError,
  sanitizeWeChatText,
  WeChatApiError,
} from './errors'

export { resolveWeChatApiOrigin }

const DEFAULT_CONCURRENCY = 3
const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_MAX_POLL_ATTEMPTS = 45
const ALLOWED_LOCAL_IMAGE_EXTENSIONS = new Set([`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`])

export interface ImageBinary {
  buffer: Uint8Array
  mimeType: string
  filename: string
}

export interface WeChatPublisherOptions {
  fetchFn?: typeof fetch
  readLocalFile?: (filePath: string) => Promise<ImageBinary>
  sleepFn?: (ms: number) => Promise<void>
  resolveEgressIp?: () => Promise<string | undefined>
  onProgress?: (event: WeChatPublishProgressEvent) => void
  concurrency?: number
  pollIntervalMs?: number
  maxPollAttempts?: number
}

interface CachedToken {
  accessToken: string
  expiresAt: number
}

interface StableTokenResponse {
  access_token?: string
  expires_in?: number
  errcode?: number
  errmsg?: string
}

interface UploadImgResponse {
  url?: string
  errcode?: number
  errmsg?: string
}

interface AddMaterialResponse {
  media_id?: string
  url?: string
  errcode?: number
  errmsg?: string
}

interface AddDraftResponse {
  media_id?: string
  errcode?: number
  errmsg?: string
}

interface FreePublishSubmitResponse {
  publish_id?: string | number
  msg_data_id?: string | number
  errcode?: number
  errmsg?: string
}

interface FreePublishGetResponse {
  publish_id?: string | number
  publish_status?: number
  article_url?: string
  article_detail?: {
    count?: number
    item?: Array<{
      idx?: number
      article_url?: string
    }>
  }
  errcode?: number
  errmsg?: string
}

function extensionForMime(mimeType: string): string {
  const clean = mimeType.split(`;`)[0]?.trim().toLowerCase()
  switch (clean) {
    case `image/jpeg`:
    case `image/jpg`:
      return `.jpg`
    case `image/png`:
      return `.png`
    case `image/gif`:
      return `.gif`
    case `image/webp`:
      return `.webp`
    case `image/bmp`:
      return `.bmp`
    default:
      return `.png`
  }
}

export function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case `.jpg`:
    case `.jpeg`:
      return `image/jpeg`
    case `.png`:
      return `image/png`
    case `.gif`:
      return `image/gif`
    case `.webp`:
      return `image/webp`
    case `.bmp`:
      return `image/bmp`
    default:
      return `image/png`
  }
}

function parseDataImageUri(dataUri: string): ImageBinary {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/i.exec(dataUri)
  if (!match)
    throw new Error(`Unsupported image data URI`)
  const mimeType = match[1].toLowerCase()
  const isBase64 = Boolean(match[2])
  const payload = match[3]
  const raw = isBase64
    ? Buffer.from(payload, `base64`)
    : Buffer.from(decodeURIComponent(payload), `utf-8`)
  const ext = extensionForMime(mimeType)
  return {
    buffer: raw,
    mimeType,
    filename: `image${ext}`,
  }
}

async function defaultReadLocalFile(filePath: string): Promise<ImageBinary> {
  const resolved = path.resolve(filePath)
  const ext = path.extname(resolved).toLowerCase()
  if (!ALLOWED_LOCAL_IMAGE_EXTENSIONS.has(ext))
    throw new Error(`Unsupported local image format: ${ext || `unknown`}`)
  const data = await fs.readFile(resolved)
  return {
    buffer: data,
    mimeType: mimeForExtension(ext),
    filename: path.basename(resolved),
  }
}

async function defaultResolveEgressIp(fetchFn: typeof fetch): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetchFn(`https://api.ipify.org?format=json`, {
      signal: controller.signal,
    })
    if (!res.ok)
      return undefined
    const json = await res.json() as { ip?: string }
    return typeof json.ip === `string` && json.ip.trim() ? json.ip.trim() : undefined
  }
  catch {
    return undefined
  }
  finally {
    clearTimeout(timer)
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0)
    return
  const maxWorkers = Math.max(1, Math.min(limit, items.length))
  let nextIndex = 0
  let firstError: unknown = null

  async function runNext(): Promise<void> {
    while (nextIndex < items.length && firstError === null) {
      const current = nextIndex
      nextIndex += 1
      try {
        await worker(items[current], current)
      }
      catch (err) {
        if (firstError === null)
          firstError = err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: maxWorkers }, () => runNext()))
  if (firstError !== null)
    throw firstError
}

export class WeChatPublisher {
  private readonly fetchFn: typeof fetch
  private readonly readLocalFile: (filePath: string) => Promise<ImageBinary>
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly resolveEgressIp: () => Promise<string | undefined>
  private readonly onProgress?: (event: WeChatPublishProgressEvent) => void
  private readonly concurrency: number
  private readonly pollIntervalMs: number
  private readonly maxPollAttempts: number
  private readonly tokenCache = new Map<string, CachedToken>()
  private readonly allowedLocalPaths = new Set<string>()

  constructor(options: WeChatPublisherOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.readLocalFile = options.readLocalFile ?? defaultReadLocalFile
    this.sleepFn = options.sleepFn ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.resolveEgressIp = options.resolveEgressIp ?? (() => defaultResolveEgressIp(this.fetchFn))
    this.onProgress = options.onProgress
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS
  }

  /** Authorize a local image file explicitly picked by the user via the native picker. */
  allowLocalImagePath(filePath: string): void {
    const trimmed = filePath.trim()
    if (trimmed)
      this.allowedLocalPaths.add(path.resolve(trimmed))
  }

  private emitProgress(event: WeChatPublishProgressEvent): void {
    this.onProgress?.(event)
  }

  private async throwWeChatError(
    errcode: number | undefined,
    errmsg: string,
    secret?: string,
  ): Promise<never> {
    let egressIp = extractIpFromWeChatError(errmsg || ``)
    if (errcode === 40164 && !egressIp) {
      egressIp = await this.resolveEgressIp().catch(() => undefined)
    }
    const mapped = mapWeChatError(errcode, errmsg, { egressIp, secret })
    throw new WeChatApiError({
      errcode,
      errmsg: sanitizeWeChatText(errmsg || ``, secret),
      errorCodeKey: mapped.errorCodeKey,
      message: mapped.message,
      egressIp: mapped.egressIp,
    })
  }

  private async parseJsonResponse<T extends { errcode?: number, errmsg?: string }>(
    response: Response,
    secret?: string,
  ): Promise<T> {
    const rawText = await response.text()
    let parsed: T
    try {
      parsed = JSON.parse(rawText) as T
    }
    catch {
      const safeSnippet = sanitizeWeChatText(rawText.slice(0, 200), secret)
      throw new Error(`WeChat API returned non-JSON response (HTTP ${response.status}): ${safeSnippet}`)
    }

    if (typeof parsed.errcode === `number` && parsed.errcode !== 0)
      await this.throwWeChatError(parsed.errcode, parsed.errmsg ?? ``, secret)

    if (!response.ok)
      await this.throwWeChatError(parsed.errcode, parsed.errmsg ?? `HTTP ${response.status}`, secret)

    return parsed
  }

  private tokenCacheKey(origin: string, appID: string): string {
    return `${origin}|${appID}`
  }

  async getAccessToken(credentials: WeChatMpCredentials, forceRefresh = false): Promise<string> {
    const origin = resolveWeChatApiOrigin(credentials.proxyOrigin)
    const cacheKey = this.tokenCacheKey(origin, credentials.appID)
    const cached = this.tokenCache.get(cacheKey)
    if (!forceRefresh && cached && cached.expiresAt > Date.now())
      return cached.accessToken

    const response = await this.fetchFn(buildWeChatStableTokenUrl(origin), {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
      },
      body: JSON.stringify(buildWeChatStableTokenBody(credentials.appID, credentials.appsecret)),
    })

    const data = await this.parseJsonResponse<StableTokenResponse>(response, credentials.appsecret)
    if (!data.access_token)
      await this.throwWeChatError(data.errcode, data.errmsg || `Missing access_token`, credentials.appsecret)

    const ttlSeconds = Math.max(60, (data.expires_in ?? 7200) - 60)
    this.tokenCache.set(cacheKey, {
      accessToken: data.access_token!,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
    return data.access_token!
  }

  private async withTokenRetry<T>(
    credentials: WeChatMpCredentials,
    operation: (token: string, origin: string) => Promise<T>,
  ): Promise<T> {
    const origin = resolveWeChatApiOrigin(credentials.proxyOrigin)
    const token = await this.getAccessToken(credentials, false)
    try {
      return await operation(token, origin)
    }
    catch (err) {
      if (err instanceof WeChatApiError && isWeChatTokenExpiredError(err.errcode)) {
        this.tokenCache.delete(this.tokenCacheKey(origin, credentials.appID))
        const refreshed = await this.getAccessToken(credentials, true)
        return await operation(refreshed, origin)
      }
      throw err
    }
  }

  private async loadImageBinary(source: string): Promise<ImageBinary> {
    const normalized = normalizeImageSource(source)
    if (/^data:image\//i.test(normalized))
      return parseDataImageUri(normalized)

    if (/^https?:\/\//i.test(normalized)) {
      const response = await this.fetchFn(normalized)
      if (!response.ok)
        throw new Error(`Failed to fetch image (${response.status}): ${normalized}`)
      const contentType = response.headers.get(`content-type`)?.split(`;`)[0]?.trim().toLowerCase()
      const arrayBuf = await response.arrayBuffer()
      let urlExt = ``
      try {
        urlExt = path.extname(new URL(normalized).pathname).toLowerCase()
      }
      catch {
        urlExt = ``
      }
      const mimeType = contentType && contentType.startsWith(`image/`)
        ? contentType
        : mimeForExtension(urlExt)
      const ext = extensionForMime(mimeType)
      return {
        buffer: new Uint8Array(arrayBuf),
        mimeType,
        filename: `image${ext}`,
      }
    }

    const resolved = path.resolve(normalized)
    if (!this.allowedLocalPaths.has(resolved))
      throw new Error(`Local cover image must be selected through the image picker.`)

    return this.readLocalFile(resolved)
  }

  private buildMediaForm(binary: ImageBinary): FormData {
    const form = new FormData()
    const blob = new Blob([binary.buffer as BlobPart], { type: binary.mimeType })
    form.append(`media`, blob, binary.filename)
    return form
  }

  private async uploadContentImage(
    credentials: WeChatMpCredentials,
    source: string,
  ): Promise<string> {
    const binary = await this.loadImageBinary(source)
    return this.withTokenRetry(credentials, async (token, origin) => {
      const response = await this.fetchFn(
        buildWeChatUploadImgUrl(origin, token),
        {
          method: `POST`,
          body: this.buildMediaForm(binary),
        },
      )
      const data = await this.parseJsonResponse<UploadImgResponse>(response, credentials.appsecret)
      if (!data.url)
        await this.throwWeChatError(data.errcode, data.errmsg || `Missing uploaded image url`, credentials.appsecret)
      return data.url!
    })
  }

  /**
   * Uploads a single renderer image via the main-process token cache so
   * editor image uploads and article publishing share one WeChat access_token.
   */
  async uploadImage(request: WeChatUploadImageRequest): Promise<WeChatUploadImageResult> {
    const secret = request.credentials?.appsecret ?? ``
    try {
      const appID = request.credentials?.appID?.trim() ?? ``
      const appsecret = secret.trim()
      if (!appID || !appsecret) {
        throw new WeChatApiError({
          errmsg: `Missing credentials`,
          errorCodeKey: `invalid_credentials`,
          message: `WeChat Official Account AppID and AppSecret are required.`,
        })
      }

      const credentials: WeChatMpCredentials = {
        appID,
        appsecret,
        proxyOrigin: request.credentials.proxyOrigin?.trim() || undefined,
      }
      const parsed = parseDataImageUri(request.dataUrl)
      const binary: ImageBinary = {
        buffer: parsed.buffer,
        mimeType: request.mimeType || parsed.mimeType,
        filename: request.filename || parsed.filename,
      }
      const useUploadImg = shouldUseWeChatUploadImg(request.byteSize || binary.buffer.byteLength, binary.mimeType)

      const url = await this.withTokenRetry(credentials, async (token, origin) => {
        const endpoint = useUploadImg
          ? buildWeChatUploadImgUrl(origin, token)
          : buildWeChatAddMaterialUrl(origin, token, `image`)
        const response = await this.fetchFn(endpoint, {
          method: `POST`,
          body: this.buildMediaForm(binary),
        })
        const data = await this.parseJsonResponse<UploadImgResponse & AddMaterialResponse>(response, appsecret)
        if (!data.url)
          await this.throwWeChatError(data.errcode, data.errmsg || `Missing uploaded image url`, appsecret)
        return data.url!
      })

      return { ok: true, url }
    }
    catch (err) {
      const apiErr = err instanceof WeChatApiError ? err : null
      return {
        ok: false,
        errcode: apiErr?.errcode,
        error: sanitizeWeChatText(err instanceof Error ? err.message : String(err), secret),
      }
    }
  }

  private async uploadCoverMaterial(
    credentials: WeChatMpCredentials,
    coverSource: string,
  ): Promise<string> {
    const binary = await this.loadImageBinary(coverSource)
    return this.withTokenRetry(credentials, async (token, origin) => {
      const response = await this.fetchFn(
        buildWeChatAddMaterialUrl(origin, token, `image`),
        {
          method: `POST`,
          body: this.buildMediaForm(binary),
        },
      )
      const data = await this.parseJsonResponse<AddMaterialResponse>(response, credentials.appsecret)
      if (!data.media_id)
        await this.throwWeChatError(data.errcode, data.errmsg || `Missing cover media_id`, credentials.appsecret)
      return data.media_id!
    })
  }

  private async createDraft(
    credentials: WeChatMpCredentials,
    article: {
      title: string
      author: string
      digest: string
      content: string
      thumbMediaId: string
      needOpenComment: boolean
    },
  ): Promise<string> {
    return this.withTokenRetry(credentials, async (token, origin) => {
      const response = await this.fetchFn(
        buildWeChatDraftAddUrl(origin, token),
        {
          method: `POST`,
          headers: {
            'Content-Type': `application/json; charset=utf-8`,
          },
          body: JSON.stringify({
            articles: [
              {
                title: article.title,
                author: article.author,
                digest: article.digest,
                content: article.content,
                thumb_media_id: article.thumbMediaId,
                need_open_comment: article.needOpenComment ? 1 : 0,
                only_fans_can_comment: 0,
              },
            ],
          }),
        },
      )
      const data = await this.parseJsonResponse<AddDraftResponse>(response, credentials.appsecret)
      if (!data.media_id)
        await this.throwWeChatError(data.errcode, data.errmsg || `Missing draft media_id`, credentials.appsecret)
      return data.media_id!
    })
  }

  private async submitFreePublish(
    credentials: WeChatMpCredentials,
    mediaId: string,
  ): Promise<string> {
    return this.withTokenRetry(credentials, async (token, origin) => {
      const response = await this.fetchFn(
        buildWeChatFreePublishSubmitUrl(origin, token),
        {
          method: `POST`,
          headers: {
            'Content-Type': `application/json; charset=utf-8`,
          },
          body: JSON.stringify({ media_id: mediaId }),
        },
      )
      const data = await this.parseJsonResponse<FreePublishSubmitResponse>(response, credentials.appsecret)
      if (data.publish_id === undefined || data.publish_id === null || data.publish_id === ``)
        await this.throwWeChatError(data.errcode, data.errmsg || `Missing publish_id`, credentials.appsecret)
      return String(data.publish_id)
    })
  }

  private async pollFreePublish(
    credentials: WeChatMpCredentials,
    publishTaskId: string,
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const data = await this.withTokenRetry(credentials, async (token, origin) => {
        const response = await this.fetchFn(
          buildWeChatFreePublishGetUrl(origin, token),
          {
            method: `POST`,
            headers: {
              'Content-Type': `application/json; charset=utf-8`,
            },
            body: JSON.stringify({ publish_id: publishTaskId }),
          },
        )
        return this.parseJsonResponse<FreePublishGetResponse>(response, credentials.appsecret)
      })

      if (data.publish_status === 0) {
        return data.article_detail?.item?.[0]?.article_url ?? data.article_url
      }

      if (typeof data.publish_status === `number` && data.publish_status >= 2) {
        throw new WeChatApiError({
          errmsg: `publish_status=${data.publish_status}`,
          errorCodeKey: `publish_failed`,
          message: mapPublishFailureStatus(data.publish_status),
        })
      }

      if (attempt + 1 < this.maxPollAttempts)
        await this.sleepFn(this.pollIntervalMs)
    }

    throw new WeChatApiError({
      errmsg: `publish polling timed out`,
      errorCodeKey: `publish_timeout`,
      message: `WeChat is still processing the publish task. Check the status in the Official Account backend.`,
    })
  }

  async publish(request: WeChatPublishRequest): Promise<WeChatPublishResult> {
    const publishId = request.publishId || crypto.randomUUID()
    const secret = request.credentials?.appsecret ?? ``
    let createdMediaId: string | undefined

    try {
      const appID = request.credentials?.appID?.trim() ?? ``
      const appsecret = secret.trim()
      if (!appID || !appsecret) {
        throw new WeChatApiError({
          errmsg: `Missing credentials`,
          errorCodeKey: `invalid_credentials`,
          message: `WeChat Official Account AppID and AppSecret are required.`,
        })
      }

      const title = request.title.trim().slice(0, 64)
      if (!title)
        throw new Error(`Article title is required.`)

      const coverSource = request.coverSource.trim()
      if (!coverSource)
        throw new Error(`Cover image is required.`)

      const credentials: WeChatMpCredentials = {
        appID,
        appsecret,
        proxyOrigin: request.credentials.proxyOrigin?.trim() || undefined,
      }

      // 1. Acquire token
      this.emitProgress({ publishId, stage: `token` })
      await this.getAccessToken(credentials, false)

      // 2. Upload unique content images not already on mmbiz.qpic.cn
      const uniqueUrls = extractUploadableImageUrls(request.contentHtml)
      const urlMap = new Map<string, string>()

      if (uniqueUrls.length > 0) {
        let completed = 0
        this.emitProgress({
          publishId,
          stage: `images`,
          currentImage: 0,
          totalImages: uniqueUrls.length,
        })

        await runWithConcurrency(uniqueUrls, this.concurrency, async (url) => {
          const wechatUrl = await this.uploadContentImage(credentials, url)
          urlMap.set(url, wechatUrl)
          completed += 1
          this.emitProgress({
            publishId,
            stage: `images`,
            currentImage: completed,
            totalImages: uniqueUrls.length,
          })
        })
      }

      const rewrittenHtml = rewriteHtmlImageSources(request.contentHtml, urlMap)

      // 3. Upload cover material for thumb_media_id
      this.emitProgress({ publishId, stage: `cover` })
      const thumbMediaId = await this.uploadCoverMaterial(credentials, coverSource)

      // 4. Create draft
      this.emitProgress({ publishId, stage: `draft` })
      const mediaId = await this.createDraft(credentials, {
        title,
        author: (request.author ?? ``).trim(),
        digest: (request.digest ?? ``).trim().slice(0, 120),
        content: rewrittenHtml,
        thumbMediaId,
        needOpenComment: request.needOpenComment,
      })
      createdMediaId = mediaId

      if (request.mode === `draft`) {
        this.emitProgress({
          publishId,
          stage: `done`,
          mediaId,
        })
        return {
          ok: true,
          mode: `draft`,
          mediaId,
          uploadedImageCount: uniqueUrls.length,
        }
      }

      // 5. Submit free publish and poll until terminal state
      this.emitProgress({ publishId, stage: `publishing`, mediaId })
      const publishTaskId = await this.submitFreePublish(credentials, mediaId)

      this.emitProgress({
        publishId,
        stage: `polling`,
        mediaId,
        publishTaskId,
      })
      const articleUrl = await this.pollFreePublish(credentials, publishTaskId)

      this.emitProgress({
        publishId,
        stage: `done`,
        mediaId,
        publishTaskId,
        articleUrl,
      })
      return {
        ok: true,
        mode: `publish`,
        mediaId,
        publishTaskId,
        articleUrl,
        uploadedImageCount: uniqueUrls.length,
      }
    }
    catch (err) {
      const apiErr = err instanceof WeChatApiError ? err : null
      const safeMessage = sanitizeWeChatText(
        err instanceof Error ? err.message : String(err),
        secret,
      )
      this.emitProgress({
        publishId,
        stage: `error`,
        mediaId: createdMediaId,
        errcode: apiErr?.errcode,
        errorCodeKey: apiErr?.errorCodeKey ?? `unknown`,
        egressIp: apiErr?.egressIp,
        message: safeMessage,
      })
      return {
        ok: false,
        mode: request.mode,
        mediaId: createdMediaId,
        errcode: apiErr?.errcode,
        errorCodeKey: apiErr?.errorCodeKey ?? `unknown`,
        egressIp: apiErr?.egressIp,
        error: safeMessage,
      }
    }
  }
}
