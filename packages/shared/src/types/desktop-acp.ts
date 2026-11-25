import type { DesktopPickedImage, DesktopWeChatApi } from './desktop-wechat'

export interface AcpAgentAvatar {
  letter: string
  color: string
}

export interface AcpAgentConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  installPackage?: string
  detectBinaries?: string[]
  builtin: boolean
  avatar: AcpAgentAvatar
}

export interface AcpInstallProgress {
  percent: number
  command: string
  line: string
}

export interface AcpAgentStatus {
  id: string
  name: string
  builtin: boolean
  installed: boolean
  resolvedPath?: string
  command: string
  args: string[]
  env?: Record<string, string>
  installPackage?: string
  avatar: AcpAgentAvatar
  isDefault: boolean
  installing?: boolean
  installProgress?: AcpInstallProgress
}

export interface AcpThinkingOption {
  id: string
  name?: string
  description?: string
}

export interface AcpModelInfo {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  /** Available thinking levels for this model when the agent exposes effort-suffixed model variants. */
  thinkingOptions?: AcpThinkingOption[]
  /** Maps a thinking level id to the raw ACP variant model id sent over `session/set_model`. */
  thinkingVariantIds?: Record<string, string>
  defaultThinkingLevel?: string
}

export interface AcpModeInfo {
  id: string
  name: string
  description?: string
}

export interface AcpSlashCommand {
  name: string
  description?: string
  inputHint?: string
}

export interface AcpProbeResult {
  agentId: string
  models: AcpModelInfo[]
  currentModelId: string | null
  /** Session-level thinking options from a `thought_level` configOption when models are not variant-grouped. */
  thinkingOptions?: AcpThinkingOption[]
  currentThinkingLevel?: string | null
  modes: AcpModeInfo[]
  currentModeId: string | null
  commands: AcpSlashCommand[]
  probedAt: number
  error?: string
}

export interface AcpCommandOverride {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type AcpPermissionLevel = `ask` | `auto_edits` | `plan` | `bypass`

export interface AcpSettings {
  defaultAgentId: string
  defaultPermissionLevel: AcpPermissionLevel
  lastModelByAgent: Record<string, string>
  lastThinkingLevelByAgent: Record<string, string>
  customAgents: AcpAgentConfig[]
  commandOverrides: Record<string, AcpCommandOverride>
}

export interface AcpPlanEntry {
  content: string
  status: `pending` | `in_progress` | `completed`
  priority?: string
}

export type AcpToolKind
  = | `read`
    | `edit`
    | `delete`
    | `move`
    | `search`
    | `execute`
    | `think`
    | `fetch`
    | `switch_mode`
    | `other`

export type AcpToolStatus = `pending` | `in_progress` | `completed` | `failed`

export interface AcpDiffStats {
  added: number
  removed: number
  hasChanges: boolean
  truncated?: boolean
}

export interface AcpToolCallItem {
  id: string
  title: string
  toolKind: AcpToolKind
  status: AcpToolStatus
  detail?: string
  filePath?: string
  command?: string
  oldText?: string
  newText?: string
  unifiedDiff?: string
  diffStats?: AcpDiffStats
  error?: string
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: `allow_once` | `allow_always` | `reject_once` | `reject_always` | string
}

export interface AcpPermissionRequest {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  toolKind: AcpToolKind
  command?: string
  detail?: string
  filePath?: string
  oldText?: string
  newText?: string
  unifiedDiff?: string
  diffStats?: AcpDiffStats
  options: AcpPermissionOption[]
}

export type AcpPermissionDecision = `allow_once` | `allow_always` | `reject`

export type AcpHostEvent
  = | { type: `session_created`, sessionId: string, agentId: string, modelId: string | null, postId: string, title: string }
    | { type: `session_closed`, sessionId: string, reason?: string }
    | { type: `turn_started`, sessionId: string }
    | { type: `turn_finished`, sessionId: string, stopReason?: string }
    | { type: `turn_error`, sessionId: string, message: string }
    | { type: `message_chunk`, sessionId: string, text: string }
    | { type: `thought_chunk`, sessionId: string, text: string }
    | { type: `plan`, sessionId: string, entries: AcpPlanEntry[] }
    | { type: `tool_call`, sessionId: string, tool: AcpToolCallItem }
    | { type: `permission_requested`, sessionId: string, request: AcpPermissionRequest }
    | { type: `permission_resolved`, sessionId: string, requestId: string, decision: AcpPermissionDecision | `cancelled` }
    | { type: `article_synced`, sessionId: string, postId: string, content: string }
    | { type: `model_changed`, sessionId: string, modelId: string | null }
    | { type: `thinking_changed`, sessionId: string, thinkingLevel: string | null, thinkingOptions?: AcpThinkingOption[] }
    | { type: `mode_changed`, sessionId: string, modeId: string | null, permissionLevel?: AcpPermissionLevel }
    | { type: `commands_updated`, sessionId: string, commands: AcpSlashCommand[] }
    | { type: `install_progress`, agentId: string, percent: number, command: string, line: string, done?: boolean, error?: string }
    | { type: `agents_changed`, agents: AcpAgentStatus[] }

export interface AcpStartSessionParams {
  agentId: string
  modelId?: string | null
  thinkingLevel?: string | null
  permissionLevel?: AcpPermissionLevel
  modeId?: string | null
  postId: string
  postTitle: string
  content: string
}

export interface AcpStartSessionResult {
  sessionId: string
  modelId: string | null
  models: AcpModelInfo[]
  thinkingLevel: string | null
  thinkingOptions: AcpThinkingOption[]
  modes: AcpModeInfo[]
  currentModeId: string | null
  permissionLevel: AcpPermissionLevel
  commands: AcpSlashCommand[]
}

export interface AcpPromptParams {
  sessionId: string
  text: string
  attachments?: string[]
  content: string
  postTitle: string
}

export interface DesktopAcpApi {
  listAgents: () => Promise<AcpAgentStatus[]>
  detectAgents: () => Promise<AcpAgentStatus[]>
  getSettings: () => Promise<AcpSettings>
  updateSettings: (patch: Partial<AcpSettings>) => Promise<AcpSettings>
  addCustomAgent: (agent: { name: string, command: string, args: string[], env?: Record<string, string> }) => Promise<AcpAgentStatus[]>
  removeCustomAgent: (agentId: string) => Promise<AcpAgentStatus[]>
  installAgent: (agentId: string) => Promise<{ ok: boolean, error?: string }>
  cancelInstall: (agentId: string) => Promise<void>
  probeAgent: (agentId: string, options?: { force?: boolean }) => Promise<AcpProbeResult>
  startSession: (params: AcpStartSessionParams) => Promise<AcpStartSessionResult>
  prompt: (params: AcpPromptParams) => Promise<{ stopReason?: string }>
  cancelTurn: (sessionId: string) => Promise<void>
  setModel: (params: { sessionId: string, modelId: string, thinkingLevel?: string | null }) => Promise<{ modelId: string | null, thinkingLevel: string | null }>
  setThinkingLevel: (params: { sessionId: string, thinkingLevel: string }) => Promise<{ thinkingLevel: string | null, modelId: string | null }>
  setPermissionMode: (params: {
    sessionId: string
    permissionLevel?: AcpPermissionLevel
    modeId?: string | null
  }) => Promise<{ permissionLevel: AcpPermissionLevel, modeId: string | null }>
  respondPermission: (params: {
    sessionId: string
    requestId: string
    decision: AcpPermissionDecision
    optionId?: string
  }) => Promise<void>
  closeSession: (sessionId: string) => Promise<void>
  /** Reads an image the agent saved inside its session workspace (for upload to the user's image host). */
  readWorkspaceImage: (params: { sessionId: string, path: string }) => Promise<AcpWorkspaceImage>
  onEvent: (listener: (event: AcpHostEvent) => void) => () => void
}

export interface AcpWorkspaceImage {
  data: Uint8Array
  mimeType: string
  filename: string
}

export interface DesktopPickedFile {
  path: string
  name: string
}

export interface DesktopBridge {
  isDesktop: true
  platform: string
  acp: DesktopAcpApi
  wechat: DesktopWeChatApi
  pickFiles: () => Promise<DesktopPickedFile[]>
  pickImage: () => Promise<DesktopPickedImage | null>
  openExternal: (url: string) => Promise<void>
  setLocale: (locale: string) => Promise<void>
}
