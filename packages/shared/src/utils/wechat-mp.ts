export const DEFAULT_WECHAT_API_ORIGIN = `https://api.weixin.qq.com`

export function resolveWeChatApiOrigin(proxyOrigin?: string): string {
  const trimmed = proxyOrigin?.trim().replace(/\/+$/, ``)
  if (!trimmed)
    return DEFAULT_WECHAT_API_ORIGIN
  if (!/^https?:\/\//i.test(trimmed))
    throw new Error(`Invalid proxy origin: must start with http:// or https://`)
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  }
  catch {
    throw new Error(`Invalid proxy origin URL`)
  }
  if ((parsed.protocol !== `http:` && parsed.protocol !== `https:`) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(`Invalid proxy origin URL`)
  return trimmed
}

export function buildWeChatStableTokenUrl(origin: string): string {
  return `${origin}/cgi-bin/stable_token`
}

export function buildWeChatStableTokenBody(appID: string, appsecret: string) {
  return {
    grant_type: `client_credential` as const,
    appid: appID,
    secret: appsecret,
  }
}

export function buildWeChatUploadImgUrl(origin: string, accessToken: string): string {
  return `${origin}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`
}

export function buildWeChatAddMaterialUrl(origin: string, accessToken: string, type = `image`): string {
  return `${origin}/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`
}

export function buildWeChatDraftAddUrl(origin: string, accessToken: string): string {
  return `${origin}/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`
}

export function buildWeChatFreePublishSubmitUrl(origin: string, accessToken: string): string {
  return `${origin}/cgi-bin/freepublish/submit?access_token=${encodeURIComponent(accessToken)}`
}

export function buildWeChatFreePublishGetUrl(origin: string, accessToken: string): string {
  return `${origin}/cgi-bin/freepublish/get?access_token=${encodeURIComponent(accessToken)}`
}

export function isWeChatTokenExpiredError(errcode?: number): boolean {
  return errcode === 40001 || errcode === 42001
}

export function shouldUseWeChatUploadImg(byteSize: number, mimeType: string): boolean {
  const lower = mimeType.toLowerCase()
  return byteSize < 1024 * 1024 && (lower === `image/jpeg` || lower === `image/png`)
}
