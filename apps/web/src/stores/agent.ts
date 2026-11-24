import type {
  AcpAgentStatus,
  AcpHostEvent,
  AcpModeInfo,
  AcpModelInfo,
  AcpPermissionDecision,
  AcpPermissionLevel,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpProbeResult,
  AcpSettings,
  AcpToolCallItem,
} from '@md/shared/types'
import type { DesktopLayoutWidths } from '@/lib/agent/desktop-layout'
import { getCustomExtraModes, mapAcpModeIdToPermissionLevel } from '@md/shared/utils/acp-permissions'
import { uuidv4 } from '@md/shared/utils/uuid'
import { t } from '@/i18n/translate'
import {
  clampLayoutWidth,
  DEFAULT_DESKTOP_LAYOUT_WIDTHS,
  DESKTOP_LAYOUT_LIMITS,
  normalizeDesktopLayoutWidths,
} from '@/lib/agent/desktop-layout'
import { store } from '@/storage'
import { useEditorStore } from '@/stores/editor'
import { usePostStore } from '@/stores/post'

export type AgentTimelineItem
  = | { type: `user`, id: string, text: string, attachments?: string[], timestamp: number }
    | { type: `assistant`, id: string, text: string, thought?: string, streaming?: boolean, timestamp: number }
    | { type: `plan`, id: string, entries: AcpPlanEntry[], timestamp: number }
    | { type: `tool_call`, id: string, tool: AcpToolCallItem, timestamp: number }
    | {
      type: `permission`
      id: string
      request: AcpPermissionRequest
      resolvedOutcome?: AcpPermissionDecision | `cancelled`
      timestamp: number
    }
    | { type: `error`, id: string, message: string, timestamp: number }

export interface AgentConversationSession {
  id: string
  acpSessionId: string | null
  agentId: string
  modelId: string | null
  permissionLevel?: AcpPermissionLevel
  modeId?: string | null
  postId: string
  title: string
  items: AgentTimelineItem[]
  updatedAt: number
}

const SESSIONS_STORAGE_KEY = `desktop_acp_sessions_v1`
const PANEL_OPEN_STORAGE_KEY = `desktop_acp_panel_open_v1`
const SIDEBAR_OPEN_STORAGE_KEY = `desktop_acp_sidebar_open_v1`
const LAYOUT_WIDTHS_STORAGE_KEY = `desktop_acp_layout_widths_v1`
const MAX_STORED_SESSIONS = 30

const DEFAULT_SETTINGS: AcpSettings = {
  defaultAgentId: `claude`,
  defaultPermissionLevel: `ask`,
  lastModelByAgent: {},
  customAgents: [],
  commandOverrides: {},
}

export const useAgentStore = defineStore(`agent`, () => {
  const postStore = usePostStore()
  const editorStore = useEditorStore()

  const isDesktop = computed(() => Boolean(window.mdDesktop?.isDesktop))

  const agents = ref<AcpAgentStatus[]>([])
  const settings = ref<AcpSettings>(structuredClone(DEFAULT_SETTINGS))
  const probeByAgent = ref<Record<string, AcpProbeResult>>({})
  const probingAgents = ref<Record<string, boolean>>({})

  const selectedAgentId = ref<string>(`claude`)
  const selectedModelByAgent = ref<Record<string, string>>({})
  const draftPermissionLevel = ref<AcpPermissionLevel>(`ask`)
  const draftModeId = ref<string | null>(null)

  const isPanelOpen = store.reactive<boolean>(PANEL_OPEN_STORAGE_KEY, true)
  const isSidebarOpen = store.reactive<boolean>(SIDEBAR_OPEN_STORAGE_KEY, true)
  const layoutWidths = store.reactive<DesktopLayoutWidths>(
    LAYOUT_WIDTHS_STORAGE_KEY,
    { ...DEFAULT_DESKTOP_LAYOUT_WIDTHS },
  )
  layoutWidths.value = normalizeDesktopLayoutWidths(layoutWidths.value)

  const isNewArticleHero = ref<boolean>(false)

  function togglePanel(): void {
    isPanelOpen.value = !isPanelOpen.value
  }

  function setPanelOpen(open: boolean): void {
    isPanelOpen.value = open
  }

  function toggleSidebar(): void {
    isSidebarOpen.value = !isSidebarOpen.value
  }

  function setSidebarOpen(open: boolean): void {
    isSidebarOpen.value = open
  }

  function setLayoutWidth(panel: keyof DesktopLayoutWidths, widthPx: number): void {
    const limits = DESKTOP_LAYOUT_LIMITS[panel]
    const clamped = clampLayoutWidth(widthPx, limits.min, limits.max, limits.default)
    if (layoutWidths.value[panel] === clamped)
      return
    layoutWidths.value = {
      ...layoutWidths.value,
      [panel]: clamped,
    }
  }

  function resetLayoutWidth(panel: keyof DesktopLayoutWidths): number {
    const fallback = DESKTOP_LAYOUT_LIMITS[panel].default
    setLayoutWidth(panel, fallback)
    return fallback
  }

  const sessions = ref<AgentConversationSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const runningAcpSessions = ref<Record<string, boolean>>({})

  let initialized = false
  let unsubscribeEvents: (() => void) | null = null

  const activeSession = computed<AgentConversationSession | null>(() => {
    if (!activeSessionId.value)
      return null
    return sessions.value.find(s => s.id === activeSessionId.value) ?? null
  })

  const isCurrentSessionRunning = computed(() => {
    const acpId = activeSession.value?.acpSessionId
    return Boolean(acpId && runningAcpSessions.value[acpId])
  })

  const writingPostIds = computed<Set<string>>(() => {
    const ids = new Set<string>()
    for (const s of sessions.value) {
      if (s.acpSessionId && runningAcpSessions.value[s.acpSessionId])
        ids.add(s.postId)
    }
    return ids
  })

  const isCurrentPostWriting = computed(() => {
    const postId = postStore.currentPostId
    return Boolean(postId && writingPostIds.value.has(postId))
  })

  const activePendingPermissions = computed<AcpPermissionRequest[]>(() => {
    const session = activeSession.value
    if (!session)
      return []
    return session.items
      .filter(
        (item): item is Extract<AgentTimelineItem, { type: `permission` }> =>
          item.type === `permission` && !item.resolvedOutcome,
      )
      .map(item => item.request)
  })

  const isWaitingPermission = computed(() => activePendingPermissions.value.length > 0)

  const selectedAgent = computed<AcpAgentStatus | undefined>(() =>
    agents.value.find(a => a.id === selectedAgentId.value)
    ?? agents.value.find(a => a.installed)
    ?? agents.value[0],
  )

  const selectedModel = computed<AcpModelInfo | null>(() => {
    const agent = selectedAgent.value
    if (!agent)
      return null
    const probe = probeByAgent.value[agent.id]
    const chosenId = selectedModelByAgent.value[agent.id]
      ?? settings.value.lastModelByAgent[agent.id]
      ?? probe?.currentModelId
      ?? probe?.models[0]?.id
      ?? null
    if (!chosenId)
      return null
    const found = probe?.models.find(m => m.id === chosenId)
    return found ?? { id: chosenId, name: chosenId }
  })

  const currentPermissionLevel = computed<AcpPermissionLevel>(
    () => activeSession.value?.permissionLevel ?? draftPermissionLevel.value,
  )

  const currentModeId = computed<string | null>(
    () => activeSession.value?.modeId ?? draftModeId.value,
  )

  const availableModes = computed<AcpModeInfo[]>(() => {
    const agent = selectedAgent.value
    if (!agent)
      return []
    return probeByAgent.value[agent.id]?.modes ?? []
  })

  const customExtraModes = computed<AcpModeInfo[]>(() => getCustomExtraModes(availableModes.value))

  const activeCustomMode = computed<AcpModeInfo | null>(() => {
    const modeId = currentModeId.value
    if (!modeId)
      return null
    return customExtraModes.value.find(m => m.id === modeId) ?? null
  })

  const currentActivityLabel = computed<string>(() => {
    const session = activeSession.value
    if (!session)
      return t(`agent.panel.writingBadge`)

    const lastUserIdx = findLastIndex(session.items, item => item.type === `user`)
    const lastPlanIdx = findLastIndex(session.items, item => item.type === `plan`)
    if (lastPlanIdx > lastUserIdx) {
      const planItem = session.items[lastPlanIdx]
      if (planItem?.type === `plan`) {
        const runningStep = planItem.entries.find(e => e.status === `in_progress`)
        if (runningStep?.content)
          return runningStep.content
      }
    }

    for (let i = session.items.length - 1; i > lastUserIdx; i--) {
      const item = session.items[i]
      if (item.type === `tool_call` && (item.tool.status === `in_progress` || item.tool.status === `pending`))
        return item.tool.title
    }

    return t(`agent.panel.writingBadge`)
  })

  async function persistSessions(): Promise<void> {
    const serializable = sessions.value.slice(0, MAX_STORED_SESSIONS).map(s => ({
      ...s,
      acpSessionId: null,
      items: s.items.map(item =>
        item.type === `assistant` ? { ...item, streaming: false } : item,
      ),
    }))
    await store.setJSON(SESSIONS_STORAGE_KEY, serializable)
  }

  function findSessionByAcpId(acpSessionId: string): AgentConversationSession | undefined {
    return sessions.value.find(s => s.acpSessionId === acpSessionId)
  }

  /**
   * Dispatches into CodeMirror BEFORE updating postStore so EditorPanel's content
   * watcher sees an already-matching document and does not reset undo history.
   */
  function applySyncedArticleContent(postId: string, content: string): void {
    if (postStore.currentPostId === postId && editorStore.editor) {
      if (editorStore.getContent() !== content)
        editorStore.importContent(content)
    }
    const existing = postStore.getPostById(postId)
    if (existing && existing.content !== content)
      postStore.updatePostContent(postId, content)
  }

  function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i]))
        return i
    }
    return -1
  }

  function handleHostEvent(event: AcpHostEvent): void {
    switch (event.type) {
      case `agents_changed`: {
        agents.value = event.agents
        ensureValidSelectedAgent()
        break
      }
      case `install_progress`: {
        const idx = agents.value.findIndex(a => a.id === event.agentId)
        if (idx !== -1) {
          const next = { ...agents.value[idx] }
          if (event.done) {
            next.installing = false
            next.installProgress = undefined
          }
          else {
            next.installing = true
            next.installProgress = {
              percent: event.percent,
              command: event.command,
              line: event.line,
            }
          }
          agents.value.splice(idx, 1, next)
        }
        break
      }
      case `turn_started`: {
        runningAcpSessions.value = { ...runningAcpSessions.value, [event.sessionId]: true }
        break
      }
      case `turn_finished`: {
        const nextRunning = { ...runningAcpSessions.value }
        delete nextRunning[event.sessionId]
        runningAcpSessions.value = nextRunning
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          const last = session.items[session.items.length - 1]
          if (last?.type === `assistant`)
            last.streaming = false
          session.updatedAt = Date.now()
          void persistSessions()
        }
        break
      }
      case `turn_error`: {
        const nextRunning = { ...runningAcpSessions.value }
        delete nextRunning[event.sessionId]
        runningAcpSessions.value = nextRunning
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          const last = session.items[session.items.length - 1]
          if (last?.type === `assistant`)
            last.streaming = false
          session.items.push({
            type: `error`,
            id: uuidv4(),
            message: event.message,
            timestamp: Date.now(),
          })
          session.updatedAt = Date.now()
          void persistSessions()
        }
        break
      }
      case `message_chunk`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const last = session.items[session.items.length - 1]
        if (last?.type === `assistant` && last.streaming) {
          last.text += event.text
        }
        else {
          session.items.push({
            type: `assistant`,
            id: uuidv4(),
            text: event.text,
            streaming: true,
            timestamp: Date.now(),
          })
        }
        session.updatedAt = Date.now()
        break
      }
      case `thought_chunk`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const last = session.items[session.items.length - 1]
        if (last?.type === `assistant` && last.streaming) {
          last.thought = (last.thought ?? ``) + event.text
        }
        else {
          session.items.push({
            type: `assistant`,
            id: uuidv4(),
            text: ``,
            thought: event.text,
            streaming: true,
            timestamp: Date.now(),
          })
        }
        break
      }
      case `plan`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const existingIdx = findLastIndex(session.items, item => item.type === `plan`)
        const lastUserIdx = findLastIndex(session.items, item => item.type === `user`)
        if (existingIdx > lastUserIdx) {
          const target = session.items[existingIdx]
          if (target.type === `plan`) {
            target.entries = event.entries
            target.timestamp = Date.now()
            return
          }
        }
        const last = session.items[session.items.length - 1]
        if (last?.type === `assistant`)
          last.streaming = false
        session.items.push({
          type: `plan`,
          id: uuidv4(),
          entries: event.entries,
          timestamp: Date.now(),
        })
        break
      }
      case `tool_call`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const existing = session.items.find(
          item => item.type === `tool_call` && item.tool.id === event.tool.id,
        )
        if (existing && existing.type === `tool_call`) {
          existing.tool = event.tool
        }
        else {
          const last = session.items[session.items.length - 1]
          if (last?.type === `assistant`)
            last.streaming = false
          session.items.push({
            type: `tool_call`,
            id: event.tool.id,
            tool: event.tool,
            timestamp: Date.now(),
          })
        }
        break
      }
      case `permission_requested`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const last = session.items[session.items.length - 1]
        if (last?.type === `assistant`)
          last.streaming = false
        session.items.push({
          type: `permission`,
          id: event.request.requestId,
          request: event.request,
          timestamp: Date.now(),
        })
        break
      }
      case `permission_resolved`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const item = session.items.find(
          i => i.type === `permission` && i.request.requestId === event.requestId,
        )
        if (item && item.type === `permission`)
          item.resolvedOutcome = event.decision
        break
      }
      case `article_synced`: {
        applySyncedArticleContent(event.postId, event.content)
        break
      }
      case `model_changed`: {
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          session.modelId = event.modelId
          if (event.modelId)
            selectedModelByAgent.value[session.agentId] = event.modelId
        }
        break
      }
      case `mode_changed`: {
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          session.modeId = event.modeId
          const mapped = event.permissionLevel ?? mapAcpModeIdToPermissionLevel(event.modeId)
          if (mapped)
            session.permissionLevel = mapped
        }
        break
      }
      case `session_closed`: {
        const nextRunning = { ...runningAcpSessions.value }
        delete nextRunning[event.sessionId]
        runningAcpSessions.value = nextRunning
        const session = findSessionByAcpId(event.sessionId)
        if (session)
          session.acpSessionId = null
        break
      }
    }
  }

  function ensureValidSelectedAgent(): void {
    const current = agents.value.find(a => a.id === selectedAgentId.value)
    if (current?.installed)
      return
    const preferred = agents.value.find(a => a.id === settings.value.defaultAgentId && a.installed)
    const firstInstalled = agents.value.find(a => a.installed)
    selectedAgentId.value = preferred?.id ?? firstInstalled?.id ?? settings.value.defaultAgentId ?? `claude`
  }

  async function init(): Promise<void> {
    if (!window.mdDesktop?.acp || initialized)
      return
    initialized = true

    unsubscribeEvents = window.mdDesktop.acp.onEvent(handleHostEvent)

    const [loadedAgents, loadedSettings, savedSessions] = await Promise.all([
      window.mdDesktop.acp.listAgents(),
      window.mdDesktop.acp.getSettings(),
      store.getJSON<AgentConversationSession[]>(SESSIONS_STORAGE_KEY, []),
    ])

    agents.value = loadedAgents
    settings.value = loadedSettings
    draftPermissionLevel.value = loadedSettings.defaultPermissionLevel
    selectedModelByAgent.value = { ...loadedSettings.lastModelByAgent }
    sessions.value = savedSessions
    if (savedSessions.length > 0)
      activeSessionId.value = savedSessions[0].id

    ensureValidSelectedAgent()

    if (selectedAgent.value?.installed)
      void probeAgent(selectedAgent.value.id)
  }

  async function detectAgents(): Promise<void> {
    if (!window.mdDesktop?.acp)
      return
    agents.value = await window.mdDesktop.acp.detectAgents()
    ensureValidSelectedAgent()
  }

  async function probeAgent(agentId: string, force = false): Promise<AcpProbeResult | null> {
    if (!window.mdDesktop?.acp)
      return null
    if (!force && probeByAgent.value[agentId] && !probeByAgent.value[agentId].error)
      return probeByAgent.value[agentId]

    probingAgents.value = { ...probingAgents.value, [agentId]: true }
    try {
      const result = await window.mdDesktop.acp.probeAgent(agentId, { force })
      probeByAgent.value = { ...probeByAgent.value, [agentId]: result }
      if (!selectedModelByAgent.value[agentId] && result.currentModelId)
        selectedModelByAgent.value[agentId] = result.currentModelId
      return result
    }
    finally {
      const next = { ...probingAgents.value }
      delete next[agentId]
      probingAgents.value = next
    }
  }

  async function selectAgentAndModel(agentId: string, modelId?: string): Promise<void> {
    selectedAgentId.value = agentId
    if (modelId) {
      selectedModelByAgent.value = { ...selectedModelByAgent.value, [agentId]: modelId }
      void window.mdDesktop?.acp.updateSettings({
        lastModelByAgent: { [agentId]: modelId },
      })
    }

    const session = activeSession.value
    if (session?.acpSessionId && session.agentId === agentId && modelId && window.mdDesktop?.acp) {
      try {
        await window.mdDesktop.acp.setModel({
          sessionId: session.acpSessionId,
          modelId,
        })
      }
      catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    }
  }

  async function setSessionPermissionMode(params: {
    permissionLevel?: AcpPermissionLevel
    modeId?: string | null
  }): Promise<void> {
    const session = activeSession.value

    if (params.permissionLevel) {
      draftPermissionLevel.value = params.permissionLevel
      draftModeId.value = params.modeId ?? null
      if (session) {
        session.permissionLevel = params.permissionLevel
        session.modeId = params.modeId ?? null
      }
    }
    else if (params.modeId) {
      const mapped = mapAcpModeIdToPermissionLevel(params.modeId)
      const nextLevel = mapped ?? `ask`
      draftPermissionLevel.value = nextLevel
      draftModeId.value = params.modeId
      if (session) {
        session.permissionLevel = nextLevel
        session.modeId = params.modeId
      }
    }

    if (session?.acpSessionId && window.mdDesktop?.acp) {
      try {
        const result = await window.mdDesktop.acp.setPermissionMode({
          sessionId: session.acpSessionId,
          permissionLevel: params.permissionLevel,
          modeId: params.modeId,
        })
        session.permissionLevel = result.permissionLevel
        session.modeId = result.modeId
      }
      catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    }

    if (session)
      void persistSessions()
  }

  function createSessionRecord(title?: string): AgentConversationSession {
    const post = postStore.currentPost
    const session: AgentConversationSession = {
      id: uuidv4(),
      acpSessionId: null,
      agentId: selectedAgentId.value,
      modelId: selectedModel.value?.id ?? null,
      permissionLevel: draftPermissionLevel.value,
      modeId: draftModeId.value,
      postId: post?.id ?? ``,
      title: title || post?.title || t(`agent.panel.defaultTitle`),
      items: [],
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    return session
  }

  async function startNewSession(): Promise<void> {
    const current = activeSession.value
    if (current?.acpSessionId && window.mdDesktop?.acp)
      await window.mdDesktop.acp.closeSession(current.acpSessionId).catch(() => undefined)
    draftPermissionLevel.value = settings.value.defaultPermissionLevel
    draftModeId.value = null
    createSessionRecord()
    await persistSessions()
  }

  async function switchSession(id: string): Promise<void> {
    const target = sessions.value.find(s => s.id === id)
    if (!target)
      return
    activeSessionId.value = target.id
    if (target.agentId)
      selectedAgentId.value = target.agentId
    if (target.modelId)
      selectedModelByAgent.value[target.agentId] = target.modelId
  }

  async function deleteSession(id: string): Promise<void> {
    const target = sessions.value.find(s => s.id === id)
    if (target?.acpSessionId && window.mdDesktop?.acp)
      await window.mdDesktop.acp.closeSession(target.acpSessionId).catch(() => undefined)

    sessions.value = sessions.value.filter(s => s.id !== id)
    if (activeSessionId.value === id)
      activeSessionId.value = sessions.value[0]?.id ?? null
    await persistSessions()
  }

  async function sendPrompt(rawText: string, attachments: string[] = []): Promise<void> {
    const text = rawText.trim()
    if (!text || !window.mdDesktop?.acp)
      return

    const agent = selectedAgent.value
    if (!agent?.installed) {
      toast.error(t(`agent.composer.noAgentInstalled`))
      return
    }

    isNewArticleHero.value = false
    isPanelOpen.value = true

    const post = postStore.currentPost
    const postId = post?.id ?? ``
    const postTitle = post?.title ?? t(`agent.newArticle.untitled`)
    const content = editorStore.editor ? editorStore.getContent() : (post?.content ?? ``)

    let session = activeSession.value
    if (!session || (session.acpSessionId && session.agentId !== agent.id)) {
      const derivedTitle = text.length > 22 ? `${text.slice(0, 22)}…` : text
      session = createSessionRecord(derivedTitle)
    }
    else if (session.items.length === 0) {
      session.title = text.length > 22 ? `${text.slice(0, 22)}…` : text
      session.agentId = agent.id
      session.postId = postId
    }

    session.items.push({
      type: `user`,
      id: uuidv4(),
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
    })
    session.updatedAt = Date.now()
    void persistSessions()

    try {
      if (!session.acpSessionId) {
        const started = await window.mdDesktop.acp.startSession({
          agentId: agent.id,
          modelId: selectedModel.value?.id ?? null,
          permissionLevel: session.permissionLevel ?? draftPermissionLevel.value,
          modeId: session.modeId ?? draftModeId.value,
          postId,
          postTitle,
          content,
        })
        session.acpSessionId = started.sessionId
        session.modelId = started.modelId
        session.permissionLevel = started.permissionLevel
        session.modeId = started.currentModeId
        if (started.models.length > 0 || started.modes.length > 0) {
          probeByAgent.value = {
            ...probeByAgent.value,
            [agent.id]: {
              agentId: agent.id,
              models: started.models.length > 0 ? started.models : (probeByAgent.value[agent.id]?.models ?? []),
              currentModelId: started.modelId ?? probeByAgent.value[agent.id]?.currentModelId ?? null,
              modes: started.modes.length > 0 ? started.modes : (probeByAgent.value[agent.id]?.modes ?? []),
              currentModeId: started.currentModeId ?? probeByAgent.value[agent.id]?.currentModeId ?? null,
              commands: started.commands.length > 0 ? started.commands : (probeByAgent.value[agent.id]?.commands ?? []),
              probedAt: Date.now(),
            },
          }
        }
        if (started.modelId)
          selectedModelByAgent.value[agent.id] = started.modelId
      }

      await window.mdDesktop.acp.prompt({
        sessionId: session.acpSessionId,
        text,
        attachments,
        content,
        postTitle,
      })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const last = session.items[session.items.length - 1]
      if (last?.type !== `error` || last.message !== message) {
        session.items.push({
          type: `error`,
          id: uuidv4(),
          message,
          timestamp: Date.now(),
        })
      }
      void persistSessions()
    }
  }

  async function stopTurn(): Promise<void> {
    const acpId = activeSession.value?.acpSessionId
    if (!acpId || !window.mdDesktop?.acp)
      return
    await window.mdDesktop.acp.cancelTurn(acpId)
  }

  async function respondPermission(
    requestId: string,
    decision: AcpPermissionDecision,
    optionId?: string,
  ): Promise<void> {
    const session = activeSession.value
    const acpId = session?.acpSessionId
    if (!acpId || !window.mdDesktop?.acp)
      return
    await window.mdDesktop.acp.respondPermission({
      sessionId: acpId,
      requestId,
      decision,
      optionId,
    })
  }

  async function updateSettings(patch: Partial<AcpSettings>): Promise<void> {
    if (!window.mdDesktop?.acp)
      return
    settings.value = await window.mdDesktop.acp.updateSettings(patch)
    if (patch.defaultPermissionLevel && !activeSession.value?.acpSessionId) {
      draftPermissionLevel.value = settings.value.defaultPermissionLevel
      draftModeId.value = null
      if (activeSession.value && activeSession.value.items.length === 0) {
        activeSession.value.permissionLevel = settings.value.defaultPermissionLevel
        activeSession.value.modeId = null
      }
    }
    ensureValidSelectedAgent()
  }

  async function addCustomAgent(input: {
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
  }): Promise<void> {
    if (!window.mdDesktop?.acp)
      return
    agents.value = await window.mdDesktop.acp.addCustomAgent(input)
    settings.value = await window.mdDesktop.acp.getSettings()
    ensureValidSelectedAgent()
  }

  async function removeCustomAgent(agentId: string): Promise<void> {
    if (!window.mdDesktop?.acp)
      return
    agents.value = await window.mdDesktop.acp.removeCustomAgent(agentId)
    settings.value = await window.mdDesktop.acp.getSettings()
    ensureValidSelectedAgent()
  }

  async function installAgent(agentId: string): Promise<{ ok: boolean, error?: string }> {
    if (!window.mdDesktop?.acp)
      return { ok: false, error: `Desktop bridge unavailable` }
    const targetName = agents.value.find(a => a.id === agentId)?.name ?? agentId
    const result = await window.mdDesktop.acp.installAgent(agentId)
    if (result.ok) {
      toast.success(t(`agent.settings.installSuccess`, { name: targetName }))
      void probeAgent(agentId, true)
    }
    else if (result.error && !/cancel/i.test(result.error)) {
      toast.error(t(`agent.settings.installFailed`, { name: targetName, error: result.error }))
    }
    return result
  }

  async function cancelInstall(agentId: string): Promise<void> {
    await window.mdDesktop?.acp.cancelInstall(agentId)
  }

  onScopeDispose(() => {
    unsubscribeEvents?.()
    unsubscribeEvents = null
  })

  return {
    isDesktop,
    agents,
    settings,
    probeByAgent,
    probingAgents,
    selectedAgentId,
    selectedModelByAgent,
    selectedAgent,
    selectedModel,
    isPanelOpen,
    isSidebarOpen,
    layoutWidths,
    isNewArticleHero,
    sessions,
    activeSessionId,
    activeSession,
    isCurrentSessionRunning,
    writingPostIds,
    isCurrentPostWriting,
    activePendingPermissions,
    isWaitingPermission,
    currentPermissionLevel,
    currentModeId,
    availableModes,
    customExtraModes,
    activeCustomMode,
    currentActivityLabel,

    init,
    togglePanel,
    setPanelOpen,
    toggleSidebar,
    setSidebarOpen,
    setLayoutWidth,
    resetLayoutWidth,
    detectAgents,
    probeAgent,
    selectAgentAndModel,
    setSessionPermissionMode,
    startNewSession,
    switchSession,
    deleteSession,
    sendPrompt,
    stopTurn,
    respondPermission,
    updateSettings,
    addCustomAgent,
    removeCustomAgent,
    installAgent,
    cancelInstall,
  }
})
