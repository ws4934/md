export const API_MODEL_AGENT_ID = `api-model`

export type DesktopAiProtocol = `openai-compatible` | `anthropic` | `google`

export const DEFAULT_PROTOCOL_BASE_URLS: Record<DesktopAiProtocol, string> = {
  'openai-compatible': `https://api.openai.com/v1`,
  'anthropic': `https://api.anthropic.com/v1`,
  'google': `https://generativelanguage.googleapis.com/v1beta`,
}

export const DEFAULT_IMAGE_GEN_SIZES = [
  `1024x1024`,
  `1536x1024`,
  `1024x1536`,
  `1792x1024`,
  `1024x1792`,
  `512x512`,
] as const

export const DEFAULT_IMAGE_GEN_QUALITIES = [
  `auto`,
  `standard`,
  `hd`,
  `low`,
  `medium`,
  `high`,
] as const

export interface DesktopModelApiConfig {
  protocol: DesktopAiProtocol
  providerPreset: string
  baseUrl: string
  /** Renderer never receives raw API keys; only whether one is saved in the main process. */
  hasApiKey: boolean
  enabledModels: string[]
  availableModels: string[]
  defaultModel: string
}

export interface DesktopModelApiConfigUpdate {
  protocol?: DesktopAiProtocol
  providerPreset?: string
  baseUrl?: string
  /** Non-empty sets/replaces the key, empty string clears it, undefined keeps the existing key. */
  apiKey?: string
  enabledModels?: string[]
  availableModels?: string[]
  defaultModel?: string
}

export interface DesktopImageGenConfig {
  providerPreset: string
  baseUrl: string
  /** Renderer never receives raw API keys; only whether one is saved in the main process. */
  hasApiKey: boolean
  model: string
  size: string
  quality: string
}

export interface DesktopImageGenConfigUpdate {
  providerPreset?: string
  baseUrl?: string
  /** Non-empty sets/replaces the key, empty string clears it, undefined keeps the existing key. */
  apiKey?: string
  model?: string
  size?: string
  quality?: string
}

export interface DesktopAiConfigs {
  modelApi: DesktopModelApiConfig
  imageGen: DesktopImageGenConfig
}

export interface DesktopRemoteModelInfo {
  id: string
  name?: string
}

export interface DesktopListRemoteModelsParams {
  protocol: DesktopAiProtocol
  baseUrl: string
  /** Optional unsaved key from the form; when omitted, main uses the saved key. */
  apiKey?: string
}

export interface DesktopListRemoteModelsResult {
  ok: boolean
  models: DesktopRemoteModelInfo[]
  error?: string
}

export interface DesktopTestImageGenParams {
  prompt?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  size?: string
  quality?: string
}

export interface DesktopTestImageGenResult {
  ok: boolean
  dataUrl?: string
  mimeType?: string
  error?: string
}

export interface DesktopAiApi {
  getConfigs: () => Promise<DesktopAiConfigs>
  updateModelApiConfig: (patch: DesktopModelApiConfigUpdate) => Promise<DesktopModelApiConfig>
  updateImageGenConfig: (patch: DesktopImageGenConfigUpdate) => Promise<DesktopImageGenConfig>
  listRemoteModels: (params: DesktopListRemoteModelsParams) => Promise<DesktopListRemoteModelsResult>
  testImageGen: (params?: DesktopTestImageGenParams) => Promise<DesktopTestImageGenResult>
}
