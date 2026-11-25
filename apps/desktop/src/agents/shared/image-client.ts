import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface WorkspaceImageResult {
  relativePath: string
  absolutePath: string
  mimeType: string
}

export const MAX_WORKSPACE_IMAGE_BYTES = 10 * 1024 * 1024

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

async function ensureConfinedImagesDir(workspaceDir: string): Promise<string> {
  const workspaceReal = await fs.realpath(workspaceDir)
  const candidateImagesDir = path.join(workspaceReal, `images`)
  const existingStat = await fs.lstat(candidateImagesDir).catch(() => null)
  if (existingStat?.isSymbolicLink())
    throw new Error(`Refusing to write to symlinked workspace images directory`)

  await fs.mkdir(candidateImagesDir, { recursive: true })
  const imagesReal = await fs.realpath(candidateImagesDir)
  if (!imagesReal.startsWith(`${workspaceReal}${path.sep}`))
    throw new Error(`Workspace images directory resolved outside workspace`)
  return imagesReal
}

async function writeUniqueImageFile(
  imagesDir: string,
  slug: string,
  ext: string,
  bytes: Buffer,
): Promise<{ fileName: string, absolutePath: string }> {
  const candidates: string[] = [`${slug}${ext}`]
  for (let i = 2; i <= 20; i++)
    candidates.push(`${slug}-${i}${ext}`)
  candidates.push(`${slug}-${randomBytes(4).toString(`hex`)}${ext}`)

  for (const fileName of candidates) {
    const absolutePath = path.join(imagesDir, fileName)
    try {
      await fs.writeFile(absolutePath, bytes, { flag: `wx` })
      return { fileName, absolutePath }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === `EEXIST`)
        continue
      throw error
    }
  }
  throw new Error(`Failed to allocate unique image filename under images/`)
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

  // Verify workspace confinement upfront so a tampered workspace fails before spending API quota.
  const imagesDir = await ensureConfinedImagesDir(params.workspaceDir)

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

  const bytes = Buffer.from(base64, `base64`)
  if (bytes.byteLength === 0)
    throw new Error(`Image bridge returned empty image bytes`)
  if (bytes.byteLength > MAX_WORKSPACE_IMAGE_BYTES)
    throw new Error(`Generated image exceeds maximum size of 10 MB`)

  const mimeType = typeof payload.mimeType === `string` && payload.mimeType.trim()
    ? payload.mimeType.trim()
    : `image/png`

  const ext = extensionForImageMime(mimeType)
  const slug = sanitizeImageSlug(params.filename, prompt)
  // Re-check confinement immediately before atomic exclusive write in case the workspace mutated mid-request.
  const verifiedImagesDir = await ensureConfinedImagesDir(params.workspaceDir)
  const { fileName, absolutePath } = await writeUniqueImageFile(
    verifiedImagesDir || imagesDir,
    slug,
    ext,
    bytes,
  )

  return {
    relativePath: `images/${fileName}`,
    absolutePath,
    mimeType,
  }
}
