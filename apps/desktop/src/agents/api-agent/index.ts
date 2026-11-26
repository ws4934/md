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
import type { ModelMessage } from 'ai'
import type { ApiAgentModeId, ApiAgentRuntimeConfig, ApiThoughtLevel } from './provider'
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
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { redactSecret } from '../../main/ai/sanitize'
import { generateAndSaveWorkspaceImage } from '../shared/image-client'
import {
  API_AGENT_MODES,
  API_THOUGHT_LEVEL_OPTIONS,
  buildReasoningProviderOptions,
  createApiAgentLanguageModel,
  isUnsupportedReasoningError,
} from './provider'

type ApiModeId = ApiAgentModeId

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
}

const AVAILABLE_MODES: SessionMode[] = API_AGENT_MODES.map(m => ({ ...m }))

const VALID_MODES = new Set<ApiModeId>([`default`, `acceptEdits`, `plan`, `bypassPermissions`])
const VALID_THOUGHT_LEVELS = new Set<ApiThoughtLevel>([`default`, `low`, `medium`, `high`])

const MAX_AGENT_STEPS = 12

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

function getImageBridgeEnv(): { url: string, token: string } | null {
  const url = process.env.MD_IMAGE_BRIDGE_URL?.trim()
  const token = process.env.MD_IMAGE_BRIDGE_TOKEN?.trim()
  if (!url || !token)
    return null
  return { url, token }
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

function buildSystemPrompt(articlePath: string, modeId: ApiModeId, hasImageGen: boolean): string {
  const lines = [
    `You are a focused Markdown article writing and editing assistant inside doocs/md.`,
    `The active article file is "${articlePath}".`,
    `Available tools: read_article (read the full Markdown article), edit_article (replace an exact snippet in the article), write_article (replace the full article)${hasImageGen ? `, and generate_image (generate an illustration saved under images/ for Markdown insertion)` : ``}.`,
    `Always inspect the current article with read_article before editing unless you already have its latest content in this conversation.`,
    `Use edit_article for targeted revisions and write_article for drafting from scratch or major rewrites.`,
    `Keep replies concise and respond in the user's language.`,
  ]
  if (modeId === `plan`)
    lines.push(`You are currently in Plan mode (read-only). Do NOT modify the article or generate images; read the article and propose a clear plan instead.`)
  return lines.join(`\n`)
}

function extractPromptText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === `text`)
        return block.text
      if (block.type === `resource_link`)
        return `[Resource: ${block.name || block.uri}]`
      return ``
    })
    .filter(Boolean)
    .join(`\n`)
}

async function readArticleSafe(articlePath: string): Promise<string> {
  try {
    return await fs.readFile(articlePath, `utf8`)
  }
  catch {
    return ``
  }
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
  locations?: Array<{ path: string }>
  content?: ToolCallContent[]
  rawInput?: Record<string, unknown>
}): Promise<boolean> {
  const { client, session, toolCallId, title, kind, locations, content, rawInput } = params

  if (session.modeId === `bypassPermissions`)
    return true
  if (session.modeId === `acceptEdits` && kind === `edit`)
    return true
  if (session.alwaysAllowedKinds.has(kind))
    return true

  const response = await client.request<RequestPermissionResponse>(`session/request_permission`, {
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

  const outcome = response?.outcome
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
  imageBridge: { url: string, token: string } | null
  abortSignal: AbortSignal
}) {
  const { client, session, imageBridge, abortSignal } = params

  const applyArticleUpdate = (opts: {
    toolCallId?: string
    title: string
    rawInput: Record<string, unknown>
    computeNext: (existing: string) => { ok: true, next: string } | { ok: false, error: string }
  }) => {
    // Serialize concurrent tool calls within the same step so parallel edits never clobber article.md.
    const run = async () => {
      const toolCallId = opts.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      const existing = await readArticleSafe(session.articlePath)

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
        locations: [{ path: session.articlePath }],
        content: diffContent,
        rawInput: opts.rawInput,
      })

      if (abortSignal.aborted || !allowed) {
        const reason = abortSignal.aborted ? `Cancelled` : `Edit rejected by user`
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

      await fs.writeFile(session.articlePath, computed.next, `utf8`)
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
      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title: `Read article.md`,
        kind: `read`,
        status: `in_progress`,
        locations: [{ path: session.articlePath }],
      })
      const content = await readArticleSafe(session.articlePath)
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
        rawInput: { path: session.articlePath, old_text, new_text },
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

  const baseTools = {
    read_article: readArticleTool,
    edit_article: editArticleTool,
    write_article: writeArticleTool,
  }

  if (!imageBridge)
    return baseTools

  const generateImageTool = tool({
    description: `Generate an illustration and save it under images/ in the article workspace. Insert it in article.md as ![alt](images/<name>.png).`,
    inputSchema: z.object({
      prompt: z.string().min(1).describe(`Detailed description of the image to generate`),
      filename: z.string().optional().describe(`Optional short filename slug without directory`),
      size: z.string().optional().describe(`Optional image size such as "1024x1024", "1536x1024", or "1024x1536"`),
    }),
    execute: async ({ prompt, filename, size }, options) => {
      const toolCallId = options?.toolCallId || `tc-${randomUUID().slice(0, 8)}`
      const rawInput = { prompt, ...(filename ? { filename } : {}), ...(size ? { size } : {}) }

      if (session.modeId === `plan`) {
        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call`,
          toolCallId,
          title: `Generate image`,
          kind: `other`,
          status: `failed`,
          rawInput,
          rawOutput: { error: `Plan mode is read-only` },
        })
        return { ok: false, error: `Plan mode is read-only; do not generate images in Plan mode.` }
      }

      await emitUpdate(client, session.id, {
        sessionUpdate: `tool_call`,
        toolCallId,
        title: `Generate image`,
        kind: `other`,
        status: `pending`,
        rawInput,
      })

      const allowed = await requestToolPermission({
        client,
        session,
        toolCallId,
        title: `Generate image`,
        kind: `other`,
        rawInput,
        content: [{ type: `content`, content: { type: `text`, text: prompt } }],
      })

      if (abortSignal.aborted || !allowed) {
        const reason = abortSignal.aborted ? `Cancelled` : `Image generation rejected by user`
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
        const saved = await generateAndSaveWorkspaceImage({
          bridgeUrl: imageBridge.url,
          bridgeToken: imageBridge.token,
          workspaceDir: session.cwd,
          prompt,
          filename,
          size,
          abortSignal,
        })

        await emitUpdate(client, session.id, {
          sessionUpdate: `tool_call_update`,
          toolCallId,
          status: `completed`,
          locations: [{ path: saved.absolutePath }],
          content: [{ type: `content`, content: { type: `text`, text: saved.relativePath } }],
        })

        return {
          ok: true,
          path: saved.relativePath,
          markdown: `![illustration](${saved.relativePath})`,
          hint: `Reference this image in article.md as ![description](${saved.relativePath}).`,
        }
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

  return {
    ...baseTools,
    generate_image: generateImageTool,
  }
}

async function runPromptTurn(params: {
  config: ApiAgentRuntimeConfig
  imageBridge: { url: string, token: string } | null
  session: SessionState
  client: AgentContext
  userText: string
}): Promise<`end_turn` | `cancelled`> {
  const { config, imageBridge, session, client, userText } = params
  const abortController = new AbortController()
  session.activeAbort = abortController

  const currentDiskArticle = await readArticleSafe(session.articlePath)
  const changedExternally = session.messages.length > 0
    && session.lastAgentArticleContent !== null
    && currentDiskArticle !== session.lastAgentArticleContent
  const effectiveUserText = changedExternally
    ? `[System note: article.md was updated outside this conversation since the previous turn (for example, local images/... paths were uploaded to hosted URLs or the user edited the article). Call read_article to inspect the latest article.md before calling edit_article or write_article.]\n\n${userText}`
    : userText

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
      imageBridge,
      abortSignal: abortController.signal,
    })

    const result = streamText({
      model,
      system: buildSystemPrompt(session.articlePath, session.modeId, Boolean(imageBridge)),
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

  try {
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
    session.messages = [...turnMessages, ...response.messages]
    return `end_turn`
  }
  catch (error) {
    if (abortController.signal.aborted || (error instanceof Error && error.name === `AbortError`))
      return `cancelled`
    const rawMessage = error instanceof Error ? error.message : String(error)
    throw new Error(redactSecret(rawMessage, config.apiKey))
  }
  finally {
    if (session.activeAbort === abortController)
      session.activeAbort = null
  }
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig()
  const imageBridge = getImageBridgeEnv()
  const sessions = new Map<string, SessionState>()

  const getSessionOrThrow = (sessionId: string): SessionState => {
    const found = sessions.get(sessionId)
    if (!found)
      throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return found
  }

  const acpAgent = createAcpAgent({ name: `md-api-agent` })
    .onRequest(`initialize`, ({ params }) => {
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        agentCapabilities: {
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
    .onRequest(`session/new`, ({ params }) => {
      const sessionId = `api_sess_${randomUUID().slice(0, 12)}`
      const cwd = params.cwd || process.cwd()
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
      }
      sessions.set(sessionId, session)
      return buildSessionResponse(config, session)
    })
    .onRequest(`session/set_model`, setModelParamsSchema, ({ params }) => {
      const session = getSessionOrThrow(params.sessionId)
      if (!config.enabledModels.includes(params.modelId))
        throw RequestError.invalidParams(`Model "${params.modelId}" is not enabled`)
      session.modelId = params.modelId
      return {}
    })
    .onRequest(`session/set_mode`, async ({ params, client }) => {
      const session = getSessionOrThrow(params.sessionId)
      if (!VALID_MODES.has(params.modeId as ApiModeId))
        throw RequestError.invalidParams(`Unsupported mode: ${params.modeId}`)
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
          throw RequestError.invalidParams(`Model "${value}" is not enabled`)
        session.modelId = value
      }
      else if (params.configId === `mode`) {
        if (!VALID_MODES.has(value as ApiModeId))
          throw RequestError.invalidParams(`Unsupported mode: ${value}`)
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
          throw RequestError.invalidParams(`Unsupported thinking level: ${value}`)
        session.thoughtLevel = value as ApiThoughtLevel
      }
      else {
        throw RequestError.invalidParams(`Unknown configId: ${params.configId}`)
      }
      return { configOptions: buildConfigOptions(config, session) }
    })
    .onRequest(`session/prompt`, async ({ params, client }) => {
      const session = getSessionOrThrow(params.sessionId)
      const userText = extractPromptText(params.prompt)
      const stopReason = await runPromptTurn({
        config,
        imageBridge,
        session,
        client,
        userText,
      })
      return { stopReason }
    })
    .onNotification(`session/cancel`, ({ params }) => {
      const session = sessions.get(params.sessionId)
      session?.activeAbort?.abort()
    })
    .onRequest(`session/close`, ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (session) {
        session.activeAbort?.abort()
        sessions.delete(params.sessionId)
      }
      return {}
    })

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  const connection = acpAgent.connect(stream)
  await connection.closed
}

main().catch((error) => {
  process.stderr.write(`[md-api-agent] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
