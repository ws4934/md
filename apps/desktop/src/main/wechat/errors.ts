import type { WeChatErrorCodeKey } from '@md/shared/types'

export interface MappedWeChatError {
  errorCodeKey: WeChatErrorCodeKey
  message: string
  egressIp?: string
}

export class WeChatApiError extends Error {
  readonly errcode?: number
  readonly errmsg: string
  readonly errorCodeKey: WeChatErrorCodeKey
  readonly egressIp?: string

  constructor(params: {
    errcode?: number
    errmsg: string
    errorCodeKey: WeChatErrorCodeKey
    message: string
    egressIp?: string
  }) {
    super(params.message)
    this.name = `WeChatApiError`
    this.errcode = params.errcode
    this.errmsg = params.errmsg
    this.errorCodeKey = params.errorCodeKey
    this.egressIp = params.egressIp
  }
}

export function sanitizeWeChatText(text: string, secret?: string): string {
  let clean = text
  if (secret) {
    clean = clean.split(secret).join(`[REDACTED]`)
    const encoded = encodeURIComponent(secret)
    if (encoded && encoded !== secret)
      clean = clean.split(encoded).join(`[REDACTED]`)
  }
  clean = clean
    .replace(/([?&]secret=)[^&\s"']+/gi, `$1[REDACTED]`)
    .replace(/([?&]access_token=)[^&\s"']+/gi, `$1[REDACTED]`)
    .replace(/("secret"\s*:\s*")[^"]+(")/gi, `$1[REDACTED]$2`)
  return clean
}

export function extractIpFromWeChatError(errmsg: string): string | undefined {
  const ipv4Match = /invalid ip\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(errmsg)
    ?? /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(errmsg)
  if (ipv4Match)
    return ipv4Match[1]

  const ipv6Match = /invalid ip\s+([0-9a-f:]{3,})/i.exec(errmsg)
  return ipv6Match?.[1]
}

export function mapWeChatError(
  errcode: number | undefined,
  errmsg: string,
  options?: { egressIp?: string, secret?: string },
): MappedWeChatError {
  const cleanErrmsg = sanitizeWeChatText(errmsg || ``, options?.secret).trim()
  const extractedIp = options?.egressIp || extractIpFromWeChatError(cleanErrmsg)

  switch (errcode) {
    case 40164:
      return {
        errorCodeKey: `ip_not_whitelisted`,
        egressIp: extractedIp,
        message: extractedIp
          ? `Current egress IP (${extractedIp}) is not in the WeChat Official Account IP whitelist (errcode 40164). Add it under MP Settings > Basic Configuration > IP Whitelist.`
          : `Current egress IP is not in the WeChat Official Account IP whitelist (errcode 40164). Add your machine's public IP under MP Settings > Basic Configuration > IP Whitelist.`,
      }
    case 48001:
      return {
        errorCodeKey: `api_unauthorized`,
        message: `This Official Account does not have permission for this API (errcode 48001). Unverified or personal accounts may lack Draft Box or Free Publish API permissions.`,
      }
    case 40007:
      return {
        errorCodeKey: `invalid_media`,
        message: `Invalid media asset (errcode 40007). Check the cover image format and size, then try again.`,
      }
    case 45009:
      return {
        errorCodeKey: `quota_exceeded`,
        message: `Daily WeChat API quota exceeded (errcode 45009). Please try again tomorrow or clear quota in the Official Account console.`,
      }
    case 40001:
    case 40013:
    case 40125:
    case 42001:
      return {
        errorCodeKey: `invalid_credentials`,
        message: `Invalid AppID, AppSecret, or access token (errcode ${errcode}). Check your Official Account developer credentials.`,
      }
    case 45002:
    case 45003:
    case 45004:
    case 45007:
      return {
        errorCodeKey: `content_too_long`,
        message: `Article title, digest, or body exceeds WeChat length limits (errcode ${errcode}).`,
      }
    default:
      return {
        errorCodeKey: `unknown`,
        message: errcode !== undefined
          ? `WeChat API error [${errcode}]: ${cleanErrmsg || `Unknown error`}`
          : (cleanErrmsg || `WeChat API request failed`),
      }
  }
}

export function mapPublishFailureStatus(publishStatus: number): string {
  switch (publishStatus) {
    case 2:
      return `WeChat original content check failed (publish_status 2).`
    case 3:
      return `WeChat publishing failed (publish_status 3).`
    case 4:
      return `WeChat platform content review rejected the article (publish_status 4).`
    case 5:
      return `Published article was deleted by the account operator (publish_status 5).`
    case 6:
      return `Published article was blocked by the platform (publish_status 6).`
    default:
      return `WeChat publishing failed with status ${publishStatus}.`
  }
}
