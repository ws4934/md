// @vitest-environment jsdom
import type { AcpHostEvent, AcpProbeResult, AcpSettings, DesktopAcpApi } from '@md/shared/types'
import { createDefaultAcpSettings } from '@md/shared/utils/acp-permissions'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, onScopeDispose, reactive, ref, shallowRef } from 'vue'

const toastErrorMock = vi.fn()
const toastSuccessMock = vi.fn()

// Mirror unplugin-auto-import globals used by Pinia stores under vitest.
Object.assign(globalThis, {
  defineStore,
  ref,
  computed,
  reactive,
  shallowRef,
  onScopeDispose,
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
})

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/storage`, () => ({
  store: {
    reactive: <T>(_key: string, initial: T) => ref(initial),
    getJSON: vi.fn(async () => []),
    setJSON: vi.fn(async () => undefined),
  },
}))

vi.mock(`@/stores/editor`, () => ({
  useEditorStore: () => ({
    editor: null,
    getContent: () => `# Test`,
    applyMinimalContent: vi.fn(),
  }),
}))

vi.mock(`@/stores/post`, () => ({
  usePostStore: () => ({
    currentPostId: `post-1`,
    currentPost: { id: `post-1`, title: `Test Post`, content: `# Test` },
    getPostById: () => ({ id: `post-1`, title: `Test Post`, content: `# Test` }),
    updatePostContent: vi.fn(),
  }),
}))

function createAgyProbe(): AcpProbeResult {
  return {
    agentId: `antigravity`,
    currentModelId: `gemini-4-neon`,
    currentThinkingLevel: `high`,
    thinkingOptions: [],
    modes: [{ id: `default`, name: `Default` }],
    currentModeId: `default`,
    commands: [],
    probedAt: Date.now(),
    models: [
      {
        id: `gemini-4-neon`,
        name: `Gemini 4 Neon`,
        isDefault: true,
        defaultThinkingLevel: `medium`,
        thinkingOptions: [
          { id: `low`, name: `Low` },
          { id: `medium`, name: `Medium` },
          { id: `high`, name: `High` },
          { id: `xhigh`, name: `XHigh` },
        ],
        thinkingVariantIds: {
          low: `gemini-4-neon-low`,
          medium: `gemini-4-neon-medium`,
          high: `gemini-4-neon-high`,
          xhigh: `gemini-4-neon-xhigh`,
        },
      },
      {
        id: `gemini-3.8-flash`,
        name: `Gemini 3.8 Flash`,
        defaultThinkingLevel: `medium`,
        thinkingOptions: [
          { id: `low`, name: `Low` },
          { id: `medium`, name: `Medium` },
          { id: `high`, name: `High` },
        ],
        thinkingVariantIds: {
          low: `gemini-3.8-flash-low`,
          medium: `gemini-3.8-flash-medium`,
          high: `gemini-3.8-flash-high`,
        },
      },
      {
        id: `gpt-oss-120b-medium`,
        name: `GPT-OSS 120B (Medium)`,
      },
    ],
  }
}

describe(`useAgentStore thinking level state`, () => {
  const originalDesktop = window.mdDesktop
  let eventListener: ((event: AcpHostEvent) => void) | null = null
  let currentSettings: AcpSettings
  let acpMock: DesktopAcpApi

  beforeEach(() => {
    setActivePinia(createPinia())
    toastErrorMock.mockReset()
    toastSuccessMock.mockReset()
    eventListener = null
    currentSettings = {
      ...createDefaultAcpSettings(),
      defaultAgentId: `antigravity`,
    }

    const probe = createAgyProbe()
    acpMock = {
      listAgents: vi.fn(async () => [
        {
          id: `antigravity`,
          name: `Antigravity CLI`,
          builtin: true,
          installed: true,
          command: `agy`,
          args: [`acp`],
          avatar: { letter: `A`, color: `#0F9D8A` },
          isDefault: true,
        },
      ]),
      detectAgents: vi.fn(async () => []),
      getSettings: vi.fn(async () => structuredClone(currentSettings)),
      updateSettings: vi.fn(async (patch: Partial<AcpSettings>) => {
        currentSettings = {
          ...currentSettings,
          ...patch,
          lastModelByAgent: { ...currentSettings.lastModelByAgent, ...(patch.lastModelByAgent ?? {}) },
          lastThinkingLevelByAgent: {
            ...currentSettings.lastThinkingLevelByAgent,
            ...(patch.lastThinkingLevelByAgent ?? {}),
          },
        }
        return structuredClone(currentSettings)
      }),
      addCustomAgent: vi.fn(async () => []),
      removeCustomAgent: vi.fn(async () => []),
      installAgent: vi.fn(async () => ({ ok: true })),
      cancelInstall: vi.fn(async () => undefined),
      probeAgent: vi.fn(async () => probe),
      startSession: vi.fn(async params => ({
        sessionId: `sess-1`,
        modelId: params.modelId ?? `gemini-4-neon`,
        models: probe.models,
        thinkingLevel: params.thinkingLevel ?? `high`,
        thinkingOptions: [],
        modes: probe.modes,
        currentModeId: `default`,
        permissionLevel: params.permissionLevel ?? `ask`,
        commands: [],
      })),
      prompt: vi.fn(async () => ({ stopReason: `end_turn` })),
      cancelTurn: vi.fn(async () => undefined),
      setModel: vi.fn(async params => ({
        modelId: params.modelId,
        thinkingLevel: params.thinkingLevel ?? null,
      })),
      setThinkingLevel: vi.fn(async params => ({
        thinkingLevel: params.thinkingLevel,
        modelId: `gemini-4-neon`,
      })),
      setPermissionMode: vi.fn(async params => ({
        permissionLevel: params.permissionLevel ?? `ask`,
        modeId: params.modeId ?? null,
      })),
      respondPermission: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      onEvent: vi.fn((listener) => {
        eventListener = listener
        return () => {
          eventListener = null
        }
      }),
    }

    window.mdDesktop = {
      isDesktop: true,
      platform: `darwin`,
      acp: acpMock,
      wechat: {} as never,
      pickFiles: vi.fn(async () => []),
      pickImage: vi.fn(async () => null),
      openExternal: vi.fn(async () => undefined),
      setLocale: vi.fn(async () => undefined),
    }
  })

  afterEach(() => {
    window.mdDesktop = originalDesktop
  })

  it(`supports draft selection, model-switch fallback, standalone hiding, host sync, and error rollback`, async () => {
    const { useAgentStore } = await import(`./agent`)
    const agentStore = useAgentStore()
    await agentStore.init()
    await agentStore.probeAgent(`antigravity`)

    // Initial state from probe: gemini-4-neon with 4 thinking levels and default level high.
    expect(agentStore.selectedModel?.id).toBe(`gemini-4-neon`)
    expect(agentStore.availableThinkingOptions.map(o => o.id)).toEqual([`low`, `medium`, `high`, `xhigh`])
    expect(agentStore.selectedThinkingLevel).toBe(`high`)

    // Draft thinking level selection before session starts persists and forwards to startSession.
    await agentStore.setSessionThinkingLevel(`xhigh`)
    expect(agentStore.selectedThinkingLevel).toBe(`xhigh`)
    expect(acpMock.updateSettings).toHaveBeenCalledWith({
      lastThinkingLevelByAgent: { antigravity: `xhigh` },
    })

    await agentStore.sendPrompt(`Write outline`)
    expect(acpMock.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `antigravity`,
      modelId: `gemini-4-neon`,
      thinkingLevel: `xhigh`,
    }))

    // Switching to gemini-3.8-flash (no xhigh) falls back to medium and sends it to setModel.
    await agentStore.selectAgentAndModel(`antigravity`, `gemini-3.8-flash`)
    expect(agentStore.selectedModel?.id).toBe(`gemini-3.8-flash`)
    expect(agentStore.selectedThinkingLevel).toBe(`medium`)
    expect(acpMock.setModel).toHaveBeenCalledWith({
      sessionId: `sess-1`,
      modelId: `gemini-3.8-flash`,
      thinkingLevel: `medium`,
    })

    // Switching to standalone gpt-oss-120b-medium hides thinking options (length 0) and sets level null.
    await agentStore.selectAgentAndModel(`antigravity`, `gpt-oss-120b-medium`)
    expect(agentStore.availableThinkingOptions).toEqual([])
    expect(agentStore.selectedThinkingLevel).toBeNull()

    // Switching back restores remembered level (`medium`).
    await agentStore.selectAgentAndModel(`antigravity`, `gemini-3.8-flash`)
    expect(agentStore.selectedThinkingLevel).toBe(`medium`)

    // Agent-pushed thinking_changed event updates session and computed level.
    eventListener?.({
      type: `thinking_changed`,
      sessionId: `sess-1`,
      thinkingLevel: `low`,
    })
    expect(agentStore.selectedThinkingLevel).toBe(`low`)

    // Failed setThinkingLevel rolls back UI state and surfaces an error toast.
    vi.mocked(acpMock.setThinkingLevel).mockRejectedValueOnce(new Error(`Invalid level`))
    await agentStore.setSessionThinkingLevel(`high`)
    expect(agentStore.selectedThinkingLevel).toBe(`low`)
    expect(toastErrorMock).toHaveBeenCalledWith(`Invalid level`)

    // Starting a new session remembers the per-agent thinking level (`low`).
    await agentStore.startNewSession()
    expect(agentStore.selectedThinkingLevel).toBe(`low`)
  })
})
