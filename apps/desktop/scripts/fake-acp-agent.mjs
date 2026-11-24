#!/usr/bin/env node
/**
 * Minimal ACP JSON-RPC test/dev agent over stdio.
 * Reads/writes disk directly (matching default clientCapabilities.fs = false).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'

const junkStdout = process.env.FAKE_AGENT_JUNK_STDOUT === `1`
const hangMethod = process.env.FAKE_AGENT_HANG_METHOD || ``
const earlyUpdate = process.env.FAKE_AGENT_EARLY_UPDATE === `1`
const modelStyle = process.env.FAKE_AGENT_MODEL_STYLE || `models`
const modesStyle = process.env.FAKE_AGENT_MODES_STYLE || `claude`
const extraModes = process.env.FAKE_AGENT_EXTRA_MODES === `1`
const emitCommands = process.env.FAKE_AGENT_EMIT_COMMANDS === `1`
const requirePermission = process.env.FAKE_AGENT_REQUIRE_PERMISSION === `1`
const requireEditPermission = process.env.FAKE_AGENT_REQUIRE_EDIT_PERMISSION !== `0`
const emitAllToolKinds = process.env.FAKE_AGENT_ALL_TOOL_KINDS === `1`
const stringifyIds = process.env.FAKE_AGENT_STRINGIFY_IDS === `1`
const directWriteWithoutEditTool = process.env.FAKE_AGENT_DIRECT_WRITE_ONLY === `1`
const pushModeUpdate = process.env.FAKE_AGENT_PUSH_MODE || ``

const SESSION_ID = `fake_sess_01`
let currentModelId = `opus-5.5`
let currentModeId = process.env.FAKE_AGENT_INITIAL_MODE || `default`
const modeHistory = []
let currentCwd = process.cwd()
let nextClientRequestId = 1000
const pendingClientRequests = new Map()

function writeRaw(line) {
  process.stdout.write(`${line}\n`)
}

function sendJson(msg) {
  writeRaw(JSON.stringify(msg))
}

function sendResult(id, result) {
  sendJson({
    jsonrpc: `2.0`,
    id: stringifyIds && typeof id === `number` ? String(id) : id,
    result,
  })
}

function sendError(id, code, message) {
  sendJson({
    jsonrpc: `2.0`,
    id,
    error: { code, message },
  })
}

function sendNotification(method, params) {
  sendJson({ jsonrpc: `2.0`, method, params })
}

function callClient(method, params) {
  const id = nextClientRequestId++
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject })
    sendJson({ jsonrpc: `2.0`, id, method, params })
  })
}

function sendUpdate(update) {
  sendNotification(`session/update`, {
    sessionId: SESSION_ID,
    update,
  })
}

function buildModesEntries() {
  if (modesStyle === `none`)
    return []
  const base = [
    { id: `default`, name: `Default`, description: `Ask before edits and commands` },
    { id: `acceptEdits`, name: `Accept Edits`, description: `Auto-accept file edits` },
    { id: `plan`, name: `Plan`, description: `Read-only planning mode` },
    { id: `bypassPermissions`, name: `Bypass Permissions`, description: `Skip all permission prompts` },
  ]
  if (extraModes) {
    base.push({ id: `deep_review`, name: `Deep Review`, description: `Editorial fact-check and tone audit` })
  }
  return base
}

function buildModelsMetadata() {
  const modelEntries = [
    { modelId: `opus-5.5`, name: `Opus 5.5`, description: `Best for long-form writing and reasoning` },
    { modelId: `sonnet-5.5`, name: `Sonnet 5.5`, description: `Balanced speed and quality` },
    { modelId: `haiku-5.5`, name: `Haiku 5.5`, description: `Fastest for quick edits and polishing` },
  ]
  const modeEntries = buildModesEntries()
  const configOptions = [
    {
      id: `model`,
      name: `Model`,
      category: `model`,
      type: `select`,
      currentValue: currentModelId,
      options: modelEntries.map(m => ({
        value: m.modelId,
        name: m.name,
        description: m.description,
      })),
    },
    ...(modeEntries.length > 0
      ? [{
          id: `mode`,
          name: `Mode`,
          category: `mode`,
          type: `select`,
          currentValue: currentModeId,
          options: modeEntries.map(m => ({
            value: m.id,
            name: m.name,
            description: m.description,
          })),
        }]
      : []),
  ]

  const modesField = modeEntries.length > 0
    ? {
        modes: {
          currentModeId,
          availableModes: modeEntries,
        },
      }
    : {}

  if (modelStyle === `configOptions`)
    return { configOptions }
  if (modelStyle === `both`) {
    return {
      models: { currentModelId, availableModels: modelEntries },
      ...modesField,
      configOptions,
    }
  }
  return {
    models: { currentModelId, availableModels: modelEntries },
    ...modesField,
  }
}

async function handlePrompt(id, params) {
  const text = (params.prompt || [])
    .filter(b => b.type === `text`)
    .map(b => b.text)
    .join(`\n`)

  if (emitAllToolKinds) {
    const kinds = [
      { id: `tc-read`, kind: `read`, title: `Read outline`, rawInput: { path: `outline.md` }, status: `completed` },
      { id: `tc-search`, kind: `search`, title: `Search docs`, rawInput: { query: `ACP` }, status: `completed` },
      {
        id: `tc-edit`,
        kind: `edit`,
        title: `Update article`,
        locations: [{ path: `article.md` }],
        content: [{ type: `diff`, path: `article.md`, oldText: `old`, newText: `new` }],
        status: `completed`,
      },
      { id: `tc-delete`, kind: `delete`, title: `Remove temp`, locations: [{ path: `tmp.md` }], status: `completed` },
      { id: `tc-execute`, kind: `execute`, title: `Render SVG`, rawInput: { command: `npx mmdc -i a.mmd -o a.svg` }, status: `completed` },
      { id: `tc-fetch`, kind: `fetch`, title: `Fetch spec`, rawInput: { url: `https://agentclientprotocol.com` }, status: `completed` },
      { id: `tc-think`, kind: `think`, title: `Plan structure`, status: `completed` },
      { id: `tc-mode`, kind: `switch_mode`, title: `Switch to write`, status: `completed` },
      { id: `tc-move`, kind: `move`, title: `Rename draft`, rawInput: { path: `draft.md` }, status: `completed` },
    ]
    for (const item of kinds) {
      sendUpdate({
        sessionUpdate: `tool_call`,
        toolCallId: item.id,
        title: item.title,
        kind: item.kind,
        status: `in_progress`,
        rawInput: item.rawInput,
        locations: item.locations,
      })
      sendUpdate({
        sessionUpdate: `tool_call_update`,
        toolCallId: item.id,
        status: item.status,
        content: item.content,
      })
    }
    sendUpdate({
      sessionUpdate: `agent_message_chunk`,
      content: { type: `text`, text: `All tool kinds emitted.` },
    })
    sendResult(id, { stopReason: `end_turn` })
    return
  }

  const articlePath = path.join(currentCwd, `article.md`)
  let existing = ``
  try {
    existing = await fs.readFile(articlePath, `utf8`)
  }
  catch {
    existing = ``
  }

  if (directWriteWithoutEditTool) {
    const nextText = `${existing.trimEnd()}\n\n<!-- turn-end-sync -->\n`
    await fs.writeFile(articlePath, nextText, `utf8`)
    sendUpdate({
      sessionUpdate: `agent_message_chunk`,
      content: { type: `text`, text: `Updated article directly on disk.` },
    })
    sendResult(id, { stopReason: `end_turn` })
    return
  }

  sendUpdate({
    sessionUpdate: `agent_thought_chunk`,
    content: { type: `text`, text: `Analyzing article context and reader tone.` },
  })

  sendUpdate({
    sessionUpdate: `agent_message_chunk`,
    content: { type: `text`, text: `好的，先读取当前文章内容，然后按要求更新正文。` },
  })

  sendUpdate({
    sessionUpdate: `plan`,
    entries: [
      { content: `读取当前文章`, status: `completed`, priority: `high` },
      { content: `整理段落与示例`, status: `in_progress`, priority: `medium` },
      { content: `写入修改并校对`, status: `pending`, priority: `low` },
    ],
  })

  const updatedArticle = existing.trim()
    ? `${existing.trimEnd()}\n\n## ACP 协作示例\n\n由本地 Agent (${currentModelId}) 直接写入的示例段落：\n\n\`\`\`json\n{ "method": "session/prompt", "params": { "sessionId": "${SESSION_ID}" } }\n\`\`\`\n`
    : `# ACP 协议入门\n\n> 写作这件事，正在从「人写、AI 改」变成「人定方向、Agent 动手」。\n\n## 协议如何工作\n\n一次完整的会话只需要四步：\`initialize\`、\`session/new\`、\`session/prompt\` 与 \`session/update\`。\n`

  sendUpdate({
    sessionUpdate: `tool_call`,
    toolCallId: `edit-article-1`,
    title: `更新 article.md`,
    kind: `edit`,
    status: `pending`,
    locations: [{ path: articlePath }],
    content: [{ type: `diff`, path: articlePath, oldText: existing, newText: updatedArticle }],
  })

  let editAllowed = true
  if (requireEditPermission) {
    const editPerm = await callClient(`session/request_permission`, {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: `edit-article-1`,
        title: `更新 article.md`,
        kind: `edit`,
        status: `pending`,
        locations: [{ path: articlePath }],
        content: [{ type: `diff`, path: articlePath, oldText: existing, newText: updatedArticle }],
      },
      options: [
        { optionId: `opt_allow_once`, name: `Allow once`, kind: `allow_once` },
        { optionId: `opt_allow_always`, name: `Allow always`, kind: `allow_always` },
        { optionId: `opt_reject_once`, name: `Reject`, kind: `reject_once` },
      ],
    })
    const editOutcome = editPerm?.outcome
    editAllowed = editOutcome?.outcome === `selected` && editOutcome.optionId !== `opt_reject_once`
  }

  if (editAllowed) {
    await fs.writeFile(articlePath, updatedArticle, `utf8`)
    sendUpdate({
      sessionUpdate: `tool_call_update`,
      toolCallId: `edit-article-1`,
      status: `completed`,
      content: [{ type: `diff`, path: articlePath, oldText: existing, newText: updatedArticle }],
    })
  }
  else {
    sendUpdate({
      sessionUpdate: `tool_call_update`,
      toolCallId: `edit-article-1`,
      status: `failed`,
      rawOutput: { error: `Edit rejected by user` },
    })
  }

  const needsExecPerm = requirePermission || /permission|mermaid|命令|svg|run/i.test(text)
  if (needsExecPerm) {
    sendUpdate({
      sessionUpdate: `agent_message_chunk`,
      content: { type: `text`, text: `\n\n正文已更新。接下来需要执行一条命令来渲染图表：` },
    })

    const permRes = await callClient(`session/request_permission`, {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: `exec-mmdc-1`,
        title: `允许执行命令？`,
        kind: `execute`,
        status: `pending`,
        rawInput: { command: `npx mmdc -i acp.mmd -o acp.svg` },
      },
      options: [
        { optionId: `opt_allow_once`, name: `Allow once`, kind: `allow_once` },
        { optionId: `opt_allow_always`, name: `Allow always`, kind: `allow_always` },
        { optionId: `opt_reject_once`, name: `Reject`, kind: `reject_once` },
      ],
    })

    const outcome = permRes?.outcome
    const summary = outcome?.outcome === `selected`
      ? `permission:${outcome.optionId}`
      : `permission:cancelled`

    sendUpdate({
      sessionUpdate: `agent_message_chunk`,
      content: { type: `text`, text: `\n\n[${summary}]` },
    })
  }

  if (pushModeUpdate) {
    currentModeId = pushModeUpdate
    sendUpdate({
      sessionUpdate: `current_mode_update`,
      currentModeId,
    })
  }

  sendUpdate({
    sessionUpdate: `plan`,
    entries: [
      { content: `读取当前文章`, status: `completed`, priority: `high` },
      { content: `整理段落与示例`, status: `completed`, priority: `medium` },
      { content: `写入修改并校对`, status: `completed`, priority: `low` },
    ],
  })

  if (modeHistory.length > 0) {
    sendUpdate({
      sessionUpdate: `agent_message_chunk`,
      content: { type: `text`, text: `\n\n[modes:${modeHistory.join(`,`)}]` },
    })
  }

  sendResult(id, { stopReason: `end_turn` })
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg

  if (hangMethod === method)
    return

  if (junkStdout)
    writeRaw(`[banner] non-json debug line before ${method}`)

  switch (method) {
    case `initialize`: {
      if (process.env.NO_BROWSER === `true`)
        process.stderr.write(`[fake-agent] NO_BROWSER=true observed\n`)

      sendResult(id, {
        protocolVersion: params.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {} },
        },
        agentInfo: { name: `fake-acp-agent`, version: `1.0.0` },
        _meta: {
          receivedClientCapabilities: params.clientCapabilities ?? null,
        },
      })
      return
    }
    case `session/new`: {
      if (!params.cwd || !Array.isArray(params.mcpServers)) {
        sendError(id, -32602, `cwd and mcpServers are required`)
        return
      }
      currentCwd = params.cwd

      if (earlyUpdate) {
        sendUpdate({
          sessionUpdate: `agent_message_chunk`,
          content: { type: `text`, text: `EARLY_UPDATE_MESSAGE` },
        })
      }

      sendResult(id, {
        sessionId: SESSION_ID,
        ...buildModelsMetadata(),
      })

      if (emitCommands) {
        setTimeout(() => {
          sendUpdate({
            sessionUpdate: `available_commands_update`,
            availableCommands: [
              { name: `outline`, description: `Generate an article outline` },
              { name: `polish`, description: `Polish tone and clarity`, input: { hint: `style` } },
            ],
          })
        }, 40)
      }
      return
    }
    case `session/load`: {
      if (!params.cwd || !Array.isArray(params.mcpServers)) {
        sendError(id, -32602, `cwd and mcpServers are required`)
        return
      }
      currentCwd = params.cwd
      sendResult(id, buildModelsMetadata())
      return
    }
    case `session/set_model`: {
      if (modelStyle === `configOptions`) {
        sendError(id, -32601, `Method not found: session/set_model`)
        return
      }
      currentModelId = params.modelId
      sendResult(id, {})
      return
    }
    case `session/set_mode`: {
      if (modelStyle === `configOptions` || modesStyle === `none`) {
        sendError(id, -32601, `Method not found: session/set_mode`)
        return
      }
      currentModeId = params.modeId
      modeHistory.push(params.modeId)
      sendUpdate({
        sessionUpdate: `current_mode_update`,
        currentModeId,
      })
      sendResult(id, {})
      return
    }
    case `session/set_config_option`: {
      if (params.configId === `model`)
        currentModelId = params.value
      if (params.configId === `mode`) {
        currentModeId = params.value
        modeHistory.push(params.value)
      }
      const meta = buildModelsMetadata()
      sendResult(id, { configOptions: meta.configOptions ?? [] })
      return
    }
    case `session/prompt`: {
      await handlePrompt(id, params)
      return
    }
    case `session/close`: {
      sendResult(id, {})
      return
    }
    default: {
      sendError(id, -32601, `Unknown method: ${method}`)
    }
  }
}

if (junkStdout)
  writeRaw(`Starting Fake ACP Agent v1.0 (not json!)`)

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on(`line`, (line) => {
  const trimmed = line.trim()
  if (!trimmed)
    return
  let msg
  try {
    msg = JSON.parse(trimmed)
  }
  catch {
    return
  }

  if (msg.method) {
    if (msg.id !== undefined) {
      void handleRequest(msg).catch((error) => {
        sendError(msg.id, -32603, error instanceof Error ? error.message : String(error))
      })
    }
    return
  }

  if (msg.id !== undefined && pendingClientRequests.has(msg.id)) {
    const pending = pendingClientRequests.get(msg.id)
    pendingClientRequests.delete(msg.id)
    if (msg.error)
      pending.reject(new Error(msg.error.message || `Client error`))
    else
      pending.resolve(msg.result)
  }
})
