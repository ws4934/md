export function validateHttpBaseUrl(raw: string, fallback?: string): string {
  const candidate = (raw.trim() || fallback?.trim() || ``).replace(/\/+$/, ``)
  if (!candidate)
    throw new Error(`Base URL is required (must start with http:// or https://)`)

  let parsed: URL
  try {
    parsed = new URL(candidate)
  }
  catch {
    throw new Error(`Invalid Base URL "${candidate}": must be a valid http:// or https:// URL`)
  }

  if ((parsed.protocol !== `http:` && parsed.protocol !== `https:`) || !parsed.hostname)
    throw new Error(`Invalid Base URL protocol "${parsed.protocol}": only http:// and https:// are allowed`)

  if (parsed.username || parsed.password)
    throw new Error(`Base URL must not embed credentials`)

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

export function redactSecret(message: string, secret?: string | null): string {
  let cleaned = message
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, `$1***`)
    .replace(/\b(Bearer\s+)[\w.~+/=-]{4,}/gi, `$1***`)

  const trimmed = secret?.trim()
  if (trimmed && trimmed.length >= 3) {
    cleaned = cleaned.split(trimmed).join(`***`)
    const encoded = encodeURIComponent(trimmed)
    if (encoded !== trimmed)
      cleaned = cleaned.split(encoded).join(`***`)
  }
  return cleaned
}
