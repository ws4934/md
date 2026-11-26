import type { AcpHostEvent } from '@md/shared/types'
import type { ModelMessage } from 'ai'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildDesktopBundles } from '../../../scripts/build'
import { trimMessageHistory } from '../../agents/api-agent/history'
import { McpStdioClient } from '../../agents/api-agent/mcp-client'
import { isUnsupportedReasoningError } from '../../agents/api-agent/provider'
import { readNdjsonLines } from '../../agents/shared/ndjson'
import { listSkillSupportFiles, readSkills } from '../../agents/shared/skills'
import { AcpHost } from '../acp/host'
import { AiConfigStore } from './config-store'
import { ImageGenBridge } from './image-bridge'
import { generateDesktopImage } from './image-service'
import { resolveUnpackedAgentScript } from './paths'
import { fetchRemoteModels } from './remote-models'
import { redactSecret, validateHttpBaseUrl } from './sanitize'

const { generateImageMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
}))

vi.mock(`ai`, async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateImage: generateImageMock,
  }
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(__dirname, `../../..`)
const API_AGENT_SCRIPT = path.join(DESKTOP_ROOT, `dist/agents/api-agent.js`)
const IMAGE_MCP_SCRIPT = path.join(DESKTOP_ROOT, `dist/agents/image-mcp.js`)

const TINY_PNG_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, `base64`)

const tempDirs: string[] = []
const openHosts: AcpHost[] = []
const openBridges: ImageGenBridge[] = []
const openServers: Server[] = []
const openMcpClients: McpStdioClient[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on(`data`, (c: Buffer) => chunks.push(c))
    req.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)))
    req.on(`error`, reject)
  })
}

function writeSseChunk(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

beforeAll(async () => {
  try {
    await fs.access(API_AGENT_SCRIPT)
    await fs.access(IMAGE_MCP_SCRIPT)
  }
  catch {
    await buildDesktopBundles()
  }
}, 30_000)

afterEach(async () => {
  generateImageMock.mockReset()
  while (openMcpClients.length > 0)
    await openMcpClients.pop()!.close()
  while (openHosts.length > 0)
    await openHosts.pop()!.dispose()
  while (openBridges.length > 0)
    await openBridges.pop()!.close()
  while (openServers.length > 0) {
    const s = openServers.pop()!
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      if (typeof s.closeAllConnections === `function`)
        s.closeAllConnections()
    })
  }
  while (tempDirs.length > 0)
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
})

describe(`ndjson framing and MCP stdio protocol`, () => {
  it(`preserves U+2028/U+2029/CR inside JSON lines and discards oversized lines cleanly`, async () => {
    const stream = new PassThrough()
    const received: string[] = []
    const oversized: number[] = []
    let closed = false

    readNdjsonLines(stream, {
      maxLineChars: 64,
      onLine: l => received.push(l),
      onOversizedLine: limit => oversized.push(limit),
      onClose: () => {
        closed = true
      },
    })

    const msgWithSeparators = JSON.stringify({ text: `a\u2028b\u2029c` })
    stream.write(`${msgWithSeparators}\r\n`)
    // Multi-chunk oversized line followed by a normal line.
    stream.write(`{"huge":"${`x`.repeat(40)}`)
    stream.write(`${`y`.repeat(40)}"}\n{"ok":1}\n`)
    await new Promise<void>((resolve) => {
      stream.end(`{"tail":true}`, () => resolve())
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(received).toEqual([
      msgWithSeparators,
      `{"ok":1}`,
      `{"tail":true}`,
    ])
    expect(oversized).toEqual([64])
    expect(closed).toBe(true)
  })

  it(`handles server-to-client requests with colliding IDs, ignores invalid IDs, dedupes tools/cursors, and fails fast with redacted stderr after exit`, async () => {
    const cwd = await makeTempDir(`md-mcp-proto-`)
    const secretToken = `tok-super-secret-mcp-999`

    const fixtureScript = [
      `const { readInterface } = require('node:readline');`,
      `let buf = '';`,
      `process.stdin.setEncoding('utf8');`,
      `const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');`,
      `const pingAcked = { value: false };`,
      `const rootsRejected = { value: false };`,
      `process.stdin.on('data', (chunk) => {`,
      `  buf += chunk;`,
      `  let idx;`,
      `  while ((idx = buf.indexOf('\\n')) !== -1) {`,
      `    const line = buf.slice(0, idx).trim();`,
      `    buf = buf.slice(idx + 1);`,
      `    if (!line) continue;`,
      `    const msg = JSON.parse(line);`,
      `    if (!('method' in msg)) {`,
      `      if (msg.id === 1 && msg.result) pingAcked.value = true;`,
      `      if (msg.id === 2 && msg.error && msg.error.code === -32601) rootsRejected.value = true;`,
      `      continue;`,
      `    }`,
      `    if (msg.method === 'initialize') {`,
      // Emit server->client requests with id=1 and id=2 plus bogus responses BEFORE replying to client's id=1!
      `      send({ jsonrpc: '2.0', id: 1, method: 'ping' });`,
      `      send({ jsonrpc: '2.0', id: 2, method: 'roots/list' });`,
      `      send({ jsonrpc: '2.0', id: true, result: { hijacked: true } });`,
      `      send({ jsonrpc: '2.0', id: '', result: { hijacked: true } });`,
      `      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'proto-mcp', version: '1.0.0' } } });`,
      `      continue;`,
      `    }`,
      `    if (msg.method === 'tools/list') {`,
      `      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'sep_echo' }, { name: 'sep_echo' }], nextCursor: 'same-cursor' } });`,
      `      continue;`,
      `    }`,
      `    if (msg.method === 'tools/call') {`,
      `      if (msg.params?.arguments?.crash) {`,
      `        process.stderr.write('Crash with token=' + process.env.MD_SECRET_TOKEN + '\\n');`,
      `        process.exit(2);`,
      `      }`,
      `      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'A\\u2028B:' + pingAcked.value + ':' + rootsRejected.value }] } });`,
      `    }`,
      `  }`,
      `});`,
    ].join(`\n`)

    const client = await McpStdioClient.connect({
      name: `proto-mcp`,
      command: process.execPath,
      args: [`-e`, fixtureScript],
      env: [{ name: `MD_SECRET_TOKEN`, value: secretToken }],
    }, cwd)
    openMcpClients.push(client)

    // Duplicate tool names and repeating nextCursor are deduped cleanly.
    expect(client.tools.map(t => t.name)).toEqual([`sep_echo`])

    const okOut = await client.callTool(`sep_echo`, {})
    expect(okOut.isError).toBe(false)
    expect(okOut.text).toBe(`A\u2028B:true:true`)

    // Crashing server redacts secret from stderr and fails subsequent calls immediately.
    await expect(client.callTool(`sep_echo`, { crash: true })).rejects.toThrow(/exited/)
    try {
      await client.callTool(`sep_echo`, {})
      expect.unreachable(`Expected dead MCP client to reject immediately`)
    }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      expect(msg).toMatch(/exited/)
      expect(msg).not.toContain(secretToken)
    }
  })

  it(`accepts U+2028/U+2029 in image-mcp prompts without framing split`, async () => {
    const workspaceDir = await makeTempDir(`md-img-mcp-sep-`)
    let receivedPrompt = ``

    const bridge = new ImageGenBridge({
      getConfig: async () => ({
        providerPreset: `custom`,
        baseUrl: `http://127.0.0.1:1/v1`,
        hasApiKey: true,
        apiKey: `sk-img`,
        model: `mock-img`,
        size: `1024x1024`,
        quality: `auto`,
        isConfigured: true,
      }),
      generate: async ({ prompt }) => {
        receivedPrompt = prompt
        return { bytes: TINY_PNG_BYTES, base64: TINY_PNG_BASE64, mimeType: `image/png` }
      },
    })
    openBridges.push(bridge)
    const conn = await bridge.ensureStarted()

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [IMAGE_MCP_SCRIPT],
      env: {
        ...process.env,
        MD_IMAGE_BRIDGE_URL: conn.url,
        MD_IMAGE_BRIDGE_TOKEN: conn.token,
        MD_WORKSPACE_DIR: workspaceDir,
      } as Record<string, string>,
    })
    const client = new McpClient({ name: `test-sep`, version: `1.0.0` })
    try {
      await client.connect(transport)
      const res = await client.callTool({
        name: `generate_image`,
        arguments: {
          prompt: `Line one\u2028Line two\u2029Line three`,
          filename: `sep-test`,
        },
      })
      expect(res.isError).toBeFalsy()
      expect(receivedPrompt).toBe(`Line one\u2028Line two\u2029Line three`)
    }
    finally {
      await client.close()
    }
  })
})

describe(`skills confinement, history bounding, and sanitize/bridge/remote-models hardening`, () => {
  it(`rejects symlinked skill dirs and symlinked SKILL.md escaping the workspace root`, async () => {
    const workspaceDir = await makeTempDir(`md-skill-confine-ws-`)
    const outsideDir = await makeTempDir(`md-skill-confine-out-`)

    await fs.mkdir(path.join(outsideDir, `outside-skill`), { recursive: true })
    await fs.writeFile(
      path.join(outsideDir, `outside-skill`, `SKILL.md`),
      `---\nname: escaped-skill\ndescription: outside\n---\nOUTSIDE_SECRET`,
    )
    await fs.writeFile(path.join(outsideDir, `outside-skill`, `leak.txt`), `secret`)

    const skillsRoot = path.join(workspaceDir, `.agents`, `skills`)
    await fs.mkdir(path.join(skillsRoot, `valid-skill`), { recursive: true })
    await fs.writeFile(
      path.join(skillsRoot, `valid-skill`, `SKILL.md`),
      `---\nname: valid-skill\ndescription: inside\n---\nVALID_BODY`,
    )
    await fs.symlink(path.join(outsideDir, `outside-skill`), path.join(skillsRoot, `escaped-dir`))

    await fs.mkdir(path.join(skillsRoot, `escaped-file`), { recursive: true })
    await fs.symlink(
      path.join(outsideDir, `outside-skill`, `SKILL.md`),
      path.join(skillsRoot, `escaped-file`, `SKILL.md`),
    )

    const discovered = await readSkills([skillsRoot], { rootDir: workspaceDir })
    expect(discovered.map(s => s.name)).toEqual([`valid-skill`])

    // listSkillSupportFiles refuses to walk an outside-pointing skill directory when rootDir is set.
    const leakedFiles = await listSkillSupportFiles(path.join(skillsRoot, `escaped-dir`), {
      rootDir: workspaceDir,
    })
    expect(leakedFiles).toEqual([])
  })

  it(`bounds message history at user-turn boundaries while keeping Turn 1 writing rules and tool pairs intact`, () => {
    const turn1: ModelMessage[] = [
      { role: `user`, content: `[Context]\n[Writing rules] Keep headings clean.\n\nDraft intro` },
      { role: `assistant`, content: `Intro drafted.` },
    ]
    const makeToolTurn = (idx: number): ModelMessage[] => [
      { role: `user`, content: `Turn ${idx} request ${`x`.repeat(200)}` },
      {
        role: `assistant`,
        content: [
          {
            type: `tool-call`,
            toolCallId: `call_${idx}`,
            toolName: `read_article`,
            input: {},
          },
        ],
      },
      {
        role: `tool`,
        content: [
          {
            type: `tool-result`,
            toolCallId: `call_${idx}`,
            toolName: `read_article`,
            output: { type: `text`, value: `Article snapshot ${idx} ${`y`.repeat(300)}` },
          },
        ],
      },
      { role: `assistant`, content: `Completed turn ${idx}.` },
    ]

    const all: ModelMessage[] = [...turn1]
    for (let i = 2; i <= 10; i++)
      all.push(...makeToolTurn(i))

    const trimmed = trimMessageHistory(all, { maxMessages: 14, maxChars: 10_000 })
    expect(trimmed.length).toBeLessThanOrEqual(14)
    expect(trimmed[0].role).toBe(`user`)
    expect(String(trimmed[0].content)).toContain(`[Writing rules]`)

    // Every `tool` message must be immediately preceded by an `assistant` message (never orphaned).
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].role === `tool`)
        expect(trimmed[i - 1]?.role).toBe(`assistant`)
    }
    // Latest turn is preserved intact.
    expect(trimmed[trimmed.length - 1]).toEqual({ role: `assistant`, content: `Completed turn 10.` })
  })

  it(`tightens reasoning error detection, baseUrl validation, secret redaction, and asar path resolution`, () => {
    expect(isUnsupportedReasoningError(new Error(`Unknown field: reasoning_effort`))).toBe(true)
    expect(isUnsupportedReasoningError(new Error(`thinking is not supported for this model`))).toBe(true)
    expect(isUnsupportedReasoningError(new Error(`Image size 999x999 is not supported`))).toBe(false)
    expect(isUnsupportedReasoningError(new Error(`Tool choice is not supported`))).toBe(false)

    expect(() => validateHttpBaseUrl(`https://api.example.com/v1?api_key=leak`)).toThrow(/query|fragment/i)
    expect(() => validateHttpBaseUrl(`https://api.example.com/v1#frag`)).toThrow(/query|fragment/i)
    try {
      validateHttpBaseUrl(`https://admin:supersecret@[invalid`)
      expect.unreachable()
    }
    catch (error) {
      expect((error as Error).message).not.toContain(`supersecret`)
    }

    const redacted = redactSecret(
      `Failed GET "https://example.com/models?key=AIzaSecret99" with x-api-key: sk-ant-secret-11 and custom=my-tok-77`,
      `my-tok-77`,
    )
    expect(redacted).not.toContain(`AIzaSecret99`)
    expect(redacted).not.toContain(`sk-ant-secret-11`)
    expect(redacted).not.toContain(`my-tok-77`)
    expect(redacted).toContain(`"https://example.com/models?key=***"`)

    const nestedAsar = path.join(`/Users/dev/app.asar/md.app/Contents/Resources/app.asar`, `dist`, `main`)
    const unpacked = resolveUnpackedAgentScript(nestedAsar, `api-agent.js`)
    expect(unpacked).toBe(
      path.join(`/Users/dev/app.asar/md.app/Contents/Resources/app.asar.unpacked`, `dist`, `agents`, `api-agent.js`),
    )
  })

  it(`stops on repeated pagination cursors, caps oversized model responses, and reports clear timeout errors`, async () => {
    let antCalls = 0
    const loopingFetch: typeof fetch = async () => {
      antCalls += 1
      return new Response(JSON.stringify({
        data: [{ id: `claude-${antCalls}` }],
        has_more: true,
        last_id: `stuck-cursor`,
      }), { status: 200 })
    }
    const loopRes = await fetchRemoteModels({
      protocol: `anthropic`,
      baseUrl: `https://example.test/v1`,
      apiKey: `sk-ant-loop`,
      fetchImpl: loopingFetch,
    })
    expect(loopRes.ok).toBe(true)
    expect(antCalls).toBe(2)

    const hugeFetch: typeof fetch = async () => new Response(`x`, {
      status: 200,
      headers: { 'content-length': String(20 * 1024 * 1024) },
    })
    const hugeRes = await fetchRemoteModels({
      protocol: `openai-compatible`,
      baseUrl: `https://example.test/v1`,
      apiKey: `sk-oai`,
      fetchImpl: hugeFetch,
    })
    expect(hugeRes.ok).toBe(false)
    expect(hugeRes.error).toMatch(/10 MB/i)

    const slowFetch: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(`abort`, () => reject(new DOMException(`Aborted`, `AbortError`)))
    })
    const timeoutRes = await fetchRemoteModels({
      protocol: `openai-compatible`,
      baseUrl: `https://example.test/v1`,
      apiKey: `sk-oai`,
      fetchImpl: slowFetch,
      timeoutMs: 40,
    })
    expect(timeoutRes.ok).toBe(false)
    expect(timeoutRes.error).toMatch(/timed out/i)
  })

  it(`returns HTTP 400 JSON on oversized bridge bodies without ECONNRESET and preserves AbortError in image-service`, async () => {
    const bridge = new ImageGenBridge({
      getConfig: async () => ({
        providerPreset: `custom`,
        baseUrl: `https://api.example.com/v1`,
        hasApiKey: true,
        apiKey: `sk-img`,
        model: `mock-img`,
        size: `1024x1024`,
        quality: `auto`,
        isConfigured: true,
      }),
      generate: async () => ({ bytes: TINY_PNG_BYTES, base64: TINY_PNG_BASE64, mimeType: `image/png` }),
    })
    openBridges.push(bridge)
    const conn = await bridge.ensureStarted()

    // Exceeds MAX_BODY_BYTES (~43 MB): must still receive a clean HTTP 400 JSON response.
    const hugeBody = `{"prompt":"${`a`.repeat(44 * 1024 * 1024)}"}`
    const res = await fetch(conn.url, {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
        'Authorization': `Bearer ${conn.token}`,
      },
      body: hugeBody,
    })
    expect(res.status).toBe(400)
    const json = await res.json() as { error?: string }
    expect(json.error).toMatch(/too large/i)

    // Invalid size `0x0` is omitted, and AbortError name is preserved while redacting apiKey.
    const abortErr = new Error(`Aborted for Bearer sk-secret-999`)
    abortErr.name = `AbortError`
    generateImageMock.mockRejectedValueOnce(abortErr)

    await expect(generateDesktopImage({
      baseUrl: `https://api.example.com/v1`,
      apiKey: `sk-secret-999`,
      model: `gpt-image-1`,
      prompt: `test`,
      size: `0x0`,
    })).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error
        && err.name === `AbortError`
        && !err.message.includes(`sk-secret-999`)
    })
    expect(generateImageMock.mock.calls[0][0].size).toBeUndefined()
  })
})

describe(`api-agent security and turn lifecycle regressions`, () => {
  it(`blocks symlinked article.md, prevents mid-permission Plan-mode bypass & cancel leaks, avoids duplicate tool retries, and expands wrapped /skill`, async () => {
    let step2NonReasoningFailCount = 0
    let step1ToolCalls = 0
    const chatBodies: Array<Record<string, unknown>> = []

    const server = http.createServer(async (req, res) => {
      if (req.method !== `POST` || req.url !== `/v1/chat/completions`) {
        res.writeHead(404).end()
        return
      }
      const body = JSON.parse(await readBody(req)) as {
        model?: string
        messages?: Array<{ role?: string, content?: unknown }>
      }
      chatBodies.push(body)
      const msgs = body.messages ?? []
      const lastRole = String(msgs[msgs.length - 1]?.role ?? ``)
      const userMsgs = msgs.filter(m => m.role === `user`)
      const latestUser = String(userMsgs[userMsgs.length - 1]?.content ?? ``)
      const id = `cmpl-${chatBodies.length}`
      const created = Math.floor(Date.now() / 1000)
      const model = body.model ?? `mock-pro`

      if (latestUser.includes(`STEP2_NOT_SUPPORTED_AFTER_TOOL`)) {
        if (lastRole === `user`) {
          step1ToolCalls += 1
          res.writeHead(200, { 'Content-Type': `text/event-stream; charset=utf-8` })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model,
            choices: [{
              index: 0,
              delta: {
                role: `assistant`,
                tool_calls: [{
                  index: 0,
                  id: `call_step1_${step1ToolCalls}`,
                  type: `function`,
                  function: { name: `read_article`, arguments: `{}` },
                }],
              },
              finish_reason: null,
            }],
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
          })
          res.write(`data: [DONE]\n\n`)
          res.end()
          return
        }
        step2NonReasoningFailCount += 1
        res.writeHead(400, { 'Content-Type': `application/json` })
        res.end(JSON.stringify({ error: { message: `Vision input is not supported on this endpoint` } }))
        return
      }

      const dynMatch = /RUN_TOOL:(\{[^\n]+\})/.exec(latestUser)
      if (dynMatch && lastRole === `user`) {
        const spec = JSON.parse(dynMatch[1]) as { name: string, arguments?: Record<string, unknown> }
        res.writeHead(200, { 'Content-Type': `text/event-stream; charset=utf-8` })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              role: `assistant`,
              tool_calls: [{
                index: 0,
                id: `call_${chatBodies.length}`,
                type: `function`,
                function: { name: spec.name, arguments: JSON.stringify(spec.arguments ?? {}) },
              }],
            },
            finish_reason: null,
          }],
        })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
        })
        res.write(`data: [DONE]\n\n`)
        res.end()
        return
      }

      if (latestUser.includes(`PARALLEL_EDITS_CANCEL`) && lastRole === `user`) {
        res.writeHead(200, { 'Content-Type': `text/event-stream; charset=utf-8` })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              role: `assistant`,
              tool_calls: [
                {
                  index: 0,
                  id: `call_cancel_1`,
                  type: `function`,
                  function: { name: `edit_article`, arguments: JSON.stringify({ old_text: `Line A`, new_text: `Line A1` }) },
                },
                {
                  index: 1,
                  id: `call_cancel_2`,
                  type: `function`,
                  function: { name: `edit_article`, arguments: JSON.stringify({ old_text: `Line B`, new_text: `Line B1` }) },
                },
              ],
            },
            finish_reason: null,
          }],
        })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
        })
        res.write(`data: [DONE]\n\n`)
        res.end()
        return
      }

      const lastContent = String(msgs[msgs.length - 1]?.content ?? ``)
      res.writeHead(200, { 'Content-Type': `text/event-stream; charset=utf-8` })
      writeSseChunk(res, {
        id,
        object: `chat.completion.chunk`,
        created,
        model,
        choices: [{ index: 0, delta: { role: `assistant`, content: `OUT:${lastContent}` }, finish_reason: null }],
      })
      writeSseChunk(res, {
        id,
        object: `chat.completion.chunk`,
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: `stop` }],
      })
      res.write(`data: [DONE]\n\n`)
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, `127.0.0.1`, resolve))
    openServers.push(server)
    const port = (server.address() as { port: number }).port

    const dataDir = await makeTempDir(`md-reg-host-`)
    const skillsDir = await makeTempDir(`md-reg-skills-`)
    const outsideDir = await makeTempDir(`md-reg-outside-`)
    await fs.writeFile(path.join(outsideDir, `outside.md`), `SECRET_OUTSIDE_MD`, `utf8`)

    await fs.mkdir(path.join(skillsDir, `quick-lead`), { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, `quick-lead`, `SKILL.md`),
      `---\nname: quick-lead\ndescription: Quick lead\n---\nQUICK_LEAD_MARKER_77`,
    )

    const store = new AiConfigStore({ configPath: path.join(dataDir, `ai-config.json`) })
    await store.updateModelApiConfig({
      protocol: `openai-compatible`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: `sk-reg-secret`,
      enabledModels: [`mock-pro`],
      defaultModel: `mock-pro`,
    })

    const events: AcpHostEvent[] = []
    let onPermission: ((e: Extract<AcpHostEvent, { type: `permission_requested` }>) => void) | null = null

    const host = new AcpHost({
      dataDir,
      skillsDir,
      extraBuiltinAgents: [{
        id: API_MODEL_AGENT_ID,
        name: `API Model`,
        command: process.execPath,
        args: [API_AGENT_SCRIPT],
        env: {},
        detectBinaries: [process.execPath],
        builtin: true,
        avatar: { letter: `M`, color: `#0284C7` },
      }],
      resolveAgentAvailability: async id => (id === API_MODEL_AGENT_ID ? true : null),
      resolveAgentRuntimeEnv: async (id) => {
        if (id !== API_MODEL_AGENT_ID)
          return undefined
        const cfg = await store.getResolvedModelApiConfig()
        return {
          MD_API_AGENT_CONFIG: JSON.stringify({
            protocol: cfg.protocol,
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            enabledModels: cfg.enabledModels,
            defaultModel: cfg.defaultModel,
          }),
        }
      },
      onEvent: (event) => {
        events.push(event)
        if (event.type === `permission_requested` && onPermission)
          onPermission(event)
      },
    })
    openHosts.push(host)

    const started = await host.startSession({
      agentId: API_MODEL_AGENT_ID,
      permissionLevel: `ask`,
      postId: `post-reg`,
      postTitle: `Reg`,
      content: `# Reg\n\nLine A\n\nLine B\n`,
    })

    // 1. Immediate `/quick-lead` with leading spaces (wrapped inside `[Context]...`) still expands SKILL.md!
    await host.prompt({
      sessionId: started.sessionId,
      text: `   /quick-lead Opening hook`,
      content: `# Reg\n\nLine A\n\nLine B\n`,
      postTitle: `Reg`,
    })
    const firstSentUser = String((chatBodies[0].messages as Array<{ role: string, content: string }>).find(m => m.role === `user`)?.content ?? ``)
    expect(firstSentUser).toContain(`QUICK_LEAD_MARKER_77`)
    expect(firstSentUser).toContain(`Opening hook`)

    // 2. Plan-mode TOCTOU: switching to `plan` while a permission card is pending blocks the write even if approved.
    const wsNames = await fs.readdir(path.join(dataDir, `acp-workspaces`))
    const workspaceDir = path.join(dataDir, `acp-workspaces`, wsNames[0])

    onPermission = (permEvent) => {
      void (async () => {
        await host.setPermissionMode({ sessionId: started.sessionId, permissionLevel: `plan` })
        host.respondPermission({
          sessionId: started.sessionId,
          requestId: permEvent.request.requestId,
          decision: `allow_once`,
        })
      })()
    }
    events.length = 0
    await host.prompt({
      sessionId: started.sessionId,
      text: `RUN_TOOL:${JSON.stringify({ name: `write_file`, arguments: { path: `notes/race.txt`, content: `blocked` } })}`,
      content: `# Reg\n\nLine A\n\nLine B\n`,
      postTitle: `Reg`,
    })
    await expect(fs.access(path.join(workspaceDir, `notes`, `race.txt`))).rejects.toThrow()

    // 3. Cancelling during permission prompt of parallel edits never emits a second permission_requested.
    await host.setPermissionMode({ sessionId: started.sessionId, permissionLevel: `ask` })
    events.length = 0
    onPermission = () => {
      void host.cancelTurn(started.sessionId)
    }
    const cancelRes = await host.prompt({
      sessionId: started.sessionId,
      text: `PARALLEL_EDITS_CANCEL`,
      content: `# Reg\n\nLine A\n\nLine B\n`,
      postTitle: `Reg`,
    })
    expect(cancelRes.stopReason).toBe(`cancelled`)
    expect(events.filter(e => e.type === `permission_requested`)).toHaveLength(1)

    // 4. `write_file` TOCTOU symlink swap while waiting for user approval cannot overwrite outside files.
    onPermission = (permEvent) => {
      void (async () => {
        await fs.mkdir(path.join(workspaceDir, `notes`), { recursive: true })
        await fs.symlink(path.join(outsideDir, `outside.md`), path.join(workspaceDir, `notes`, `swap.txt`))
        host.respondPermission({
          sessionId: started.sessionId,
          requestId: permEvent.request.requestId,
          decision: `allow_once`,
        })
      })()
    }
    events.length = 0
    await host.prompt({
      sessionId: started.sessionId,
      text: `RUN_TOOL:${JSON.stringify({ name: `write_file`, arguments: { path: `notes/swap.txt`, content: `PWNED` } })}`,
      content: `# Reg\n\nLine A\n\nLine B\n`,
      postTitle: `Reg`,
    })
    expect(await fs.readFile(path.join(outsideDir, `outside.md`), `utf8`)).toBe(`SECRET_OUTSIDE_MD`)

    // 5. `read_article` refuses a symlinked `article.md` pointing outside the workspace.
    onPermission = null
    await host.setPermissionMode({ sessionId: started.sessionId, permissionLevel: `bypass` })
    onPermission = null
    // Swap article.md with an outside symlink right when read_article runs? Host writes article.md at prompt start,
    // so swap article.md via symlink inside a dedicated check right after prompt starts:
    // Instead, make article.md a symlink to outsideDir/outside.md after fs.writeFile by making article.md a symlink BEFORE read_article executes:
    // Actually AcpHost.prompt writes params.content to managed.articlePath (which follows a symlink if article.md were a symlink — cross-area!),
    // so test api-agent's own read_article confinement by creating the symlink during step 1 before read_article? Wait: we can swap article.md inside the HTTP handler right before returning the `read_article` tool_call!
    const origListener = server.listeners(`request`)[0] as (req: IncomingMessage, res: ServerResponse) => void
    server.removeAllListeners(`request`)
    server.on(`request`, async (req: IncomingMessage, res: ServerResponse) => {
      const raw = await readBody(req)
      if (raw.includes(`SYMLINK_ARTICLE_TEST`) && !raw.includes(`"role":"tool"`)) {
        await fs.rm(path.join(workspaceDir, `article.md`), { force: true })
        await fs.symlink(path.join(outsideDir, `outside.md`), path.join(workspaceDir, `article.md`))
      }
      // Replay buffered body into a synthetic readable stream or handle directly:
      const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string, content?: unknown }> }
      const msgs = parsed.messages ?? []
      const lastRole = String(msgs[msgs.length - 1]?.role ?? ``)
      res.writeHead(200, { 'Content-Type': `text/event-stream; charset=utf-8` })
      if (lastRole === `user` && raw.includes(`SYMLINK_ARTICLE_TEST`)) {
        writeSseChunk(res, {
          id: `sym-1`,
          object: `chat.completion.chunk`,
          created: 1,
          model: `mock-pro`,
          choices: [{
            index: 0,
            delta: {
              role: `assistant`,
              tool_calls: [{ index: 0, id: `c_sym`, type: `function`, function: { name: `read_article`, arguments: `{}` } }],
            },
            finish_reason: null,
          }],
        })
        writeSseChunk(res, {
          id: `sym-1`,
          object: `chat.completion.chunk`,
          created: 1,
          model: `mock-pro`,
          choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
        })
        res.write(`data: [DONE]\n\n`)
        res.end()
        return
      }
      const toolOut = String(msgs[msgs.length - 1]?.content ?? ``)
      writeSseChunk(res, {
        id: `sym-2`,
        object: `chat.completion.chunk`,
        created: 1,
        model: `mock-pro`,
        choices: [{ index: 0, delta: { role: `assistant`, content: `SYM_OUT:${toolOut}` }, finish_reason: null }],
      })
      writeSseChunk(res, {
        id: `sym-2`,
        object: `chat.completion.chunk`,
        created: 1,
        model: `mock-pro`,
        choices: [{ index: 0, delta: {}, finish_reason: `stop` }],
      })
      res.write(`data: [DONE]\n\n`)
      res.end()
    })

    events.length = 0
    await host.prompt({
      sessionId: started.sessionId,
      text: `SYMLINK_ARTICLE_TEST`,
      content: `# Safe\n`,
      postTitle: `Reg`,
    })
    const symReply = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(symReply).toMatch(/outside the session workspace/i)
    expect(symReply).not.toContain(`SECRET_OUTSIDE_MD`)
    await fs.rm(path.join(workspaceDir, `article.md`), { force: true })
    await fs.writeFile(path.join(workspaceDir, `article.md`), `# Safe\n`, `utf8`)

    // Restore main mock handler and verify step-2 "not supported" after step-1 tool call does NOT retry step 1!
    server.removeAllListeners(`request`)
    server.on(`request`, origListener)
    await host.setThinkingLevel({ sessionId: started.sessionId, thinkingLevel: `high` })
    await expect(host.prompt({
      sessionId: started.sessionId,
      text: `STEP2_NOT_SUPPORTED_AFTER_TOOL`,
      content: `# Safe\n`,
      postTitle: `Reg`,
    })).rejects.toThrow(/Vision input is not supported/i)
    expect(step1ToolCalls).toBe(1)
    expect(step2NonReasoningFailCount).toBe(1)
  }, 25_000)
})
