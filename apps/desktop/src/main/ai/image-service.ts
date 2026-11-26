import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateImage } from 'ai'
import { redactSecret, validateHttpBaseUrl } from './sanitize'

export interface GenerateDesktopImageParams {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  size?: string
  quality?: string
  referenceImages?: Uint8Array[]
  abortSignal?: AbortSignal
  timeoutMs?: number
}

export interface GeneratedDesktopImage {
  bytes: Uint8Array
  base64: string
  mimeType: string
}

const IMAGE_SIZE_RE = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/
const DEFAULT_IMAGE_TIMEOUT_MS = 120_000

export async function generateDesktopImage(
  params: GenerateDesktopImageParams,
): Promise<GeneratedDesktopImage> {
  const rawBaseUrl = params.baseUrl.trim()
  const apiKey = params.apiKey.trim()
  const modelId = params.model.trim()
  const prompt = params.prompt.trim()

  if (!rawBaseUrl || !apiKey || !modelId)
    throw new Error(`Image generation is not fully configured (baseUrl, apiKey, and model are required)`)
  if (!prompt)
    throw new Error(`Image prompt is required`)

  const baseURL = validateHttpBaseUrl(rawBaseUrl)
  const provider = createOpenAICompatible({
    name: `openai-compatible`,
    baseURL,
    apiKey,
  })

  const rawSize = params.size?.trim()
  const size = rawSize && IMAGE_SIZE_RE.test(rawSize)
    ? (rawSize as `${number}x${number}`)
    : undefined

  const quality = params.quality?.trim()
  const providerOptions = quality && quality.toLowerCase() !== `auto`
    ? { openaiCompatible: { quality } }
    : undefined

  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS)
  const abortSignal = params.abortSignal
    ? AbortSignal.any([timeoutSignal, params.abortSignal])
    : timeoutSignal

  const referenceImages = params.referenceImages?.length ? params.referenceImages : undefined
  const imagePrompt = referenceImages
    ? { text: prompt, images: referenceImages }
    : prompt

  try {
    const result = await generateImage({
      model: provider.imageModel(modelId),
      prompt: imagePrompt,
      size,
      providerOptions,
      abortSignal,
    })

    const image = result.image
    return {
      bytes: image.uint8Array,
      base64: image.base64,
      mimeType: image.mediaType || `image/png`,
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(redactSecret(message, apiKey))
    if (error instanceof Error && error.name)
      wrapped.name = error.name
    throw wrapped
  }
}
