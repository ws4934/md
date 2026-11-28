import type {
  DesktopAiConfigs,
  DesktopAiProtocol,
  DesktopImageGenConfig,
  DesktopImageGenConfigUpdate,
  DesktopModelApiConfig,
  DesktopModelApiConfigUpdate,
  DesktopWebSearchConfig,
  DesktopWebSearchConfigUpdate,
  DesktopWebSearchProtocol,
  DesktopWebSearchProvider,
} from '@md/shared/types'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PROTOCOL_BASE_URLS, DESKTOP_WEB_SEARCH_PROTOCOLS, MAX_WEB_SEARCH_PROVIDERS } from '@md/shared/types'
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

interface StoredWebSearchProviderRecord {
  id: string
  name: string
  enabled: boolean
  protocol: DesktopWebSearchProtocol
  baseUrl: string
  apiKey?: StoredSecret | null
  model: string
}

interface StoredWebSearchRecord {
  enabled: boolean
  providers: StoredWebSearchProviderRecord[]
}

interface StoredAiConfigFile {
  version: 1
  modelApi: StoredModelApiRecord
  imageGen: StoredImageGenRecord
  webSearch: StoredWebSearchRecord
}

export interface ResolvedModelApiConfig extends DesktopModelApiConfig {
  apiKey: string
  isConfigured: boolean
}

export interface ResolvedImageGenConfig extends DesktopImageGenConfig {
  apiKey: string
  isConfigured: boolean
}

export interface ResolvedWebSearchProvider extends DesktopWebSearchProvider {
  apiKey: string
  /** Enabled with base URL, key, and model. */
  isUsable: boolean
}

export interface ResolvedWebSearchConfig {
  enabled: boolean
  providers: ResolvedWebSearchProvider[]
  isConfigured: boolean
}

export type AiConfigScope = `modelApi` | `imageGen` | `webSearch`

export interface AiConfigStoreOptions {
  configPath: string
  cipher?: SecretCipher
  onChange?: (scope: AiConfigScope) => void
}

const VALID_PROTOCOLS = new Set<DesktopAiProtocol>([`openai-compatible`, `anthropic`, `google`])
const VALID_WEB_SEARCH_PROTOCOLS = new Set<string>(DESKTOP_WEB_SEARCH_PROTOCOLS)
const DEFAULT_WEB_SEARCH_MODEL = `gpt-5-mini`
/** Id given to the provider migrated from the single-provider config, so it stays stable across restarts. */
const LEGACY_WEB_SEARCH_PROVIDER_ID = `default`

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

function createDefaultWebSearchRecord(): StoredWebSearchRecord {
  return { enabled: false, providers: [] }
}

function parseStoredWebSearchProvider(raw: Record<string, unknown> | undefined, id: string, enabled: boolean): StoredWebSearchProviderRecord {
  return {
    id,
    name: typeof raw?.name === `string` ? raw.name.trim() : ``,
    enabled,
    protocol: VALID_WEB_SEARCH_PROTOCOLS.has(raw?.protocol as string) ? raw!.protocol as DesktopWebSearchProtocol : `openai-responses`,
    // An invalid stored URL becomes empty rather than a default host, so a saved key is never sent elsewhere.
    baseUrl: typeof raw?.baseUrl === `string` ? normalizeBaseUrl(raw.baseUrl, ``) : ``,
    apiKey: isStoredSecret(raw?.apiKey) ? raw.apiKey : null,
    model: typeof raw?.model === `string` ? raw.model.trim() : DEFAULT_WEB_SEARCH_MODEL,
  }
}

function parseStoredWebSearch(raw: unknown): StoredWebSearchRecord {
  const rec = typeof raw === `object` && raw !== null ? raw as Record<string, unknown> : undefined
  if (!rec)
    return createDefaultWebSearchRecord()
  const enabled = rec.enabled === true
  // Single-provider shape: { enabled, protocol, baseUrl, apiKey, model }.
  if (!Array.isArray(rec.providers)) {
    const isLegacy = [`baseUrl`, `apiKey`, `model`].some(key => key in rec)
    return {
      enabled,
      providers: isLegacy ? [parseStoredWebSearchProvider(rec, LEGACY_WEB_SEARCH_PROVIDER_ID, true)] : [],
    }
  }
  const seenIds = new Set<string>()
  const providers: StoredWebSearchProviderRecord[] = []
  for (const item of rec.providers) {
    if (typeof item !== `object` || item === null || providers.length >= MAX_WEB_SEARCH_PROVIDERS)
      continue
    const p = item as Record<string, unknown>
    const rawId = typeof p.id === `string` ? p.id.trim() : ``
    const id = rawId && !seenIds.has(rawId) ? rawId : randomUUID()
    seenIds.add(id)
    providers.push(parseStoredWebSearchProvider(p, id, p.enabled !== false))
  }
  return { enabled, providers }
}

function normalizeBaseUrl(raw: string, fallback: string): string {
  const trimmed = raw.trim().replace(/\/+$/, ``)
  if (!trimmed)
    return fallback
  return isValidHttpBaseUrl(trimmed) ? trimmed : fallback
}

function parseHttpOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed)
    return null
  try {
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== `http:` && parsed.protocol !== `https:`) || !parsed.hostname)
      return null
    return parsed.origin
  }
  catch {
    return null
  }
}

function hasBaseUrlOriginChanged(prevBaseUrl: string, nextBaseUrl: string): boolean {
  if (prevBaseUrl === nextBaseUrl)
    return false
  const prevOrigin = parseHttpOrigin(prevBaseUrl)
  const nextOrigin = parseHttpOrigin(nextBaseUrl)
  return !prevOrigin || !nextOrigin || prevOrigin !== nextOrigin
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
  private readonly onChange?: (scope: AiConfigScope) => void

  private data: StoredAiConfigFile = {
    version: 1,
    modelApi: createDefaultModelApiRecord(),
    imageGen: createDefaultImageGenRecord(),
    webSearch: createDefaultWebSearchRecord(),
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
          webSearch: parseStoredWebSearch(parsed.webSearch),
        }
      }
      catch {
        this.data = {
          version: 1,
          modelApi: createDefaultModelApiRecord(),
          imageGen: createDefaultImageGenRecord(),
          webSearch: createDefaultWebSearchRecord(),
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
    try {
      await fs.writeFile(tmpPath, snapshot, { encoding: `utf8`, mode: 0o600 })
      await fs.rename(tmpPath, this.configPath)
    }
    catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined)
      throw error
    }
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

  private toPublicWebSearch(): DesktopWebSearchConfig {
    const rec = this.data.webSearch
    return {
      enabled: rec.enabled,
      providers: rec.providers.map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        hasApiKey: Boolean(this.decryptSecret(p.apiKey).trim()),
        model: p.model,
      })),
    }
  }

  async getPublicConfigs(): Promise<DesktopAiConfigs> {
    await this.ensureLoaded()
    return {
      modelApi: this.toPublicModelApi(),
      imageGen: this.toPublicImageGen(),
      webSearch: this.toPublicWebSearch(),
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

  async getResolvedWebSearchConfig(): Promise<ResolvedWebSearchConfig> {
    await this.ensureLoaded()
    const pub = this.toPublicWebSearch()
    const providers = pub.providers.map((p, i) => {
      const apiKey = this.decryptSecret(this.data.webSearch.providers[i].apiKey).trim()
      return { ...p, apiKey, isUsable: Boolean(p.enabled && apiKey && p.baseUrl.trim() && p.model.trim()) }
    })
    return {
      enabled: pub.enabled,
      providers,
      isConfigured: pub.enabled && providers.some(p => p.isUsable),
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

  async isWebSearchConfigured(): Promise<boolean> {
    const resolved = await this.getResolvedWebSearchConfig()
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

    const prevEffectiveBaseUrl = prev.baseUrl.trim() || DEFAULT_PROTOCOL_BASE_URLS[prev.protocol]
    // Clear the saved key when switching to a different origin without supplying a new key.
    const nextApiKey = patch.apiKey !== undefined
      ? this.encryptSecret(patch.apiKey)
      : (hasBaseUrlOriginChanged(prevEffectiveBaseUrl, nextBaseUrl) ? null : prev.apiKey)

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

    // Clear the saved key when switching to a different origin without supplying a new key.
    const nextApiKey = patch.apiKey !== undefined
      ? this.encryptSecret(patch.apiKey)
      : (hasBaseUrlOriginChanged(prev.baseUrl, nextBaseUrl) ? null : prev.apiKey)

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

  async updateWebSearchConfig(update: DesktopWebSearchConfigUpdate): Promise<DesktopWebSearchConfig> {
    await this.ensureLoaded()
    const prevById = new Map(this.data.webSearch.providers.map(p => [p.id, p]))
    const usedIds = new Set<string>()

    const providers = update.providers.map((p): StoredWebSearchProviderRecord => {
      const prev = p.id && !usedIds.has(p.id) ? prevById.get(p.id) : undefined
      const id = prev?.id ?? randomUUID()
      usedIds.add(id)
      const baseUrl = p.baseUrl.trim() ? validateHttpBaseUrl(p.baseUrl) : ``
      // Clear the saved key when switching to a different origin without supplying a new key.
      const apiKey = p.apiKey !== undefined
        ? this.encryptSecret(p.apiKey)
        : (prev && !hasBaseUrlOriginChanged(prev.baseUrl, baseUrl) ? prev.apiKey : null)
      return {
        id,
        name: p.name.trim(),
        enabled: p.enabled,
        protocol: VALID_WEB_SEARCH_PROTOCOLS.has(p.protocol) ? p.protocol : `openai-responses`,
        baseUrl,
        apiKey,
        model: p.model.trim(),
      }
    })

    this.data.webSearch = {
      enabled: update.enabled,
      providers: providers.slice(0, MAX_WEB_SEARCH_PROVIDERS),
    }

    await this.persist()
    this.onChange?.(`webSearch`)
    return this.toPublicWebSearch()
  }
}
