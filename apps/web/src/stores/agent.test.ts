// @vitest-environment jsdom
import type { AcpHostEvent, AcpProbeResult, AcpSettings, DesktopAcpApi } from '@md/shared/types'
import { createDefaultAcpSettings } from '@md/shared/utils/acp-permissions'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, onScopeDispose, reactive, ref, shallowRef } from 'vue'

const { postMock, uploadMock } = vi.hoisted(() => ({
  postMock: { id: `post-1`, title: `Test Post`, content: `# Test` },
  uploadMock: vi.fn(async (file: File) => `https://cdn.test/${file.name}`),
}))

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

vi.mock(`@/composables/useImageUploader`, () => ({
  useImageUploader: () => ({ upload: uploadMock }),
}))

vi.mock(`@/storage`, () => ({
  store: {
    reactive: <T>(_key: string, initial: T) => ref(initial),
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
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
    currentPost: postMock,
    getPostById: () => postMock,
    updatePostContent: (_id: string, content: string) => {
      postMock.content = content
    },
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
      readWorkspaceImage: vi.fn(async () => ({ data: new Uint8Array(), mimeType: `image/png`, filename: `x.png` })),
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
      ai: {} as never,
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

  it(`hides thinking options on Claude Haiku and restores remembered level when switching back to Sonnet`, async () => {
    const claudeProbe: AcpProbeResult = {
      agentId: `claude`,
      currentModelId: `default`,
      currentThinkingLevel: `xhigh`,
      thinkingOptions: [
        { id: `default`, name: `Default` },
        { id: `low`, name: `Low` },
        { id: `medium`, name: `Medium` },
        { id: `high`, name: `High` },
        { id: `xhigh`, name: `Xhigh` },
        { id: `max`, name: `Max` },
      ],
      modes: [{ id: `default`, name: `Manual` }],
      currentModeId: `default`,
      commands: [],
      probedAt: Date.now(),
      models: [
        { id: `default`, name: `Default (recommended)` },
        { id: `opus[1m]`, name: `Opus 5.5` },
        { id: `sonnet`, name: `Sonnet 5` },
        { id: `haiku`, name: `Haiku 4.5` },
      ],
    }

    currentSettings.defaultAgentId = `claude`
    vi.mocked(acpMock.listAgents).mockResolvedValueOnce([
      {
        id: `claude`,
        name: `Claude Code`,
        builtin: true,
        installed: true,
        command: `claude-agent-acp`,
        args: [],
        avatar: { letter: `C`, color: `#D97757` },
        isDefault: true,
      },
    ])
    vi.mocked(acpMock.probeAgent).mockResolvedValueOnce(claudeProbe)
    vi.mocked(acpMock.startSession).mockResolvedValueOnce({
      sessionId: `sess-claude`,
      modelId: `default`,
      models: claudeProbe.models,
      thinkingLevel: `default`,
      thinkingOptions: claudeProbe.thinkingOptions!,
      modes: claudeProbe.modes,
      currentModeId: `default`,
      permissionLevel: `ask`,
      commands: [],
    })

    const { useAgentStore } = await import(`./agent`)
    const agentStore = useAgentStore()
    await agentStore.init()
    await agentStore.probeAgent(`claude`)

    expect(agentStore.availableThinkingOptions.map(o => o.id)).toEqual([`default`, `low`, `medium`, `high`, `xhigh`, `max`])
    await agentStore.setSessionThinkingLevel(`default`)
    await agentStore.sendPrompt(`Hello`)

    // Switching to Haiku emits thinking_changed with empty options (no effort config on Haiku).
    vi.mocked(acpMock.setModel).mockImplementationOnce(async () => {
      eventListener?.({
        type: `thinking_changed`,
        sessionId: `sess-claude`,
        thinkingLevel: null,
        thinkingOptions: [],
      })
      return { modelId: `haiku`, thinkingLevel: null }
    })
    await agentStore.selectAgentAndModel(`claude`, `haiku`)
    expect(agentStore.availableThinkingOptions).toEqual([])
    expect(agentStore.selectedThinkingLevel).toBeNull()

    // Starting a brand-new draft session after Haiku must NOT lose Claude's probed thinking options!
    await agentStore.startNewSession()
    await agentStore.selectAgentAndModel(`claude`, `sonnet`)
    expect(agentStore.availableThinkingOptions.map(o => o.id)).toEqual([`default`, `low`, `medium`, `high`, `xhigh`, `max`])
    expect(agentStore.selectedThinkingLevel).toBe(`default`)

    // Switch back to the live Haiku session (`sess-claude`) and verify switching back to Sonnet restores `'default'`.
    const liveSess = agentStore.sessions.find(s => s.id !== agentStore.activeSessionId)!
    liveSess.acpSessionId = `sess-claude`
    await agentStore.switchSession(liveSess.id)
    expect(agentStore.availableThinkingOptions).toEqual([])

    // Failed setModel in a live session must NOT persist rejected model via updateSettings and must roll back cleanly.
    vi.mocked(acpMock.updateSettings).mockClear()
    vi.mocked(acpMock.setModel).mockRejectedValueOnce(new Error(`Model unavailable`))
    await agentStore.selectAgentAndModel(`claude`, `opus[1m]`)
    expect(acpMock.updateSettings).not.toHaveBeenCalled()
    expect(agentStore.selectedModel?.id).toBe(`haiku`)
    expect(toastErrorMock).toHaveBeenCalledWith(`Model unavailable`)

    // Switching back to Sonnet forwards the remembered level (`default`) so the host re-applies it.
    vi.mocked(acpMock.setModel).mockImplementationOnce(async (params) => {
      eventListener?.({
        type: `thinking_changed`,
        sessionId: `sess-claude`,
        thinkingLevel: params.thinkingLevel ?? `xhigh`,
        thinkingOptions: claudeProbe.thinkingOptions,
      })
      return { modelId: `sonnet`, thinkingLevel: params.thinkingLevel ?? `xhigh` }
    })
    await agentStore.selectAgentAndModel(`claude`, `sonnet`)
    expect(acpMock.setModel).toHaveBeenLastCalledWith({
      sessionId: `sess-claude`,
      modelId: `sonnet`,
      thinkingLevel: `default`,
    })
    expect(agentStore.availableThinkingOptions.map(o => o.id)).toEqual([`default`, `low`, `medium`, `high`, `xhigh`, `max`])
    expect(agentStore.selectedThinkingLevel).toBe(`default`)
  })
})

describe(`useAgentStore workspace image upload`, () => {
  const originalDesktop = window.mdDesktop

  afterEach(() => {
    window.mdDesktop = originalDesktop
    postMock.content = `# Test`
    uploadMock.mockClear()
  })

  it(`uploads agent-saved images on article sync, rewrites paths, and reports read failures once`, async () => {
    setActivePinia(createPinia())
    let emit: ((event: AcpHostEvent) => void) | null = null
    const readWorkspaceImage = vi.fn(async ({ path }: { path: string }) => {
      if (path.includes(`missing`))
        throw new Error(`ENOENT`)
      return { data: new Uint8Array([1, 2]), mimeType: `image/png`, filename: path.split(`/`).pop()! }
    })
    window.mdDesktop = {
      acp: {
        listAgents: vi.fn(async () => []),
        getSettings: vi.fn(async () => createDefaultAcpSettings()),
        onEvent: vi.fn((listener) => {
          emit = listener
          return () => {}
        }),
        readWorkspaceImage,
      } as unknown as DesktopAcpApi,
    } as never
    const { useAgentStore } = await import(`./agent`)
    const agentStore = useAgentStore()
    await agentStore.init()
    agentStore.sessions.push({ id: `local-1`, acpSessionId: `sess-1`, items: [] } as never)

    const content = `![chart](images/chart.png) ![gone](images/missing.png) ![web](https://x.com/a.png)`
    emit!({ type: `article_synced`, sessionId: `sess-1`, postId: `post-1`, content })
    await vi.waitFor(() => expect(postMock.content).toContain(`https://cdn.test/chart.png`))
    expect(postMock.content).toBe(`![chart](https://cdn.test/chart.png) ![gone](images/missing.png) ![web](https://x.com/a.png)`)
    expect(readWorkspaceImage).toHaveBeenCalledWith({ sessionId: `sess-1`, path: `images/chart.png` })
    expect(uploadMock).toHaveBeenCalledTimes(1)

    // A second sync retries the broken path but does not repeat the same error item.
    emit!({ type: `article_synced`, sessionId: `sess-1`, postId: `post-1`, content })
    await vi.waitFor(() => expect(readWorkspaceImage).toHaveBeenCalledTimes(4))
    await new Promise(resolve => setTimeout(resolve, 0))
    const errors = agentStore.sessions[0].items.filter(i => i.type === `error`)
    expect(errors).toHaveLength(1)
  })

  it(`fails fast on uploadDefaultImage in desktop mode instead of sending CORS-blocked md-api requests`, async () => {
    const fetchSpy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(new Response(`{}`, { status: 200 }))
    window.mdDesktop = { isDesktop: true } as never
    try {
      const { uploadDefaultImage } = await import(`@/services/upload/client`)
      const file = new File([new Uint8Array([1, 2, 3])], `cover.png`, { type: `image/png` })
      await expect(uploadDefaultImage(file)).rejects.toThrow(`store.uploader.defaultHostRequiresApi`)
      expect(fetchSpy).not.toHaveBeenCalled()
    }
    finally {
      fetchSpy.mockRestore()
    }
  })

  it(`surfaces imageUploadFailed on empty upload URL, preserves errors across session_closed, and persists sessions`, async () => {
    setActivePinia(createPinia())
    const { store: storageMock } = await import(`@/storage`)
    vi.mocked(storageMock.setJSON).mockClear()

    let emit: ((event: AcpHostEvent) => void) | undefined
    const readWorkspaceImage = vi.fn(async ({ path }: { path: string }) => ({
      data: new Uint8Array([1, 2, 3]),
      mimeType: `image/png`,
      filename: path.split(`/`).pop()!,
    }))
    let rejectSlowUpload!: (err: Error) => void
    uploadMock.mockImplementation((file: File) => {
      if (file.name === `empty.png`)
        return Promise.resolve(``)
      return new Promise<string>((_resolve, reject) => {
        rejectSlowUpload = reject
      })
    })

    window.mdDesktop = {
      isDesktop: true,
      platform: `darwin`,
      acp: {
        listAgents: vi.fn(async () => []),
        getSettings: vi.fn(async () => createDefaultAcpSettings()),
        onEvent: vi.fn((listener: (event: AcpHostEvent) => void) => {
          emit = listener
          return () => {}
        }),
        readWorkspaceImage,
      } as unknown as DesktopAcpApi,
    } as never

    const { useAgentStore } = await import(`./agent`)
    const agentStore = useAgentStore()
    await agentStore.init()
    agentStore.sessions.push({
      id: `local-race`,
      acpSessionId: `sess-race`,
      agentId: `api-model`,
      modelId: `gpt-5`,
      postId: `post-1`,
      title: `Race Test`,
      items: [],
      updatedAt: 1,
    })

    emit!({
      type: `article_synced`,
      sessionId: `sess-race`,
      postId: `post-1`,
      content: `![e](images/empty.png) ![s](images/slow.png)`,
    })

    // Empty upload URL must surface an error item and persist.
    await vi.waitFor(() => {
      const errs = agentStore.sessions[0].items.filter(i => i.type === `error`)
      expect(errs).toHaveLength(1)
    })

    // Close the ACP session BEFORE slow.png upload rejects; error must still attach to local-race and persist.
    emit!({ type: `session_closed`, sessionId: `sess-race`, reason: `closed` })
    expect(agentStore.sessions[0].acpSessionId).toBeNull()
    vi.mocked(storageMock.setJSON).mockClear()

    rejectSlowUpload(new Error(`No host configured`))
    await vi.waitFor(() => {
      const errs = agentStore.sessions[0].items.filter(i => i.type === `error`)
      expect(errs).toHaveLength(2)
    })
    expect(storageMock.setJSON).toHaveBeenCalled()
  })

  it(`updates selectedModelByAgent when force-probing removes a previously selected model`, async () => {
    setActivePinia(createPinia())
    const probeAgentMock = vi.fn()
      .mockResolvedValueOnce({
        agentId: `api-model`,
        models: [
          { id: `gpt-old`, name: `gpt-old`, isDefault: true },
          { id: `gpt-keep`, name: `gpt-keep` },
        ],
        currentModelId: `gpt-old`,
        modes: [],
        currentModeId: null,
        commands: [],
        probedAt: Date.now(),
      } satisfies AcpProbeResult)
      .mockResolvedValueOnce({
        agentId: `api-model`,
        models: [
          { id: `gpt-new`, name: `gpt-new`, isDefault: true },
        ],
        currentModelId: `gpt-new`,
        modes: [],
        currentModeId: null,
        commands: [],
        probedAt: Date.now(),
      } satisfies AcpProbeResult)

    window.mdDesktop = {
      isDesktop: true,
      platform: `darwin`,
      acp: {
        listAgents: vi.fn(async () => [{
          id: `api-model`,
          name: `API Model`,
          command: `node`,
          args: [],
          installed: true,
          builtin: true,
          avatar: { letter: `M`, color: `#0284C7` },
        }]),
        getSettings: vi.fn(async () => createDefaultAcpSettings()),
        probeAgent: probeAgentMock,
        onEvent: vi.fn(() => () => {}),
      } as unknown as DesktopAcpApi,
    } as never

    const { useAgentStore } = await import(`./agent`)
    const agentStore = useAgentStore()
    await agentStore.init()
    agentStore.selectedAgentId = `api-model`

    await agentStore.probeAgent(`api-model`, false)
    expect(agentStore.selectedModel?.id).toBe(`gpt-old`)

    // User removes `gpt-old` in Model API Settings and force-reprobes:
    await agentStore.probeAgent(`api-model`, true)
    expect(agentStore.selectedModel?.id).toBe(`gpt-new`)
  })
})
