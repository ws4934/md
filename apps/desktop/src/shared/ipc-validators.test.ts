import { describe, expect, it } from 'vitest'
import {
  resolveEffectiveApiKey,
  validateAcpSettingsPatch,
  validateCustomAgentInput,
  validateIdArg,
  validateImageGenConfigUpdate,
  validateListRemoteModelsParams,
  validateLocaleArg,
  validateModelApiConfigUpdate,
  validateProbeOptions,
  validatePromptParams,
  validateReadWorkspaceImageParams,
  validateRespondPermissionParams,
  validateSetModelParams,
  validateSetPermissionModeParams,
  validateSetThinkingLevelParams,
  validateStartSessionParams,
  validateTestImageGenParams,
  validateTestWebSearchParams,
  validateWebSearchConfigUpdate,
} from './ipc-validators'

describe(`ipc-validators`, () => {
  it(`validates IDs, locales, and probe options strictly`, () => {
    expect(validateIdArg(`  claude  `)).toBe(`claude`)
    expect(() => validateIdArg(``)).toThrow(/empty/)
    expect(() => validateIdArg(123)).toThrow(TypeError)
    expect(() => validateIdArg(`bad\0id`)).toThrow(/null/)
    expect(() => validateIdArg(`a`.repeat(129))).toThrow(RangeError)

    expect(validateLocaleArg(` zh-CN `)).toBe(`zh-CN`)
    expect(() => validateLocaleArg(`a`.repeat(33))).toThrow(RangeError)

    expect(validateProbeOptions(undefined)).toBeUndefined()
    expect(validateProbeOptions({ force: true })).toEqual({ force: true })
    expect(() => validateProbeOptions({ force: `yes` })).toThrow(TypeError)
    expect(() => validateProbeOptions(`bad`)).toThrow(TypeError)
  })

  it(`validates AI config updates, remote model queries, and prevents saved-key exfiltration across origins`, () => {
    expect(validateModelApiConfigUpdate({
      protocol: `anthropic`,
      baseUrl: `https://api.anthropic.com/v1`,
      enabledModels: [`claude-sonnet-4-0`],
    })).toEqual({
      protocol: `anthropic`,
      baseUrl: `https://api.anthropic.com/v1`,
      enabledModels: [`claude-sonnet-4-0`],
    })
    expect(() => validateModelApiConfigUpdate(null)).toThrow(TypeError)
    expect(() => validateModelApiConfigUpdate({ protocol: `evil` })).toThrow(/protocol/i)
    expect(() => validateModelApiConfigUpdate({ baseUrl: 123 })).toThrow(TypeError)

    expect(validateImageGenConfigUpdate({ model: `gpt-image-1`, size: `1024x1024` })).toEqual({
      model: `gpt-image-1`,
      size: `1024x1024`,
    })
    expect(() => validateImageGenConfigUpdate([])).toThrow(TypeError)

    expect(validateWebSearchConfigUpdate({
      enabled: true,
      protocol: `openai-responses`,
      model: `gpt-5-mini`,
    })).toEqual({
      enabled: true,
      protocol: `openai-responses`,
      model: `gpt-5-mini`,
    })
    expect(() => validateWebSearchConfigUpdate({ enabled: `yes` })).toThrow(TypeError)
    expect(() => validateWebSearchConfigUpdate({ protocol: `chat-completions` })).toThrow(/protocol/i)
    expect(() => validateWebSearchConfigUpdate({ apiKey: `k`.repeat(4097) })).toThrow(RangeError)
    expect(validateTestWebSearchParams(undefined)).toBeUndefined()
    expect(validateTestWebSearchParams({ query: `node` })).toMatchObject({ query: `node` })
    expect(() => validateTestWebSearchParams({ query: `x`.repeat(1001) })).toThrow(RangeError)

    expect(validateListRemoteModelsParams({
      protocol: `openai-compatible`,
      baseUrl: `https://api.openai.com/v1`,
    })).toEqual({
      protocol: `openai-compatible`,
      baseUrl: `https://api.openai.com/v1`,
    })
    expect(() => validateListRemoteModelsParams({
      protocol: `unknown`,
      baseUrl: `https://api.openai.com/v1`,
    })).toThrow(/protocol/i)

    expect(validateTestImageGenParams(undefined)).toBeUndefined()
    expect(() => validateTestImageGenParams({ prompt: `x`.repeat(8001) })).toThrow(RangeError)

    // Same origin reuses saved key; different origin refuses to attach saved key.
    expect(resolveEffectiveApiKey({
      savedApiKey: `sk-saved-secret`,
      requestedBaseUrl: `https://api.openai.com/v1`,
      savedBaseUrl: `https://api.openai.com/v1/`,
    })).toBe(`sk-saved-secret`)

    expect(resolveEffectiveApiKey({
      savedApiKey: `sk-saved-secret`,
      requestedBaseUrl: `http://127.0.0.1:9999/v1`,
      savedBaseUrl: `https://api.openai.com/v1`,
    })).toBe(``)

    expect(resolveEffectiveApiKey({
      explicitApiKey: `sk-explicit`,
      savedApiKey: `sk-saved-secret`,
      requestedBaseUrl: `https://api.deepseek.com/v1`,
      savedBaseUrl: `https://api.openai.com/v1`,
    })).toBe(`sk-explicit`)
  })

  it(`validates ACP settings, custom agents, sessions, prompts, permissions, and workspace image reads`, () => {
    const patch = validateAcpSettingsPatch({
      defaultAgentId: `codex`,
      defaultPermissionLevel: `auto_edits`,
      commandOverrides: {
        claude: { command: `/usr/local/bin/claude`, args: [`--acp`] },
      },
      extraIgnored: `ignored`,
    })
    expect(patch).toEqual({
      defaultAgentId: `codex`,
      defaultPermissionLevel: `auto_edits`,
      commandOverrides: {
        claude: { command: `/usr/local/bin/claude`, args: [`--acp`] },
      },
    })
    expect(() => validateAcpSettingsPatch({ defaultPermissionLevel: `root` })).toThrow(/defaultPermissionLevel/)
    expect(() => validateAcpSettingsPatch({ customAgents: [] })).toThrow(/addCustomAgent/)

    expect(validateCustomAgentInput({
      name: `My Agent`,
      command: `my-agent`,
      args: [`acp`],
      env: { FOO: `bar` },
    })).toEqual({
      name: `My Agent`,
      command: `my-agent`,
      args: [`acp`],
      env: { FOO: `bar` },
    })
    expect(() => validateCustomAgentInput({ name: ``, command: `x`, args: [] })).toThrow(/empty/)

    expect(validateStartSessionParams({
      agentId: `claude`,
      postId: `p1`,
      postTitle: `Hello`,
      content: `# Body`,
      permissionLevel: `ask`,
    })).toMatchObject({ agentId: `claude`, postId: `p1` })
    expect(() => validateStartSessionParams({
      agentId: `claude`,
      postId: `p1`,
      postTitle: `Hello`,
      content: 123,
    })).toThrow(TypeError)

    expect(validatePromptParams({
      sessionId: `s1`,
      text: `Rewrite intro`,
      attachments: [`/tmp/a.md`],
      content: `# Body`,
      postTitle: `Title`,
    })).toMatchObject({ sessionId: `s1`, attachments: [`/tmp/a.md`] })
    expect(() => validatePromptParams({
      sessionId: `s1`,
      text: `Rewrite`,
      attachments: [`/tmp/bad\ninjected`],
      content: `# Body`,
      postTitle: `Title`,
    })).toThrow(/line breaks/)

    expect(validateSetModelParams({ sessionId: `s1`, modelId: `gpt-5` })).toEqual({
      sessionId: `s1`,
      modelId: `gpt-5`,
    })
    expect(validateSetThinkingLevelParams({ sessionId: `s1`, thinkingLevel: `high` })).toEqual({
      sessionId: `s1`,
      thinkingLevel: `high`,
    })
    expect(validateSetPermissionModeParams({ sessionId: `s1`, permissionLevel: `plan`, modeId: null })).toEqual({
      sessionId: `s1`,
      permissionLevel: `plan`,
      modeId: null,
    })
    expect(validateRespondPermissionParams({
      sessionId: `s1`,
      requestId: `r1`,
      decision: `allow_once`,
    })).toEqual({
      sessionId: `s1`,
      requestId: `r1`,
      decision: `allow_once`,
    })
    expect(() => validateRespondPermissionParams({
      sessionId: `s1`,
      requestId: `r1`,
      decision: `approve_all`,
    })).toThrow(/decision/)

    expect(validateReadWorkspaceImageParams({ sessionId: `s1`, path: `images/out.png` })).toEqual({
      sessionId: `s1`,
      path: `images/out.png`,
    })
    expect(() => validateReadWorkspaceImageParams({ sessionId: `s1`, path: `` })).toThrow(/empty/)
  })
})
