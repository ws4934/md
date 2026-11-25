import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface WorkspaceImageResult {
  relativePath: string
  absolutePath: string
  mimeType: string
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': `.png`,
  'image/jpeg': `.jpg`,
  'image/jpg': `.jpg`,
  'image/webp': `.webp`,
  'image/gif': `.gif`,
}

export function extensionForImageMime(mimeType: string): string {
  const normalized = mimeType.split(`;`)[0].trim().toLowerCase()
  return MIME_TO_EXT[normalized] ?? `.png`
}

export function sanitizeImageSlug(raw: string | undefined, fallbackPrompt?: string): string {
  const baseSource = raw?.trim()
    ? path.basename(raw.trim()).replace(/\.[a-z0-9]{1,5}$/i, ``)
    : (fallbackPrompt ?? ``).slice(0, 40)

  const asciiSlug = baseSource
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, `-`)
    .replace(/^-+|-+$/g, ``)
    .slice(0, 48)

  if (asciiSlug)
    return asciiSlug
  return `img-${randomBytes(4).toString(`hex`)}`
}

async function resolveUniqueImageFilename(imagesDir: string, slug: string, ext: string): Promise<string> {
  const firstCandidate = `${slug}${ext}`
  try {
    await fs.access(path.join(imagesDir, firstCandidate))
  }
  catch {
    return firstCandidate
  }
  return `${slug}-${randomBytes(3).toString(`hex`)}${ext}`
}

export async function generateAndSaveWorkspaceImage(params: {
  bridgeUrl: string
  bridgeToken: string
  workspaceDir: string
  prompt: string
  filename?: string
  size?: string
  abortSignal?: AbortSignal
}): Promise<WorkspaceImageResult> {
  const prompt = params.prompt.trim()
  if (!prompt)
    throw new Error(`prompt is required`)

  const response = await fetch(params.bridgeUrl, {
    method: `POST`,
    headers: {
      'Content-Type': `application/json`,
      'Authorization': `Bearer ${params.bridgeToken}`,
    },
    body: JSON.stringify({
      prompt,
      ...(params.size?.trim() ? { size: params.size.trim() } : {}),
    }),
    signal: params.abortSignal,
  })

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }
  catch {
    payload = {}
  }

  if (!response.ok) {
    const errMsg = typeof payload.error === `string` ? payload.error : text.slice(0, 200)
    throw new Error(errMsg || `Image bridge returned HTTP ${response.status}`)
  }

  const base64 = typeof payload.base64 === `string` ? payload.base64 : ``
  if (!base64)
    throw new Error(`Image bridge returned empty image data`)

  const mimeType = typeof payload.mimeType === `string` && payload.mimeType.trim()
    ? payload.mimeType.trim()
    : `image/png`

  const ext = extensionForImageMime(mimeType)
  const slug = sanitizeImageSlug(params.filename, prompt)
  const imagesDir = path.join(params.workspaceDir, `images`)
  await fs.mkdir(imagesDir, { recursive: true })

  const fileName = await resolveUniqueImageFilename(imagesDir, slug, ext)
  const absolutePath = path.join(imagesDir, fileName)
  const bytes = Buffer.from(base64, `base64`)
  await fs.writeFile(absolutePath, bytes)

  return {
    relativePath: `images/${fileName}`,
    absolutePath,
    mimeType,
  }
}
