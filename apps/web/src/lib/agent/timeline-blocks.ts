import type { AcpToolCallItem } from '@md/shared/types'
import type { AgentTimelineItem } from '@/stores/agent'
import { formatShortFilePath } from '@md/shared/utils/compact-diff'

export type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: `tool_call` }>
export type ErrorTimelineItem = Extract<AgentTimelineItem, { type: `error` }>
export type AssistantTimelineItem = Extract<AgentTimelineItem, { type: `assistant` }>
export type UserTimelineItem = Extract<AgentTimelineItem, { type: `user` }>
export type PlanTimelineItem = Extract<AgentTimelineItem, { type: `plan` }>
export type PermissionTimelineItem = Extract<AgentTimelineItem, { type: `permission` }>

export type TimelineDisplayBlock
  = | { kind: `user`, id: string, item: UserTimelineItem, isTurnStart: boolean }
    | { kind: `assistant`, id: string, item: AssistantTimelineItem }
    | { kind: `plan`, id: string, item: PlanTimelineItem }
    | { kind: `edit_tool`, id: string, item: ToolCallTimelineItem }
    | {
      kind: `tool_group`
      id: string
      items: ToolCallTimelineItem[]
      hasRunning: boolean
      hasFailed: boolean
      failedCount: number
      followedByContent: boolean
    }
    | { kind: `permission`, id: string, item: PermissionTimelineItem }
    | { kind: `error_group`, id: string, items: ErrorTimelineItem[] }

export type ToolVisualCategory
  = | `read`
    | `execute`
    | `search`
    | `fetch`
    | `image`
    | `steps`
    | `subagent`
    | `think`
    | `other`

export interface DescribedToolCall {
  category: ToolVisualCategory
  /** Short target shown next to the localized verb (e.g. `article.md`, `mkdir -p images`). */
  target: string
  /** Optional full detail / command / output shown when the row is expanded. */
  expandableCommand?: string
  expandableOutput?: string
  /** Relative workspace image path (e.g. `images/hero.png`) for completed image generation calls. */
  workspaceImagePath?: string
  hasDetails: boolean
}

export interface ErrorGroupSummary {
  /** Shared message when all items share the same root cause; otherwise each item renders individually. */
  sharedMessage: string | null
  /** Deduplicated list of affected file paths (e.g. image paths from upload failures). */
  affectedPaths: string[]
  /** Extracted IPv4 address when a WeChat 40164 IP whitelist error is detected. */
  whitelistIp: string | null
  /** Individual messages when errors are heterogeneous. */
  messages: string[]
}

const PATH_WORKSPACE_PREFIX_RE = /^.*?[/\\]acp-workspaces[/\\][0-9a-f-]{8,}(?:[/\\]|$)/i
const PATH_BRAIN_PREFIX_RE = /^.*?[/\\]\.gemini[/\\][^/\\]+[/\\]brain[/\\][0-9a-f-]{8,}[/\\]/i
const CMD_WORKSPACE_PREFIX_RE = /(?:[A-Z]:)?[^\s"'`]*?[/\\]acp-workspaces[/\\][0-9a-f-]{8,}[/\\]?/gi
const CMD_BRAIN_PREFIX_RE = /(?:[A-Z]:)?[^\s"'`]*?[/\\]\.gemini[/\\][^/\\]+[/\\]brain[/\\][0-9a-f-]{8,}[/\\]/gi
const SKILLS_PREFIX_RE = /(?:^|[/\\])\.?(?:agents|claude|qwen)[/\\]skills[/\\]/i
const LEADING_DOTDOT_RE = /^(?:\.\.[/\\])+/
const WORKSPACE_IMAGE_PATH_RE = /\b(images\/[^\s)"'`]+\.(?:png|jpe?g|gif|webp))\b/i
const IPV4_RE = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/
const UPLOAD_ERROR_RE = /^(?:图片|圖片|Failed to upload image|画像) (\S+) (?:上传失败：|上傳失敗：|のアップロードに失敗しました：|: )([\s\S]+)$/

function parseUploadError(message: string): { path: string, reason: string } | null {
  const match = UPLOAD_ERROR_RE.exec(message)
  if (!match)
    return null
  const reason = match[2].trim()
  if (!reason)
    return null
  return { path: match[1], reason }
}

function extractWeChat40164Ip(message: string): string | null {
  const codeIdx = message.indexOf(`40164`)
  if (codeIdx === -1)
    return null
  const match = IPV4_RE.exec(message.slice(codeIdx))
  return match ? match[1] : null
}

export function isEditToolCall(tool: AcpToolCallItem): boolean {
  return tool.toolKind === `edit` || tool.toolKind === `delete` || tool.toolKind === `move`
}

/**
 * Strips bulky workspace temp prefixes and leading `../../../` traversals so file references
 * inside the sidebar stay concise and scannable.
 */
export function cleanDisplayPath(raw: string | undefined): string {
  if (!raw)
    return ``
  const trimmed = raw.trim().replace(/^['"`]|['"`]$/g, ``)
  if (!trimmed)
    return ``

  const normalized = trimmed.replace(/\\/g, `/`)
  const withoutWorkspace = normalized.replace(PATH_WORKSPACE_PREFIX_RE, ``)
  const withoutBrain = withoutWorkspace.replace(PATH_BRAIN_PREFIX_RE, ``)
  const withoutDotDot = withoutBrain.replace(LEADING_DOTDOT_RE, ``)

  const skillsMatch = SKILLS_PREFIX_RE.exec(withoutDotDot)
  if (skillsMatch) {
    const afterSkills = withoutDotDot.slice(skillsMatch.index + skillsMatch[0].length)
    if (afterSkills)
      return afterSkills
  }

  if (!withoutDotDot)
    return `.`

  if (!withoutDotDot.startsWith(`/`) && withoutDotDot.split(`/`).length <= 3)
    return withoutDotDot

  return formatShortFilePath(withoutDotDot, withoutDotDot)
}

/**
 * Shortens absolute session workspace paths inside shell commands for compact 1-line summaries.
 */
export function cleanDisplayCommand(raw: string | undefined): string {
  if (!raw)
    return ``
  const collapsed = raw.replace(/\s+/g, ` `).trim()
  if (!collapsed)
    return ``

  return collapsed
    .replace(/"([^"]+)"/g, (full, inner: string) => {
      if (!PATH_WORKSPACE_PREFIX_RE.test(inner))
        return full
      const tail = inner.replace(PATH_WORKSPACE_PREFIX_RE, ``).replace(/^[/\\]+/, ``)
      return tail || `.`
    })
    .replace(CMD_WORKSPACE_PREFIX_RE, ``)
    .replace(CMD_BRAIN_PREFIX_RE, ``)
    .trim()
}

function classifyToolCategory(tool: AcpToolCallItem): ToolVisualCategory {
  const title = tool.title.trim()
  const lower = title.toLowerCase()

  if (/generate[_ -]?image|image[_ -]?gen|md-image/i.test(lower))
    return `image`
  if (/\bupdate[_ -]?steps\b|\btodo(?:write)?\b/i.test(lower))
    return `steps`
  if (/\binvoke[_ -]?subagent\b|\bsubagent\b/i.test(lower))
    return `subagent`

  if (tool.toolKind === `read` || /^(?:file|read|view)\s+/i.test(title))
    return `read`
  if (tool.toolKind === `execute`)
    return `execute`
  if (tool.toolKind === `search`)
    return `search`
  if (tool.toolKind === `fetch`)
    return `fetch`
  if (tool.toolKind === `think`)
    return `think`
  return `other`
}

function stripLeadingVerbPrefix(title: string): string {
  return title
    .replace(/^(?:Run|File|Read|View|Search|Fetch|Execute|Bash|Shell)\s+/i, ``)
    .trim()
}

function extractWorkspaceImagePath(tool: AcpToolCallItem): string | undefined {
  if (tool.status !== `completed`)
    return undefined
  for (const candidate of [tool.filePath, tool.detail]) {
    if (!candidate)
      continue
    const normalized = candidate.replace(/\\/g, `/`)
    const match = WORKSPACE_IMAGE_PATH_RE.exec(normalized)
    if (match)
      return match[1]
  }
  return undefined
}

export function describeToolCall(tool: AcpToolCallItem): DescribedToolCall {
  const category = classifyToolCategory(tool)
  const rawTitle = tool.title.trim()
  const rawCommand = tool.command?.trim()
  const rawDetail = tool.detail?.trim()

  let target = ``
  if (category === `read`) {
    const pathSource = tool.filePath || stripLeadingVerbPrefix(rawTitle)
    target = cleanDisplayPath(pathSource) || rawTitle
  }
  else if (category === `execute`) {
    target = cleanDisplayCommand(rawCommand || stripLeadingVerbPrefix(rawTitle))
  }
  else if (category === `image`) {
    const imgPath = extractWorkspaceImagePath(tool)
    if (imgPath) {
      target = cleanDisplayPath(imgPath)
    }
    else if (tool.filePath) {
      target = cleanDisplayPath(tool.filePath)
    }
    else {
      const stripped = stripLeadingVerbPrefix(rawTitle)
      target = /^mcp_md-image_generate_image$|^generate[_ -]?image$/i.test(stripped) ? `` : stripped
    }
  }
  else if (category === `steps`) {
    target = ``
  }
  else if (category === `subagent`) {
    const stripped = stripLeadingVerbPrefix(rawTitle)
    target = /^invoke[_ -]?subagent$/i.test(stripped) ? `` : stripped
  }
  else if (category === `search` || category === `fetch`) {
    target = rawDetail && rawDetail !== rawTitle
      ? rawDetail
      : stripLeadingVerbPrefix(rawTitle)
  }
  else {
    target = stripLeadingVerbPrefix(rawTitle) || rawTitle
  }

  const expandableCommand = rawCommand && rawCommand !== target ? rawCommand : (category === `execute` ? rawCommand : undefined)
  const redundantDetail = !rawDetail
    || rawDetail === rawTitle
    || rawDetail === target
    || rawDetail === tool.filePath
    || rawDetail === rawCommand
    || rawDetail === tool.error
  const expandableOutput = redundantDetail ? undefined : rawDetail
  const workspaceImagePath = category === `image` ? extractWorkspaceImagePath(tool) : undefined

  const hasDetails = Boolean(
    tool.error
    || expandableCommand
    || expandableOutput
    || (tool.filePath && cleanDisplayPath(tool.filePath) !== tool.filePath)
    || workspaceImagePath,
  )

  return {
    category,
    target,
    expandableCommand,
    expandableOutput,
    workspaceImagePath,
    hasDetails,
  }
}

export interface ToolGroupBreakdown {
  readCount: number
  executeCount: number
  searchCount: number
  imageCount: number
  otherCount: number
  totalCount: number
}

export function summarizeToolGroup(items: readonly ToolCallTimelineItem[]): ToolGroupBreakdown {
  let readCount = 0
  let executeCount = 0
  let searchCount = 0
  let imageCount = 0
  let otherCount = 0

  for (const item of items) {
    const category = classifyToolCategory(item.tool)
    if (category === `read`)
      readCount++
    else if (category === `execute`)
      executeCount++
    else if (category === `search`)
      searchCount++
    else if (category === `image`)
      imageCount++
    else
      otherCount++
  }

  return {
    readCount,
    executeCount,
    searchCount,
    imageCount,
    otherCount,
    totalCount: items.length,
  }
}

export function summarizeErrorGroup(items: readonly ErrorTimelineItem[]): ErrorGroupSummary {
  const messages = items.map(item => item.message.trim()).filter(Boolean)
  if (messages.length === 0)
    return { sharedMessage: null, affectedPaths: [], whitelistIp: null, messages: [] }

  const whitelistIp = extractWeChat40164Ip(messages[0])

  if (messages.length === 1) {
    const parsed = parseUploadError(messages[0])
    if (parsed) {
      return {
        sharedMessage: parsed.reason,
        affectedPaths: [cleanDisplayPath(parsed.path)],
        whitelistIp,
        messages,
      }
    }
    return { sharedMessage: null, affectedPaths: [], whitelistIp, messages }
  }

  // Group repeated image upload failures that share the exact same underlying reason.
  const parsedUploads = messages.map(parseUploadError)
  if (parsedUploads.every((entry): entry is NonNullable<typeof entry> => entry !== null)) {
    const reasons = new Set(parsedUploads.map(entry => entry.reason))
    if (reasons.size === 1) {
      const affectedPaths = [...new Set(parsedUploads.map(entry => cleanDisplayPath(entry.path)))]
      return {
        sharedMessage: parsedUploads[0].reason,
        affectedPaths,
        whitelistIp,
        messages,
      }
    }
  }

  const uniqueMessages = [...new Set(messages)]
  if (uniqueMessages.length === 1) {
    return {
      sharedMessage: uniqueMessages[0],
      affectedPaths: [],
      whitelistIp,
      messages,
    }
  }

  return {
    sharedMessage: null,
    affectedPaths: [],
    whitelistIp,
    messages: uniqueMessages,
  }
}

function isSilentBookkeepingTool(tool: AcpToolCallItem): boolean {
  if (tool.status !== `completed` || tool.error)
    return false
  if (classifyToolCategory(tool) !== `steps`)
    return false
  return !tool.detail?.trim() || tool.detail.trim() === `OK` || tool.detail.trim() === tool.title.trim()
}

/**
 * Converts the flat store timeline into Cursor-style display blocks:
 * - Omits completed no-op bookkeeping steps (`update_steps`) so they do not clutter the chat or split error/tool groups.
 * - Consecutive non-edit tool calls merge into a single collapsible `tool_group`.
 * - Consecutive errors merge into an `error_group` so repeated failures deduplicate cleanly.
 * - Completed empty assistant placeholders (no text, no thought, not streaming) are omitted.
 */
export function groupTimelineItems(items: readonly AgentTimelineItem[]): TimelineDisplayBlock[] {
  const visibleItems = items.filter((item) => {
    if (item.type === `assistant` && !item.text && !item.thought && !item.streaming)
      return false
    if (item.type === `tool_call` && isSilentBookkeepingTool(item.tool))
      return false
    return true
  })

  const blocks: TimelineDisplayBlock[] = []
  let seenAnyUser = false

  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i]

    if (item.type === `user`) {
      blocks.push({
        kind: `user`,
        id: item.id,
        item,
        isTurnStart: seenAnyUser,
      })
      seenAnyUser = true
      continue
    }

    if (item.type === `assistant`) {
      blocks.push({ kind: `assistant`, id: item.id, item })
      continue
    }

    if (item.type === `plan`) {
      blocks.push({ kind: `plan`, id: item.id, item })
      continue
    }

    if (item.type === `permission`) {
      blocks.push({ kind: `permission`, id: item.id, item })
      continue
    }

    if (item.type === `tool_call`) {
      if (isEditToolCall(item.tool)) {
        blocks.push({ kind: `edit_tool`, id: item.id, item })
        continue
      }

      const grouped: ToolCallTimelineItem[] = [item]
      while (i + 1 < visibleItems.length) {
        const next = visibleItems[i + 1]
        if (next.type === `tool_call` && !isEditToolCall(next.tool)) {
          grouped.push(next)
          i++
        }
        else {
          break
        }
      }

      const hasRunning = grouped.some(entry => entry.tool.status === `in_progress` || entry.tool.status === `pending`)
      const failedCount = grouped.filter(entry => entry.tool.status === `failed`).length
      const followedByContent = visibleItems.slice(i + 1).some(
        after =>
          after.type === `user`
          || (after.type === `assistant` && Boolean(after.text.trim())),
      )

      blocks.push({
        kind: `tool_group`,
        id: `tg-${grouped[0].id}`,
        items: grouped,
        hasRunning,
        hasFailed: failedCount > 0,
        failedCount,
        followedByContent,
      })
      continue
    }

    if (item.type === `error`) {
      const grouped: ErrorTimelineItem[] = [item]
      while (i + 1 < visibleItems.length && visibleItems[i + 1].type === `error`) {
        grouped.push(visibleItems[i + 1] as ErrorTimelineItem)
        i++
      }
      blocks.push({
        kind: `error_group`,
        id: `eg-${grouped[0].id}`,
        items: grouped,
      })
    }
  }

  return blocks
}
