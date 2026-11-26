export function validateHttpBaseUrl(raw: string, fallback?: string): string {
  const candidate = (raw.trim() || fallback?.trim() || ``).replace(/\/+$/, ``)
  if (!candidate)
    throw new Error(`Base URL is required (must start with http:// or https://)`)

  let parsed: URL
  try {
    parsed = new URL(candidate)
  }
  catch {
    const safeCandidate = candidate.replace(/(:\/\/)[^/@\s]+@/g, `$1***@`)
    throw new Error(`Invalid Base URL "${safeCandidate}": must be a valid http:// or https:// URL`)
  }

  if ((parsed.protocol !== `http:` && parsed.protocol !== `https:`) || !parsed.hostname)
    throw new Error(`Invalid Base URL protocol "${parsed.protocol}": only http:// and https:// are allowed`)

  if (parsed.username || parsed.password)
    throw new Error(`Base URL must not embed credentials`)

  if (parsed.search || parsed.hash)
    throw new Error(`Base URL must not include query parameters or fragments`)

  return candidate
}

export function isValidHttpBaseUrl(raw: string): boolean {
  try {
    validateHttpBaseUrl(raw)
    return true
  }
  catch {
    return false
  }
}

export function redactSecret(message: string, ...secrets: Array<string | null | undefined>): string {
  let cleaned = message
    .replace(/([?&](?:key|api_key|token)=)[^&\s"'`)\]]+/gi, `$1***`)
    .replace(/\b(Bearer\s+)[\w.~+/=-]{4,}/gi, `$1***`)
    .replace(/\b(x-(?:goog-)?api-key\s*[:=]\s*)[^\s,"'`)\]]+/gi, `$1***`)

  for (const secret of secrets) {
    const trimmed = secret?.trim()
    if (trimmed && trimmed.length >= 3) {
      cleaned = cleaned.split(trimmed).join(`***`)
      const encoded = encodeURIComponent(trimmed)
      if (encoded !== trimmed)
        cleaned = cleaned.split(encoded).join(`***`)
    }
  }
  return cleaned
}
