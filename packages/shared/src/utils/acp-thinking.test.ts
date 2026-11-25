import type { AcpModelInfo, AcpThinkingOption } from '../types/desktop-acp'
import { describe, expect, it } from 'vitest'
import {
  formatThinkingFallbackLabel,
  getModelThinkingOptions,
  groupVariantModels,
  isKnownThinkingLevel,
  parseVariantModelId,
  resolveThinkingLevelForModel,
  resolveWireModelId,
  sortThinkingOptions,
} from './acp-thinking'

describe(`acp-thinking helpers`, () => {
  it(`groups agy dash-suffixed variants into base models while keeping standalone -medium models intact`, () => {
    const rawModels: AcpModelInfo[] = [
      { id: `gemini-4-neon-high`, name: `Gemini 4 Neon (High)`, isDefault: true },
      { id: `gemini-4-neon-xhigh`, name: `Gemini 4 Neon (XHigh)` },
      { id: `gemini-4-neon-medium`, name: `Gemini 4 Neon (Medium)` },
      { id: `gemini-4-neon-low`, name: `Gemini 4 Neon (Low)` },
      { id: `gemini-3.8-flash-high`, name: `Gemini 3.8 Flash (High)` },
      { id: `gemini-3.8-flash-medium`, name: `Gemini 3.8 Flash (Medium)` },
      { id: `gemini-3.8-flash-low`, name: `Gemini 3.8 Flash (Low)` },
      { id: `gemini-pro-orchestrator`, name: `Gemini Pro Orchestrator` },
      { id: `gpt-oss-120b-medium`, name: `GPT-OSS 120B (Medium)` },
    ]

    const configModelOptions = [
      { value: `gemini-4-neon`, name: `Gemini 4 Neon` },
      { value: `gemini-3.8-flash`, name: `Gemini 3.8 Flash` },
      { value: `gemini-pro-orchestrator`, name: `Gemini Pro Orchestrator` },
      { value: `gpt-oss-120b-medium`, name: `GPT-OSS 120B (Medium)` },
    ]

    const thoughtConfigOptions: AcpThinkingOption[] = [
      { id: `low`, name: `Low` },
      { id: `medium`, name: `Medium` },
      { id: `high`, name: `High` },
      { id: `xhigh`, name: `XHigh` },
    ]

    const { models, hasVariants } = groupVariantModels({
      rawModels,
      configModelOptions,
      thoughtConfigOptions,
    })

    expect(hasVariants).toBe(true)
    expect(models.map(m => m.id)).toEqual([
      `gemini-4-neon`,
      `gemini-3.8-flash`,
      `gemini-pro-orchestrator`,
      `gpt-oss-120b-medium`,
    ])

    const neon = models[0]
    expect(neon.name).toBe(`Gemini 4 Neon`)
    expect(neon.isDefault).toBe(true)
    expect(neon.thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`, `xhigh`])
    expect(neon.thinkingVariantIds).toEqual({
      low: `gemini-4-neon-low`,
      medium: `gemini-4-neon-medium`,
      high: `gemini-4-neon-high`,
      xhigh: `gemini-4-neon-xhigh`,
    })
    expect(neon.defaultThinkingLevel).toBe(`medium`)

    const flash = models[1]
    expect(flash.thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`])

    // Standalone models must not gain thinking options or inherit another model's config options.
    const gptOss = models[3]
    expect(gptOss.id).toBe(`gpt-oss-120b-medium`)
    expect(gptOss.thinkingOptions).toBeUndefined()
    expect(gptOss.thinkingVariantIds).toBeUndefined()
    expect(getModelThinkingOptions(gptOss, thoughtConfigOptions, models)).toEqual([])
  })

  it(`groups codex-acp bracket-suffixed variants including ultra and preserves descriptions`, () => {
    const rawModels: AcpModelInfo[] = [
      { id: `gpt-6-astra[low]`, name: `6 Astra (low)` },
      { id: `gpt-6-astra[medium]`, name: `6 Astra (medium)` },
      { id: `gpt-6-astra[high]`, name: `6 Astra (high)` },
      { id: `gpt-6-astra[xhigh]`, name: `6 Astra (xhigh)`, isDefault: true },
      { id: `gpt-6-astra[max]`, name: `6 Astra (max)` },
      { id: `gpt-6-astra[ultra]`, name: `6 Astra (ultra)` },
      { id: `gpt-6-luna[low]`, name: `6 Luna (low)` },
      { id: `gpt-6-luna[medium]`, name: `6 Luna (medium)` },
      { id: `gpt-6-luna[high]`, name: `6 Luna (high)` },
      { id: `gpt-6-luna[xhigh]`, name: `6 Luna (xhigh)` },
      { id: `gpt-6-luna[max]`, name: `6 Luna (max)` },
    ]

    const configModelOptions = [
      { value: `gpt-6-astra`, name: `6 Astra`, description: `Flagship reasoning model` },
      { value: `gpt-6-luna`, name: `6 Luna`, description: `Fast everyday model` },
    ]

    const thoughtConfigOptions: AcpThinkingOption[] = [
      { id: `low`, name: `Low`, description: `Fast responses` },
      { id: `medium`, name: `Medium`, description: `Balanced` },
      { id: `high`, name: `High`, description: `Deep reasoning` },
      { id: `xhigh`, name: `Extra High`, description: `Extended reasoning` },
      { id: `max`, name: `Max` },
      { id: `ultra`, name: `Ultra` },
    ]

    const { models, hasVariants } = groupVariantModels({
      rawModels,
      configModelOptions,
      thoughtConfigOptions,
    })

    expect(hasVariants).toBe(true)
    expect(models).toHaveLength(2)
    expect(models[0].id).toBe(`gpt-6-astra`)
    expect(models[0].name).toBe(`6 Astra`)
    expect(models[0].description).toBe(`Flagship reasoning model`)
    expect(models[0].thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`, `xhigh`, `max`, `ultra`])
    expect(models[0].thinkingOptions?.[0].description).toBe(`Fast responses`)
    expect(models[0].thinkingVariantIds?.ultra).toBe(`gpt-6-astra[ultra]`)

    expect(models[1].id).toBe(`gpt-6-luna`)
    expect(models[1].thinkingOptions?.map(o => o.id)).toEqual([`low`, `medium`, `high`, `xhigh`, `max`])
  })

  it(`groups dash variants without configOptions only when >= 2 levels exist, leaving lone -medium untouched`, () => {
    const { models, hasVariants } = groupVariantModels({
      rawModels: [
        { id: `alpha-high`, name: `Alpha (High)` },
        { id: `alpha-low`, name: `Alpha (Low)` },
        { id: `gpt-oss-120b-medium`, name: `GPT-OSS 120B (Medium)` },
      ],
    })

    expect(hasVariants).toBe(true)
    expect(models.map(m => m.id)).toEqual([`alpha`, `gpt-oss-120b-medium`])
    expect(models[0].name).toBe(`Alpha`)
    expect(models[0].thinkingOptions?.map(o => o.id)).toEqual([`low`, `high`])
    expect(models[0].defaultThinkingLevel).toBe(`low`)
    expect(models[1].thinkingOptions).toBeUndefined()
  })

  it(`leaves non-variant agents unchanged and delegates thinking options to session configOptions`, () => {
    const { models, hasVariants } = groupVariantModels({
      rawModels: [
        { id: `opus-5.5`, name: `Opus 5.5` },
        { id: `sonnet-5.5`, name: `Sonnet 5.5` },
      ],
    })

    expect(hasVariants).toBe(false)
    expect(models.map(m => m.id)).toEqual([`opus-5.5`, `sonnet-5.5`])

    const sessionThoughtOptions: AcpThinkingOption[] = [
      { id: `low`, name: `Low` },
      { id: `medium`, name: `Medium` },
      { id: `high`, name: `High` },
    ]
    expect(getModelThinkingOptions(models[0], sessionThoughtOptions, models)).toEqual(sessionThoughtOptions)
  })

  it(`resolves fallback thinking level cleanly when switching between models`, () => {
    const flashOptions: AcpThinkingOption[] = [
      { id: `low` },
      { id: `medium` },
      { id: `high` },
    ]
    const twoLevelNoMedium: AcpThinkingOption[] = [
      { id: `low` },
      { id: `high` },
    ]

    // Preserves desired level when supported.
    expect(resolveThinkingLevelForModel(flashOptions, `high`)).toBe(`high`)
    // Falls back to medium when desired level (xhigh) is unsupported.
    expect(resolveThinkingLevelForModel(flashOptions, `xhigh`)).toBe(`medium`)
    // Falls back to first option when neither desired nor medium exists.
    expect(resolveThinkingLevelForModel(twoLevelNoMedium, `xhigh`)).toBe(`low`)
    // Returns null when model exposes no thinking options.
    expect(resolveThinkingLevelForModel([], `high`)).toBeNull()
  })

  it(`parses legacy variant IDs and resolves wire model IDs for both base and variant inputs`, () => {
    const { models } = groupVariantModels({
      rawModels: [
        { id: `gemini-4-neon-low`, name: `Gemini 4 Neon (Low)` },
        { id: `gemini-4-neon-xhigh`, name: `Gemini 4 Neon (XHigh)` },
        { id: `gemini-3.8-flash-low`, name: `Gemini 3.8 Flash (Low)` },
        { id: `gemini-3.8-flash-medium`, name: `Gemini 3.8 Flash (Medium)` },
        { id: `gemini-3.8-flash-high`, name: `Gemini 3.8 Flash (High)` },
      ],
      configModelOptions: [
        { value: `gemini-4-neon`, name: `Gemini 4 Neon` },
        { value: `gemini-3.8-flash`, name: `Gemini 3.8 Flash` },
      ],
    })

    expect(parseVariantModelId(`gemini-3.8-flash-low`, models)).toEqual({
      baseModelId: `gemini-3.8-flash`,
      thinkingLevel: `low`,
    })
    expect(parseVariantModelId(`gemini-3.8-flash`, models)).toEqual({
      baseModelId: `gemini-3.8-flash`,
      thinkingLevel: null,
    })

    // Switching from neon@xhigh -> flash falls back to medium and emits flash-medium.
    expect(resolveWireModelId(`gemini-3.8-flash`, `xhigh`, models)).toEqual({
      wireModelId: `gemini-3.8-flash-medium`,
      baseModelId: `gemini-3.8-flash`,
      thinkingLevel: `medium`,
    })

    // Passing a legacy variant ID preserves its level unless overridden.
    expect(resolveWireModelId(`gemini-3.8-flash-low`, null, models)).toEqual({
      wireModelId: `gemini-3.8-flash-low`,
      baseModelId: `gemini-3.8-flash`,
      thinkingLevel: `low`,
    })

    // Sorting orders default/auto/off/none before effort levels and keeps unknown custom values in original order.
    expect(
      sortThinkingOptions([
        { id: `custom-b` },
        { id: `ultra` },
        { id: `high` },
        { id: `default`, name: `Default` },
        { id: `minimal` },
        { id: `custom-a` },
        { id: `low` },
        { id: `auto` },
        { id: `off` },
        { id: `none` },
      ]).map(o => o.id),
    ).toEqual([`default`, `auto`, `off`, `none`, `minimal`, `low`, `high`, `ultra`, `custom-b`, `custom-a`])

    expect(isKnownThinkingLevel(`default`)).toBe(true)
    expect(isKnownThinkingLevel(`auto`)).toBe(true)
    expect(isKnownThinkingLevel(`off`)).toBe(true)
    expect(isKnownThinkingLevel(`none`)).toBe(true)
    expect(formatThinkingFallbackLabel({ id: `super_deep` })).toBe(`Super Deep`)
    expect(formatThinkingFallbackLabel({ id: `adaptive`, name: `adaptive` })).toBe(`Adaptive`)
    expect(formatThinkingFallbackLabel({ id: `custom`, name: `Extra-effort` })).toBe(`Extra Effort`)
  })

  it(`keeps Claude Code context-window suffixes like opus[1m] and sonnet[1m] ungrouped`, () => {
    const { models, hasVariants } = groupVariantModels({
      rawModels: [
        { id: `default`, name: `Default (recommended)` },
        { id: `opus[1m]`, name: `Opus 5.5` },
        { id: `sonnet`, name: `Sonnet 5` },
        { id: `sonnet[1m]`, name: `Sonnet 5 (1M context)` },
        { id: `haiku`, name: `Haiku 4.5` },
      ],
      thoughtConfigOptions: [
        { id: `default`, name: `Default` },
        { id: `low`, name: `Low` },
        { id: `medium`, name: `Medium` },
        { id: `high`, name: `High` },
        { id: `xhigh`, name: `Xhigh` },
        { id: `max`, name: `Max` },
      ],
    })

    expect(hasVariants).toBe(false)
    expect(models.map(m => m.id)).toEqual([`default`, `opus[1m]`, `sonnet`, `sonnet[1m]`, `haiku`])
  })
})
