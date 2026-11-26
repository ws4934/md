import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

export interface WorkspaceImageResult {
  relativePath: string
  absolutePath: string
  mimeType: string
}

export type ReferenceImageMediaType = `image/png` | `image/jpeg` | `image/webp`

export interface ReferenceImagePayload {
  base64: string
  mediaType: ReferenceImageMediaType
}

export interface GenerateAndSaveWorkspaceImageParams {
  bridgeUrl: string
  bridgeToken: string
  workspaceDir: string
  prompt: string
  filename?: string
  size?: string
  referenceImages?: string[]
  abortSignal?: AbortSignal
}

export const MAX_WORKSPACE_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_REFERENCE_IMAGES = 4
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024

const DEFAULT_BRIDGE_TIMEOUT_MS = 130_000
const MAX_BRIDGE_RESPONSE_BYTES = Math.ceil(MAX_WORKSPACE_IMAGE_BYTES / 3) * 4 + 64 * 1024
const CASE_INSENSITIVE_FS = process.platform === `darwin` || process.platform === `win32`

const MIME_TO_EXT: Record<string, string> = {
  'image/png': `.png`,
  'image/jpeg': `.jpg`,
  'image/jpg': `.jpg`,
  'image/webp': `.webp`,
  'image/gif': `.gif`,
}

const REFERENCE_EXT_TO_MIME: Record<string, ReferenceImageMediaType> = {
  '.png': `image/png`,
  '.jpg': `image/jpeg`,
  '.jpeg': `image/jpeg`,
  '.webp': `image/webp`,
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

function isWithinDirectory(parentReal: string, targetReal: string): boolean {
  const normParent = CASE_INSENSITIVE_FS ? parentReal.toLowerCase() : parentReal
  const normTarget = CASE_INSENSITIVE_FS ? targetReal.toLowerCase() : targetReal
  const prefix = normParent.endsWith(path.sep) ? normParent : `${normParent}${path.sep}`
  return normTarget !== normParent && normTarget.startsWith(prefix)
}

async function ensureConfinedImagesDir(workspaceDir: string): Promise<string> {
  const workspaceReal = await fs.realpath(workspaceDir)
  const candidateImagesDir = path.join(workspaceReal, `images`)
  const existingStat = await fs.lstat(candidateImagesDir).catch(() => null)
  if (existingStat?.isSymbolicLink())
    throw new Error(`Refusing to write to symlinked workspace images directory`)

  await fs.mkdir(candidateImagesDir, { recursive: true })
  const imagesReal = await fs.realpath(candidateImagesDir)
  if (!isWithinDirectory(workspaceReal, imagesReal))
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

async function readBoundedRegularFile(targetReal: string, maxBytes: number, label: string): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await fs.open(targetReal, flags)
  try {
    const stat = await handle.stat()
    if (!stat.isFile())
      throw new Error(`Reference image "${label}" is not a regular file`)
    if (stat.size === 0)
      throw new Error(`Reference image "${label}" is empty`)
    if (stat.size > maxBytes)
      throw new Error(`Reference image "${label}" exceeds maximum size of 8 MB`)

    const buf = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buf, offset, stat.size - offset, offset)
      if (bytesRead === 0)
        break
      offset += bytesRead
    }
    const probe = Buffer.allocUnsafe(1)
    const { bytesRead: extra } = await handle.read(probe, 0, 1, offset)
    if (extra > 0)
      throw new Error(`Reference image "${label}" exceeds maximum size of 8 MB`)

    const actual = offset === buf.byteLength ? buf : buf.subarray(0, offset)
    if (actual.byteLength === 0)
      throw new Error(`Reference image "${label}" is empty`)
    return actual
  }
  finally {
    await handle.close()
  }
}

async function loadReferenceImages(
  workspaceDir: string,
  referenceImages: string[],
): Promise<ReferenceImagePayload[]> {
  if (referenceImages.length > MAX_REFERENCE_IMAGES)
    throw new Error(`At most ${MAX_REFERENCE_IMAGES} reference images are allowed`)

  const workspaceReal = await fs.realpath(workspaceDir)
  const payloads: ReferenceImagePayload[] = []

  for (const rawRef of referenceImages) {
    if (typeof rawRef !== `string` || !rawRef.trim())
      throw new Error(`Reference image path must be a non-empty string`)
    const refPath = rawRef.trim()
    if (refPath.includes(`\0`))
      throw new Error(`Invalid reference image path: ${refPath}`)
    if (path.isAbsolute(refPath) || path.win32.isAbsolute(refPath))
      throw new Error(`Reference image path must be workspace-relative: ${refPath}`)
    if (refPath.split(/[\\/]/).includes(`..`))
      throw new Error(`Reference image path must not contain "..": ${refPath}`)

    const requestedExt = path.extname(refPath).toLowerCase()
    if (!REFERENCE_EXT_TO_MIME[requestedExt])
      throw new Error(`Unsupported reference image extension for "${refPath}" (allowed: png, jpg, jpeg, webp)`)

    const candidatePath = path.resolve(workspaceReal, refPath)
    if (!isWithinDirectory(workspaceReal, candidatePath))
      throw new Error(`Reference image "${refPath}" resolves outside workspace`)

    let targetReal: string
    try {
      targetReal = await fs.realpath(candidatePath)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === `ENOENT`)
        throw new Error(`Reference image not found: ${refPath}`)
      throw new Error(`Failed to resolve reference image "${refPath}": ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!isWithinDirectory(workspaceReal, targetReal))
      throw new Error(`Reference image "${refPath}" resolves outside workspace`)

    // Re-check extension after realpath so an in-workspace symlink cannot target a non-image file.
    const realExt = path.extname(targetReal).toLowerCase()
    const mediaType = REFERENCE_EXT_TO_MIME[realExt]
    if (!mediaType)
      throw new Error(`Reference image "${refPath}" resolves to an unsupported file type (allowed: png, jpg, jpeg, webp)`)

    const bytes = await readBoundedRegularFile(targetReal, MAX_REFERENCE_IMAGE_BYTES, refPath)

    payloads.push({
      base64: bytes.toString(`base64`),
      mediaType,
    })
  }

  return payloads
}

export async function generateAndSaveWorkspaceImage(
  params: GenerateAndSaveWorkspaceImageParams,
): Promise<WorkspaceImageResult> {
  const prompt = params.prompt.trim()
  if (!prompt)
    throw new Error(`prompt is required`)

  if (params.referenceImages !== undefined && !Array.isArray(params.referenceImages))
    throw new Error(`referenceImages must be an array of workspace-relative image paths`)

  const referencePayloads = params.referenceImages?.length
    ? await loadReferenceImages(params.workspaceDir, params.referenceImages)
    : []

  // Verify workspace confinement upfront so a tampered workspace fails before spending API quota.
  await ensureConfinedImagesDir(params.workspaceDir)

  const timeoutSignal = AbortSignal.timeout(DEFAULT_BRIDGE_TIMEOUT_MS)
  const signal = params.abortSignal
    ? AbortSignal.any([timeoutSignal, params.abortSignal])
    : timeoutSignal

  const response = await fetch(params.bridgeUrl, {
    method: `POST`,
    headers: {
      'Content-Type': `application/json`,
      'Authorization': `Bearer ${params.bridgeToken}`,
    },
    body: JSON.stringify({
      prompt,
      ...(params.size?.trim() ? { size: params.size.trim() } : {}),
      ...(referencePayloads.length > 0 ? { referenceImages: referencePayloads } : {}),
    }),
    signal,
  })

  const declaredLength = Number(response.headers.get(`content-length`))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BRIDGE_RESPONSE_BYTES)
    throw new Error(`Generated image exceeds maximum size of 10 MB`)

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
    verifiedImagesDir,
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
