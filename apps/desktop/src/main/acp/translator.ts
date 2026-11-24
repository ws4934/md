import type {
  NewSessionResponse,
  PermissionOption,
  Plan,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk/unstable'
import type {
  AcpDiffStats,
  AcpModeInfo,
  AcpModelInfo,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpToolCallItem,
  AcpToolKind,
  AcpToolStatus,
} from '@md/shared/types'
import { computeCompactDiff } from '@md/shared/utils/compact-diff'

export interface UnstableSessionModelState {
  currentModelId?: string | null
  availableModels?: Array<{
    modelId: string
    name?: string | null
    description?: string | null
  }> | null
}

export type ExtendedNewSessionResponse = NewSessionResponse & {
  models?: UnstableSessionModelState | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === `object` && value !== null && !Array.isArray(value)
}

export function isMethodNotFoundError(error: unknown): boolean {
  if (typeof error === `object` && error !== null && `code` in error && (error as { code?: unknown }).code === -32601)
    return true
  const msg = error instanceof Error ? error.message : String(error)
  return /method not found/i.test(msg)
}

function readString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record)
    return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === `string` && value.trim())
      return value
  }
  return undefined
}

function readStringAllowEmpty(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record)
    return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === `string`)
      return value
  }
  return undefined
}

export function flattenSelectConfigOptions(
  options: Array<SessionConfigSelectOption | { group: string, name: string, options: SessionConfigSelectOption[] }>,
): SessionConfigSelectOption[] {
  const result: SessionConfigSelectOption[] = []
  for (const item of options) {
    if (`options` in item && Array.isArray(item.options)) {
      result.push(...item.options)
    }
    else if (`value` in item) {
      result.push(item)
    }
  }
  return result
}

export function findSelectConfigOption(
  configOptions: SessionConfigOption[] | null | undefined,
  category: `model` | `mode` | `thought_level`,
): (SessionConfigOption & { type: `select` }) | null {
  if (!configOptions?.length)
    return null

  const byCategory = configOptions.find(
    opt => opt.type === `select` && opt.category === category,
  )
  if (byCategory && byCategory.type === `select`)
    return byCategory

  const byId = configOptions.find(
    opt => opt.type === `select` && opt.id.toLowerCase() === category,
  )
  if (byId && byId.type === `select`)
    return byId

  return null
}

/**
 * Resolves the active `models.availableModels` ID after a `config_option_update` when
 * the agent splits effort-parameterized model IDs (e.g. `gemini-3.8-flash-low` or
 * `gpt-6-astra[xhigh]`) into separate `model` + `thought_level` config options.
 */
export function resolveCurrentModelFromConfigOptions(
  configOptions: SessionConfigOption[] | null | undefined,
  availableModels: readonly AcpModelInfo[],
  currentModelId: string | null,
): string | null {
  const modelOption = findSelectConfigOption(configOptions, `model`)
  const baseModel = modelOption?.currentValue?.trim() || null
  if (!baseModel)
    return currentModelId

  const availableIds = new Set(availableModels.map(m => m.id))
  const thoughtOption = findSelectConfigOption(configOptions, `thought_level`)
  const thought = thoughtOption?.currentValue?.trim() || null

  if (thought) {
    const dashCandidate = `${baseModel}-${thought}`
    if (availableIds.has(dashCandidate))
      return dashCandidate
    const bracketCandidate = `${baseModel}[${thought}]`
    if (availableIds.has(bracketCandidate))
      return bracketCandidate
  }

  if (
    currentModelId
    && availableIds.has(currentModelId)
    && (
      currentModelId === baseModel
      || currentModelId.startsWith(`${baseModel}-`)
      || currentModelId.startsWith(`${baseModel}[`)
    )
  ) {
    return currentModelId
  }

  if (availableIds.has(baseModel))
    return baseModel

  return currentModelId
}

export function deriveModelsFromSessionResponse(response: ExtendedNewSessionResponse): {
  models: AcpModelInfo[]
  currentModelId: string | null
  source: `models` | `configOptions` | `none`
} {
  if (response.models?.availableModels?.length) {
    const currentModelId = response.models.currentModelId ?? null
    return {
      models: response.models.availableModels.map(m => ({
        id: m.modelId,
        name: m.name || m.modelId,
        description: m.description ?? undefined,
        isDefault: currentModelId === m.modelId,
      })),
      currentModelId,
      source: `models`,
    }
  }

  const modelConfig = findSelectConfigOption(response.configOptions, `model`)
  if (modelConfig) {
    const flat = flattenSelectConfigOptions(modelConfig.options)
    const currentModelId = modelConfig.currentValue || null
    return {
      models: flat.map(opt => ({
        id: opt.value,
        name: opt.name || opt.value,
        description: opt.description ?? undefined,
        isDefault: currentModelId === opt.value,
      })),
      currentModelId,
      source: `configOptions`,
    }
  }

  return {
    models: [],
    currentModelId: null,
    source: `none`,
  }
}

export function deriveModesFromSessionResponse(response: ExtendedNewSessionResponse): {
  modes: AcpModeInfo[]
  currentModeId: string | null
  source: `modes` | `configOptions` | `none`
} {
  if (response.modes?.availableModes?.length) {
    return {
      modes: response.modes.availableModes.map(mode => ({
        id: mode.id,
        name: mode.name,
        description: mode.description ?? undefined,
      })),
      currentModeId: response.modes.currentModeId ?? null,
      source: `modes`,
    }
  }

  const modeConfig = findSelectConfigOption(response.configOptions, `mode`)
  if (modeConfig) {
    const flat = flattenSelectConfigOptions(modeConfig.options)
    return {
      modes: flat.map(opt => ({
        id: opt.value,
        name: opt.name || opt.value,
        description: opt.description ?? undefined,
      })),
      currentModeId: modeConfig.currentValue || null,
      source: `configOptions`,
    }
  }

  return {
    modes: [],
    currentModeId: null,
    source: `none`,
  }
}

const KNOWN_TOOL_KINDS = new Set<AcpToolKind>([
  `read`,
  `edit`,
  `delete`,
  `move`,
  `search`,
  `execute`,
  `think`,
  `fetch`,
  `switch_mode`,
  `other`,
])

export function normalizeToolKind(kind: ToolKind | string | null | undefined): AcpToolKind {
  if (kind && KNOWN_TOOL_KINDS.has(kind as AcpToolKind))
    return kind as AcpToolKind
  return `other`
}

export function normalizeToolStatus(status: ToolCallStatus | string | null | undefined): AcpToolStatus {
  switch (status) {
    case `completed`:
      return `completed`
    case `failed`:
      return `failed`
    case `in_progress`:
      return `in_progress`
    case `pending`:
    default:
      return `pending`
  }
}

function extractTextFromToolContent(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content?.length)
    return undefined
  const texts: string[] = []
  for (const item of content) {
    if (item.type === `content` && item.content.type === `text` && item.content.text)
      texts.push(item.content.text)
  }
  return texts.length > 0 ? texts.join(`\n`) : undefined
}

function extractDiffFromToolContent(content: ToolCallContent[] | null | undefined): {
  path?: string
  oldText?: string
  newText?: string
} | null {
  if (!content?.length)
    return null
  for (const item of content) {
    if (item.type === `diff`) {
      return {
        path: item.path,
        oldText: item.oldText ?? undefined,
        newText: item.newText,
      }
    }
  }
  return null
}

function extractCommandFromRawInput(rawInput: Record<string, unknown> | null, kind: AcpToolKind): string | undefined {
  if (kind !== `execute`)
    return undefined
  const direct = readString(rawInput, [`command`, `cmd`, `script`, `CommandLine`])
  if (!direct)
    return undefined
  const args = rawInput?.args
  if (Array.isArray(args) && args.length > 0) {
    const renderedArgs = args.filter((a): a is string => typeof a === `string`).join(` `)
    return renderedArgs ? `${direct} ${renderedArgs}` : direct
  }
  return direct
}

export function mergeToolCallSnapshot(
  previous: AcpToolCallItem | undefined,
  update: ToolCall | ToolCallUpdate,
): AcpToolCallItem {
  const toolKind = update.kind ? normalizeToolKind(update.kind) : (previous?.toolKind ?? `other`)
  const status = update.status ? normalizeToolStatus(update.status) : (previous?.status ?? `pending`)
  const title = update.title ?? previous?.title ?? update.toolCallId

  const rawInput = isRecord(update.rawInput) ? update.rawInput : null
  const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : null
  const rawOutputText = typeof update.rawOutput === `string` && update.rawOutput.trim()
    ? update.rawOutput
    : undefined
  const diff = extractDiffFromToolContent(update.content)
  const contentText = extractTextFromToolContent(update.content)

  const filePath
    = diff?.path
      ?? update.locations?.[0]?.path
      ?? readString(rawInput, [`path`, `filePath`, `file`, `Path`, `target`])
      ?? previous?.filePath

  const command
    = extractCommandFromRawInput(rawInput, toolKind)
      ?? previous?.command
      ?? (toolKind === `execute` ? title || undefined : undefined)
  const rawOldText = diff?.oldText ?? readStringAllowEmpty(rawInput, [`oldText`, `oldString`, `Target`])
  const rawNewText
    = toolKind === `delete`
      ? ``
      : (diff?.newText ?? readStringAllowEmpty(rawInput, [`newText`, `newString`, `content`, `Replacement`, `Content`]))

  let detail = contentText ?? previous?.detail
  if (!detail) {
    if (toolKind === `search`)
      detail = readString(rawInput, [`query`, `pattern`]) ?? title
    else if (toolKind === `fetch`)
      detail = readString(rawInput, [`url`, `uri`]) ?? title
    else if (toolKind === `execute`)
      detail = command
    else if (filePath)
      detail = filePath
  }

  const isEditLike = toolKind === `edit` || toolKind === `delete` || toolKind === `move`
  const rawUnifiedDiff = isEditLike
    ? (contentText ?? readString(rawInput, [`patch`, `diff`, `unifiedDiff`]))
    : undefined

  let unifiedDiff = previous?.unifiedDiff
  let diffStats: AcpDiffStats | undefined = previous?.diffStats

  if (isEditLike && (rawOldText !== undefined || rawNewText !== undefined || rawUnifiedDiff !== undefined)) {
    const compact = computeCompactDiff({
      oldText: rawOldText,
      newText: rawNewText,
      unifiedDiff: rawUnifiedDiff,
    })
    unifiedDiff = compact.unifiedDiff || undefined
    diffStats = compact.stats
  }

  const error
    = status === `failed`
      ? (readString(rawOutput, [`error`, `message`]) ?? rawOutputText ?? contentText ?? previous?.error ?? `Tool call failed`)
      : undefined

  return {
    id: update.toolCallId,
    title,
    toolKind,
    status,
    detail,
    filePath,
    command,
    unifiedDiff,
    diffStats,
    error,
  }
}

export function mapPlanToEntries(plan: Plan): AcpPlanEntry[] {
  return plan.entries.map(entry => ({
    content: entry.content,
    status: entry.status,
    priority: entry.priority,
  }))
}

export function mapPermissionRequest(
  requestId: string,
  sessionId: string,
  params: RequestPermissionRequest,
  toolSnapshot?: AcpToolCallItem,
): AcpPermissionRequest {
  const merged = mergeToolCallSnapshot(toolSnapshot, params.toolCall)
  return {
    requestId,
    sessionId,
    toolCallId: params.toolCall.toolCallId,
    title: merged.title,
    toolKind: merged.toolKind,
    command: merged.command,
    detail: merged.detail,
    filePath: merged.filePath,
    unifiedDiff: merged.unifiedDiff,
    diffStats: merged.diffStats,
    options: params.options.map(opt => ({
      optionId: opt.optionId,
      name: opt.name,
      kind: opt.kind,
    })),
  }
}

// Allow once only: an "always" answer would write a permanent grant into the agent's own settings.
// Without an allow-once option the request falls through to the UI as a normal permission card.
export function selectAutoAcceptOption(options: PermissionOption[]): PermissionOption | null {
  return options.find(opt => opt.kind === `allow_once`) ?? null
}

export function buildPermissionResponse(
  options: PermissionOption[],
  decision: AcpPermissionDecision,
  explicitOptionId?: string,
): RequestPermissionResponse {
  if (explicitOptionId && options.some(opt => opt.optionId === explicitOptionId)) {
    return {
      outcome: {
        outcome: `selected`,
        optionId: explicitOptionId,
      },
    }
  }

  if (decision === `allow_once`) {
    // Never fall back to `allow_always` when the user only approved once.
    const opt = options.find(o => o.kind === `allow_once`)
      ?? options.find(o => o.kind.startsWith(`allow`) && o.kind !== `allow_always`)
    if (opt)
      return { outcome: { outcome: `selected`, optionId: opt.optionId } }
  }
  else if (decision === `allow_always`) {
    const opt = options.find(o => o.kind === `allow_always`)
      ?? options.find(o => o.kind === `allow_once`)
      ?? options.find(o => o.kind.startsWith(`allow`))
    if (opt)
      return { outcome: { outcome: `selected`, optionId: opt.optionId } }
  }
  else if (decision === `reject`) {
    const opt = options.find(o => o.kind === `reject_once`)
      ?? options.find(o => o.kind === `reject_always`)
      ?? options.find(o => o.kind.startsWith(`reject`))
    if (opt)
      return { outcome: { outcome: `selected`, optionId: opt.optionId } }
  }

  return { outcome: { outcome: `cancelled` } }
}
