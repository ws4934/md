import type {
  AgentContext,
  ContentBlock,
  NewSessionResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionMode,
  ToolCallContent,
  ToolKind,
} from '@agentclientprotocol/sdk/unstable'
import type { ModelMessage, ToolSet } from 'ai'
import type { SkillEntry } from '../shared/skills'
import type { McpStdioClient } from './mcp-client'
import type { ApiAgentModeId, ApiAgentRuntimeConfig, ApiThoughtLevel } from './provider'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import {
  agent as createAcpAgent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk/unstable'
import { jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { redactSecret } from '../../main/ai/sanitize'
import { listSkillSupportFiles, readSkills } from '../shared/skills'
import { trimMessageHistory } from './history'
import { connectMcpServers } from './mcp-client'
import {
  API_AGENT_MODES,
  API_THOUGHT_LEVEL_OPTIONS,
  buildReasoningProviderOptions,
  createApiAgentLanguageModel,
  isUnsupportedReasoningError,
} from './provider'

type ApiModeId = ApiAgentModeId
type JsonSchemaInput = Parameters<typeof jsonSchema>[0]

interface SessionState {
  id: string
  cwd: string
  articlePath: string
  modelId: string
  modeId: ApiModeId
  thoughtLevel: ApiThoughtLevel
  messages: ModelMessage[]
  lastAgentArticleContent: string | null
  editQueue: Promise<unknown>
  alwaysAllowedKinds: Set<ToolKind>
  activeAbort: AbortController | null
  skills: SkillEntry[]
  mcpClients: McpStdioClient[]
}

const AVAILABLE_MODES: SessionMode[] = API_AGENT_MODES.map(m => ({ ...m }))

const VALID_MODES = new Set<ApiModeId>([`default`, `acceptEdits`, `plan`, `bypassPermissions`])
const VALID_THOUGHT_LEVELS = new Set<ApiThoughtLevel>([`default`, `low`, `medium`, `high`])

const MAX_AGENT_STEPS = 12
const MAX_READ_FILE_BYTES = 256 * 1024
const MAX_WRITE_FILE_BYTES = 1024 * 1024
const WORKSPACE_SKILL_DIRS = [`.agents/skills`, `.claude/skills`]
const CASE_INSENSITIVE_FS = process.platform === `darwin` || process.platform === `win32`

const setModelParamsSchema = z.object({
  sessionId: z.string(),
  modelId: z.string(),
})

function loadRuntimeConfig(): ApiAgentRuntimeConfig {
  const raw = process.env.MD_API_AGENT_CONFIG
  if (!raw)
    throw new Error(`Missing MD_API_AGENT_CONFIG environment variable`)
  const parsed = JSON.parse(raw) as Partial<ApiAgentRuntimeConfig>
  const enabledModels = Array.isArray(parsed.enabledModels)
    ? parsed.enabledModels.filter((m): m is string => typeof m === `string` && Boolean(m.trim()))
    : []
  if (!parsed.apiKey || enabledModels.length === 0)
    throw new Error(`API model agent requires an API key and at least one enabled model`)
  const defaultModel = parsed.defaultModel && enabledModels.includes(parsed.defaultModel)
    ? parsed.defaultModel
    : enabledModels[0]
  return {
    protocol: parsed.protocol === `anthropic` || parsed.protocol === `google` ? parsed.protocol : `openai-compatible`,
    baseUrl: typeof parsed.baseUrl === `string` ? parsed.baseUrl : ``,
    apiKey: parsed.apiKey,
    enabledModels,
    defaultModel,
  }
}

function buildConfigOptions(config: ApiAgentRuntimeConfig, session: SessionState): SessionConfigOption[] {
  return [
    {
      id: `model`,
      name: `Model`,
      category: `model`,
      type: `select`,
      currentValue: session.modelId,
      options: config.enabledModels.map(id => ({ value: id, name: id })),
    },
    {
      id: `mode`,
      name: `Mode`,
      category: `mode`,
      type: `select`,
      currentValue: session.modeId,
      options: AVAILABLE_MODES.map(m => ({
        value: m.id,
        name: m.name,
        description: m.description ?? undefined,
      })),
    },
    {
      id: `thought_level`,
      name: `Thinking Level`,
      category: `thought_level`,
      type: `select`,
      currentValue: session.thoughtLevel,
      options: API_THOUGHT_LEVEL_OPTIONS.map(o => ({ value: o.value, name: o.name })),
    },
  ]
}

function buildSessionResponse(config: ApiAgentRuntimeConfig, session: SessionState): NewSessionResponse {
  const response = {
    sessionId: session.id,
    models: {
      currentModelId: session.modelId,
      availableModels: config.enabledModels.map(id => ({
        modelId: id,
        name: id,
      })),
    },
    modes: {
      currentModeId: session.modeId,
      availableModes: AVAILABLE_MODES,
    },
    configOptions: buildConfigOptions(config, session),
  }
  return response as unknown as NewSessionResponse
}

function buildSystemPrompt(articlePath: string, modeId: ApiModeId, skills: readonly SkillEntry[]): string {
  const lines = [
    `You are a focused Markdown article writing and editing assistant inside doocs/md.`,
    `The active article file is "${articlePath}".`,
    `Use read_article, edit_article, and write_article to inspect and update article.md (use edit_article for targeted revisions and write_article for drafting from scratch or major rewrites).`,
    `Always inspect the current article with read_article before editing unless you already have its latest content in this conversation.`,
    `Use list_files, read_file, and write_file to inspect or manage other files inside the session workspace (write_file cannot modify article.md).`,
    `Use any connected MCP tools discovered in this session when helpful for the user's request.`,
    `Keep replies concise and respond in the user's language.`,
  ]
  if (skills.length > 0) {
    lines.push(
      ``,
      `Available skills (call load_skill with the skill name before acting on a task a skill covers):`,
      ...skills.map(s => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`)),
    )
  }
  if (modeId === `plan`)
    lines.push(`You are currently in Plan mode (read-only). Do NOT modify files or invoke mutating/external tools; inspect the workspace and propose a clear plan instead.`)
  return lines.join(`\n`)
}

function extractPromptText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === `text`)
        return block.text
      if (block.type === `resource_link`)
        return `[Resource: ${block.name || block.uri}]`
      if (block.type === `resource` && `text` in block.resource && typeof block.resource.text === `string`)
        return block.resource.text
      return ``
    })
    .filter(Boolean)
    .join(`\n`)
}

function toPosixRelative(fromDir: string, targetPath: string): string {
  return path.relative(fromDir, targetPath).replace(/\\/g, `/`)
}

function normalizePathForCompare(p: string): string {
  const trimmedWin = process.platform === `win32` ? p.replace(/[. ]+$/, ``) : p
  return CASE_INSENSITIVE_FS ? trimmedWin.toLowerCase() : trimmedWin
}

function isSameFsPath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b)
}

function isWithinRoot(canonicalRoot: string, canonicalTarget: string, allowRoot: boolean): boolean {
  const normRoot = CASE_INSENSITIVE_FS ? canonicalRoot.toLowerCase() : canonicalRoot
  const normTarget = CASE_INSENSITIVE_FS ? canonicalTarget.toLowerCase() : canonicalTarget
  if (allowRoot && normTarget === normRoot)
    return true
  const prefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`
  return normTarget !== normRoot && normTarget.startsWith(prefix)
}

function validateRelativePath(
  rawPath: string,
  allowRoot: boolean,
): { ok: true, normalizedRel: string } | { ok: false, error: string } {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    return allowRoot
      ? { ok: true, normalizedRel: `.` }
      : { ok: false, error: `Path must be a non-empty relative path` }
  }
  if (trimmed.includes(`\0`))
    return { ok: false, error: `Path must not contain null bytes` }
  if (path.isAbsolute(trimmed) || trimmed.startsWith(`/`) || trimmed.startsWith(`\\`) || /^[a-z]:/i.test(trimmed))
    return { ok: false, error: `Absolute paths are not allowed: ${rawPath}` }
  const segments = trimmed.split(/[/\\]/)
  if (segments.includes(`..`))
    return { ok: false, error: `Parent directory traversal ("..") is not allowed: ${rawPath}` }
  const posixNorm = path.posix.normalize(trimmed.replace(/\\/g, `/`))
  if (posixNorm === `..` || posixNorm.startsWith(`../`))
    return { ok: false, error: `Path escapes workspace: ${rawPath}` }
  return { ok: true, normalizedRel: posixNorm }
}

async function resolveConfinedArticlePath(
  cwd: string,
): Promise<{ ok: true, canonicalRoot: string, targetPath: string, exists: boolean, size: number } | { ok: false, error: string }> {
  let canonicalRoot: string
  try {
    canonicalRoot = await fs.realpath(cwd)
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const candidate = path.join(canonicalRoot, `article.md`)
  try {
    const lstat = await fs.lstat(candidate)
    if (lstat.isSymbolicLink()) {
      let realTarget: string
      try {
        realTarget = await fs.realpath(candidate)
      }
      catch {
        return { ok: false, error: `Refusing to access dangling symlink article.md` }
      }
      if (!isWithinRoot(canonicalRoot, realTarget, false))
        return { ok: false, error: `article.md resolves outside the session workspace` }
      const targetStat = await fs.stat(realTarget)
      if (!targetStat.isFile())
        return { ok: false, error: `article.md is not a regular file` }
      return { ok: true, canonicalRoot, targetPath: realTarget, exists: true, size: targetStat.size }
    }
    if (!lstat.isFile())
      return { ok: false, error: `article.md is not a regular file` }
    return { ok: true, canonicalRoot, targetPath: candidate, exists: true, size: lstat.size }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === `ENOENT`)
      return { ok: true, canonicalRoot, targetPath: candidate, exists: false, size: 0 }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function resolveExistingWorkspacePath(
  cwd: string,
  rawPath: string,
  allowRoot: boolean,
): Promise<{ ok: true, canonicalRoot: string, canonicalTarget: string, normalizedRel: string } | { ok: false, error: string }> {
  const validated = validateRelativePath(rawPath, allowRoot)
  if (!validated.ok)
    return validated

  const canonicalRoot = await fs.realpath(cwd)
  const candidate = path.resolve(canonicalRoot, validated.normalizedRel)
  if (!isWithinRoot(canonicalRoot, candidate, allowRoot))
    return { ok: false, error: `Path escapes workspace: ${rawPath}` }

  let canonicalTarget: string
  try {
    canonicalTarget = await fs.realpath(candidate)
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === `ENOENT`)
      return { ok: false, error: `Path does not exist: ${rawPath}` }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!isWithinRoot(canonicalRoot, canonicalTarget, allowRoot))
    return { ok: false, error: `Path resolves outside the session workspace: ${rawPath}` }

  return {
    ok: true,
    canonicalRoot,
    canonicalTarget,
    normalizedRel: validated.normalizedRel,
  }
}

async function verifyTargetNotEscapingOrArticle(
  targetPath: string,
  canonicalRoot: string,
  canonicalArticlePath: string,
  rawPath: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  if (isSameFsPath(targetPath, canonicalArticlePath))
    return { ok: false, error: `Cannot modify article.md with write_file; use edit_article or write_article instead.` }

  try {
    const stat = await fs.lstat(targetPath)
    if (stat.isDirectory())
      return { ok: false, error: `Path is a directory: ${rawPath}` }
    if (stat.isSymbolicLink()) {
      let resolvedTarget: string
      try {
        resolvedTarget = await fs.realpath(targetPath)
      }
      catch {
        return { ok: false, error: `Refusing to write through a dangling symlink: ${rawPath}` }
      }
      if (!isWithinRoot(canonicalRoot, resolvedTarget, false))
        return { ok: false, error: `Symlink resolves outside the session workspace: ${rawPath}` }
      if (isSameFsPath(resolvedTarget, canonicalArticlePath))
        return { ok: false, error: `Cannot modify article.md with write_file; use edit_article or write_article instead.` }
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== `ENOENT`)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

async function resolveWritableWorkspacePath(
  cwd: string,
  rawPath: string,
): Promise<{ ok: true, canonicalRoot: string, canonicalArticlePath: string, targetPath: string, normalizedRel: string } | { ok: false, error: string }> {
  const validated = validateRelativePath(rawPath, false)
  if (!validated.ok)
    return validated
  if (validated.normalizedRel === `.`)
    return { ok: false, error: `Cannot write to the workspace root directory` }

  const canonicalRoot = await fs.realpath(cwd)
  const canonicalArticlePath = path.join(canonicalRoot, `article.md`)
  const candidate = path.resolve(canonicalRoot, validated.normalizedRel)
  if (!isWithinRoot(canonicalRoot, candidate, false))
    return { ok: false, error: `Path escapes workspace: ${rawPath}` }

  const leafCheck = await verifyTargetNotEscapingOrArticle(candidate, canonicalRoot, canonicalArticlePath, rawPath)
  if (!leafCheck.ok)
    return leafCheck

  // Walk up until an existing ancestor directory is found so symlinks in parent segments cannot escape cwd.
  let probe = path.dirname(candidate)
  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(probe)
      if (!isWithinRoot(canonicalRoot, canonicalAncestor, true))
        return { ok: false, error: `Path resolves outside the session workspace: ${rawPath}` }
      const tail = path.relative(probe, candidate)
      const projected = path.join(canonicalAncestor, tail)
      if (isSameFsPath(projected, canonicalArticlePath))
        return { ok: false, error: `Cannot modify article.md with write_file; use edit_article or write_article instead.` }
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== `ENOENT`)
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      const parent = path.dirname(probe)
      if (parent === probe)
        return { ok: false, error: `Path resolves outside the session workspace: ${rawPath}` }
      probe = parent
    }
  }

  return {
    ok: true,
    canonicalRoot,
    canonicalArticlePath,
    targetPath: candidate,
    normalizedRel: validated.normalizedRel,
  }
}

function normalizeMcpInputSchema(raw: unknown): JsonSchemaInput {
  if (raw && typeof raw === `object` && !Array.isArray(raw)) {
    return {
      type: `object`,
      properties: {},
      ...(raw as Record<string, unknown>),
    } as JsonSchemaInput
  }
  return { type: `object`, properties: {} } as JsonSchemaInput
}

function formatMcpPermissionPreview(rawInput: Record<string, unknown>): string | undefined {
  if (typeof rawInput.prompt === `string` && rawInput.prompt.trim())
    return rawInput.prompt.trim()
  const keys = Object.keys(rawInput)
  if (keys.length === 0)
    return undefined
  return JSON.stringify(rawInput)
}

async function readConfinedSkill(
  session: SessionState,
  skill: SkillEntry,
): Promise<{ ok: true, content: string, files: string[], relSkillDir: string } | { ok: false, error: string }> {
  try {
    const [canonicalWorkspace, canonicalSkillDir, canonicalSkillFile] = await Promise.all([
      fs.realpath(session.cwd),
      fs.realpath(skill.dir),
      fs.realpath(skill.skillFile),
    ])
    if (
      !isWithinRoot(canonicalWorkspace, canonicalSkillDir, false)
      || !isWithinRoot(canonicalSkillDir, canonicalSkillFile, false)
    ) {
      return { ok: false, error: `Skill "${skill.name}" resolves outside the session workspace` }
    }
    const stat = await fs.stat(canonicalSkillFile)
    if (!stat.isFile())
      return { ok: false, error: `Skill "${skill.name}" SKILL.md is not a regular file` }
    if (stat.size > MAX_READ_FILE_BYTES)
      return { ok: false, error: `Skill "${skill.name}" SKILL.md exceeds 256 KB read limit` }

    const [content, files] = await Promise.all([
      fs.readFile(canonicalSkillFile, `utf8`),
      listSkillSupportFiles(canonicalSkillDir, { rootDir: canonicalWorkspace }),
    ])
    return {
      ok: true,
      content,
      files,
      relSkillDir: toPosixRelative(canonicalWorkspace, canonicalSkillDir),
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function tryExpandLeadingSkillToken(segment: string, session: SessionState): Promise<string | null> {
  const trimmed = segment.trimStart()
  const firstToken = trimmed.split(/\s/, 1)[0]
  if (!firstToken.startsWith(`/`))
    return null
  const skillName = firstToken.slice(1)
  if (!skillName)
    return null
  const skill = session.skills.find(s => s.name === skillName)
  if (!skill)
    return null

  const loaded = await readConfinedSkill(session, skill)
  if (!loaded.ok)
    return null

  const filesNote = loaded.files.length > 0
    ? `\nAdditional files in ${loaded.relSkillDir}: ${loaded.files.join(`, `)}`
    : ``
  const rest = trimmed.slice(firstToken.length).trimStart()
  const inlined = `<skill name="${skill.name}" dir="${loaded.relSkillDir}">\n${loaded.content.trimEnd()}\n</skill>${filesNote}`
  return rest ? `${inlined}\n\n${rest}` : inlined
}

async function expandSlashSkill(userText: string, session: SessionState): Promise<string> {
  const direct = await tryExpandLeadingSkillToken(userText, session)
  if (direct !== null)
    return direct

  // Also expand `/skill` when AcpHost wrapped `[Context]...` ahead of the user message
  // (e.g. before `available_commands_update` arrived or when leading spaces were typed).
  if (userText.startsWith(`[Context]`)) {
    const sepIdx = userText.lastIndexOf(`\n\n`)
    if (sepIdx !== -1) {
      const expandedTail = await tryExpandLeadingSkillToken(userText.slice(sepIdx + 2), session)
      if (expandedTail !== null)
        return `${userText.slice(0, sepIdx)}\n\n${expandedTail}`
    }
  }
  return userText
}

async function readConfinedArticleSafe(cwd: string): Promise<string | null> {
  const resolved = await resolveConfinedArticlePath(cwd)
  if (!resolved.ok)
    return null
  if (!resolved.exists)
    return ``
  if (resolved.size > MAX_WRITE_FILE_BYTES)
    return null
  try {
    return await fs.readFile(resolved.targetPath, `utf8`)
  }
  catch {
    return null
  }
}

function isPlanMode(session: SessionState): boolean {
  return session.modeId === `plan`
}

async function emitUpdate(client: AgentContext, sessionId: string, update: Record<string, unknown>): Promise<void> {
  await client.notify(`session/update`, {
    sessionId,
    update: update as never,
  })
}

async function requestToolPermission(params: {
  client: AgentContext
  session: SessionState
  toolCallId: string
  title: string
  kind: ToolKind
  abortSignal: AbortSignal
  locations?: Array<{ path: string }>
  content?: ToolCallContent[]
  rawInput?: Record<string, unknown>
}): Promise<boolean> {
  const { client, session, toolCallId, title, kind, abortSignal, locations, content, rawInput } = params

  if (abortSignal.aborted)
    return false
  if (session.modeId === `bypassPermissions`)
    return true
  if (session.modeId === `acceptEdits` && kind === `edit`)
    return true
  if (session.alwaysAllowedKinds.has(kind))
    return true

  const permissionPromise = client.request<RequestPermissionResponse>(`session/request_permission`, {
    sessionId: session.id,
    toolCall: {
      toolCallId,
      title,
      kind,
      status: `pending`,
      ...(locations ? { locations } : {}),
      ...(content ? { content } : {}),
      ...(rawInput ? { rawInput } : {}),
    },
    options: [
      { optionId: `opt_allow_once`, name: `Allow once`, kind: `allow_once` },
      { optionId: `opt_allow_always`, name: `Allow always`, kind: `allow_always` },
      { optionId: `opt_reject_once`, name: `Reject`, kind: `reject_once` },
    ],
  })

  // Guard unhandled rejection if abort wins the race before the client resolves the RPC.
  permissionPromise.catch(() => undefined)

  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<null>((resolve) => {
    if (abortSignal.aborted) {
      resolve(null)
      return
    }
    onAbort = () => resolve(null)
    abortSignal.addEventListener(`abort`, onAbort, { once: true })
  })

  let response: RequestPermissionResponse | null
  try {
    response = await Promise.race([permissionPromise, abortPromise])
  }
  finally {
    if (onAbort)
      abortSignal.removeEventListener(`abort`, onAbort)
  }

  if (!response || abortSignal.aborted)
    return false

  const outcome = response.outcome
  if (outcome?.outcome !== `selected`)
    return false
  if (outcome.optionId === `opt_allow_always`) {
    session.alwaysAllowedKinds.add(kind)
    return true
  }
  return outcome.optionId === `opt_allow_once`
}

function buildToolsForTurn(params: {
  client: AgentContext
  session: SessionState
  abortSignal: AbortSignal
}): ToolSet {
  const { client, session, abortSignal } = params

  const applyArticleUpdate = (opts: {
    toolCallId?: string
    title: string
    rawInput: Record<string, unknown>
    computeNext: (existing: string) => { ok: true, next: string } | { ok: false, error: string }
  }) => {
    // Serialize concurrent tool calls within the same step so parallel edits never clobber article.md.
    const run = async () => {
      const toolCallId = opts.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      if (abortSignal.aborted)
        return { ok: false, error: `Cancelled` }

      if (session.modeId === `plan`) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: opts.title,
          kind: `edit`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawInput: opts.rawInput,
          rawOutput: { error: `Plan mode is read-only` },
        })
        return { ok: false, error: `Plan mode is read-only; propose your plan without modifying article.md.` }
      }

      const resolvedArticle = await resolveConfinedArticlePath(session.cwd)
      if (!resolvedArticle.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: opts.title,
          kind: `edit`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawInput: opts.rawInput,
          rawOutput: { error: resolvedArticle.error },
        })
        return { ok: false, error: resolvedArticle.error }
      }
      if (resolvedArticle.exists && resolvedArticle.size > MAX_WRITE_FILE_BYTES) {
        const error = `article.md exceeds 1 MB edit limit (${resolvedArticle.size} bytes)`
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: opts.title,
          kind: `edit`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawInput: opts.rawInput,
          rawOutput: { error },
        })
        return { ok: false, error }
      }

      const existing = resolvedArticle.exists
        ? await fs.readFile(resolvedArticle.targetPath, `utf8`).catch(() => ``)
        : ``

      const computed = opts.computeNext(existing)
      if (!computed.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: opts.title,
          kind: `edit`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawInput: opts.rawInput,
          rawOutput: { error: computed.error },
        })
        return { ok: false, error: computed.error }
      }

      const nextBytes = Buffer.byteLength(computed.next, `utf8`)
      if (nextBytes > MAX_WRITE_FILE_BYTES) {
        const error = `Article content exceeds 1 MB write limit (${nextBytes} bytes)`
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: opts.title,
          kind: `edit`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawInput: opts.rawInput,
          rawOutput: { error },
        })
        return { ok: false, error }
      }

      const diffContent: ToolCallContent[] = [
        {
          type: `diff`,
          path: session.articlePath,
          oldText: existing,
          newText: computed.next,
        },
      ]

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title: opts.title,
        kind: `edit`,
        status: `pending`,
        locations: [{ path: session.articlePath }],
        content: diffContent,
        rawInput: opts.rawInput,
      })

      const allowed = await requestToolPermission({
        client,
        session,
        toolCallId,
        title: opts.title,
        kind: `edit`,
        abortSignal,
        locations: [{ path: session.articlePath }],
        content: diffContent,
        rawInput: opts.rawInput,
      })

      if (abortSignal.aborted || !allowed || isPlanMode(session)) {
        const reason = abortSignal.aborted
          ? `Cancelled`
          : (isPlanMode(session) ? `Plan mode is read-only` : `Edit rejected by user`)
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `failed`,
          rawOutput: { error: reason },
        })
        return { ok: false, error: reason }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call_update`,
        toolCallId,
        status: `in_progress`,
      })

      const rechecked = await resolveConfinedArticlePath(session.cwd)
      if (!rechecked.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `failed`,
          rawOutput: { error: rechecked.error },
        })
        return { ok: false, error: rechecked.error }
      }

      await fs.writeFile(rechecked.targetPath, computed.next, `utf8`)
      session.lastAgentArticleContent = computed.next

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call_update`,
        toolCallId,
        status: `completed`,
        content: diffContent,
      })

      return { ok: true, path: session.articlePath, length: computed.next.length }
    }

    const nextTask = session.editQueue.catch(() => undefined).then(run)
    session.editQueue = nextTask
    return nextTask
  }

  const readArticleTool = tool({
    description: `Read the full current Markdown content of article.md.`,
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      if (abortSignal.aborted)
        return { ok: false, error: `Cancelled` }

      const resolved = await resolveConfinedArticlePath(session.cwd)
      if (!resolved.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: `Read article.md`,
          kind: `read`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawOutput: { error: resolved.error },
        })
        return { ok: false, error: resolved.error }
      }
      if (resolved.exists && resolved.size > MAX_WRITE_FILE_BYTES) {
        const error = `article.md exceeds 1 MB read limit (${resolved.size} bytes)`
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: `Read article.md`,
          kind: `read`,
          status: `failed`,
          locations: [{ path: session.articlePath }],
          rawOutput: { error },
        })
        return { ok: false, error }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title: `Read article.md`,
        kind: `read`,
        status: `in_progress`,
        locations: [{ path: session.articlePath }],
      })
      const content = resolved.exists
        ? await fs.readFile(resolved.targetPath, `utf8`).catch(() => ``)
        : ``
      session.lastAgentArticleContent = content
      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call_update`,
        toolCallId,
        status: `completed`,
      })
      return { path: session.articlePath, content }
    },
  })

  const editArticleTool = tool({
    description: `Edit article.md by replacing an exact snippet old_text with new_text.`,
    inputSchema: z.object({
      old_text: z.string().min(1).describe(`Exact existing text in article.md to replace`),
      new_text: z.string().describe(`Replacement Markdown text`),
      replace_all: z.boolean().optional().describe(`Replace all occurrences when true; default false requires a unique match`),
    }),
    execute: async ({ old_text, new_text, replace_all }, options) => {
      return applyArticleUpdate({
        toolCallId: options?.toolCallId,
        title: `Edit article.md`,
        rawInput: {
          path: session.articlePath,
          old_text,
          new_text,
          ...(replace_all !== undefined ? { replace_all } : {}),
        },
        computeNext: (existing) => {
          const firstIdx = existing.indexOf(old_text)
          if (firstIdx === -1)
            return { ok: false, error: `old_text was not found in article.md. Read the article again and match the exact text.` }
          if (!replace_all && existing.includes(old_text, firstIdx + old_text.length))
            return { ok: false, error: `old_text matches multiple locations in article.md. Include more surrounding context or set replace_all=true.` }
          const next = replace_all
            ? existing.split(old_text).join(new_text)
            : `${existing.slice(0, firstIdx)}${new_text}${existing.slice(firstIdx + old_text.length)}`
          return { ok: true, next }
        },
      })
    },
  })

  const writeArticleTool = tool({
    description: `Replace the entire content of article.md with new Markdown.`,
    inputSchema: z.object({
      content: z.string().describe(`Full Markdown content to write to article.md`),
    }),
    execute: async ({ content }, options) => {
      return applyArticleUpdate({
        toolCallId: options?.toolCallId,
        title: `Write article.md`,
        rawInput: { path: session.articlePath, content },
        computeNext: () => ({ ok: true, next: content }),
      })
    },
  })

  const listFilesTool = tool({
    description: `List one level of files and subdirectories inside the session workspace (directories end with "/").`,
    inputSchema: z.object({
      path: z.string().optional().describe(`Optional relative directory path within the workspace; defaults to "."`),
    }),
    execute: async ({ path: relPath }, options) => {
      const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      if (abortSignal.aborted)
        return { ok: false, error: `Cancelled` }

      const rawPath = relPath ?? `.`
      const title = rawPath && rawPath !== `.` ? `List ${rawPath}` : `List workspace files`
      const rawInput = relPath !== undefined ? { path: relPath } : {}

      const resolved = await resolveExistingWorkspacePath(session.cwd, rawPath, true)
      if (!resolved.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title,
          kind: `read`,
          status: `failed`,
          rawInput,
          rawOutput: { error: resolved.error },
        })
        return { ok: false, error: resolved.error }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title,
        kind: `read`,
        status: `in_progress`,
        locations: [{ path: resolved.canonicalTarget }],
        rawInput,
      })

      try {
        const stat = await fs.stat(resolved.canonicalTarget)
        if (!stat.isDirectory()) {
          const error = `Path is not a directory: ${rawPath}`
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `failed`,
            rawOutput: { error },
          })
          return { ok: false, error }
        }

        const dirEntries = await fs.readdir(resolved.canonicalTarget, { withFileTypes: true })
        dirEntries.sort((a, b) => a.name.localeCompare(b.name))
        const entries: string[] = []
        for (const entry of dirEntries) {
          let isDir = entry.isDirectory()
          if (!isDir && entry.isSymbolicLink()) {
            try {
              const linkReal = await fs.realpath(path.join(resolved.canonicalTarget, entry.name))
              if (isWithinRoot(resolved.canonicalRoot, linkReal, true))
                isDir = (await fs.stat(linkReal)).isDirectory()
            }
            catch {
              // Keep non-resolvable symlink unmarked.
            }
          }
          entries.push(isDir ? `${entry.name}/` : entry.name)
        }

        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `completed`,
        })
        return { ok: true, path: resolved.normalizedRel, entries }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `failed`,
          rawOutput: { error: message },
        })
        return { ok: false, error: message }
      }
    },
  })

  const readFileTool = tool({
    description: `Read a UTF-8 text file inside the session workspace (up to 256 KB).`,
    inputSchema: z.object({
      path: z.string().min(1).describe(`Relative path to a file inside the workspace`),
    }),
    execute: async ({ path: relPath }, options) => {
      const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      if (abortSignal.aborted)
        return { ok: false, error: `Cancelled` }

      const title = `Read ${relPath}`
      const rawInput = { path: relPath }

      const resolved = await resolveExistingWorkspacePath(session.cwd, relPath, false)
      if (!resolved.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title,
          kind: `read`,
          status: `failed`,
          rawInput,
          rawOutput: { error: resolved.error },
        })
        return { ok: false, error: resolved.error }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title,
        kind: `read`,
        status: `in_progress`,
        locations: [{ path: resolved.canonicalTarget }],
        rawInput,
      })

      try {
        const stat = await fs.stat(resolved.canonicalTarget)
        if (!stat.isFile()) {
          const error = `Path is not a file: ${relPath}`
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `failed`,
            rawOutput: { error },
          })
          return { ok: false, error }
        }
        if (stat.size > MAX_READ_FILE_BYTES) {
          const error = `File exceeds 256 KB read limit (${stat.size} bytes): ${relPath}`
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `failed`,
            rawOutput: { error },
          })
          return { ok: false, error }
        }

        const content = await fs.readFile(resolved.canonicalTarget, `utf8`)
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `completed`,
        })
        return { ok: true, path: resolved.normalizedRel, content }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `failed`,
          rawOutput: { error: message },
        })
        return { ok: false, error: message }
      }
    },
  })

  const writeFileTool = tool({
    description: `Write a UTF-8 text file inside the session workspace (creating parent directories as needed, up to 1 MB). Cannot write article.md; use edit_article or write_article for article.md.`,
    inputSchema: z.object({
      path: z.string().min(1).describe(`Relative path inside the workspace (cannot be article.md)`),
      content: z.string().describe(`UTF-8 text content to write`),
    }),
    execute: async ({ path: relPath, content }, options) => {
      const run = async () => {
        const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
        if (abortSignal.aborted)
          return { ok: false, error: `Cancelled` }

        const title = `Write ${relPath}`
        const rawInput = { path: relPath, content }

        if (session.modeId === `plan`) {
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call`,
            toolCallId,
            title,
            kind: `edit`,
            status: `failed`,
            rawInput,
            rawOutput: { error: `Plan mode is read-only` },
          })
          return { ok: false, error: `Plan mode is read-only; propose your plan without writing files.` }
        }

        const byteSize = Buffer.byteLength(content, `utf8`)
        if (byteSize > MAX_WRITE_FILE_BYTES) {
          const error = `Content exceeds 1 MB write limit (${byteSize} bytes)`
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call`,
            toolCallId,
            title,
            kind: `edit`,
            status: `failed`,
            rawInput,
            rawOutput: { error },
          })
          return { ok: false, error }
        }

        const resolved = await resolveWritableWorkspacePath(session.cwd, relPath)
        if (!resolved.ok) {
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call`,
            toolCallId,
            title,
            kind: `edit`,
            status: `failed`,
            rawInput,
            rawOutput: { error: resolved.error },
          })
          return { ok: false, error: resolved.error }
        }

        let existing = ``
        try {
          const existingStat = await fs.stat(resolved.targetPath)
          if (existingStat.isFile() && existingStat.size <= MAX_WRITE_FILE_BYTES)
            existing = await fs.readFile(resolved.targetPath, `utf8`)
        }
        catch {
          existing = ``
        }

        const diffContent: ToolCallContent[] = [
          {
            type: `diff`,
            path: resolved.targetPath,
            oldText: existing,
            newText: content,
          },
        ]

        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title,
          kind: `edit`,
          status: `pending`,
          locations: [{ path: resolved.targetPath }],
          content: diffContent,
          rawInput,
        })

        const allowed = await requestToolPermission({
          client,
          session,
          toolCallId,
          title,
          kind: `edit`,
          abortSignal,
          locations: [{ path: resolved.targetPath }],
          content: diffContent,
          rawInput,
        })

        if (abortSignal.aborted || !allowed || isPlanMode(session)) {
          const reason = abortSignal.aborted
            ? `Cancelled`
            : (isPlanMode(session) ? `Plan mode is read-only` : `Write rejected by user`)
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `failed`,
            rawOutput: { error: reason },
          })
          return { ok: false, error: reason }
        }

        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `in_progress`,
        })

        try {
          // Re-verify confinement after awaiting user approval so mid-prompt symlinks cannot escape or alias article.md.
          const rechecked = await resolveWritableWorkspacePath(session.cwd, relPath)
          if (!rechecked.ok)
            throw new Error(rechecked.error)

          await fs.mkdir(path.dirname(rechecked.targetPath), { recursive: true })
          const canonicalParent = await fs.realpath(path.dirname(rechecked.targetPath))
          const finalPath = path.join(canonicalParent, path.basename(rechecked.targetPath))
          if (!isWithinRoot(rechecked.canonicalRoot, canonicalParent, true))
            throw new Error(`Resolved target escapes workspace: ${relPath}`)
          const finalLeafCheck = await verifyTargetNotEscapingOrArticle(
            finalPath,
            rechecked.canonicalRoot,
            rechecked.canonicalArticlePath,
            relPath,
          )
          if (!finalLeafCheck.ok)
            throw new Error(finalLeafCheck.error)

          await fs.writeFile(finalPath, content, `utf8`)
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `completed`,
            content: diffContent,
          })
          return { ok: true, path: rechecked.normalizedRel, length: content.length }
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `failed`,
            rawOutput: { error: message },
          })
          return { ok: false, error: message }
        }
      }

      const nextTask = session.editQueue.catch(() => undefined).then(run)
      session.editQueue = nextTask
      return nextTask
    },
  })

  const loadSkillTool = tool({
    description: `Load a skill's SKILL.md instructions and list any additional files in that skill directory.`,
    inputSchema: z.object({
      name: z.string().min(1).describe(`Skill name from the available skills list`),
    }),
    execute: async ({ name }, options) => {
      const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      if (abortSignal.aborted)
        return { ok: false, error: `Cancelled` }

      const title = `Load skill ${name}`
      const rawInput = { name }
      const skill = session.skills.find(s => s.name === name)
      if (!skill) {
        const error = `Unknown skill: ${name}`
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title,
          kind: `read`,
          status: `failed`,
          rawInput,
          rawOutput: { error },
        })
        return {
          ok: false,
          error,
          availableSkills: session.skills.map(s => s.name),
        }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title,
        kind: `read`,
        status: `in_progress`,
        locations: [{ path: skill.skillFile }],
        rawInput,
      })

      const loaded = await readConfinedSkill(session, skill)
      if (!loaded.ok) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `failed`,
          rawOutput: { error: loaded.error },
        })
        return { ok: false, error: loaded.error }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call_update`,
        toolCallId,
        status: `completed`,
      })
      return {
        ok: true,
        name: skill.name,
        description: skill.description,
        dir: loaded.relSkillDir,
        content: loaded.content,
        files: loaded.files,
      }
    },
  })

  const tools: ToolSet = {
    read_article: readArticleTool,
    edit_article: editArticleTool,
    write_article: writeArticleTool,
    list_files: listFilesTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    load_skill: loadSkillTool,
  }

  for (const mcpClient of session.mcpClients) {
    for (const mcpTool of mcpClient.tools) {
      let exposedName = mcpTool.name
      if (exposedName in tools) {
        const prefix = mcpClient.serverName.replace(/[^\w-]/g, `_`)
        const candidate = `${prefix}_${mcpTool.name}`
        let counter = 2
        exposedName = candidate
        while (exposedName in tools)
          exposedName = `${candidate}_${counter++}`
      }

      const toolTitle = mcpTool.title || mcpTool.name
      tools[exposedName] = tool({
        description: mcpTool.description || `MCP tool "${mcpTool.name}" from server "${mcpClient.serverName}".`,
        inputSchema: jsonSchema<Record<string, unknown>>(normalizeMcpInputSchema(mcpTool.inputSchema)),
        execute: async (input, options) => {
          const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
          if (abortSignal.aborted)
            return { ok: false, error: `Cancelled` }

          const rawInput = input && typeof input === `object` ? input : {}

          if (session.modeId === `plan`) {
            await emitUpdate(client, session.id, {
              sessionUpdate: `tool_call`,
              toolCallId,
              title: toolTitle,
              kind: `other`,
              status: `failed`,
              rawInput,
              rawOutput: { error: `Plan mode is read-only` },
            })
            return { ok: false, error: `Plan mode is read-only; external MCP tools cannot run in Plan mode.` }
          }

          const previewText = formatMcpPermissionPreview(rawInput)
          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call`,
            toolCallId,
            title: toolTitle,
            kind: `other`,
            status: `pending`,
            rawInput,
          })

          const allowed = await requestToolPermission({
            client,
            session,
            toolCallId,
            title: toolTitle,
            kind: `other`,
            abortSignal,
            rawInput,
            ...(previewText ? { content: [{ type: `content`, content: { type: `text`, text: previewText } }] } : {}),
          })

          if (abortSignal.aborted || !allowed || isPlanMode(session)) {
            const reason = abortSignal.aborted
              ? `Cancelled`
              : (isPlanMode(session) ? `Plan mode is read-only` : `Tool call rejected by user`)
            await emitUpdate(client, session.id, {
              sessionUpdate: `tool_call_update`,
              toolCallId,
              status: `failed`,
              rawOutput: { error: reason },
            })
            return { ok: false, error: reason }
          }

          await emitUpdate(client, session.id, {
            sessionUpdate: `tool_call_update`,
            toolCallId,
            status: `in_progress`,
          })

          try {
            const output = await mcpClient.callTool(mcpTool.name, rawInput, abortSignal)
            if (output.isError) {
              const errorText = output.text || `MCP tool "${mcpTool.name}" failed`
              await emitUpdate(client, session.id, {
                sessionUpdate: `tool_call_update`,
                toolCallId,
                status: `failed`,
                rawOutput: { error: errorText },
                ...(output.text ? { content: [{ type: `content`, content: { type: `text`, text: output.text } }] } : {}),
              })
              return { ok: false, error: errorText }
            }

            await emitUpdate(client, session.id, {
              sessionUpdate: `tool_call_update`,
              toolCallId,
              status: `completed`,
              ...(output.text ? { content: [{ type: `content`, content: { type: `text`, text: output.text } }] } : {}),
            })
            return output.text || `OK`
          }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await emitUpdate(client, session.id, {
              sessionUpdate: `tool_call_update`,
              toolCallId,
              status: `failed`,
              rawOutput: { error: message },
            })
            return { ok: false, error: message }
          }
        },
      })
    }
  }

  return tools
}

async function runPromptTurn(params: {
  config: ApiAgentRuntimeConfig
  session: SessionState
  client: AgentContext
  userText: string
  requestSignal?: AbortSignal
}): Promise<`end_turn` | `cancelled`> {
  const { config, session, client, userText, requestSignal } = params
  const abortController = new AbortController()
  session.activeAbort = abortController
  const onRequestAbort = () => abortController.abort()
  if (requestSignal?.aborted)
    abortController.abort()
  else
    requestSignal?.addEventListener(`abort`, onRequestAbort, { once: true })

  try {
    const expandedUserText = await expandSlashSkill(userText, session)
    const currentDiskArticle = await readConfinedArticleSafe(session.cwd)
    const changedExternally = session.messages.length > 0
      && session.lastAgentArticleContent !== null
      && currentDiskArticle !== null
      && currentDiskArticle !== session.lastAgentArticleContent
    const effectiveUserText = changedExternally
      ? `[System note: article.md was updated outside this conversation since the previous turn (for example, local images/... paths were uploaded to hosted URLs or the user edited the article). Call read_article to inspect the latest article.md before calling edit_article or write_article.]\n\n${expandedUserText}`
      : expandedUserText

    const turnMessages: ModelMessage[] = [
      ...session.messages,
      { role: `user`, content: effectiveUserText },
    ]

    const runStreamOnce = async (useReasoningOptions: boolean) => {
      const model = createApiAgentLanguageModel(config, session.modelId)
      const providerOptions = useReasoningOptions
        ? buildReasoningProviderOptions(config.protocol, session.thoughtLevel)
        : undefined
      const tools = buildToolsForTurn({
        client,
        session,
        abortSignal: abortController.signal,
      })

      const result = streamText({
        model,
        system: buildSystemPrompt(session.articlePath, session.modeId, session.skills),
        messages: turnMessages,
        tools,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        abortSignal: abortController.signal,
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
      })

      let emittedAnyOutput = false
      let streamError: unknown = null

      for await (const part of result.fullStream) {
        if (abortController.signal.aborted)
          break
        if (part.type === `text-delta` && part.text) {
          emittedAnyOutput = true
          await emitUpdate(client, session.id, {
            sessionUpdate: `agent_message_chunk`,
            content: { type: `text`, text: part.text },
          })
        }
        else if (part.type === `reasoning-delta` && part.text) {
          emittedAnyOutput = true
          await emitUpdate(client, session.id, {
            sessionUpdate: `agent_thought_chunk`,
            content: { type: `text`, text: part.text },
          })
        }
        else if (
          part.type === `tool-input-start`
          || part.type === `tool-call`
          || part.type === `tool-result`
        ) {
          // Never retry from step 1 once a tool call has started or completed.
          emittedAnyOutput = true
        }
        else if (part.type === `error`) {
          streamError = part.error
        }
      }

      if (streamError) {
        const tagged = Object.assign(
          streamError instanceof Error ? streamError : new Error(String(streamError)),
          { emittedAnyOutput },
        )
        throw tagged
      }

      return result
    }

    let result: Awaited<ReturnType<typeof runStreamOnce>>
    const shouldTryReasoning = session.thoughtLevel !== `default`
    try {
      result = await runStreamOnce(shouldTryReasoning)
    }
    catch (error) {
      const emitted = typeof error === `object` && error !== null && `emittedAnyOutput` in error
        ? Boolean((error as { emittedAnyOutput?: unknown }).emittedAnyOutput)
        : false
      if (shouldTryReasoning && !emitted && !abortController.signal.aborted && isUnsupportedReasoningError(error)) {
        result = await runStreamOnce(false)
      }
      else {
        throw error
      }
    }

    if (abortController.signal.aborted)
      return `cancelled`

    const response = await result.response
    session.messages = trimMessageHistory([...turnMessages, ...response.messages])
    return `end_turn`
  }
  catch (error) {
    if (abortController.signal.aborted || (error instanceof Error && error.name === `AbortError`))
      return `cancelled`
    const rawMessage = error instanceof Error ? error.message : String(error)
    throw RequestError.internalError(undefined, redactSecret(rawMessage, config.apiKey))
  }
  finally {
    requestSignal?.removeEventListener(`abort`, onRequestAbort)
    if (session.activeAbort === abortController)
      session.activeAbort = null
  }
}

async function closeSessionResources(session: SessionState): Promise<void> {
  session.activeAbort?.abort()
  await Promise.allSettled(session.mcpClients.map(c => c.close()))
  session.mcpClients = []
}

let runtimeSecretForFatalLog: string | undefined

async function main(): Promise<void> {
  const config = loadRuntimeConfig()
  runtimeSecretForFatalLog = config.apiKey
  const sessions = new Map<string, SessionState>()

  const closeAllSessions = async (): Promise<void> => {
    const active = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(active.map(closeSessionResources))
  }

  process.once(`exit`, () => {
    for (const session of sessions.values()) {
      for (const mcpClient of session.mcpClients)
        mcpClient.forceKill()
    }
  })

  for (const signal of [`SIGTERM`, `SIGINT`] as const) {
    process.once(signal, () => {
      void closeAllSessions().finally(() => process.exit(0))
    })
  }

  const getSessionOrThrow = (sessionId: string): SessionState => {
    const found = sessions.get(sessionId)
    if (!found)
      throw RequestError.invalidParams(undefined, `Unknown sessionId: ${sessionId}`)
    return found
  }

  const acpAgent = createAcpAgent({ name: `md-api-agent` })
    .onRequest(`initialize`, ({ params }) => {
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        agentCapabilities: {
          mcpCapabilities: {
            http: false,
            sse: false,
          },
          sessionCapabilities: {
            close: {},
          },
        },
        agentInfo: {
          name: `md-api-agent`,
          version: `1.0.0`,
        },
      }
    })
    .onRequest(`session/new`, async ({ params, client }) => {
      const sessionId = `api_sess_${randomUUID().slice(0, 12)}`
      const cwd = params.cwd || process.cwd()
      const skillDirs = WORKSPACE_SKILL_DIRS.map(sub => path.join(cwd, sub))
      const [skills, mcpClients] = await Promise.all([
        readSkills(skillDirs, { rootDir: cwd }),
        connectMcpServers(params.mcpServers ?? [], cwd),
      ])

      const session: SessionState = {
        id: sessionId,
        cwd,
        articlePath: path.join(cwd, `article.md`),
        modelId: config.defaultModel,
        modeId: `default`,
        thoughtLevel: `default`,
        messages: [],
        lastAgentArticleContent: null,
        editQueue: Promise.resolve(),
        alwaysAllowedKinds: new Set<ToolKind>(),
        activeAbort: null,
        skills,
        mcpClients,
      }
      sessions.set(sessionId, session)

      // Send after the session/new response flushes; even an empty list unblocks the host's probe wait.
      setImmediate(() => {
        if (!sessions.has(sessionId))
          return
        void emitUpdate(client, sessionId, {
          sessionUpdate: `available_commands_update`,
          availableCommands: session.skills.map(s => ({
            name: s.name,
            description: s.description,
          })),
        }).catch(() => undefined)
      })

      return buildSessionResponse(config, session)
    })
    .onRequest(`session/set_model`, setModelParamsSchema, ({ params }) => {
      const session = getSessionOrThrow(params.sessionId)
      if (!config.enabledModels.includes(params.modelId))
        throw RequestError.invalidParams(undefined, `Model "${params.modelId}" is not enabled`)
      session.modelId = params.modelId
      return {}
    })
    .onRequest(`session/set_mode`, async ({ params, client }) => {
      const session = getSessionOrThrow(params.sessionId)
      if (!VALID_MODES.has(params.modeId as ApiModeId))
        throw RequestError.invalidParams(undefined, `Unsupported mode: ${params.modeId}`)
      session.modeId = params.modeId as ApiModeId
      if (session.modeId === `default` || session.modeId === `plan`)
        session.alwaysAllowedKinds.clear()
      await emitUpdate(client, session.id, {
        sessionUpdate: `current_mode_update`,
        currentModeId: session.modeId,
      })
      return {}
    })
    .onRequest(`session/set_config_option`, async ({ params, client }) => {
      const session = getSessionOrThrow(params.sessionId)
      const value = typeof params.value === `string` ? params.value : ``
      if (params.configId === `model`) {
        if (!config.enabledModels.includes(value))
          throw RequestError.invalidParams(undefined, `Model "${value}" is not enabled`)
        session.modelId = value
      }
      else if (params.configId === `mode`) {
        if (!VALID_MODES.has(value as ApiModeId))
          throw RequestError.invalidParams(undefined, `Unsupported mode: ${value}`)
        session.modeId = value as ApiModeId
        if (session.modeId === `default` || session.modeId === `plan`)
          session.alwaysAllowedKinds.clear()
        await emitUpdate(client, session.id, {
          sessionUpdate: `current_mode_update`,
          currentModeId: session.modeId,
        })
      }
      else if (params.configId === `thought_level`) {
        if (!VALID_THOUGHT_LEVELS.has(value as ApiThoughtLevel))
          throw RequestError.invalidParams(undefined, `Unsupported thinking level: ${value}`)
        session.thoughtLevel = value as ApiThoughtLevel
      }
      else {
        throw RequestError.invalidParams(undefined, `Unknown configId: ${params.configId}`)
      }
      return { configOptions: buildConfigOptions(config, session) }
    })
    .onRequest(`session/prompt`, async ({ params, client, signal }) => {
      const session = getSessionOrThrow(params.sessionId)
      if (session.activeAbort)
        throw RequestError.invalidParams(undefined, `Session "${params.sessionId}" already has an active prompt turn`)
      const userText = extractPromptText(params.prompt)
      const stopReason = await runPromptTurn({
        config,
        session,
        client,
        userText,
        requestSignal: signal,
      })
      return { stopReason }
    })
    .onNotification(`session/cancel`, ({ params }) => {
      const session = sessions.get(params.sessionId)
      session?.activeAbort?.abort()
    })
    .onRequest(`session/close`, async ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (session) {
        sessions.delete(params.sessionId)
        await closeSessionResources(session)
      }
      return {}
    })

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  const connection = acpAgent.connect(stream)
  await connection.closed
  await closeAllSessions()
}

main().catch((error) => {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`[md-api-agent] fatal: ${redactSecret(raw, runtimeSecretForFatalLog)}\n`)
  process.exit(1)
})
