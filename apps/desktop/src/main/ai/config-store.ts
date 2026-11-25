import type {
  DesktopAiConfigs,
  DesktopAiProtocol,
  DesktopImageGenConfig,
  DesktopImageGenConfigUpdate,
  DesktopModelApiConfig,
  DesktopModelApiConfigUpdate,
} from '@md/shared/types'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PROTOCOL_BASE_URLS } from '@md/shared/types'
import { isValidHttpBaseUrl, validateHttpBaseUrl } from './sanitize'

export interface SecretCipher {
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

interface StoredSecret {
  encoding: `safeStorage` | `plain`
  value: string
}

interface StoredModelApiRecord {
  protocol: DesktopAiProtocol
  providerPreset: string
  baseUrl: string
  apiKey?: StoredSecret | null
  enabledModels: string[]
  availableModels: string[]
  defaultModel: string
}

interface StoredImageGenRecord {
  providerPreset: string
  baseUrl: string
  apiKey?: StoredSecret | null
  model: string
  size: string
  quality: string
}

interface StoredAiConfigFile {
  version: 1
  modelApi: StoredModelApiRecord
  imageGen: StoredImageGenRecord
}

export interface ResolvedModelApiConfig extends DesktopModelApiConfig {
  apiKey: string
  isConfigured: boolean
}

export interface ResolvedImageGenConfig extends DesktopImageGenConfig {
  apiKey: string
  isConfigured: boolean
}

export interface AiConfigStoreOptions {
  configPath: string
  cipher?: SecretCipher
  onChange?: (scope: `modelApi` | `imageGen`) => void
}

const VALID_PROTOCOLS = new Set<DesktopAiProtocol>([`openai-compatible`, `anthropic`, `google`])

function createDefaultModelApiRecord(): StoredModelApiRecord {
  return {
    protocol: `openai-compatible`,
    providerPreset: `openai`,
    baseUrl: DEFAULT_PROTOCOL_BASE_URLS[`openai-compatible`],
    apiKey: null,
    enabledModels: [],
    availableModels: [],
    defaultModel: ``,
  }
}

function createDefaultImageGenRecord(): StoredImageGenRecord {
  return {
    providerPreset: `openai`,
    baseUrl: `https://api.openai.com/v1`,
    apiKey: null,
    model: `gpt-image-1`,
    size: `1024x1024`,
    quality: `auto`,
  }
}

function normalizeBaseUrl(raw: string, fallback: string): string {
  const trimmed = raw.trim().replace(/\/+$/, ``)
  if (!trimmed)
    return fallback
  return isValidHttpBaseUrl(trimmed) ? trimmed : fallback
}

function normalizeModelList(list: unknown): string[] {
  if (!Array.isArray(list))
    return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of list) {
    if (typeof item !== `string`)
      continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed))
      continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === `object`
    && value !== null
    && (`encoding` in value)
    && (`value` in value)
    && ((value as { encoding: unknown }).encoding === `safeStorage` || (value as { encoding: unknown }).encoding === `plain`)
    && typeof (value as { value: unknown }).value === `string`
  )
}

export class AiConfigStore {
  private readonly configPath: string
  private readonly cipher?: SecretCipher
  private readonly onChange?: (scope: `modelApi` | `imageGen`) => void

  private data: StoredAiConfigFile = {
    version: 1,
    modelApi: createDefaultModelApiRecord(),
    imageGen: createDefaultImageGenRecord(),
  }

  private loaded = false
  private loadPromise: Promise<void> | null = null
  private persistChain: Promise<void> = Promise.resolve()

  constructor(options: AiConfigStoreOptions) {
    this.configPath = options.configPath
    this.cipher = options.cipher
    this.onChange = options.onChange
  }

  private encryptSecret(plainText: string): StoredSecret | null {
    const trimmed = plainText.trim()
    if (!trimmed)
      return null

    if (this.cipher?.isEncryptionAvailable()) {
      const encrypted = this.cipher.encryptString(trimmed)
      return {
        encoding: `safeStorage`,
        value: encrypted.toString(`base64`),
      }
    }

    return {
      encoding: `plain`,
      value: trimmed,
    }
  }

  private decryptSecret(secret: StoredSecret | null | undefined): string {
    if (!secret || !secret.value)
      return ``
    if (secret.encoding === `plain`)
      return secret.value
    if (!this.cipher?.isEncryptionAvailable())
      return ``
    try {
      return this.cipher.decryptString(Buffer.from(secret.value, `base64`))
    }
    catch {
      return ``
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded)
      return
    this.loadPromise ??= (async () => {
      try {
        const raw = await fs.readFile(this.configPath, `utf8`)
        const parsed = JSON.parse(raw) as Partial<StoredAiConfigFile>
        const rawModel = parsed.modelApi
        const protocol: DesktopAiProtocol = rawModel?.protocol && VALID_PROTOCOLS.has(rawModel.protocol)
          ? rawModel.protocol
          : `openai-compatible`
        const enabledModels = normalizeModelList(rawModel?.enabledModels)
        const availableModels = normalizeModelList(rawModel?.availableModels)
        const rawDefaultModel = typeof rawModel?.defaultModel === `string` ? rawModel.defaultModel.trim() : ``
        const defaultModel = rawDefaultModel && enabledModels.includes(rawDefaultModel)
          ? rawDefaultModel
          : (enabledModels[0] ?? ``)

        const rawImage = parsed.imageGen
        this.data = {
          version: 1,
          modelApi: {
            protocol,
            providerPreset: typeof rawModel?.providerPreset === `string` && rawModel.providerPreset.trim()
              ? rawModel.providerPreset.trim()
              : (protocol === `openai-compatible` ? `openai` : protocol),
            baseUrl: typeof rawModel?.baseUrl === `string`
              ? normalizeBaseUrl(rawModel.baseUrl, DEFAULT_PROTOCOL_BASE_URLS[protocol])
              : DEFAULT_PROTOCOL_BASE_URLS[protocol],
            apiKey: isStoredSecret(rawModel?.apiKey) ? rawModel.apiKey : null,
            enabledModels,
            availableModels: availableModels.length > 0 ? availableModels : [...enabledModels],
            defaultModel,
          },
          imageGen: {
            providerPreset: typeof rawImage?.providerPreset === `string` && rawImage.providerPreset.trim()
              ? rawImage.providerPreset.trim()
              : `openai`,
            baseUrl: typeof rawImage?.baseUrl === `string`
              ? normalizeBaseUrl(rawImage.baseUrl, `https://api.openai.com/v1`)
              : `https://api.openai.com/v1`,
            apiKey: isStoredSecret(rawImage?.apiKey) ? rawImage.apiKey : null,
            model: typeof rawImage?.model === `string` ? rawImage.model.trim() : `gpt-image-1`,
            size: typeof rawImage?.size === `string` && rawImage.size.trim() ? rawImage.size.trim() : `1024x1024`,
            quality: typeof rawImage?.quality === `string` && rawImage.quality.trim() ? rawImage.quality.trim() : `auto`,
          },
        }
      }
      catch {
        this.data = {
          version: 1,
          modelApi: createDefaultModelApiRecord(),
          imageGen: createDefaultImageGenRecord(),
        }
      }
      finally {
        this.loaded = true
      }
    })()
    await this.loadPromise
  }

  private async writeAtomic(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`
    await fs.mkdir(path.dirname(this.configPath), { recursive: true })
    const tmpPath = `${this.configPath}.${randomUUID()}.tmp`
    await fs.writeFile(tmpPath, snapshot, { encoding: `utf8`, mode: 0o600 })
    await fs.rename(tmpPath, this.configPath)
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain.catch(() => undefined).then(() => this.writeAtomic())
    return this.persistChain
  }

  private toPublicModelApi(): DesktopModelApiConfig {
    const rec = this.data.modelApi
    const hasApiKey = Boolean(this.decryptSecret(rec.apiKey).trim())
    return {
      protocol: rec.protocol,
      providerPreset: rec.providerPreset,
      baseUrl: rec.baseUrl,
      hasApiKey,
      enabledModels: [...rec.enabledModels],
      availableModels: [...rec.availableModels],
      defaultModel: rec.defaultModel,
    }
  }

  private toPublicImageGen(): DesktopImageGenConfig {
    const rec = this.data.imageGen
    const hasApiKey = Boolean(this.decryptSecret(rec.apiKey).trim())
    return {
      providerPreset: rec.providerPreset,
      baseUrl: rec.baseUrl,
      hasApiKey,
      model: rec.model,
      size: rec.size,
      quality: rec.quality,
    }
  }

  async getPublicConfigs(): Promise<DesktopAiConfigs> {
    await this.ensureLoaded()
    return {
      modelApi: this.toPublicModelApi(),
      imageGen: this.toPublicImageGen(),
    }
  }

  async getResolvedModelApiConfig(): Promise<ResolvedModelApiConfig> {
    await this.ensureLoaded()
    const pub = this.toPublicModelApi()
    const apiKey = this.decryptSecret(this.data.modelApi.apiKey).trim()
    const effectiveBaseUrl = pub.baseUrl.trim() || DEFAULT_PROTOCOL_BASE_URLS[pub.protocol]
    const isConfigured = Boolean(apiKey && effectiveBaseUrl && pub.enabledModels.length > 0)
    return {
      ...pub,
      baseUrl: effectiveBaseUrl,
      apiKey,
      isConfigured,
    }
  }

  async getResolvedImageGenConfig(): Promise<ResolvedImageGenConfig> {
    await this.ensureLoaded()
    const pub = this.toPublicImageGen()
    const apiKey = this.decryptSecret(this.data.imageGen.apiKey).trim()
    const isConfigured = Boolean(apiKey && pub.baseUrl.trim() && pub.model.trim())
    return {
      ...pub,
      apiKey,
      isConfigured,
    }
  }

  async isModelApiConfigured(): Promise<boolean> {
    const resolved = await this.getResolvedModelApiConfig()
    return resolved.isConfigured
  }

  async isImageGenConfigured(): Promise<boolean> {
    const resolved = await this.getResolvedImageGenConfig()
    return resolved.isConfigured
  }

  async updateModelApiConfig(patch: DesktopModelApiConfigUpdate): Promise<DesktopModelApiConfig> {
    await this.ensureLoaded()
    const prev = this.data.modelApi

    const nextProtocol: DesktopAiProtocol = patch.protocol && VALID_PROTOCOLS.has(patch.protocol)
      ? patch.protocol
      : prev.protocol

    const nextBaseUrl = patch.baseUrl !== undefined
      ? (patch.baseUrl.trim()
          ? validateHttpBaseUrl(patch.baseUrl)
          : DEFAULT_PROTOCOL_BASE_URLS[nextProtocol])
      : prev.baseUrl

    const nextPreset = patch.providerPreset !== undefined
      ? patch.providerPreset.trim() || (nextProtocol === `openai-compatible` ? `custom` : nextProtocol)
      : prev.providerPreset

    const nextApiKey = patch.apiKey !== undefined
      ? this.encryptSecret(patch.apiKey)
      : prev.apiKey

    const nextEnabled = patch.enabledModels !== undefined
      ? normalizeModelList(patch.enabledModels)
      : [...prev.enabledModels]

    const nextAvailable = patch.availableModels !== undefined
      ? normalizeModelList([...patch.availableModels, ...nextEnabled])
      : normalizeModelList([...prev.availableModels, ...nextEnabled])

    const requestedDefault = patch.defaultModel !== undefined
      ? patch.defaultModel.trim()
      : prev.defaultModel

    const nextDefault = requestedDefault && nextEnabled.includes(requestedDefault)
      ? requestedDefault
      : (nextEnabled[0] ?? ``)

    this.data.modelApi = {
      protocol: nextProtocol,
      providerPreset: nextPreset,
      baseUrl: nextBaseUrl,
      apiKey: nextApiKey,
      enabledModels: nextEnabled,
      availableModels: nextAvailable,
      defaultModel: nextDefault,
    }

    await this.persist()
    this.onChange?.(`modelApi`)
    return this.toPublicModelApi()
  }

  async updateImageGenConfig(patch: DesktopImageGenConfigUpdate): Promise<DesktopImageGenConfig> {
    await this.ensureLoaded()
    const prev = this.data.imageGen

    const nextPreset = patch.providerPreset !== undefined
      ? patch.providerPreset.trim() || `custom`
      : prev.providerPreset

    const nextBaseUrl = patch.baseUrl !== undefined
      ? (patch.baseUrl.trim() ? validateHttpBaseUrl(patch.baseUrl) : ``)
      : prev.baseUrl

    const nextApiKey = patch.apiKey !== undefined
      ? this.encryptSecret(patch.apiKey)
      : prev.apiKey

    const nextModel = patch.model !== undefined
      ? patch.model.trim()
      : prev.model

    const nextSize = patch.size !== undefined
      ? patch.size.trim() || `1024x1024`
      : prev.size

    const nextQuality = patch.quality !== undefined
      ? patch.quality.trim() || `auto`
      : prev.quality

    this.data.imageGen = {
      providerPreset: nextPreset,
      baseUrl: nextBaseUrl,
      apiKey: nextApiKey,
      model: nextModel,
      size: nextSize,
      quality: nextQuality,
    }

    await this.persist()
    this.onChange?.(`imageGen`)
    return this.toPublicImageGen()
  }
}
