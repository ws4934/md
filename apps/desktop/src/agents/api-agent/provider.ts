import type { DesktopAiProtocol } from '@md/shared/types'
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { DEFAULT_PROTOCOL_BASE_URLS } from '@md/shared/types'
import { validateHttpBaseUrl } from '../../main/ai/sanitize'

export interface ApiAgentRuntimeConfig {
  protocol: DesktopAiProtocol
  baseUrl: string
  apiKey: string
  enabledModels: string[]
  defaultModel: string
}

export type ApiAgentModeId = `default` | `acceptEdits` | `plan` | `bypassPermissions`

export const API_AGENT_MODES: ReadonlyArray<{
  id: ApiAgentModeId
  name: string
  description: string
}> = [
  { id: `default`, name: `Default`, description: `Ask before editing the article or generating images` },
  { id: `acceptEdits`, name: `Accept Edits`, description: `Auto-accept article edits` },
  { id: `plan`, name: `Plan`, description: `Read-only planning mode` },
  { id: `bypassPermissions`, name: `Bypass Permissions`, description: `Skip all permission prompts` },
]

export type ApiThoughtLevel = `default` | `low` | `medium` | `high`

export const API_THOUGHT_LEVEL_OPTIONS: ReadonlyArray<{
  value: ApiThoughtLevel
  name: string
}> = [
  { value: `default`, name: `Default` },
  { value: `low`, name: `Low` },
  { value: `medium`, name: `Medium` },
  { value: `high`, name: `High` },
]

export function createApiAgentLanguageModel(
  config: ApiAgentRuntimeConfig,
  modelId: string,
): LanguageModel {
  const baseURL = validateHttpBaseUrl(config.baseUrl, DEFAULT_PROTOCOL_BASE_URLS[config.protocol])

  if (config.protocol === `anthropic`) {
    const provider = createAnthropic({
      baseURL,
      apiKey: config.apiKey,
    })
    return provider(modelId)
  }

  if (config.protocol === `google`) {
    const provider = createGoogleGenerativeAI({
      baseURL,
      apiKey: config.apiKey,
    })
    return provider(modelId)
  }

  const provider = createOpenAICompatible({
    name: `openai-compatible`,
    baseURL,
    apiKey: config.apiKey,
  })
  return provider.chatModel(modelId)
}

export function buildReasoningProviderOptions(
  protocol: DesktopAiProtocol,
  thoughtLevel: ApiThoughtLevel,
): Record<string, Record<string, any>> | undefined {
  if (thoughtLevel === `default`)
    return undefined

  if (protocol === `openai-compatible`) {
    return {
      openaiCompatible: {
        reasoningEffort: thoughtLevel,
      },
    }
  }

  if (protocol === `anthropic`) {
    const budgetTokens = thoughtLevel === `low` ? 2048 : thoughtLevel === `medium` ? 8192 : 16384
    return {
      anthropic: {
        thinking: {
          type: `enabled`,
          budgetTokens,
        },
      },
    }
  }

  if (protocol === `google`) {
    const thinkingBudget = thoughtLevel === `low` ? 1024 : thoughtLevel === `medium` ? 4096 : 8192
    return {
      google: {
        thinkingConfig: {
          thinkingBudget,
          includeThoughts: true,
        },
      },
    }
  }

  return undefined
}

/**
 * Detects provider 400 errors triggered by unsupported reasoning/thinking parameters
 * so the caller can seamlessly retry without reasoning options.
 */
export function isUnsupportedReasoningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /reasoning[_ ]?effort|thinking(?:_?config|_?budget)?|budget_?tokens|unrecognized|unknown field|extra_forbidden|not supported/i.test(message)
}
