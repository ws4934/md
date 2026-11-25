import type { AcpModelInfo, AcpThinkingOption } from '../types/desktop-acp'

export const KNOWN_THINKING_LEVELS = [
  `default`,
  `auto`,
  `off`,
  `none`,
  `minimal`,
  `low`,
  `medium`,
  `high`,
  `xhigh`,
  `max`,
  `ultra`,
] as const

export type KnownThinkingLevel = (typeof KNOWN_THINKING_LEVELS)[number]

// Effort suffixes valid for splitting variant model IDs (excludes generic words like `default`/`auto`
// so standalone models named `*-default` or `*-auto` are never mis-grouped).
const VARIANT_SUFFIX_LEVELS = new Set<string>([
  `minimal`,
  `low`,
  `medium`,
  `high`,
  `xhigh`,
  `max`,
  `ultra`,
])

const KNOWN_LEVEL_RANK = new Map<string, number>(
  KNOWN_THINKING_LEVELS.map((level, idx) => [level, idx]),
)

export interface ConfigModelOptionInput {
  value: string
  name?: string | null
  description?: string | null
}

export function isKnownThinkingLevel(value: string | null | undefined): value is KnownThinkingLevel {
  if (!value)
    return false
  return KNOWN_LEVEL_RANK.has(value.trim().toLowerCase())
}

/**
 * Title-cases an unrecognized thinking level option for display fallback.
 */
export function formatThinkingFallbackLabel(option: Pick<AcpThinkingOption, `id` | `name`>): string {
  const raw = (option.name?.trim() || option.id.trim()).replace(/[_-]+/g, ` `).trim()
  if (!raw)
    return option.id
  return raw.replace(/\b[a-z]/g, ch => ch.toUpperCase())
}

export function sortThinkingOptions(options: readonly AcpThinkingOption[]): AcpThinkingOption[] {
  const deduped = new Map<string, AcpThinkingOption>()
  const originalOrder = new Map<string, number>()

  for (const opt of options) {
    const id = opt.id.trim()
    if (!id)
      continue
    const key = id.toLowerCase()
    if (!deduped.has(key)) {
      deduped.set(key, {
        id,
        ...(opt.name ? { name: opt.name } : {}),
        ...(opt.description ? { description: opt.description } : {}),
      })
      originalOrder.set(key, originalOrder.size)
    }
  }

  return [...deduped.entries()]
    .sort(([aKey], [bKey]) => {
      const aRank = KNOWN_LEVEL_RANK.get(aKey)
      const bRank = KNOWN_LEVEL_RANK.get(bKey)
      if (aRank !== undefined && bRank !== undefined)
        return aRank - bRank
      if (aRank !== undefined)
        return -1
      if (bRank !== undefined)
        return 1
      return (originalOrder.get(aKey) ?? 0) - (originalOrder.get(bKey) ?? 0)
    })
    .map(([, opt]) => opt)
}

interface ParsedSuffix {
  baseId: string
  level: string
  syntax: `bracket` | `dash`
}

function parseVariantSuffix(rawId: string, extraAllowedLevels: ReadonlySet<string>): ParsedSuffix | null {
  const bracketMatch = /^(.+)\[([\w-]+)\]$/.exec(rawId)
  if (bracketMatch) {
    const level = bracketMatch[2].toLowerCase()
    if (VARIANT_SUFFIX_LEVELS.has(level) || extraAllowedLevels.has(level)) {
      return { baseId: bracketMatch[1], level, syntax: `bracket` }
    }
  }

  const dashMatch = /^(.+)-([a-z0-9]+)$/i.exec(rawId)
  if (dashMatch) {
    const level = dashMatch[2].toLowerCase()
    if (VARIANT_SUFFIX_LEVELS.has(level) || extraAllowedLevels.has(level)) {
      return { baseId: dashMatch[1], level, syntax: `dash` }
    }
  }

  return null
}

function stripEffortFromName(rawName: string, level: string): string {
  const escaped = level.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)
  const stripped = rawName
    .replace(new RegExp(`\\s*[(\\[]${escaped}[)\\]]\\s*$`, `i`), ``)
    .trim()
  return stripped || rawName
}

function defaultLevelName(level: string): string {
  if (level === `xhigh`)
    return `XHigh`
  return level.charAt(0).toUpperCase() + level.slice(1)
}

/**
 * Collapses effort-suffixed ACP model IDs (e.g. `gemini-4-neon-high` or
 * `gpt-6-astra[xhigh]`) into base models with per-model `thinkingOptions` and
 * `thinkingVariantIds`. Standalone models whose own ID ends in a level word
 * (such as `gpt-oss-120b-medium`) stay ungrouped.
 */
export function groupVariantModels(params: {
  rawModels: readonly AcpModelInfo[]
  configModelOptions?: readonly ConfigModelOptionInput[]
  thoughtConfigOptions?: readonly AcpThinkingOption[]
}): {
  models: AcpModelInfo[]
  hasVariants: boolean
} {
  const { rawModels, configModelOptions, thoughtConfigOptions } = params
  if (rawModels.length === 0)
    return { models: [], hasVariants: false }

  const configBaseMap = new Map<string, ConfigModelOptionInput>()
  for (const opt of configModelOptions ?? []) {
    if (opt.value)
      configBaseMap.set(opt.value, opt)
  }

  const thoughtMetaMap = new Map<string, AcpThinkingOption>()
  const extraAllowedLevels = new Set<string>()
  for (const opt of thoughtConfigOptions ?? []) {
    const key = opt.id.trim().toLowerCase()
    if (key) {
      thoughtMetaMap.set(key, opt)
      extraAllowedLevels.add(key)
    }
  }

  // Pre-scan unmatched dash candidates so a single standalone model ending in `-medium`
  // is never mis-grouped when configOptions[model] is absent.
  const unmatchedDashLevels = new Map<string, Set<string>>()
  const directAssignments = new Map<string, { baseId: string, level: string | null }>()

  for (const raw of rawModels) {
    if (configBaseMap.has(raw.id)) {
      directAssignments.set(raw.id, { baseId: raw.id, level: null })
      continue
    }

    const parsed = parseVariantSuffix(raw.id, extraAllowedLevels)
    if (parsed && configBaseMap.has(parsed.baseId)) {
      directAssignments.set(raw.id, { baseId: parsed.baseId, level: parsed.level })
      continue
    }

    if (parsed?.syntax === `bracket`) {
      directAssignments.set(raw.id, { baseId: parsed.baseId, level: parsed.level })
      continue
    }

    if (parsed?.syntax === `dash`) {
      let set = unmatchedDashLevels.get(parsed.baseId)
      if (!set) {
        set = new Set<string>()
        unmatchedDashLevels.set(parsed.baseId, set)
      }
      set.add(parsed.level)
    }
  }

  interface GroupBucket {
    baseId: string
    firstRaw: AcpModelInfo
    firstLevel: string | null
    isDefault: boolean
    variants: Map<string, string>
  }

  const groups = new Map<string, GroupBucket>()

  for (const raw of rawModels) {
    let baseId = raw.id
    let level: string | null = null

    const assigned = directAssignments.get(raw.id)
    if (assigned) {
      baseId = assigned.baseId
      level = assigned.level
    }
    else {
      const parsed = parseVariantSuffix(raw.id, extraAllowedLevels)
      if (parsed?.syntax === `dash` && (unmatchedDashLevels.get(parsed.baseId)?.size ?? 0) >= 2) {
        baseId = parsed.baseId
        level = parsed.level
      }
    }

    let bucket = groups.get(baseId)
    if (!bucket) {
      bucket = {
        baseId,
        firstRaw: raw,
        firstLevel: level,
        isDefault: Boolean(raw.isDefault),
        variants: new Map<string, string>(),
      }
      groups.set(baseId, bucket)
    }
    else if (raw.isDefault) {
      bucket.isDefault = true
    }

    if (level)
      bucket.variants.set(level, raw.id)
  }

  let hasVariants = false
  const models: AcpModelInfo[] = []

  for (const bucket of groups.values()) {
    const configMeta = configBaseMap.get(bucket.baseId)

    if (bucket.variants.size === 0) {
      models.push({
        id: bucket.firstRaw.id,
        name: configMeta?.name?.trim() || bucket.firstRaw.name,
        ...(configMeta?.description || bucket.firstRaw.description
          ? { description: configMeta?.description ?? bucket.firstRaw.description }
          : {}),
        ...(bucket.isDefault ? { isDefault: true } : {}),
      })
      continue
    }

    hasVariants = true
    const rawOptions: AcpThinkingOption[] = []
    for (const level of bucket.variants.keys()) {
      const meta = thoughtMetaMap.get(level)
      rawOptions.push({
        id: meta?.id ?? level,
        name: meta?.name ?? defaultLevelName(level),
        ...(meta?.description ? { description: meta.description } : {}),
      })
    }

    const thinkingOptions = sortThinkingOptions(rawOptions)
    const thinkingVariantIds: Record<string, string> = {}
    for (const opt of thinkingOptions) {
      const variantId = bucket.variants.get(opt.id.toLowerCase())
      if (variantId)
        thinkingVariantIds[opt.id] = variantId
    }

    const defaultThinkingLevel = thinkingOptions.find(o => o.id.toLowerCase() === `medium`)?.id
      ?? thinkingOptions[0]?.id

    const derivedName = configMeta?.name?.trim()
      || (bucket.firstLevel ? stripEffortFromName(bucket.firstRaw.name, bucket.firstLevel) : bucket.firstRaw.name)
      || bucket.baseId

    const description = configMeta?.description ?? bucket.firstRaw.description

    models.push({
      id: bucket.baseId,
      name: derivedName,
      ...(description ? { description } : {}),
      ...(bucket.isDefault ? { isDefault: true } : {}),
      thinkingOptions,
      thinkingVariantIds,
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    })
  }

  return { models, hasVariants }
}

export function hasVariantModels(models: readonly AcpModelInfo[] | undefined): boolean {
  if (!models?.length)
    return false
  return models.some(m => Boolean(m.thinkingVariantIds && Object.keys(m.thinkingVariantIds).length > 0))
}

/**
 * Returns the thinking options applicable to `model`.
 * For agents with per-model effort variants, models without variants (e.g. `gpt-oss-120b-medium`)
 * return an empty list rather than inheriting another model's `thought_level` config options.
 */
export function getModelThinkingOptions(
  model: AcpModelInfo | null | undefined,
  sessionThinkingOptions?: readonly AcpThinkingOption[],
  allModels?: readonly AcpModelInfo[],
): AcpThinkingOption[] {
  if (model?.thinkingOptions !== undefined)
    return model.thinkingOptions
  if (hasVariantModels(allModels))
    return []
  return sessionThinkingOptions ? [...sessionThinkingOptions] : []
}

/**
 * Maps a raw or base model ID onto its grouped base model ID and thinking level
 * (also supporting legacy saved variant IDs such as `gemini-3.8-flash-low`).
 */
export function parseVariantModelId(
  modelId: string | null | undefined,
  models: readonly AcpModelInfo[],
): { baseModelId: string | null, thinkingLevel: string | null } {
  if (!modelId)
    return { baseModelId: null, thinkingLevel: null }

  for (const model of models) {
    if (!model.thinkingVariantIds)
      continue
    for (const [level, variantId] of Object.entries(model.thinkingVariantIds)) {
      if (variantId === modelId)
        return { baseModelId: model.id, thinkingLevel: level }
    }
  }

  if (models.some(m => m.id === modelId))
    return { baseModelId: modelId, thinkingLevel: null }

  return { baseModelId: modelId, thinkingLevel: null }
}

/**
 * Keeps `desiredLevel` if the model supports it, otherwise falls back to `medium`,
 * `fallbackLevel`, or the model's first available level.
 */
export function resolveThinkingLevelForModel(
  options: readonly AcpThinkingOption[] | undefined,
  desiredLevel: string | null | undefined,
  fallbackLevel?: string | null,
): string | null {
  if (!options || options.length === 0)
    return null

  const normalizedDesired = desiredLevel?.trim().toLowerCase()
  if (normalizedDesired) {
    const exact = options.find(opt => opt.id.toLowerCase() === normalizedDesired)
    if (exact)
      return exact.id
  }

  const medium = options.find(opt => opt.id.toLowerCase() === `medium`)
  if (medium)
    return medium.id

  if (fallbackLevel) {
    const fallback = options.find(opt => opt.id.toLowerCase() === fallbackLevel.toLowerCase())
    if (fallback)
      return fallback.id
  }

  return options[0]?.id ?? null
}

/**
 * Resolves a base (or legacy variant) model ID + desired thinking level to the exact
 * ACP model ID to send on the wire via `session/set_model`.
 */
export function resolveWireModelId(
  modelId: string,
  thinkingLevel: string | null | undefined,
  models: readonly AcpModelInfo[],
): {
  wireModelId: string
  baseModelId: string
  thinkingLevel: string | null
} {
  const parsed = parseVariantModelId(modelId, models)
  const baseModelId = parsed.baseModelId ?? modelId
  const targetModel = models.find(m => m.id === baseModelId)

  if (!targetModel?.thinkingVariantIds || !targetModel.thinkingOptions?.length) {
    return {
      wireModelId: modelId,
      baseModelId,
      thinkingLevel: null,
    }
  }

  const desired = thinkingLevel ?? parsed.thinkingLevel
  const resolvedLevel = resolveThinkingLevelForModel(
    targetModel.thinkingOptions,
    desired,
    targetModel.defaultThinkingLevel,
  )
  const wireModelId = (resolvedLevel && targetModel.thinkingVariantIds[resolvedLevel]) || modelId

  return {
    wireModelId,
    baseModelId: targetModel.id,
    thinkingLevel: resolvedLevel,
  }
}
