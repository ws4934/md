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
  AcpSlashCommand,
  AcpThinkingOption,
  AcpToolCallItem,
} from '@md/shared/types'
import type { DesktopLayoutWidths } from '@/lib/agent/desktop-layout'
import { createDefaultAcpSettings, getCustomExtraModes, mapAcpModeIdToPermissionLevel } from '@md/shared/utils/acp-permissions'
import {
  getModelThinkingOptions,
  hasVariantModels,
  parseVariantModelId,
  resolveThinkingLevelForModel,
} from '@md/shared/utils/acp-thinking'
import { computeCompactDiff } from '@md/shared/utils/compact-diff'
import { uuidv4 } from '@md/shared/utils/uuid'
import { toRaw } from 'vue'
import { useImageUploader } from '@/composables/useImageUploader'
import { t } from '@/i18n/translate'
import {
  clampLayoutWidth,
  DEFAULT_DESKTOP_LAYOUT_WIDTHS,
  DESKTOP_LAYOUT_LIMITS,
  normalizeDesktopLayoutWidths,
} from '@/lib/agent/desktop-layout'
import { findLocalImageRefs, replaceImageRefs } from '@/lib/agent/workspace-images'
import { store } from '@/storage'
import { useEditorStore } from '@/stores/editor'
import { usePostStore } from '@/stores/post'

export type AgentTimelineItem
  = | { type: `user`, id: string, text: string, attachments?: string[], timestamp: number }
    | {
      type: `assistant`
      id: string
      text: string
      thought?: string
      thoughtStartedAt?: number
      thoughtDurationMs?: number
      streaming?: boolean
      timestamp: number
    }
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
  thinkingLevel?: string | null
  thinkingOptions?: AcpThinkingOption[]
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
const MAX_STORED_ITEMS_PER_SESSION = 200
const MAX_LIVE_ITEMS_PER_SESSION = 400
const MAX_ANNOUNCED_COMMAND_SESSIONS = 60
const IPC_INVOKE_PREFIX_RE = /^Error invoking remote method '[^']+': (?:Error: )?/

function extractErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(IPC_INVOKE_PREFIX_RE, ``)
}

function compactDiffPayload<T extends { oldText?: string, newText?: string, unifiedDiff?: string, diffStats?: AcpToolCallItem[`diffStats`] }>(
  payload: T,
): T {
  if (payload.oldText === undefined && payload.newText === undefined)
    return payload
  const { oldText, newText, ...rest } = payload
  if (rest.unifiedDiff && rest.diffStats)
    return rest as T
  const compact = computeCompactDiff({
    oldText,
    newText,
    unifiedDiff: rest.unifiedDiff,
  })
  return {
    ...rest,
    unifiedDiff: compact.unifiedDiff || undefined,
    diffStats: compact.stats,
  } as T
}

function sanitizeItemForStorage(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type === `assistant`) {
    const thoughtDurationMs = item.thoughtStartedAt !== undefined && item.thoughtDurationMs === undefined
      ? Math.max(0, Date.now() - item.thoughtStartedAt)
      : item.thoughtDurationMs
    return {
      ...item,
      ...(thoughtDurationMs !== undefined ? { thoughtDurationMs } : {}),
      streaming: false,
    }
  }
  if (item.type === `tool_call`) {
    const tool = item.tool.status === `in_progress` || item.tool.status === `pending`
      ? { ...item.tool, status: `failed` as const }
      : item.tool
    return { ...item, tool: compactDiffPayload(tool) }
  }
  if (item.type === `permission`) {
    return {
      ...item,
      request: compactDiffPayload(item.request),
      resolvedOutcome: item.resolvedOutcome ?? `cancelled`,
    }
  }
  return item
}

function normalizePersistedSessions(raw: unknown): AgentConversationSession[] {
  if (!Array.isArray(raw))
    return []
  const normalized: AgentConversationSession[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== `object`)
      continue
    const candidate = entry as Partial<AgentConversationSession>
    if (typeof candidate.id !== `string` || !candidate.id)
      continue
    const rawItems = Array.isArray(candidate.items) ? candidate.items : []
    const items = rawItems
      .filter((item): item is AgentTimelineItem => Boolean(item && typeof item === `object` && `type` in item && `id` in item))
      .slice(-MAX_STORED_ITEMS_PER_SESSION)
      .map(sanitizeItemForStorage)
    normalized.push({
      id: candidate.id,
      acpSessionId: null,
      agentId: typeof candidate.agentId === `string` && candidate.agentId ? candidate.agentId : `claude`,
      modelId: typeof candidate.modelId === `string` ? candidate.modelId : null,
      ...(candidate.thinkingLevel !== undefined ? { thinkingLevel: candidate.thinkingLevel } : {}),
      ...(candidate.permissionLevel !== undefined ? { permissionLevel: candidate.permissionLevel } : {}),
      ...(candidate.modeId !== undefined ? { modeId: candidate.modeId } : {}),
      postId: typeof candidate.postId === `string` ? candidate.postId : ``,
      title: typeof candidate.title === `string` && candidate.title ? candidate.title : t(`agent.panel.defaultTitle`),
      items,
      updatedAt: typeof candidate.updatedAt === `number` && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0,
    })
  }
  normalized.sort((a, b) => b.updatedAt - a.updatedAt)
  return normalized.slice(0, MAX_STORED_SESSIONS)
}

export const useAgentStore = defineStore(`agent`, () => {
  const postStore = usePostStore()
  const editorStore = useEditorStore()

  const isDesktop = computed(() => Boolean(window.mdDesktop?.isDesktop))

  const agents = ref<AcpAgentStatus[]>([])
  const settings = ref<AcpSettings>(createDefaultAcpSettings())
  const probeByAgent = ref<Record<string, AcpProbeResult>>({})
  const probingAgents = ref<Record<string, boolean>>({})

  const selectedAgentId = ref<string>(`claude`)
  const selectedModelByAgent = ref<Record<string, string>>({})
  const selectedThinkingLevelByAgent = ref<Record<string, string>>({})
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
  const startingSessionIds = ref<Record<string, boolean>>({})
  const abortedStartSessionIds = new Set<string>()
  // Keyed by ACP session id so announcements arriving before `startSession` resolves are kept.
  // Presence means the agent announced; an empty list is authoritative (no probe fallback).
  const announcedCommandsBySession = ref<Record<string, AcpSlashCommand[]>>({})

  function setSessionStarting(localSessionId: string, starting: boolean): void {
    if (starting) {
      if (!startingSessionIds.value[localSessionId])
        startingSessionIds.value = { ...startingSessionIds.value, [localSessionId]: true }
      return
    }
    if (localSessionId in startingSessionIds.value) {
      const next = { ...startingSessionIds.value }
      delete next[localSessionId]
      startingSessionIds.value = next
    }
  }

  let initialized = false
  let unsubscribeEvents: (() => void) | null = null

  const activeSession = computed<AgentConversationSession | null>(() => {
    if (!activeSessionId.value)
      return null
    return sessions.value.find(s => s.id === activeSessionId.value) ?? null
  })

  const isCurrentSessionRunning = computed(() => {
    const session = activeSession.value
    if (!session)
      return false
    if (startingSessionIds.value[session.id])
      return true
    return Boolean(session.acpSessionId && runningAcpSessions.value[session.acpSessionId])
  })

  const writingPostIds = computed<Set<string>>(() => {
    const ids = new Set<string>()
    for (const s of sessions.value) {
      if (!s.postId)
        continue
      if (startingSessionIds.value[s.id] || (s.acpSessionId && runningAcpSessions.value[s.acpSessionId]))
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
    const rawChosenId = selectedModelByAgent.value[agent.id]
      ?? settings.value.lastModelByAgent[agent.id]
      ?? probe?.currentModelId
      ?? probe?.models[0]?.id
      ?? null
    if (!rawChosenId)
      return null
    const parsed = parseVariantModelId(rawChosenId, probe?.models ?? [])
    const baseId = parsed.baseModelId ?? rawChosenId
    const found = probe?.models.find(m => m.id === baseId)
    return found ?? { id: baseId, name: baseId }
  })

  const availableThinkingOptions = computed<AcpThinkingOption[]>(() => {
    const agent = selectedAgent.value
    if (!agent)
      return []
    const probe = probeByAgent.value[agent.id]
    const active = activeSession.value
    const sessionOptions
      = active?.acpSessionId && active.agentId === agent.id && active.thinkingOptions !== undefined
        ? active.thinkingOptions
        : probe?.thinkingOptions
    return getModelThinkingOptions(selectedModel.value, sessionOptions, probe?.models)
  })

  const selectedThinkingLevel = computed<string | null>(() => {
    const options = availableThinkingOptions.value
    if (options.length === 0)
      return null
    const agent = selectedAgent.value
    const probe = agent ? probeByAgent.value[agent.id] : undefined
    const model = selectedModel.value
    const active = activeSession.value

    const sessionLevel = active && agent && active.agentId === agent.id
      ? active.thinkingLevel
      : null

    const rawModelId = agent
      ? (selectedModelByAgent.value[agent.id] ?? settings.value.lastModelByAgent[agent.id] ?? null)
      : null
    const legacyLevel = parseVariantModelId(rawModelId, probe?.models ?? []).thinkingLevel

    const probeDefaultLevel = probe?.currentThinkingLevel
      && (!hasVariantModels(probe.models) || model?.id === probe.currentModelId)
      ? probe.currentThinkingLevel
      : null

    const desired
      = sessionLevel
        ?? (agent ? selectedThinkingLevelByAgent.value[agent.id] : null)
        ?? (agent ? settings.value.lastThinkingLevelByAgent[agent.id] : null)
        ?? legacyLevel
        ?? probeDefaultLevel
        ?? model?.defaultThinkingLevel
        ?? null

    return resolveThinkingLevelForModel(options, desired, model?.defaultThinkingLevel)
  })

  const activeSessionForSelectedAgent = computed<AgentConversationSession | null>(() => {
    const active = activeSession.value
    if (!active)
      return null
    const agent = selectedAgent.value
    if (agent && active.agentId !== agent.id)
      return null
    return active
  })

  const currentPermissionLevel = computed<AcpPermissionLevel>(
    () => activeSessionForSelectedAgent.value?.permissionLevel ?? draftPermissionLevel.value,
  )

  const currentModeId = computed<string | null>(
    () => activeSessionForSelectedAgent.value?.modeId ?? draftModeId.value,
  )

  const availableModes = computed<AcpModeInfo[]>(() => {
    const agent = selectedAgent.value
    if (!agent)
      return []
    return probeByAgent.value[agent.id]?.modes ?? []
  })

  const customExtraModes = computed<AcpModeInfo[]>(() => getCustomExtraModes(availableModes.value))

  const availableCommands = computed<AcpSlashCommand[]>(() => {
    const agent = selectedAgent.value
    if (!agent)
      return []
    // After an agent switch the old live session is only closed on the next send; its commands belong to the old agent.
    const active = activeSession.value
    const acpId = active?.agentId === agent.id ? active.acpSessionId : null
    if (acpId && acpId in announcedCommandsBySession.value)
      return announcedCommandsBySession.value[acpId]
    return probeByAgent.value[agent.id]?.commands ?? []
  })

  const activeCustomMode = computed<AcpModeInfo | null>(() => {
    if (currentPermissionLevel.value !== `ask`)
      return null
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

  interface CachedSessionSnapshot {
    updatedAt: number
    modelId: string | null
    thinkingLevel: string | null | undefined
    permissionLevel: AcpPermissionLevel | undefined
    modeId: string | null | undefined
    title: string
    postId: string
    agentId: string
    itemsLen: number
    lastItem: AgentTimelineItem | undefined
    snapshot: Omit<AgentConversationSession, `thinkingOptions`>
  }
  const persistedSessionCache = new WeakMap<object, CachedSessionSnapshot>()

  function toSerializableSession(s: AgentConversationSession): Omit<AgentConversationSession, `thinkingOptions`> {
    const raw = toRaw(s)
    const itemsLen = s.items.length
    const lastItem = itemsLen > 0 ? toRaw(s.items[itemsLen - 1]) : undefined
    const cached = !s.acpSessionId ? persistedSessionCache.get(raw) : undefined
    if (
      cached
      && cached.updatedAt === s.updatedAt
      && cached.modelId === s.modelId
      && cached.thinkingLevel === s.thinkingLevel
      && cached.permissionLevel === s.permissionLevel
      && cached.modeId === s.modeId
      && cached.title === s.title
      && cached.postId === s.postId
      && cached.agentId === s.agentId
      && cached.itemsLen === itemsLen
      && cached.lastItem === lastItem
    ) {
      return cached.snapshot
    }
    const { thinkingOptions: _liveOptions, ...rest } = s
    const snapshot: Omit<AgentConversationSession, `thinkingOptions`> = {
      ...rest,
      acpSessionId: null,
      items: s.items.slice(-MAX_STORED_ITEMS_PER_SESSION).map(sanitizeItemForStorage),
    }
    if (!s.acpSessionId) {
      persistedSessionCache.set(raw, {
        updatedAt: s.updatedAt,
        modelId: s.modelId,
        thinkingLevel: s.thinkingLevel,
        permissionLevel: s.permissionLevel,
        modeId: s.modeId,
        title: s.title,
        postId: s.postId,
        agentId: s.agentId,
        itemsLen,
        lastItem,
        snapshot,
      })
    }
    return snapshot
  }

  async function persistSessions(): Promise<void> {
    const serializable = [...sessions.value]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_STORED_SESSIONS)
      .map(toSerializableSession)
    await store.setJSON(SESSIONS_STORAGE_KEY, serializable)
  }

  function pruneInactiveSessions(): void {
    if (sessions.value.length <= MAX_STORED_SESSIONS)
      return
    const protectedIds = new Set<string>()
    if (activeSessionId.value)
      protectedIds.add(activeSessionId.value)
    for (const s of sessions.value) {
      if (s.acpSessionId || startingSessionIds.value[s.id])
        protectedIds.add(s.id)
    }
    const candidates = sessions.value
      .filter(s => !protectedIds.has(s.id))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const excess = sessions.value.length - MAX_STORED_SESSIONS
    if (excess <= 0 || candidates.length === 0)
      return
    const dropIds = new Set(candidates.slice(0, excess).map(s => s.id))
    sessions.value = sessions.value.filter(s => !dropIds.has(s.id))
  }

  function trimLiveItems(session: AgentConversationSession): void {
    if (session.items.length > MAX_LIVE_ITEMS_PER_SESSION)
      session.items.splice(0, session.items.length - MAX_LIVE_ITEMS_PER_SESSION)
  }

  function findSessionByAcpId(acpSessionId: string): AgentConversationSession | undefined {
    return sessions.value.find(s => s.acpSessionId === acpSessionId)
  }

  function isEditorBoundToPost(postId: string): boolean {
    if (!editorStore.editor)
      return false
    return !editorStore.activePostId || editorStore.activePostId === postId
  }

  function findLatestSessionForPost(postId: string): AgentConversationSession | null {
    if (!postId)
      return null
    let best: AgentConversationSession | null = null
    for (const s of sessions.value) {
      if (s.postId !== postId)
        continue
      if (!best) {
        best = s
        continue
      }
      const bestLive = Boolean(best.acpSessionId)
      const curLive = Boolean(s.acpSessionId)
      if (curLive !== bestLive) {
        if (curLive)
          best = s
        continue
      }
      if (s.updatedAt > best.updatedAt)
        best = s
    }
    return best
  }

  /**
   * Dispatches into CodeMirror BEFORE updating postStore so EditorPanel's content
   * watcher sees an already-matching document and does not reset undo history.
   * Uses minimal changed range to preserve selection, scroll, and incremental parse state.
   */
  function applySyncedArticleContent(postId: string, content: string): void {
    if (postStore.currentPostId === postId && isEditorBoundToPost(postId)) {
      if (editorStore.getContent() !== content)
        editorStore.applyMinimalContent(content)
    }
    const existing = postStore.getPostById(postId)
    if (existing && existing.content !== content)
      postStore.updatePostContent(postId, content)
  }

  const imageUploader = useImageUploader()
  // Keyed `${acpSessionId}\u0000${ref}`: in-flight uploads shared by overlapping syncs, and errors already shown.
  const workspaceImageUploads = new Map<string, Promise<string | null>>()
  const reportedImageErrors = new Set<string>()

  function clearReportedErrorsForSession(acpSessionId: string): void {
    const prefix = `${acpSessionId}\u0000`
    for (const key of reportedImageErrors) {
      if (key.startsWith(prefix))
        reportedImageErrors.delete(key)
    }
  }

  function uploadWorkspaceImage(
    acpSessionId: string,
    ref: string,
    targetSession?: AgentConversationSession,
  ): Promise<string | null> {
    const key = `${acpSessionId}\u0000${ref}`
    const inFlight = workspaceImageUploads.get(key)
    if (inFlight)
      return inFlight
    const pending = (async () => {
      try {
        const image = await window.mdDesktop!.acp.readWorkspaceImage({ sessionId: acpSessionId, path: ref })
        // The uploader caches by content hash, so later syncs of an unchanged file skip the network.
        const uploadedUrl = await imageUploader.upload(
          new File([image.data as BlobPart], image.filename, { type: image.mimeType }),
        )
        if (!uploadedUrl)
          throw new Error(t(`store.uploader.uploadFailed`))
        return uploadedUrl
      }
      catch (error) {
        const message = extractErrorMessage(error)
        const errorKey = `${key}\u0000${message}`
        if (!reportedImageErrors.has(errorKey)) {
          const session = targetSession ?? findSessionByAcpId(acpSessionId)
          if (session?.acpSessionId === acpSessionId)
            reportedImageErrors.add(errorKey)
          if (session) {
            session.items.push({
              type: `error`,
              id: uuidv4(),
              message: t(`agent.imageUploadFailed`, { path: ref, message }),
              timestamp: Date.now(),
            })
            trimLiveItems(session)
            session.updatedAt = Date.now()
            void persistSessions()
          }
        }
        return null
      }
      finally {
        workspaceImageUploads.delete(key)
      }
    })()
    workspaceImageUploads.set(key, pending)
    return pending
  }

  /** Uploads images the agent saved in its workspace and swaps their local paths for hosted URLs. */
  async function uploadSyncedWorkspaceImages(
    acpSessionId: string,
    postId: string,
    content: string,
    targetSession?: AgentConversationSession,
  ): Promise<void> {
    const refs = findLocalImageRefs(content)
    if (refs.length === 0 || !window.mdDesktop?.acp)
      return
    const urls = new Map<string, string>()
    await Promise.all(refs.map(async (ref) => {
      const url = await uploadWorkspaceImage(acpSessionId, ref, targetSession)
      if (url)
        urls.set(ref, url)
    }))
    if (urls.size === 0)
      return
    // Rewrite whatever the post holds now so edits made during the upload are kept.
    const current = postStore.currentPostId === postId && isEditorBoundToPost(postId)
      ? editorStore.getContent()
      : postStore.getPostById(postId)?.content
    if (current !== undefined)
      applySyncedArticleContent(postId, replaceImageRefs(current, urls))
  }

  function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i]))
        return i
    }
    return -1
  }

  // Coalesce high-frequency streaming deltas per animation frame in arrival order.
  interface PendingChunkSegment { kind: `text` | `thought`, text: string }
  const pendingChunks = new Map<string, PendingChunkSegment[]>()
  let chunkFlushHandle = 0

  function finalizeAssistantThought(item: AgentTimelineItem | undefined): void {
    if (item?.type !== `assistant`)
      return
    if (item.thoughtStartedAt !== undefined && item.thoughtDurationMs === undefined)
      item.thoughtDurationMs = Math.max(0, Date.now() - item.thoughtStartedAt)
  }

  function finalizeClosedSessionItems(session: AgentConversationSession): boolean {
    let changed = false
    for (let i = 0; i < session.items.length; i++) {
      const item = session.items[i]
      if (item.type === `assistant` && item.streaming) {
        finalizeAssistantThought(item)
        item.streaming = false
        changed = true
      }
      else if (item.type === `permission` && !item.resolvedOutcome) {
        item.resolvedOutcome = `cancelled`
        changed = true
      }
      else if (item.type === `tool_call` && (item.tool.status === `in_progress` || item.tool.status === `pending`)) {
        item.tool = { ...item.tool, status: `failed` }
        changed = true
      }
    }
    return changed
  }

  function cleanupAcpSessionRuntime(acpSessionId: string): void {
    if (pendingChunks.delete(acpSessionId) && pendingChunks.size === 0 && chunkFlushHandle && typeof cancelAnimationFrame === `function`) {
      cancelAnimationFrame(chunkFlushHandle)
      chunkFlushHandle = 0
    }
    if (acpSessionId in runningAcpSessions.value) {
      const nextRunning = { ...runningAcpSessions.value }
      delete nextRunning[acpSessionId]
      runningAcpSessions.value = nextRunning
    }
    if (acpSessionId in announcedCommandsBySession.value) {
      const nextCommands = { ...announcedCommandsBySession.value }
      delete nextCommands[acpSessionId]
      announcedCommandsBySession.value = nextCommands
    }
    clearReportedErrorsForSession(acpSessionId)
  }

  function setAnnouncedCommands(acpSessionId: string, commands: AcpSlashCommand[]): void {
    const next = { ...announcedCommandsBySession.value, [acpSessionId]: commands }
    const keys = Object.keys(next)
    if (keys.length > MAX_ANNOUNCED_COMMAND_SESSIONS) {
      const activeAcpIds = new Set(sessions.value.map(s => s.acpSessionId).filter((id): id is string => Boolean(id)))
      for (const key of keys) {
        if (Object.keys(next).length <= MAX_ANNOUNCED_COMMAND_SESSIONS)
          break
        if (key !== acpSessionId && !activeAcpIds.has(key))
          delete next[key]
      }
    }
    announcedCommandsBySession.value = next
  }

  function applyChunkSegments(sessionId: string, segments: readonly PendingChunkSegment[]): void {
    const session = findSessionByAcpId(sessionId)
    if (!session || segments.length === 0)
      return

    for (const seg of segments) {
      if (!seg.text)
        continue
      if (seg.kind === `thought`) {
        const last = session.items[session.items.length - 1]
        // Only merge into an active assistant item before any output text has streamed;
        // interleaved thoughts after text start a new assistant block to preserve timeline order.
        if (last?.type === `assistant` && last.streaming && !last.text) {
          last.thoughtStartedAt ??= Date.now()
          last.thought = (last.thought ?? ``) + seg.text
        }
        else {
          if (last?.type === `assistant` && last.streaming)
            last.streaming = false
          const now = Date.now()
          session.items.push({
            type: `assistant`,
            id: uuidv4(),
            text: ``,
            thought: seg.text,
            thoughtStartedAt: now,
            streaming: true,
            timestamp: now,
          })
          trimLiveItems(session)
        }
      }
      else {
        const last = session.items[session.items.length - 1]
        if (last?.type === `assistant` && last.streaming) {
          finalizeAssistantThought(last)
          last.text += seg.text
        }
        else {
          session.items.push({
            type: `assistant`,
            id: uuidv4(),
            text: seg.text,
            streaming: true,
            timestamp: Date.now(),
          })
          trimLiveItems(session)
        }
      }
    }

    session.updatedAt = Date.now()
  }

  function flushPendingChunks(sessionId?: string): void {
    if (sessionId) {
      const segments = pendingChunks.get(sessionId)
      if (!segments)
        return
      pendingChunks.delete(sessionId)
      applyChunkSegments(sessionId, segments)
      if (pendingChunks.size === 0 && chunkFlushHandle && typeof cancelAnimationFrame === `function`) {
        cancelAnimationFrame(chunkFlushHandle)
        chunkFlushHandle = 0
      }
      return
    }

    chunkFlushHandle = 0
    if (pendingChunks.size === 0)
      return
    const entries = [...pendingChunks.entries()]
    pendingChunks.clear()
    for (const [sid, segments] of entries)
      applyChunkSegments(sid, segments)
  }

  function queueChunk(sessionId: string, kind: `text` | `thought`, delta: string): void {
    if (!delta)
      return
    let segments = pendingChunks.get(sessionId)
    if (!segments) {
      segments = [{ kind, text: delta }]
      pendingChunks.set(sessionId, segments)
    }
    else {
      const tail = segments[segments.length - 1]
      if (tail.kind === kind)
        tail.text += delta
      else
        segments.push({ kind, text: delta })
    }

    if (typeof requestAnimationFrame !== `function`) {
      flushPendingChunks(sessionId)
      return
    }
    if (!chunkFlushHandle) {
      chunkFlushHandle = requestAnimationFrame(() => flushPendingChunks())
    }
  }

  function handleHostEvent(event: AcpHostEvent): void {
    if (event.type === `message_chunk`) {
      queueChunk(event.sessionId, `text`, event.text)
      return
    }
    if (event.type === `thought_chunk`) {
      queueChunk(event.sessionId, `thought`, event.text)
      return
    }

    // Flush any buffered chunks for this session before applying structural/terminal events.
    if (`sessionId` in event && typeof event.sessionId === `string`)
      flushPendingChunks(event.sessionId)

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
        const session = findSessionByAcpId(event.sessionId)
        if (session)
          setSessionStarting(session.id, false)
        break
      }
      case `turn_finished`: {
        const nextRunning = { ...runningAcpSessions.value }
        delete nextRunning[event.sessionId]
        runningAcpSessions.value = nextRunning
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          setSessionStarting(session.id, false)
          const last = session.items[session.items.length - 1]
          if (last?.type === `assistant`) {
            finalizeAssistantThought(last)
            last.streaming = false
          }
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
          setSessionStarting(session.id, false)
          const last = session.items[session.items.length - 1]
          if (last?.type === `assistant`) {
            finalizeAssistantThought(last)
            last.streaming = false
          }
          session.items.push({
            type: `error`,
            id: uuidv4(),
            message: event.message,
            timestamp: Date.now(),
          })
          trimLiveItems(session)
          session.updatedAt = Date.now()
          void persistSessions()
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
        if (last?.type === `assistant`) {
          finalizeAssistantThought(last)
          last.streaming = false
        }
        session.items.push({
          type: `plan`,
          id: uuidv4(),
          entries: event.entries,
          timestamp: Date.now(),
        })
        trimLiveItems(session)
        break
      }
      case `tool_call`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const compactedTool = compactDiffPayload(event.tool)
        const existing = session.items.find(
          item => item.type === `tool_call` && item.tool.id === compactedTool.id,
        )
        if (existing && existing.type === `tool_call`) {
          existing.tool = compactedTool
        }
        else {
          const last = session.items[session.items.length - 1]
          if (last?.type === `assistant`) {
            finalizeAssistantThought(last)
            last.streaming = false
          }
          session.items.push({
            type: `tool_call`,
            id: compactedTool.id,
            tool: compactedTool,
            timestamp: Date.now(),
          })
          trimLiveItems(session)
        }
        break
      }
      case `permission_requested`: {
        const session = findSessionByAcpId(event.sessionId)
        if (!session)
          return
        const last = session.items[session.items.length - 1]
        if (last?.type === `assistant`) {
          finalizeAssistantThought(last)
          last.streaming = false
        }
        session.items.push({
          type: `permission`,
          id: event.request.requestId,
          request: compactDiffPayload(event.request),
          timestamp: Date.now(),
        })
        trimLiveItems(session)
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
        const targetSession = findSessionByAcpId(event.sessionId)
        applySyncedArticleContent(event.postId, event.content)
        void uploadSyncedWorkspaceImages(event.sessionId, event.postId, event.content, targetSession)
        break
      }
      case `commands_updated`: {
        setAnnouncedCommands(event.sessionId, event.commands)
        break
      }
      case `model_changed`: {
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          const probe = probeByAgent.value[session.agentId]
          const parsed = parseVariantModelId(event.modelId, probe?.models ?? [])
          session.modelId = parsed.baseModelId
          if (parsed.baseModelId)
            selectedModelByAgent.value[session.agentId] = parsed.baseModelId
          if (parsed.thinkingLevel) {
            session.thinkingLevel = parsed.thinkingLevel
            selectedThinkingLevelByAgent.value[session.agentId] = parsed.thinkingLevel
          }
        }
        break
      }
      case `thinking_changed`: {
        const session = findSessionByAcpId(event.sessionId)
        if (session) {
          session.thinkingLevel = event.thinkingLevel
          if (event.thinkingLevel)
            selectedThinkingLevelByAgent.value[session.agentId] = event.thinkingLevel
          if (event.thinkingOptions !== undefined) {
            session.thinkingOptions = event.thinkingOptions
            const prevProbe = probeByAgent.value[session.agentId]
            if (prevProbe && event.thinkingOptions.length > 0 && !hasVariantModels(prevProbe.models)) {
              probeByAgent.value = {
                ...probeByAgent.value,
                [session.agentId]: {
                  ...prevProbe,
                  thinkingOptions: event.thinkingOptions,
                  currentThinkingLevel: event.thinkingLevel ?? prevProbe.currentThinkingLevel ?? null,
                },
              }
            }
          }
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
        const session = findSessionByAcpId(event.sessionId)
        cleanupAcpSessionRuntime(event.sessionId)
        if (session) {
          setSessionStarting(session.id, false)
          const mutated = finalizeClosedSessionItems(session)
          session.acpSessionId = null
          session.thinkingOptions = undefined
          if (mutated) {
            session.updatedAt = Date.now()
            void persistSessions()
          }
        }
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

    let loadedAgents: AcpAgentStatus[]
    let loadedSettings: AcpSettings
    let rawSavedSessions: unknown
    try {
      ;[loadedAgents, loadedSettings, rawSavedSessions] = await Promise.all([
        window.mdDesktop.acp.listAgents(),
        window.mdDesktop.acp.getSettings(),
        store.getJSON<unknown>(SESSIONS_STORAGE_KEY, []),
      ])
    }
    catch (error) {
      initialized = false
      unsubscribeEvents?.()
      unsubscribeEvents = null
      throw error
    }

    const savedSessions = normalizePersistedSessions(rawSavedSessions)
    agents.value = loadedAgents
    settings.value = loadedSettings
    draftPermissionLevel.value = loadedSettings.defaultPermissionLevel
    selectedModelByAgent.value = { ...loadedSettings.lastModelByAgent }
    selectedThinkingLevelByAgent.value = { ...(loadedSettings.lastThinkingLevelByAgent ?? {}) }
    sessions.value = savedSessions

    let matched: AgentConversationSession | null = null
    if (savedSessions.length > 0) {
      const currentId = postStore.currentPostId
      matched = currentId ? findLatestSessionForPost(currentId) : savedSessions[0]
      activeSessionId.value = matched?.id ?? null
      if (matched?.modelId)
        selectedModelByAgent.value[matched.agentId] = matched.modelId
      if (matched?.thinkingLevel)
        selectedThinkingLevelByAgent.value[matched.agentId] = matched.thinkingLevel
    }

    selectedAgentId.value = matched?.agentId || loadedSettings.defaultAgentId || selectedAgentId.value
    ensureValidSelectedAgent()

    if (selectedAgent.value?.installed)
      void probeAgent(selectedAgent.value.id)
  }

  async function refreshAgentsList(): Promise<void> {
    if (!window.mdDesktop?.acp)
      return
    agents.value = await window.mdDesktop.acp.listAgents()
    ensureValidSelectedAgent()
  }

  async function detectAgents(): Promise<void> {
    if (!window.mdDesktop?.acp)
      return
    agents.value = await window.mdDesktop.acp.detectAgents()
    ensureValidSelectedAgent()
  }

  // UI entry points (menu open, `/`, session switch) may fire together; non-forced callers share in-flight requests,
  // and `probeGeneration` prevents an older slow probe or invalidated probe from overwriting fresher state.
  const pendingProbes = new Map<string, Promise<AcpProbeResult | null>>()
  const pendingForcedProbes = new Map<string, Promise<AcpProbeResult | null>>()
  const probeGeneration = new Map<string, number>()
  const activeProbeCounts = new Map<string, number>()

  function invalidateProbe(agentId: string): void {
    probeGeneration.set(agentId, (probeGeneration.get(agentId) ?? 0) + 1)
    pendingProbes.delete(agentId)
    pendingForcedProbes.delete(agentId)
    if (!(agentId in probeByAgent.value))
      return
    const next = { ...probeByAgent.value }
    delete next[agentId]
    probeByAgent.value = next
  }

  // `commandsAnnounced: false` is a timed-out probe; ask again and let the main-process TTL decide whether to re-probe.
  function needsProbe(agentId: string): boolean {
    const cached = probeByAgent.value[agentId]
    return !cached || Boolean(cached.error) || cached.commandsAnnounced === false
  }

  async function probeAgent(agentId: string, force = false): Promise<AcpProbeResult | null> {
    if (!force && !needsProbe(agentId))
      return probeByAgent.value[agentId]
    const existingForced = pendingForcedProbes.get(agentId)
    if (existingForced)
      return existingForced
    if (!force) {
      const pending = pendingProbes.get(agentId)
      if (pending)
        return pending
    }
    const request = requestProbe(agentId, force)
    pendingProbes.set(agentId, request)
    if (force)
      pendingForcedProbes.set(agentId, request)
    try {
      return await request
    }
    finally {
      if (pendingProbes.get(agentId) === request)
        pendingProbes.delete(agentId)
      if (pendingForcedProbes.get(agentId) === request)
        pendingForcedProbes.delete(agentId)
    }
  }

  async function requestProbe(agentId: string, force: boolean): Promise<AcpProbeResult | null> {
    if (!window.mdDesktop?.acp)
      return null
    const seq = (probeGeneration.get(agentId) ?? 0) + 1
    probeGeneration.set(agentId, seq)
    const count = (activeProbeCounts.get(agentId) ?? 0) + 1
    activeProbeCounts.set(agentId, count)
    if (!probingAgents.value[agentId])
      probingAgents.value = { ...probingAgents.value, [agentId]: true }
    try {
      const result = await window.mdDesktop.acp.probeAgent(agentId, { force })
      if (probeGeneration.get(agentId) !== seq)
        return probeByAgent.value[agentId] ?? result
      probeByAgent.value = { ...probeByAgent.value, [agentId]: result }
      const existingModel = selectedModelByAgent.value[agentId]
      if (existingModel) {
        const parsed = parseVariantModelId(existingModel, result.models)
        const baseCandidate = parsed.baseModelId ?? existingModel
        const stillAvailable = result.models.length === 0 || result.models.some(m => m.id === baseCandidate)
        if (!stillAvailable) {
          const fallbackModel = result.currentModelId ?? result.models[0]?.id
          if (fallbackModel)
            selectedModelByAgent.value[agentId] = fallbackModel
          else
            delete selectedModelByAgent.value[agentId]
        }
        else if (parsed.baseModelId && parsed.baseModelId !== existingModel) {
          selectedModelByAgent.value[agentId] = parsed.baseModelId
        }
        if (stillAvailable && parsed.thinkingLevel && !selectedThinkingLevelByAgent.value[agentId])
          selectedThinkingLevelByAgent.value[agentId] = parsed.thinkingLevel
      }
      else if (result.currentModelId) {
        selectedModelByAgent.value[agentId] = result.currentModelId
      }
      // Migrate legacy variant model IDs on stored sessions once model metadata is available.
      if (result.models.length > 0) {
        for (const s of sessions.value) {
          if (s.agentId !== agentId || !s.modelId)
            continue
          const parsed = parseVariantModelId(s.modelId, result.models)
          if (parsed.baseModelId && parsed.baseModelId !== s.modelId) {
            s.modelId = parsed.baseModelId
            if (parsed.thinkingLevel && !s.thinkingLevel)
              s.thinkingLevel = parsed.thinkingLevel
          }
        }
      }
      return result
    }
    finally {
      const remaining = (activeProbeCounts.get(agentId) ?? 1) - 1
      if (remaining <= 0) {
        activeProbeCounts.delete(agentId)
        if (agentId in probingAgents.value) {
          const next = { ...probingAgents.value }
          delete next[agentId]
          probingAgents.value = next
        }
      }
      else {
        activeProbeCounts.set(agentId, remaining)
      }
    }
  }

  async function selectAgentAndModel(agentId: string, modelId?: string): Promise<void> {
    const switchedAgent = selectedAgentId.value !== agentId
    if (switchedAgent)
      draftModeId.value = null
    selectedAgentId.value = agentId

    const session = activeSession.value
    const isUnstartedEmptyDraft = Boolean(session && !session.acpSessionId && session.items.length === 0)
    if (switchedAgent && isUnstartedEmptyDraft && session) {
      session.agentId = agentId
      session.modeId = null
      session.modelId = null
      session.thinkingLevel = null
    }
    const probe = probeByAgent.value[agentId]
    const prevModelId = selectedModelByAgent.value[agentId]
    const prevThinking = selectedThinkingLevelByAgent.value[agentId]
    const prevSettingsModel = settings.value.lastModelByAgent[agentId]
    const prevSettingsThinking = settings.value.lastThinkingLevelByAgent[agentId]
    const prevSessionModel = session?.modelId
    const prevSessionThinking = session?.thinkingLevel
    const prevSessionThinkingOptions = session?.thinkingOptions

    let nextBaseModelId: string | undefined
    let nextThinkingLevel: string | null | undefined
    let settingsPatch: Partial<AcpSettings> | null = null

    if (modelId) {
      const parsed = parseVariantModelId(modelId, probe?.models ?? [])
      nextBaseModelId = parsed.baseModelId ?? modelId
      selectedModelByAgent.value = { ...selectedModelByAgent.value, [agentId]: nextBaseModelId }
      settings.value = {
        ...settings.value,
        lastModelByAgent: { ...settings.value.lastModelByAgent, [agentId]: nextBaseModelId },
      }

      const targetModel = probe?.models.find(m => m.id === nextBaseModelId)
      const sessionOptions
        = session?.acpSessionId && session.agentId === agentId && session.thinkingOptions !== undefined
          ? session.thinkingOptions
          : probe?.thinkingOptions
      const targetOptions = getModelThinkingOptions(targetModel, sessionOptions, probe?.models)
      const isVariantAgent = hasVariantModels(probe?.models)
      if (targetOptions.length > 0) {
        const currentDesired = parsed.thinkingLevel
          ?? (session?.agentId === agentId ? session.thinkingLevel : null)
          ?? selectedThinkingLevelByAgent.value[agentId]
          ?? settings.value.lastThinkingLevelByAgent[agentId]
          ?? probe?.currentThinkingLevel
          ?? null
        nextThinkingLevel = resolveThinkingLevelForModel(
          targetOptions,
          currentDesired,
          targetModel?.defaultThinkingLevel,
        )
        if (nextThinkingLevel) {
          selectedThinkingLevelByAgent.value = {
            ...selectedThinkingLevelByAgent.value,
            [agentId]: nextThinkingLevel,
          }
          settings.value = {
            ...settings.value,
            lastThinkingLevelByAgent: {
              ...settings.value.lastThinkingLevelByAgent,
              [agentId]: nextThinkingLevel,
            },
          }
        }
      }
      else if (!isVariantAgent) {
        // ConfigOption-only agents (e.g. Claude Code) may re-expose effort options when leaving a
        // no-effort model like Haiku, so forward the remembered level without mutating draft state.
        nextThinkingLevel = selectedThinkingLevelByAgent.value[agentId]
          ?? settings.value.lastThinkingLevelByAgent[agentId]
          ?? null
      }
      else {
        nextThinkingLevel = null
      }

      if (session && session.agentId === agentId) {
        session.modelId = nextBaseModelId
        session.thinkingLevel = targetOptions.length > 0 ? (nextThinkingLevel ?? null) : null
      }

      settingsPatch = {
        lastModelByAgent: { [agentId]: nextBaseModelId },
        ...(targetOptions.length > 0 && nextThinkingLevel ? { lastThinkingLevelByAgent: { [agentId]: nextThinkingLevel } } : {}),
      }
    }

    if (session?.acpSessionId && session.agentId === agentId && nextBaseModelId && window.mdDesktop?.acp) {
      try {
        const result = await window.mdDesktop.acp.setModel({
          sessionId: session.acpSessionId,
          modelId: nextBaseModelId,
          thinkingLevel: nextThinkingLevel,
        })
        session.modelId = result.modelId
        session.thinkingLevel = result.thinkingLevel
        if (result.modelId) {
          selectedModelByAgent.value = { ...selectedModelByAgent.value, [agentId]: result.modelId }
          settings.value = {
            ...settings.value,
            lastModelByAgent: { ...settings.value.lastModelByAgent, [agentId]: result.modelId },
          }
        }
        if (result.thinkingLevel) {
          selectedThinkingLevelByAgent.value = { ...selectedThinkingLevelByAgent.value, [agentId]: result.thinkingLevel }
          settings.value = {
            ...settings.value,
            lastThinkingLevelByAgent: {
              ...settings.value.lastThinkingLevelByAgent,
              [agentId]: result.thinkingLevel,
            },
          }
        }
      }
      catch (error) {
        const restoredModels = { ...selectedModelByAgent.value }
        if (prevModelId !== undefined)
          restoredModels[agentId] = prevModelId
        else
          delete restoredModels[agentId]
        selectedModelByAgent.value = restoredModels

        const restoredThinking = { ...selectedThinkingLevelByAgent.value }
        if (prevThinking !== undefined)
          restoredThinking[agentId] = prevThinking
        else
          delete restoredThinking[agentId]
        selectedThinkingLevelByAgent.value = restoredThinking

        const restoredSettingsModels = { ...settings.value.lastModelByAgent }
        if (prevSettingsModel !== undefined)
          restoredSettingsModels[agentId] = prevSettingsModel
        else
          delete restoredSettingsModels[agentId]

        const restoredSettingsThinking = { ...settings.value.lastThinkingLevelByAgent }
        if (prevSettingsThinking !== undefined)
          restoredSettingsThinking[agentId] = prevSettingsThinking
        else
          delete restoredSettingsThinking[agentId]

        settings.value = {
          ...settings.value,
          lastModelByAgent: restoredSettingsModels,
          lastThinkingLevelByAgent: restoredSettingsThinking,
        }

        session.modelId = prevSessionModel ?? null
        session.thinkingLevel = prevSessionThinking
        session.thinkingOptions = prevSessionThinkingOptions
        toast.error(extractErrorMessage(error))
        return
      }
    }
    else if (settingsPatch) {
      void window.mdDesktop?.acp.updateSettings(settingsPatch)
    }

    if (isUnstartedEmptyDraft && session && !modelId) {
      session.modelId = selectedModel.value?.id ?? null
      session.thinkingLevel = selectedThinkingLevel.value
    }

    if (session && session.agentId === agentId)
      void persistSessions()
  }

  async function setSessionThinkingLevel(level: string): Promise<void> {
    const agent = selectedAgent.value
    if (!agent)
      return

    const session = activeSession.value
    const prevMapLevel = selectedThinkingLevelByAgent.value[agent.id]
    const prevSettingsLevel = settings.value.lastThinkingLevelByAgent[agent.id]
    const prevSessionLevel = session?.thinkingLevel

    selectedThinkingLevelByAgent.value = {
      ...selectedThinkingLevelByAgent.value,
      [agent.id]: level,
    }
    settings.value = {
      ...settings.value,
      lastThinkingLevelByAgent: {
        ...settings.value.lastThinkingLevelByAgent,
        [agent.id]: level,
      },
    }
    if (session && session.agentId === agent.id)
      session.thinkingLevel = level

    if (session?.acpSessionId && session.agentId === agent.id && window.mdDesktop?.acp) {
      try {
        const result = await window.mdDesktop.acp.setThinkingLevel({
          sessionId: session.acpSessionId,
          thinkingLevel: level,
        })
        session.thinkingLevel = result.thinkingLevel
        if (result.thinkingLevel) {
          selectedThinkingLevelByAgent.value = {
            ...selectedThinkingLevelByAgent.value,
            [agent.id]: result.thinkingLevel,
          }
          settings.value = {
            ...settings.value,
            lastThinkingLevelByAgent: {
              ...settings.value.lastThinkingLevelByAgent,
              [agent.id]: result.thinkingLevel,
            },
          }
        }
      }
      catch (error) {
        const restoredMap = { ...selectedThinkingLevelByAgent.value }
        if (prevMapLevel !== undefined)
          restoredMap[agent.id] = prevMapLevel
        else
          delete restoredMap[agent.id]
        selectedThinkingLevelByAgent.value = restoredMap

        const restoredSettings = { ...settings.value.lastThinkingLevelByAgent }
        if (prevSettingsLevel !== undefined)
          restoredSettings[agent.id] = prevSettingsLevel
        else
          delete restoredSettings[agent.id]
        settings.value = {
          ...settings.value,
          lastThinkingLevelByAgent: restoredSettings,
        }

        if (session && session.agentId === agent.id)
          session.thinkingLevel = prevSessionLevel
        toast.error(extractErrorMessage(error))
        return
      }
    }
    else {
      void window.mdDesktop?.acp.updateSettings({
        lastThinkingLevelByAgent: { [agent.id]: level },
      })
    }

    if (session)
      void persistSessions()
  }

  async function setSessionPermissionMode(params: {
    permissionLevel?: AcpPermissionLevel
    modeId?: string | null
  }): Promise<void> {
    const session = activeSessionForSelectedAgent.value
    const prevDraftLevel = draftPermissionLevel.value
    const prevDraftMode = draftModeId.value
    const prevSessionLevel = session?.permissionLevel
    const prevSessionMode = session?.modeId

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
        draftPermissionLevel.value = prevDraftLevel
        draftModeId.value = prevDraftMode
        if (session) {
          session.permissionLevel = prevSessionLevel
          session.modeId = prevSessionMode
        }
        toast.error(extractErrorMessage(error))
        return
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
      thinkingLevel: selectedThinkingLevel.value,
      permissionLevel: draftPermissionLevel.value,
      modeId: draftModeId.value,
      postId: post?.id ?? ``,
      title: title || post?.title || t(`agent.panel.defaultTitle`),
      items: [],
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    pruneInactiveSessions()
    // Return the reactive proxy: callers mutate the record later (e.g. `acpSessionId`), which the raw object would not track.
    return sessions.value[0]
  }

  async function startNewSession(): Promise<void> {
    const current = activeSession.value
    if (current) {
      if (startingSessionIds.value[current.id]) {
        abortedStartSessionIds.add(current.id)
        setSessionStarting(current.id, false)
      }
      if (current.acpSessionId) {
        const closingAcpId = current.acpSessionId
        finalizeClosedSessionItems(current)
        current.acpSessionId = null
        cleanupAcpSessionRuntime(closingAcpId)
        if (window.mdDesktop?.acp)
          await window.mdDesktop.acp.closeSession(closingAcpId).catch(() => undefined)
      }
    }
    // Detach activeSession first so the new draft resolves thinkingLevel from per-agent memory.
    activeSessionId.value = null
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
    if (target.modelId) {
      const probe = probeByAgent.value[target.agentId]
      const parsed = parseVariantModelId(target.modelId, probe?.models ?? [])
      const baseId = parsed.baseModelId ?? target.modelId
      target.modelId = baseId
      if (parsed.thinkingLevel && !target.thinkingLevel)
        target.thinkingLevel = parsed.thinkingLevel
      selectedModelByAgent.value[target.agentId] = baseId
    }
    if (target.thinkingLevel)
      selectedThinkingLevelByAgent.value[target.agentId] = target.thinkingLevel
    // Historical sessions may name an agent not yet (fully) probed this run; its draft needs the probe (`/` commands).
    const agent = selectedAgent.value
    if (agent?.installed && needsProbe(agent.id))
      void probeAgent(agent.id)
  }

  function syncSessionForPost(postId: string): void {
    if (!postId) {
      activeSessionId.value = null
      return
    }
    if (activeSession.value?.postId === postId)
      return
    const matched = findLatestSessionForPost(postId)
    if (matched)
      void switchSession(matched.id)
    else
      activeSessionId.value = null
  }

  async function deleteSession(id: string): Promise<void> {
    const target = sessions.value.find(s => s.id === id)
    if (target) {
      if (startingSessionIds.value[target.id]) {
        abortedStartSessionIds.add(target.id)
        setSessionStarting(target.id, false)
      }
      if (target.acpSessionId) {
        const closingAcpId = target.acpSessionId
        target.acpSessionId = null
        cleanupAcpSessionRuntime(closingAcpId)
        if (window.mdDesktop?.acp)
          await window.mdDesktop.acp.closeSession(closingAcpId).catch(() => undefined)
      }
    }

    sessions.value = sessions.value.filter(s => s.id !== id)
    if (activeSessionId.value === id) {
      const currentPostId = postStore.currentPostId
      const fallback = currentPostId ? findLatestSessionForPost(currentPostId) : (sessions.value[0] ?? null)
      if (fallback)
        await switchSession(fallback.id)
      else
        activeSessionId.value = null
    }
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

    editorStore.flushContentToPostStore?.()
    const post = postStore.currentPost
    const postId = post?.id ?? ``
    const postTitle = post?.title ?? t(`agent.newArticle.untitled`)
    const content = isEditorBoundToPost(postId) ? editorStore.getContent() : (post?.content ?? ``)

    let session = activeSession.value
    const sessionForOtherPost = Boolean(
      session && session.items.length > 0 && session.postId && postId && session.postId !== postId,
    )
    const sessionForOtherAgent = Boolean(
      session && session.items.length > 0 && session.agentId !== agent.id,
    )
    if (!session || sessionForOtherPost || sessionForOtherAgent || (session.acpSessionId && session.agentId !== agent.id)) {
      if (!sessionForOtherPost && session?.acpSessionId && session.agentId !== agent.id) {
        const staleSessionId = session.acpSessionId
        finalizeClosedSessionItems(session)
        session.acpSessionId = null
        cleanupAcpSessionRuntime(staleSessionId)
        void window.mdDesktop.acp.closeSession(staleSessionId).catch(() => undefined)
      }
      const derivedTitle = text.length > 22 ? `${text.slice(0, 22)}…` : text
      session = createSessionRecord(derivedTitle)
    }
    else if (startingSessionIds.value[session.id] || (session.acpSessionId && runningAcpSessions.value[session.acpSessionId])) {
      return
    }
    else if (session.items.length === 0) {
      // Read agent-resolved model & thinking BEFORE mutating `session.agentId`.
      const resolvedModelId = selectedModel.value?.id ?? null
      const resolvedThinking = selectedThinkingLevel.value
      const agentChangedOnDraft = session.agentId !== agent.id
      session.title = text.length > 22 ? `${text.slice(0, 22)}…` : text
      session.agentId = agent.id
      session.postId = postId
      session.modelId = resolvedModelId
      session.thinkingLevel = resolvedThinking
      if (agentChangedOnDraft) {
        session.permissionLevel = draftPermissionLevel.value
        session.modeId = draftModeId.value
      }
    }

    const desiredModelId = selectedModel.value?.id ?? null
    const desiredThinkingLevel = selectedThinkingLevel.value
    const plainAttachments = attachments.length > 0 ? [...attachments] : []
    session.items.push({
      type: `user`,
      id: uuidv4(),
      text,
      attachments: plainAttachments.length > 0 ? plainAttachments : undefined,
      timestamp: Date.now(),
    })
    trimLiveItems(session)
    session.updatedAt = Date.now()
    void persistSessions()

    abortedStartSessionIds.delete(session.id)
    setSessionStarting(session.id, true)

    try {
      if (!session.acpSessionId) {
        const started = await window.mdDesktop.acp.startSession({
          agentId: agent.id,
          modelId: desiredModelId,
          thinkingLevel: desiredThinkingLevel,
          permissionLevel: session.permissionLevel ?? draftPermissionLevel.value,
          modeId: session.modeId ?? draftModeId.value,
          postId,
          postTitle,
          content,
        })
        const wasDeletedOrAborted = abortedStartSessionIds.has(session.id) || !sessions.value.some(s => s.id === session!.id)
        if (wasDeletedOrAborted) {
          abortedStartSessionIds.delete(session.id)
          cleanupAcpSessionRuntime(started.sessionId)
          void window.mdDesktop.acp.closeSession(started.sessionId).catch(() => undefined)
          return
        }
        session.acpSessionId = started.sessionId
        session.modelId = started.modelId
        session.thinkingLevel = started.thinkingLevel
        session.thinkingOptions = started.thinkingOptions
        session.permissionLevel = started.permissionLevel
        session.modeId = started.currentModeId
        // `[]` may mean "not announced yet"; an event that already arrived is at least as fresh.
        if (started.commands.length > 0 && !(started.sessionId in announcedCommandsBySession.value))
          setAnnouncedCommands(started.sessionId, started.commands)
        if (started.models.length > 0 || started.modes.length > 0 || started.thinkingOptions.length > 0) {
          const prevProbe = probeByAgent.value[agent.id]
          const nextModels = started.models.length > 0 ? started.models : (prevProbe?.models ?? [])
          const nextThinkingOptions = hasVariantModels(nextModels)
            ? []
            : (started.thinkingOptions.length > 0 ? started.thinkingOptions : prevProbe?.thinkingOptions)
          probeByAgent.value = {
            ...probeByAgent.value,
            [agent.id]: {
              agentId: agent.id,
              models: nextModels,
              currentModelId: started.modelId ?? prevProbe?.currentModelId ?? null,
              thinkingOptions: nextThinkingOptions,
              currentThinkingLevel: started.thinkingLevel ?? prevProbe?.currentThinkingLevel ?? null,
              modes: started.modes.length > 0 ? started.modes : (prevProbe?.modes ?? []),
              currentModeId: started.currentModeId ?? prevProbe?.currentModeId ?? null,
              // Session announcements stay per session; draft commands come from probes only.
              commands: prevProbe?.commands ?? [],
              // Without a prior probe the empty list is not authoritative, so `probeAgent` must still ask.
              commandsAnnounced: prevProbe ? prevProbe.commandsAnnounced : false,
              probedAt: Date.now(),
            },
          }
        }
        if (started.modelId) {
          selectedModelByAgent.value[agent.id] = started.modelId
          settings.value = {
            ...settings.value,
            lastModelByAgent: { ...settings.value.lastModelByAgent, [agent.id]: started.modelId },
          }
        }
        if (started.thinkingLevel) {
          selectedThinkingLevelByAgent.value[agent.id] = started.thinkingLevel
          settings.value = {
            ...settings.value,
            lastThinkingLevelByAgent: {
              ...settings.value.lastThinkingLevelByAgent,
              [agent.id]: started.thinkingLevel,
            },
          }
        }
      }

      await window.mdDesktop.acp.prompt({
        sessionId: session.acpSessionId,
        text,
        attachments: plainAttachments,
        content,
        postTitle,
      })
    }
    catch (error) {
      const message = extractErrorMessage(error)
      const last = session.items[session.items.length - 1]
      if (last?.type !== `error` || last.message !== message) {
        session.items.push({
          type: `error`,
          id: uuidv4(),
          message,
          timestamp: Date.now(),
        })
        trimLiveItems(session)
      }
      session.updatedAt = Date.now()
      void persistSessions()
    }
    finally {
      setSessionStarting(session.id, false)
      abortedStartSessionIds.delete(session.id)
    }
  }

  async function stopTurn(): Promise<void> {
    const session = activeSession.value
    if (!session)
      return
    if (startingSessionIds.value[session.id]) {
      abortedStartSessionIds.add(session.id)
      setSessionStarting(session.id, false)
    }
    const acpId = session.acpSessionId
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
    if (chunkFlushHandle && typeof cancelAnimationFrame === `function`) {
      cancelAnimationFrame(chunkFlushHandle)
      chunkFlushHandle = 0
    }
    pendingChunks.clear()
    reportedImageErrors.clear()
    abortedStartSessionIds.clear()
    pendingProbes.clear()
    pendingForcedProbes.clear()
    activeProbeCounts.clear()
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
    selectedThinkingLevelByAgent,
    selectedAgent,
    selectedModel,
    availableThinkingOptions,
    selectedThinkingLevel,
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
    availableCommands,
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
    refreshAgentsList,
    detectAgents,
    invalidateProbe,
    needsProbe,
    probeAgent,
    selectAgentAndModel,
    setSessionThinkingLevel,
    setSessionPermissionMode,
    startNewSession,
    switchSession,
    syncSessionForPost,
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
