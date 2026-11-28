import type {
  AcpCommandOverride,
  AcpPermissionDecision,
  AcpPermissionLevel,
  AcpPromptParams,
  AcpSettings,
  AcpStartSessionParams,
  DesktopAiProtocol,
  DesktopImageGenConfigUpdate,
  DesktopListRemoteModelsParams,
  DesktopModelApiConfigUpdate,
  DesktopTestImageGenParams,
  DesktopTestWebSearchParams,
  DesktopWebSearchConfigUpdate,
  DesktopWebSearchProtocol,
  DesktopWebSearchProviderUpdate,
} from '@md/shared/types'
import { DESKTOP_WEB_SEARCH_PROTOCOLS, MAX_WEB_SEARCH_PROVIDERS } from '@md/shared/types'

const VALID_AI_PROTOCOLS = new Set<DesktopAiProtocol>([`openai-compatible`, `anthropic`, `google`])
const VALID_WEB_SEARCH_PROTOCOLS = new Set<string>(DESKTOP_WEB_SEARCH_PROTOCOLS)
const VALID_PERMISSION_LEVELS = new Set<AcpPermissionLevel>([`ask`, `auto_edits`, `plan`, `bypass`])
const VALID_PERMISSION_DECISIONS = new Set<AcpPermissionDecision>([`allow_once`, `allow_always`, `reject`])
const FORBIDDEN_OBJECT_KEYS = new Set([`__proto__`, `constructor`, `prototype`])

const MAX_ID_CHARS = 128
const MAX_MODEL_ID_CHARS = 256
const MAX_TITLE_CHARS = 512
const MAX_COMMAND_CHARS = 1024
const MAX_URL_CHARS = 2048
const MAX_SECRET_CHARS = 4096
const MAX_PATH_CHARS = 4096
const MAX_PROMPT_TEST_CHARS = 8000
const MAX_SEARCH_TEST_QUERY_CHARS = 1000
const MAX_PROVIDER_NAME_CHARS = 64
const MAX_PROMPT_TEXT_CHARS = 1024 * 1024
const MAX_ARTICLE_CONTENT_CHARS = 10 * 1024 * 1024
const MAX_ARGS_COUNT = 64
const MAX_ATTACHMENTS_COUNT = 32
const MAX_ENV_ENTRIES = 128
const MAX_MODELS_LIST_COUNT = 2000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== `object` || value === null || Array.isArray(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value))
    throw new TypeError(`${label} must be an object`)
  return value
}

function assertString(
  value: unknown,
  label: string,
  options: { minTrimmed?: number, maxLength: number, disallowNullByte?: boolean },
): string {
  if (typeof value !== `string`)
    throw new TypeError(`${label} must be a string`)
  if (value.length > options.maxLength)
    throw new RangeError(`${label} exceeds maximum length of ${options.maxLength}`)
  if (options.disallowNullByte && value.includes(`\0`))
    throw new Error(`${label} must not contain null bytes`)
  if (options.minTrimmed !== undefined && value.trim().length < options.minTrimmed)
    throw new Error(`${label} must not be empty`)
  return value
}

function assertOptionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined)
    return undefined
  return assertString(value, label, { maxLength })
}

function assertOptionalNullableString(
  value: unknown,
  label: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined || value === null)
    return value
  return assertString(value, label, { maxLength })
}

function assertStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number,
  options?: { disallowNullOrNewline?: boolean },
): string[] {
  if (!Array.isArray(value))
    throw new TypeError(`${label} must be an array`)
  if (value.length > maxItems)
    throw new RangeError(`${label} exceeds maximum count of ${maxItems}`)
  return value.map((item, idx) => {
    const str = assertString(item, `${label}[${idx}]`, {
      maxLength: maxItemLength,
      disallowNullByte: options?.disallowNullOrNewline,
    })
    if (options?.disallowNullOrNewline && /[\r\n]/.test(str))
      throw new Error(`${label}[${idx}] must not contain line breaks`)
    return str
  })
}

function assertStringRecord(
  value: unknown,
  label: string,
  maxEntries: number,
  maxKeyLength: number,
  maxValueLength: number,
): Record<string, string> {
  const obj = assertPlainObject(value, label)
  const keys = Object.keys(obj)
  if (keys.length > maxEntries)
    throw new RangeError(`${label} exceeds maximum entry count of ${maxEntries}`)
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (FORBIDDEN_OBJECT_KEYS.has(key))
      continue
    const cleanKey = assertString(key, `${label} key`, { minTrimmed: 1, maxLength: maxKeyLength, disallowNullByte: true })
    out[cleanKey] = assertString(obj[key], `${label}[${cleanKey}]`, { maxLength: maxValueLength, disallowNullByte: true })
  }
  return out
}

export function validateIdArg(value: unknown, label = `id`): string {
  return assertString(value, label, { minTrimmed: 1, maxLength: MAX_ID_CHARS, disallowNullByte: true }).trim()
}

export function validateLocaleArg(value: unknown): string {
  return assertString(value, `locale`, { minTrimmed: 1, maxLength: 32, disallowNullByte: true }).trim()
}

export function validateProbeOptions(value: unknown): { force?: boolean } | undefined {
  if (value === undefined)
    return undefined
  const obj = assertPlainObject(value, `options`)
  if (obj.force !== undefined && typeof obj.force !== `boolean`)
    throw new TypeError(`options.force must be a boolean`)
  return obj.force === undefined ? {} : { force: obj.force }
}

export function validateModelApiConfigUpdate(raw: unknown): DesktopModelApiConfigUpdate {
  const obj = assertPlainObject(raw, `patch`)
  const out: DesktopModelApiConfigUpdate = {}

  if (obj.protocol !== undefined) {
    if (typeof obj.protocol !== `string` || !VALID_AI_PROTOCOLS.has(obj.protocol as DesktopAiProtocol))
      throw new Error(`Invalid AI protocol`)
    out.protocol = obj.protocol as DesktopAiProtocol
  }
  if (obj.providerPreset !== undefined)
    out.providerPreset = assertString(obj.providerPreset, `providerPreset`, { maxLength: 64 })
  if (obj.baseUrl !== undefined)
    out.baseUrl = assertString(obj.baseUrl, `baseUrl`, { maxLength: MAX_URL_CHARS })
  if (obj.apiKey !== undefined)
    out.apiKey = assertString(obj.apiKey, `apiKey`, { maxLength: MAX_SECRET_CHARS })
  if (obj.enabledModels !== undefined)
    out.enabledModels = assertStringArray(obj.enabledModels, `enabledModels`, MAX_MODELS_LIST_COUNT, MAX_MODEL_ID_CHARS)
  if (obj.availableModels !== undefined)
    out.availableModels = assertStringArray(obj.availableModels, `availableModels`, MAX_MODELS_LIST_COUNT, MAX_MODEL_ID_CHARS)
  if (obj.defaultModel !== undefined)
    out.defaultModel = assertString(obj.defaultModel, `defaultModel`, { maxLength: MAX_MODEL_ID_CHARS })

  return out
}

export function validateImageGenConfigUpdate(raw: unknown): DesktopImageGenConfigUpdate {
  const obj = assertPlainObject(raw, `patch`)
  const out: DesktopImageGenConfigUpdate = {}

  if (obj.providerPreset !== undefined)
    out.providerPreset = assertString(obj.providerPreset, `providerPreset`, { maxLength: 64 })
  if (obj.baseUrl !== undefined)
    out.baseUrl = assertString(obj.baseUrl, `baseUrl`, { maxLength: MAX_URL_CHARS })
  if (obj.apiKey !== undefined)
    out.apiKey = assertString(obj.apiKey, `apiKey`, { maxLength: MAX_SECRET_CHARS })
  if (obj.model !== undefined)
    out.model = assertString(obj.model, `model`, { maxLength: MAX_MODEL_ID_CHARS })
  if (obj.size !== undefined)
    out.size = assertString(obj.size, `size`, { maxLength: 64 })
  if (obj.quality !== undefined)
    out.quality = assertString(obj.quality, `quality`, { maxLength: 64 })

  return out
}

export function validateListRemoteModelsParams(raw: unknown): DesktopListRemoteModelsParams {
  const obj = assertPlainObject(raw, `params`)
  if (typeof obj.protocol !== `string` || !VALID_AI_PROTOCOLS.has(obj.protocol as DesktopAiProtocol))
    throw new Error(`Invalid AI protocol`)
  const baseUrl = assertString(obj.baseUrl, `baseUrl`, { maxLength: MAX_URL_CHARS })
  const apiKey = assertOptionalString(obj.apiKey, `apiKey`, MAX_SECRET_CHARS)
  return {
    protocol: obj.protocol as DesktopAiProtocol,
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

export function validateTestImageGenParams(raw: unknown): DesktopTestImageGenParams | undefined {
  if (raw === undefined)
    return undefined
  const obj = assertPlainObject(raw, `params`)
  return {
    prompt: assertOptionalString(obj.prompt, `prompt`, MAX_PROMPT_TEST_CHARS),
    baseUrl: assertOptionalString(obj.baseUrl, `baseUrl`, MAX_URL_CHARS),
    apiKey: assertOptionalString(obj.apiKey, `apiKey`, MAX_SECRET_CHARS),
    model: assertOptionalString(obj.model, `model`, MAX_MODEL_ID_CHARS),
    size: assertOptionalString(obj.size, `size`, 64),
    quality: assertOptionalString(obj.quality, `quality`, 64),
  }
}

function validateWebSearchProviderUpdate(raw: unknown, label: string): DesktopWebSearchProviderUpdate {
  const obj = assertPlainObject(raw, label)
  if (typeof obj.enabled !== `boolean`)
    throw new TypeError(`${label}.enabled must be a boolean`)
  if (typeof obj.protocol !== `string` || !VALID_WEB_SEARCH_PROTOCOLS.has(obj.protocol))
    throw new Error(`Invalid web search protocol`)
  const baseUrl = assertString(obj.baseUrl, `${label}.baseUrl`, { maxLength: MAX_URL_CHARS })
  if (baseUrl.trim() && !/^https?:\/\//i.test(baseUrl.trim()))
    throw new Error(`${label}.baseUrl must start with http:// or https://`)
  const id = obj.id !== undefined ? validateIdArg(obj.id, `${label}.id`) : undefined
  const apiKey = assertOptionalString(obj.apiKey, `${label}.apiKey`, MAX_SECRET_CHARS)
  return {
    ...(id !== undefined ? { id } : {}),
    name: assertString(obj.name, `${label}.name`, { maxLength: MAX_PROVIDER_NAME_CHARS }),
    enabled: obj.enabled,
    protocol: obj.protocol as DesktopWebSearchProtocol,
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    model: assertString(obj.model, `${label}.model`, { maxLength: MAX_MODEL_ID_CHARS }),
  }
}

export function validateWebSearchConfigUpdate(raw: unknown): DesktopWebSearchConfigUpdate {
  const obj = assertPlainObject(raw, `config`)
  if (typeof obj.enabled !== `boolean`)
    throw new TypeError(`enabled must be a boolean`)
  if (!Array.isArray(obj.providers))
    throw new TypeError(`providers must be an array`)
  if (obj.providers.length > MAX_WEB_SEARCH_PROVIDERS)
    throw new RangeError(`At most ${MAX_WEB_SEARCH_PROVIDERS} web search providers are allowed`)
  const providers = obj.providers.map((p, i) => validateWebSearchProviderUpdate(p, `providers[${i}]`))
  const ids = providers.flatMap(p => p.id ?? [])
  if (new Set(ids).size !== ids.length)
    throw new Error(`Web search provider ids must be unique`)
  return { enabled: obj.enabled, providers }
}

export function validateTestWebSearchParams(raw: unknown): DesktopTestWebSearchParams | undefined {
  if (raw === undefined)
    return undefined
  const obj = assertPlainObject(raw, `params`)
  return {
    query: assertOptionalString(obj.query, `query`, MAX_SEARCH_TEST_QUERY_CHARS),
    providerId: obj.providerId !== undefined ? validateIdArg(obj.providerId, `providerId`) : undefined,
    baseUrl: assertOptionalString(obj.baseUrl, `baseUrl`, MAX_URL_CHARS),
    apiKey: assertOptionalString(obj.apiKey, `apiKey`, MAX_SECRET_CHARS),
    model: assertOptionalString(obj.model, `model`, MAX_MODEL_ID_CHARS),
  }
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

/**
 * Prevents exfiltrating a saved `safeStorage` API key to a different origin when
 * the renderer calls `listRemoteModels`, `testImageGen`, or `testWebSearch` without an explicit key.
 */
export function resolveEffectiveApiKey(params: {
  explicitApiKey?: string
  savedApiKey: string
  requestedBaseUrl: string
  savedBaseUrl: string
}): string {
  const explicit = params.explicitApiKey?.trim() ?? ``
  if (explicit)
    return explicit
  const requestedOrigin = parseHttpOrigin(params.requestedBaseUrl)
  const savedOrigin = parseHttpOrigin(params.savedBaseUrl)
  if (!requestedOrigin || !savedOrigin || requestedOrigin !== savedOrigin)
    return ``
  return params.savedApiKey
}

export function validateAcpSettingsPatch(raw: unknown): Partial<AcpSettings> {
  const obj = assertPlainObject(raw, `patch`)
  const out: Partial<AcpSettings> = {}

  if (obj.defaultAgentId !== undefined)
    out.defaultAgentId = validateIdArg(obj.defaultAgentId, `defaultAgentId`)

  if (obj.defaultPermissionLevel !== undefined) {
    if (typeof obj.defaultPermissionLevel !== `string` || !VALID_PERMISSION_LEVELS.has(obj.defaultPermissionLevel as AcpPermissionLevel))
      throw new Error(`Invalid defaultPermissionLevel`)
    out.defaultPermissionLevel = obj.defaultPermissionLevel as AcpPermissionLevel
  }

  if (obj.lastModelByAgent !== undefined)
    out.lastModelByAgent = assertStringRecord(obj.lastModelByAgent, `lastModelByAgent`, 128, MAX_ID_CHARS, MAX_MODEL_ID_CHARS)

  if (obj.lastThinkingLevelByAgent !== undefined)
    out.lastThinkingLevelByAgent = assertStringRecord(obj.lastThinkingLevelByAgent, `lastThinkingLevelByAgent`, 128, MAX_ID_CHARS, MAX_ID_CHARS)

  if (obj.commandOverrides !== undefined) {
    const rawOverrides = assertPlainObject(obj.commandOverrides, `commandOverrides`)
    const keys = Object.keys(rawOverrides)
    if (keys.length > 128)
      throw new RangeError(`commandOverrides exceeds maximum entry count`)
    const overrides: Record<string, AcpCommandOverride> = {}
    for (const key of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key))
        continue
      const agentId = validateIdArg(key, `commandOverrides key`)
      const entry = assertPlainObject(rawOverrides[key], `commandOverrides[${agentId}]`)
      const command = assertString(entry.command, `commandOverrides[${agentId}].command`, {
        maxLength: MAX_COMMAND_CHARS,
        disallowNullByte: true,
      })
      const args = assertStringArray(entry.args, `commandOverrides[${agentId}].args`, MAX_ARGS_COUNT, MAX_COMMAND_CHARS, {
        disallowNullOrNewline: false,
      })
      for (const arg of args) {
        if (arg.includes(`\0`))
          throw new Error(`commandOverrides[${agentId}].args must not contain null bytes`)
      }
      const env = entry.env !== undefined
        ? assertStringRecord(entry.env, `commandOverrides[${agentId}].env`, MAX_ENV_ENTRIES, MAX_ID_CHARS, MAX_SECRET_CHARS)
        : undefined
      overrides[agentId] = { command, args, ...(env ? { env } : {}) }
    }
    out.commandOverrides = overrides
  }

  if (obj.customAgents !== undefined)
    throw new Error(`Use addCustomAgent/removeCustomAgent to modify customAgents`)

  return out
}

export function validateCustomAgentInput(raw: unknown): {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
} {
  const obj = assertPlainObject(raw, `agent`)
  const name = assertString(obj.name, `agent.name`, { minTrimmed: 1, maxLength: MAX_ID_CHARS, disallowNullByte: true })
  const command = assertString(obj.command, `agent.command`, { minTrimmed: 1, maxLength: MAX_COMMAND_CHARS, disallowNullByte: true })
  const args = assertStringArray(obj.args, `agent.args`, MAX_ARGS_COUNT, MAX_COMMAND_CHARS)
  for (const arg of args) {
    if (arg.includes(`\0`))
      throw new Error(`agent.args must not contain null bytes`)
  }
  const env = obj.env !== undefined
    ? assertStringRecord(obj.env, `agent.env`, MAX_ENV_ENTRIES, MAX_ID_CHARS, MAX_SECRET_CHARS)
    : undefined
  return { name, command, args, ...(env ? { env } : {}) }
}

export function validateStartSessionParams(raw: unknown): AcpStartSessionParams {
  const obj = assertPlainObject(raw, `params`)
  const agentId = validateIdArg(obj.agentId, `params.agentId`)
  const modelId = assertOptionalNullableString(obj.modelId, `params.modelId`, MAX_MODEL_ID_CHARS)
  const thinkingLevel = assertOptionalNullableString(obj.thinkingLevel, `params.thinkingLevel`, MAX_ID_CHARS)
  let permissionLevel: AcpPermissionLevel | undefined
  if (obj.permissionLevel !== undefined) {
    if (typeof obj.permissionLevel !== `string` || !VALID_PERMISSION_LEVELS.has(obj.permissionLevel as AcpPermissionLevel))
      throw new Error(`Invalid params.permissionLevel`)
    permissionLevel = obj.permissionLevel as AcpPermissionLevel
  }
  const modeId = assertOptionalNullableString(obj.modeId, `params.modeId`, MAX_ID_CHARS)
  const postId = validateIdArg(obj.postId, `params.postId`)
  const postTitle = assertString(obj.postTitle, `params.postTitle`, { maxLength: MAX_TITLE_CHARS, disallowNullByte: true })
  const content = assertString(obj.content, `params.content`, { maxLength: MAX_ARTICLE_CONTENT_CHARS })

  return {
    agentId,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(permissionLevel !== undefined ? { permissionLevel } : {}),
    ...(modeId !== undefined ? { modeId } : {}),
    postId,
    postTitle,
    content,
  }
}

export function validatePromptParams(raw: unknown): AcpPromptParams {
  const obj = assertPlainObject(raw, `params`)
  const sessionId = validateIdArg(obj.sessionId, `params.sessionId`)
  const text = assertString(obj.text, `params.text`, { minTrimmed: 1, maxLength: MAX_PROMPT_TEXT_CHARS })
  const attachments = obj.attachments !== undefined
    ? assertStringArray(obj.attachments, `params.attachments`, MAX_ATTACHMENTS_COUNT, MAX_PATH_CHARS, { disallowNullOrNewline: true })
    : undefined
  const content = assertString(obj.content, `params.content`, { maxLength: MAX_ARTICLE_CONTENT_CHARS })
  const postTitle = assertString(obj.postTitle, `params.postTitle`, { maxLength: MAX_TITLE_CHARS, disallowNullByte: true })

  return {
    sessionId,
    text,
    ...(attachments !== undefined ? { attachments } : {}),
    content,
    postTitle,
  }
}

export function validateSetModelParams(raw: unknown): {
  sessionId: string
  modelId: string
  thinkingLevel?: string | null
} {
  const obj = assertPlainObject(raw, `params`)
  const sessionId = validateIdArg(obj.sessionId, `params.sessionId`)
  const modelId = assertString(obj.modelId, `params.modelId`, { minTrimmed: 1, maxLength: MAX_MODEL_ID_CHARS, disallowNullByte: true }).trim()
  const thinkingLevel = assertOptionalNullableString(obj.thinkingLevel, `params.thinkingLevel`, MAX_ID_CHARS)
  return {
    sessionId,
    modelId,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}

export function validateSetThinkingLevelParams(raw: unknown): {
  sessionId: string
  thinkingLevel: string
} {
  const obj = assertPlainObject(raw, `params`)
  const sessionId = validateIdArg(obj.sessionId, `params.sessionId`)
  const thinkingLevel = assertString(obj.thinkingLevel, `params.thinkingLevel`, {
    minTrimmed: 1,
    maxLength: MAX_ID_CHARS,
    disallowNullByte: true,
  }).trim()
  return { sessionId, thinkingLevel }
}

export function validateSetPermissionModeParams(raw: unknown): {
  sessionId: string
  permissionLevel?: AcpPermissionLevel
  modeId?: string | null
} {
  const obj = assertPlainObject(raw, `params`)
  const sessionId = validateIdArg(obj.sessionId, `params.sessionId`)
  let permissionLevel: AcpPermissionLevel | undefined
  if (obj.permissionLevel !== undefined) {
    if (typeof obj.permissionLevel !== `string` || !VALID_PERMISSION_LEVELS.has(obj.permissionLevel as AcpPermissionLevel))
      throw new Error(`Invalid params.permissionLevel`)
    permissionLevel = obj.permissionLevel as AcpPermissionLevel
  }
  const modeId = assertOptionalNullableString(obj.modeId, `params.modeId`, MAX_ID_CHARS)
  return {
    sessionId,
    ...(permissionLevel !== undefined ? { permissionLevel } : {}),
    ...(modeId !== undefined ? { modeId } : {}),
  }
}

export function validateRespondPermissionParams(raw: unknown): {
  sessionId: string
  requestId: string
  decision: AcpPermissionDecision
  optionId?: string
} {
  const obj = assertPlainObject(raw, `params`)
  const sessionId = validateIdArg(obj.sessionId, `params.sessionId`)
  const requestId = validateIdArg(obj.requestId, `params.requestId`)
  if (typeof obj.decision !== `string` || !VALID_PERMISSION_DECISIONS.has(obj.decision as AcpPermissionDecision))
    throw new Error(`Invalid params.decision`)
  const optionId = assertOptionalString(obj.optionId, `params.optionId`, MAX_ID_CHARS)
  return {
    sessionId,
    requestId,
    decision: obj.decision as AcpPermissionDecision,
    ...(optionId !== undefined ? { optionId } : {}),
  }
}

export function validateReadWorkspaceImageParams(raw: unknown): {
  sessionId: string
  path: string
} {
  const obj = assertPlainObject(raw, `params`)
  const sessionId = validateIdArg(obj.sessionId, `params.sessionId`)
  const imagePath = assertString(obj.path, `params.path`, {
    minTrimmed: 1,
    maxLength: 1024,
    disallowNullByte: true,
  })
  return { sessionId, path: imagePath }
}
