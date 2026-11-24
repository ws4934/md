const IMG_TAG_REGEX = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
const IMG_SRC_ATTR_REGEX = /(^|[\s/])(src\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, `&`)
    .replace(/&quot;/gi, `"`)
    .replace(/&#39;|&apos;/gi, `'`)
    .replace(/&lt;/gi, `<`)
    .replace(/&gt;/gi, `>`)
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, `&amp;`)
    .replace(/"/g, `&quot;`)
    .replace(/</g, `&lt;`)
    .replace(/>/g, `&gt;`)
}

export function normalizeImageSource(raw: string): string {
  const decoded = decodeHtmlEntities(raw).trim()
  if (decoded.startsWith(`//`))
    return `https:${decoded}`
  return decoded
}

export function isWeChatHostedImage(src: string): boolean {
  const normalized = normalizeImageSource(src)
  if (!/^https?:\/\//i.test(normalized))
    return false
  try {
    const { hostname } = new URL(normalized)
    const lower = hostname.toLowerCase()
    return lower === `mmbiz.qpic.cn` || lower.endsWith(`.mmbiz.qpic.cn`)
  }
  catch {
    return false
  }
}

export function isUploadableImageSource(src: string): boolean {
  const normalized = normalizeImageSource(src)
  if (!normalized || normalized === `about:blank`)
    return false
  if (isWeChatHostedImage(normalized))
    return false
  return /^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized)
}

/**
 * Extract unique image `src` URLs from rendered HTML that need uploading to WeChat.
 * Preserves first-seen order and skips images already hosted on `mmbiz.qpic.cn`.
 */
export function extractUploadableImageUrls(html: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []

  for (const match of html.matchAll(IMG_TAG_REGEX)) {
    const tag = match[0]
    const srcMatch = IMG_SRC_ATTR_REGEX.exec(tag)
    if (!srcMatch)
      continue
    const rawValue = srcMatch[3] ?? srcMatch[4] ?? srcMatch[5] ?? ``
    const normalized = normalizeImageSource(rawValue)
    if (!isUploadableImageSource(normalized) || seen.has(normalized))
      continue
    seen.add(normalized)
    urls.push(normalized)
  }

  return urls
}

/**
 * Rewrite `src` attributes of `<img>` tags using `urlMap`, preserving all other attributes.
 */
export function rewriteHtmlImageSources(html: string, urlMap: ReadonlyMap<string, string>): string {
  if (urlMap.size === 0)
    return html

  return html.replace(IMG_TAG_REGEX, (tag) => {
    return tag.replace(IMG_SRC_ATTR_REGEX, (full, prefix: string, attrName: string, dbl?: string, sgl?: string, bare?: string) => {
      const rawValue = dbl ?? sgl ?? bare ?? ``
      const normalized = normalizeImageSource(rawValue)
      const replacement = urlMap.get(normalized)
      if (!replacement)
        return full

      const quote = sgl !== undefined ? `'` : `"`
      const escaped = quote === `'`
        ? escapeHtmlAttr(replacement).replace(/'/g, `&#39;`)
        : escapeHtmlAttr(replacement)
      return `${prefix}${attrName}${quote}${escaped}${quote}`
    })
  })
}
