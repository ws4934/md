export interface WeChatMpCredentials {
  appID: string
  appsecret: string
  proxyOrigin?: string
}

export type WeChatPublishMode = `draft` | `publish`

export type WeChatPublishStage
  = | `token`
    | `images`
    | `cover`
    | `draft`
    | `publishing`
    | `polling`
    | `done`
    | `error`

export type WeChatErrorCodeKey
  = | `ip_not_whitelisted`
    | `api_unauthorized`
    | `invalid_media`
    | `quota_exceeded`
    | `invalid_credentials`
    | `content_too_long`
    | `publish_failed`
    | `publish_timeout`
    | `unknown`

export interface WeChatPublishRequest {
  publishId?: string
  credentials: WeChatMpCredentials
  mode: WeChatPublishMode
  title: string
  author?: string
  digest?: string
  contentHtml: string
  coverSource: string
  needOpenComment: boolean
}

export interface WeChatPublishProgressEvent {
  publishId: string
  stage: WeChatPublishStage
  currentImage?: number
  totalImages?: number
  mediaId?: string
  publishTaskId?: string
  articleUrl?: string
  errcode?: number
  errorCodeKey?: WeChatErrorCodeKey
  egressIp?: string
  message?: string
}

export interface WeChatPublishResult {
  ok: boolean
  mode: WeChatPublishMode
  mediaId?: string
  publishTaskId?: string
  articleUrl?: string
  uploadedImageCount?: number
  errcode?: number
  errorCodeKey?: WeChatErrorCodeKey
  egressIp?: string
  error?: string
}

export interface DesktopPickedImage {
  path: string
  name: string
  dataUrl: string
}

export interface WeChatUploadImageRequest {
  credentials: WeChatMpCredentials
  dataUrl: string
  filename: string
  mimeType: string
  byteSize: number
}

export interface WeChatUploadImageResult {
  ok: boolean
  url?: string
  errcode?: number
  error?: string
}

export interface DesktopWeChatApi {
  publish: (request: WeChatPublishRequest) => Promise<WeChatPublishResult>
  uploadImage: (request: WeChatUploadImageRequest) => Promise<WeChatUploadImageResult>
  onProgress: (listener: (event: WeChatPublishProgressEvent) => void) => () => void
}
