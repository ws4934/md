import type { AcpModeInfo, AcpPermissionLevel, AcpSettings, AcpToolKind } from '../types/desktop-acp'

export const DEFAULT_ACP_SETTINGS: Readonly<AcpSettings> = {
  defaultAgentId: `claude`,
  defaultPermissionLevel: `ask`,
  lastModelByAgent: {},
  customAgents: [],
  commandOverrides: {},
}

export function createDefaultAcpSettings(): AcpSettings {
  return {
    defaultAgentId: DEFAULT_ACP_SETTINGS.defaultAgentId,
    defaultPermissionLevel: DEFAULT_ACP_SETTINGS.defaultPermissionLevel,
    lastModelByAgent: {},
    customAgents: [],
    commandOverrides: {},
  }
}

export const ACP_PERMISSION_LEVELS: readonly AcpPermissionLevel[] = [
  `ask`,
  `auto_edits`,
  `plan`,
  `bypass`,
] as const

export type AcpPermissionPolicyAction = `allow` | `reject` | `ask`

const LEVEL_SET = new Set<string>(ACP_PERMISSION_LEVELS)

const PERMISSION_PRIVILEGE_RANK: Record<AcpPermissionLevel, number> = {
  plan: 0,
  ask: 1,
  auto_edits: 2,
  bypass: 3,
}

/**
 * Clamp an agent-reported permission level against the current level so an
 * agent-originated mode update can tighten or preserve permissions, never
 * silently escalate above the user-approved ceiling.
 */
export function clampAgentModePermissionLevel(
  currentLevel: AcpPermissionLevel,
  reportedLevel: AcpPermissionLevel | null,
): AcpPermissionLevel {
  // Unmapped custom agent modes carry `ask`-equivalent privilege (matching setPermissionMode),
  // tightening `bypass`/`auto_edits` while never escalating `plan`.
  const effectiveReported = reportedLevel ?? `ask`
  return PERMISSION_PRIVILEGE_RANK[effectiveReported] <= PERMISSION_PRIVILEGE_RANK[currentLevel]
    ? effectiveReported
    : currentLevel
}

const MODE_ID_ALIASES: Record<AcpPermissionLevel, readonly string[]> = {
  ask: [`default`, `ask`, `prompt`, `normal`, `standard`, `suggest`, `code`, `write`, `build`],
  auto_edits: [`acceptedits`, `accept_edits`, `accept-edits`, `autoedits`, `auto_edits`, `auto-edits`, `autoedit`, `auto_edit`, `auto-edit`, `edit`],
  plan: [`plan`, `planmode`, `plan_mode`, `plan-mode`, `architect`, `readonly`, `read_only`, `read-only`],
  bypass: [`bypasspermissions`, `bypass_permissions`, `bypass-permissions`, `bypass`, `dontask`, `dont_ask`, `dont-ask`, `yolo`, `fullauto`, `full_auto`, `full-auto`, `fullaccess`, `full_access`, `full-access`, `agentfullaccess`, `agent_full_access`, `agent-full-access`],
}

export function isAcpPermissionLevel(value: unknown): value is AcpPermissionLevel {
  return typeof value === `string` && LEVEL_SET.has(value)
}

export function isEditToolKind(kind: AcpToolKind): boolean {
  return kind === `edit` || kind === `delete` || kind === `move`
}

function normalizeModeKey(modeId: string): string {
  return modeId.trim().toLowerCase()
}

export function mapAcpModeIdToPermissionLevel(modeId: string | null | undefined): AcpPermissionLevel | null {
  if (!modeId)
    return null
  const normalized = normalizeModeKey(modeId)
  for (const level of ACP_PERMISSION_LEVELS) {
    if (MODE_ID_ALIASES[level].includes(normalized))
      return level
  }
  return null
}

/**
 * Resolves a canonical permission level to a matching ACP mode ID advertised by the agent.
 */
export function mapPermissionLevelToAcpModeId(
  level: AcpPermissionLevel,
  modes: readonly AcpModeInfo[],
): string | null {
  if (modes.length === 0)
    return null
  const aliases = MODE_ID_ALIASES[level]
  for (const alias of aliases) {
    const matched = modes.find(mode => normalizeModeKey(mode.id) === alias)
    if (matched)
      return matched.id
  }
  return null
}

/**
 * Agent mode a permission level runs on. Agents without a native `bypass` or `auto_edits`
 * mode run on their `ask` mode (so the client policy enforces approvals), and when an agent
 * exposes no `ask` alias either (e.g. Codex ACP `read-only` / `agent` / `agent-full-access`),
 * leaving a conflicting `bypass` or `plan` mode falls back to a neutral non-bypass/non-plan mode.
 */
export function resolveNativeModeIdForLevel(
  level: AcpPermissionLevel,
  modes: readonly AcpModeInfo[],
  currentModeId?: string | null,
): string | null {
  const direct = mapPermissionLevelToAcpModeId(level, modes)
  if (direct)
    return direct

  if (level === `bypass` || level === `auto_edits`) {
    const askMode = mapPermissionLevelToAcpModeId(`ask`, modes)
    if (askMode)
      return askMode
  }

  if (modes.length === 0)
    return null

  const currentMapped = mapAcpModeIdToPermissionLevel(currentModeId)
  const mustLeaveBypass = level !== `bypass` && currentMapped === `bypass`
  const mustLeavePlan = level !== `plan` && currentMapped === `plan`

  if (mustLeaveBypass || mustLeavePlan || (level === `bypass` && !currentModeId)) {
    const neutral = modes.find((mode) => {
      const mapped = mapAcpModeIdToPermissionLevel(mode.id)
      return mapped !== `bypass` && mapped !== `plan`
    })
    if (neutral)
      return neutral.id
    if (mustLeaveBypass) {
      const nonBypass = modes.find(mode => mapAcpModeIdToPermissionLevel(mode.id) !== `bypass`)
      if (nonBypass)
        return nonBypass.id
    }
  }

  return null
}

export function agentHasPlanMode(modes: readonly AcpModeInfo[]): boolean {
  return mapPermissionLevelToAcpModeId(`plan`, modes) !== null
}

/**
 * Returns agent-advertised ACP modes that do not correspond to one of the four built-in levels.
 */
export function getCustomExtraModes(modes: readonly AcpModeInfo[]): AcpModeInfo[] {
  return modes.filter(mode => mapAcpModeIdToPermissionLevel(mode.id) === null)
}

/**
 * Client-side permission policy enforced for every `session/request_permission`.
 */
export function evaluatePermissionPolicy(
  level: AcpPermissionLevel,
  toolKind: AcpToolKind,
  options?: { agentHasPlanMode?: boolean },
): AcpPermissionPolicyAction {
  if (level === `bypass`)
    return `allow`

  if (toolKind === `read` || toolKind === `search` || toolKind === `think`)
    return `allow`

  if (level === `auto_edits`)
    return isEditToolKind(toolKind) ? `allow` : `ask`

  if (level === `plan`) {
    if (!options?.agentHasPlanMode && (isEditToolKind(toolKind) || toolKind === `execute`))
      return `reject`
    return `ask`
  }

  return `ask`
}

/**
 * One-time migration from legacy two-toggle settings (`reviewEditsBeforeWriting` / `askBeforeRunningCommands`)
 * to `defaultPermissionLevel`.
 */
export function migrateLegacyPermissionSettings(raw: {
  defaultPermissionLevel?: unknown
  reviewEditsBeforeWriting?: unknown
  askBeforeRunningCommands?: unknown
}): { level: AcpPermissionLevel, migrated: boolean } {
  const hasLegacyKeys
    = typeof raw.reviewEditsBeforeWriting === `boolean`
      || typeof raw.askBeforeRunningCommands === `boolean`

  if (isAcpPermissionLevel(raw.defaultPermissionLevel))
    return { level: raw.defaultPermissionLevel, migrated: hasLegacyKeys }

  if (!hasLegacyKeys)
    return { level: `ask`, migrated: false }

  const reviewEdits = raw.reviewEditsBeforeWriting !== false
  const askCommands = raw.askBeforeRunningCommands !== false

  if (!reviewEdits && !askCommands)
    return { level: `bypass`, migrated: true }
  if (!reviewEdits)
    return { level: `auto_edits`, migrated: true }
  return { level: `ask`, migrated: true }
}
