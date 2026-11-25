import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateImage } from 'ai'

export interface GenerateDesktopImageParams {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  size?: string
  quality?: string
  abortSignal?: AbortSignal
}

export interface GeneratedDesktopImage {
  bytes: Uint8Array
  base64: string
  mimeType: string
}

const IMAGE_SIZE_RE = /^\d+x\d+$/

export async function generateDesktopImage(
  params: GenerateDesktopImageParams,
): Promise<GeneratedDesktopImage> {
  const baseURL = params.baseUrl.trim().replace(/\/+$/, ``)
  const apiKey = params.apiKey.trim()
  const modelId = params.model.trim()
  const prompt = params.prompt.trim()

  if (!baseURL || !apiKey || !modelId)
    throw new Error(`Image generation is not fully configured (baseUrl, apiKey, and model are required)`)
  if (!prompt)
    throw new Error(`Image prompt is required`)

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

  const result = await generateImage({
    model: provider.imageModel(modelId),
    prompt,
    size,
    providerOptions,
    abortSignal: params.abortSignal,
  })

  const image = result.image
  return {
    bytes: image.uint8Array,
    base64: image.base64,
    mimeType: image.mediaType || `image/png`,
  }
}
