import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { AcpHostEvent } from '@md/shared/types'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { SecretCipher } from './config-store'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildDesktopBundles } from '../../../scripts/build'
import { generateAndSaveWorkspaceImage } from '../../agents/shared/image-client'
import { AcpHost, buildPromptText } from '../acp/host'
import { AcpRegistry } from '../acp/registry'
import { ARTICLE_WRITING_RULES, buildArticleWritingRules } from '../acp/writing-rules'
import { AiConfigStore } from './config-store'
import { ImageGenBridge } from './image-bridge'
import { generateDesktopImage } from './image-service'
import { resolveUnpackedAgentScript } from './paths'
import {
  fetchRemoteModels,
  parseAnthropicModelsResponse,
  parseGoogleModelsResponse,
  parseOpenAiModelsResponse,
} from './remote-models'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(__dirname, `../../..`)
const API_AGENT_SCRIPT = path.join(DESKTOP_ROOT, `dist/agents/api-agent.js`)
const IMAGE_MCP_SCRIPT = path.join(DESKTOP_ROOT, `dist/agents/image-mcp.js`)
const FAKE_AGENT_SCRIPT = path.join(DESKTOP_ROOT, `scripts/fake-acp-agent.mjs`)

// Valid 1x1 red PNG (68 bytes).
const TINY_PNG_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, `base64`)

const tempDirs: string[] = []
const openHosts: AcpHost[] = []
const openBridges: ImageGenBridge[] = []
const openServers: Server[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createMockSafeStorage(available = true): SecretCipher {
  const prefix = `ENC_V1:`
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`${prefix}${plainText.split(``).reverse().join(``)}`, `utf8`),
    decryptString: (encrypted: Buffer) => {
      const decoded = encrypted.toString(`utf8`)
      if (!decoded.startsWith(prefix))
        throw new Error(`Invalid ciphertext`)
      return decoded.slice(prefix.length).split(``).reverse().join(``)
    },
  }
}

interface RecordedChatRequest {
  model?: string
  reasoning_effort?: string
  messages?: Array<Record<string, unknown>>
  tools?: Array<{ function?: { name?: string } }>
}

interface FakeOpenAiServer {
  baseUrl: string
  apiKey: string
  chatRequests: RecordedChatRequest[]
  imageRequests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

function writeSseChunk(res: ServerResponse, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on(`data`, (c: Buffer) => chunks.push(c))
    req.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)))
    req.on(`error`, reject)
  })
}

async function startFakeOpenAiServer(apiKey = `sk-test-openai-secret`): Promise<FakeOpenAiServer> {
  const chatRequests: RecordedChatRequest[] = []
  const imageRequests: Array<Record<string, unknown>> = []

  const server = http.createServer(async (req, res) => {
    const url = req.url || `/`
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'Content-Type': `application/json` })
      res.end(JSON.stringify({ error: { message: `Invalid API key` } }))
      return
    }

    if (req.method === `GET` && url === `/v1/models`) {
      res.writeHead(200, { 'Content-Type': `application/json` })
      res.end(JSON.stringify({
        object: `list`,
        data: [
          { id: `mock-gpt-pro`, object: `model` },
          { id: `mock-gpt-mini`, object: `model` },
        ],
      }))
      return
    }

    if (req.method === `POST` && url === `/v1/images/generations`) {
      const raw = await readBody(req)
      const parsed = JSON.parse(raw) as Record<string, unknown>
      imageRequests.push(parsed)
      res.writeHead(200, { 'Content-Type': `application/json` })
      res.end(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: TINY_PNG_BASE64 }],
      }))
      return
    }

    if (req.method === `POST` && url === `/v1/chat/completions`) {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as RecordedChatRequest
      chatRequests.push(body)

      const messages = body.messages ?? []
      const lastMsg = messages[messages.length - 1]
      const lastRole = String(lastMsg?.role ?? ``)
      const userMessages = messages.filter(m => m.role === `user`)
      const latestUserText = String(userMessages[userMessages.length - 1]?.content ?? ``)
      const modelId = body.model ?? `mock-gpt-pro`

      res.writeHead(200, {
        'Content-Type': `text/event-stream; charset=utf-8`,
        'Cache-Control': `no-cache`,
        'Connection': `keep-alive`,
      })

      const id = `chatcmpl-${chatRequests.length}`
      const created = Math.floor(Date.now() / 1000)

      // Slow streaming scenario for cancel tests.
      if (latestUserText.includes(`TRIGGER_SLOW_STREAM`)) {
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{ index: 0, delta: { role: `assistant`, content: `Starting slow stream...` }, finish_reason: null }],
        })
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer)
            return
          }
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{ index: 0, delta: { content: ` tick` }, finish_reason: null }],
          })
        }, 120)
        req.once(`close`, () => clearInterval(timer))
        res.once(`close`, () => clearInterval(timer))
        return
      }

      // Edit article scenario: step 1 calls edit_article, step 2 summarizes.
      if (latestUserText.includes(`TRIGGER_EDIT`)) {
        if (lastRole === `user`) {
          const args = JSON.stringify({
            old_text: `Old intro paragraph.`,
            new_text: `Updated intro paragraph by ${modelId}.`,
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                role: `assistant`,
                tool_calls: [{
                  index: 0,
                  id: `call_edit_1`,
                  type: `function`,
                  function: { name: `edit_article`, arguments: args },
                }],
              },
              finish_reason: null,
            }],
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
          })
          res.write(`data: [DONE]\n\n`)
          res.end()
          return
        }

        const toolResultText = String(lastMsg?.content ?? ``)
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: { role: `assistant`, content: `Edit result: ${toolResultText}` },
            finish_reason: null,
          }],
        })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: `stop` }],
        })
        res.write(`data: [DONE]\n\n`)
        res.end()
        return
      }

      // Parallel edit_article scenario: two edits in a single assistant step.
      if (latestUserText.includes(`TRIGGER_PARALLEL_EDIT`)) {
        if (lastRole === `user`) {
          const args1 = JSON.stringify({
            old_text: `Alpha paragraph.`,
            new_text: `Alpha updated.`,
          })
          const args2 = JSON.stringify({
            old_text: `Beta paragraph.`,
            new_text: `Beta updated.`,
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                role: `assistant`,
                tool_calls: [
                  {
                    index: 0,
                    id: `call_par_1`,
                    type: `function`,
                    function: { name: `edit_article`, arguments: args1 },
                  },
                  {
                    index: 1,
                    id: `call_par_2`,
                    type: `function`,
                    function: { name: `edit_article`, arguments: args2 },
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
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
          })
          res.write(`data: [DONE]\n\n`)
          res.end()
          return
        }

        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: { role: `assistant`, content: `Applied both parallel edits.` },
            finish_reason: null,
          }],
        })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: `stop` }],
        })
        res.write(`data: [DONE]\n\n`)
        res.end()
        return
      }

      // Generate image + embed into article scenario.
      if (latestUserText.includes(`TRIGGER_IMAGE`)) {
        if (lastRole === `user`) {
          const args = JSON.stringify({
            prompt: `A clean geometric cover illustration`,
            filename: `hero-cover`,
            size: `1024x1024`,
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                role: `assistant`,
                tool_calls: [{
                  index: 0,
                  id: `call_img_1`,
                  type: `function`,
                  function: { name: `generate_image`, arguments: args },
                }],
              },
              finish_reason: null,
            }],
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
          })
          res.write(`data: [DONE]\n\n`)
          res.end()
          return
        }

        const toolMsgs = messages.filter(m => m.role === `tool`)
        if (toolMsgs.length === 1) {
          const parsedTool = JSON.parse(String(toolMsgs[0].content ?? `{}`)) as { path?: string }
          const relPath = parsedTool.path || `images/hero-cover.png`
          const args = JSON.stringify({
            old_text: `Old intro paragraph.`,
            new_text: `Old intro paragraph.\n\n![Hero Cover](${relPath})`,
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                role: `assistant`,
                tool_calls: [{
                  index: 0,
                  id: `call_edit_img`,
                  type: `function`,
                  function: { name: `edit_article`, arguments: args },
                }],
              },
              finish_reason: null,
            }],
          })
          writeSseChunk(res, {
            id,
            object: `chat.completion.chunk`,
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: `tool_calls` }],
          })
          res.write(`data: [DONE]\n\n`)
          res.end()
          return
        }

        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: { role: `assistant`, content: `Generated image and embedded it into article.md.` },
            finish_reason: null,
          }],
        })
        writeSseChunk(res, {
          id,
          object: `chat.completion.chunk`,
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: `stop` }],
        })
        res.write(`data: [DONE]\n\n`)
        res.end()
        return
      }

      // Default plain reply (streams reasoning + text + turn count + model + effort).
      const effort = body.reasoning_effort ?? `none`
      writeSseChunk(res, {
        id,
        object: `chat.completion.chunk`,
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: { role: `assistant`, reasoning_content: `Thinking step for ${modelId}.` },
          finish_reason: null,
        }],
      })
      writeSseChunk(res, {
        id,
        object: `chat.completion.chunk`,
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: { content: `Hello from ${modelId} (turns=${userMessages.length}, effort=${effort})` },
          finish_reason: null,
        }],
      })
      writeSseChunk(res, {
        id,
        object: `chat.completion.chunk`,
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: `stop` }],
      })
      res.write(`data: [DONE]\n\n`)
      res.end()
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>(resolve => server.listen(0, `127.0.0.1`, resolve))
  openServers.push(server)
  const addr = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    apiKey,
    chatRequests,
    imageRequests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      if (typeof server.closeAllConnections === `function`)
        server.closeAllConnections()
    }),
  }
}

beforeAll(async () => {
  await buildDesktopBundles()
}, 30_000)

afterEach(async () => {
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

afterAll(() => {
  // All per-test resources are cleaned up in afterEach.
})

describe(`aiConfigStore`, () => {
  it(`encrypts API keys via safeStorage, never returns raw keys to renderer, and round-trips cleanly`, async () => {
    const dir = await makeTempDir(`md-ai-cfg-`)
    const configPath = path.join(dir, `ai-config.json`)
    const cipher = createMockSafeStorage(true)

    const store = new AiConfigStore({ configPath, cipher })
    const initial = await store.getPublicConfigs()
    expect(initial.modelApi.hasApiKey).toBe(false)
    expect(initial.imageGen.hasApiKey).toBe(false)
    expect(`apiKey` in initial.modelApi).toBe(false)
    expect(`apiKey` in initial.imageGen).toBe(false)

    const updatedModel = await store.updateModelApiConfig({
      protocol: `anthropic`,
      baseUrl: `https://api.anthropic.com/v1/`,
      apiKey: `sk-ant-top-secret-123`,
      enabledModels: [`claude-sonnet-4-6`, `claude-opus-4-8`],
      defaultModel: `claude-opus-4-8`,
    })
    expect(updatedModel.hasApiKey).toBe(true)
    expect(`apiKey` in updatedModel).toBe(false)
    expect(updatedModel.baseUrl).toBe(`https://api.anthropic.com/v1`)
    expect(updatedModel.defaultModel).toBe(`claude-opus-4-8`)

    const updatedImage = await store.updateImageGenConfig({
      providerPreset: `openai`,
      baseUrl: `https://api.openai.com/v1`,
      apiKey: `sk-img-secret-456`,
      model: `gpt-image-1`,
      size: `1536x1024`,
      quality: `high`,
    })
    expect(updatedImage.hasApiKey).toBe(true)
    expect(`apiKey` in updatedImage).toBe(false)

    // Verify raw keys are NOT stored in plaintext on disk.
    const rawOnDisk = await fs.readFile(configPath, `utf8`)
    expect(rawOnDisk).not.toContain(`sk-ant-top-secret-123`)
    expect(rawOnDisk).not.toContain(`sk-img-secret-456`)
    expect(rawOnDisk).toContain(`"encoding": "safeStorage"`)

    // Reload with a fresh store instance and verify decryption round trip.
    const reloaded = new AiConfigStore({ configPath, cipher })
    const resolvedModel = await reloaded.getResolvedModelApiConfig()
    const resolvedImage = await reloaded.getResolvedImageGenConfig()
    expect(resolvedModel.apiKey).toBe(`sk-ant-top-secret-123`)
    expect(resolvedModel.isConfigured).toBe(true)
    expect(resolvedImage.apiKey).toBe(`sk-img-secret-456`)
    expect(resolvedImage.isConfigured).toBe(true)

    // Updating non-key fields preserves the saved key; passing empty string clears it.
    await reloaded.updateModelApiConfig({ defaultModel: `claude-sonnet-4-6` })
    expect((await reloaded.getResolvedModelApiConfig()).apiKey).toBe(`sk-ant-top-secret-123`)

    const cleared = await reloaded.updateModelApiConfig({ apiKey: `` })
    expect(cleared.hasApiKey).toBe(false)
    expect((await reloaded.getResolvedModelApiConfig()).isConfigured).toBe(false)
  })

  it(`falls back to plain storage only when safeStorage encryption is unavailable`, async () => {
    const dir = await makeTempDir(`md-ai-cfg-plain-`)
    const configPath = path.join(dir, `ai-config.json`)
    const store = new AiConfigStore({ configPath, cipher: createMockSafeStorage(false) })

    await store.updateModelApiConfig({
      apiKey: `sk-plain-fallback`,
      enabledModels: [`gpt-5.4`],
    })
    const rawOnDisk = await fs.readFile(configPath, `utf8`)
    expect(rawOnDisk).toContain(`"encoding": "plain"`)

    const reloaded = new AiConfigStore({ configPath, cipher: createMockSafeStorage(false) })
    expect((await reloaded.getResolvedModelApiConfig()).apiKey).toBe(`sk-plain-fallback`)
  })
})

describe(`remote model parsing and fetching`, () => {
  it(`parses OpenAI-compatible, Anthropic, and Google Gemini model responses`, () => {
    expect(parseOpenAiModelsResponse({
      data: [{ id: `gpt-5.4` }, { id: `gpt-5.4` }, { id: `deepseek-chat`, name: `DeepSeek Chat` }],
    })).toEqual([
      { id: `gpt-5.4` },
      { id: `deepseek-chat`, name: `DeepSeek Chat` },
    ])

    expect(parseAnthropicModelsResponse({
      data: [
        { id: `claude-sonnet-4-6`, display_name: `Claude Sonnet 4.6` },
        { id: `claude-haiku-4-5` },
      ],
      has_more: true,
      last_id: `claude-haiku-4-5`,
    })).toEqual({
      models: [
        { id: `claude-sonnet-4-6`, name: `Claude Sonnet 4.6` },
        { id: `claude-haiku-4-5` },
      ],
      hasMore: true,
      lastId: `claude-haiku-4-5`,
    })

    expect(parseGoogleModelsResponse({
      models: [
        {
          name: `models/gemini-2.5-pro`,
          displayName: `Gemini 2.5 Pro`,
          supportedGenerationMethods: [`generateContent`, `countTokens`],
        },
        {
          name: `models/text-embedding-004`,
          displayName: `Text Embedding`,
          supportedGenerationMethods: [`embedContent`],
        },
      ],
      nextPageToken: `tok-2`,
    })).toEqual({
      models: [{ id: `gemini-2.5-pro`, name: `Gemini 2.5 Pro` }],
      nextPageToken: `tok-2`,
    })
  })

  it(`sends protocol-specific headers/query params and paginates Anthropic & Gemini`, async () => {
    const seen: Array<{ url: string, headers: HeadersInit | undefined }> = []
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      seen.push({ url, headers: init?.headers })
      if (url.includes(`/openai/models`)) {
        return new Response(JSON.stringify({ data: [{ id: `oai-1` }] }), { status: 200 })
      }
      if (url.includes(`/anthropic/models`)) {
        const isPage2 = url.includes(`after_id=ant-1`)
        return new Response(JSON.stringify({
          data: [isPage2 ? { id: `ant-2` } : { id: `ant-1`, display_name: `Ant 1` }],
          has_more: !isPage2,
          last_id: isPage2 ? `ant-2` : `ant-1`,
        }), { status: 200 })
      }
      if (url.includes(`/google/models`)) {
        return new Response(JSON.stringify({
          models: [
            { name: `models/gemini-2.5-flash`, supportedGenerationMethods: [`generateContent`] },
            { name: `models/embedding-001`, supportedGenerationMethods: [`embedContent`] },
          ],
        }), { status: 200 })
      }
      return new Response(`not found`, { status: 404 })
    }

    const oai = await fetchRemoteModels({
      protocol: `openai-compatible`,
      baseUrl: `https://example.test/openai`,
      apiKey: `sk-oai`,
      fetchImpl: mockFetch,
    })
    expect(oai).toEqual({ ok: true, models: [{ id: `oai-1` }] })

    const ant = await fetchRemoteModels({
      protocol: `anthropic`,
      baseUrl: `https://example.test/anthropic`,
      apiKey: `sk-ant`,
      fetchImpl: mockFetch,
    })
    expect(ant).toEqual({ ok: true, models: [{ id: `ant-1`, name: `Ant 1` }, { id: `ant-2` }] })

    const gem = await fetchRemoteModels({
      protocol: `google`,
      baseUrl: `https://example.test/google`,
      apiKey: `gem-key-secret`,
      fetchImpl: mockFetch,
    })
    expect(gem).toEqual({ ok: true, models: [{ id: `gemini-2.5-flash` }] })

    const oaiReq = seen.find(r => r.url.includes(`/openai/models`))
    expect((oaiReq?.headers as Record<string, string>).Authorization).toBe(`Bearer sk-oai`)
    const antReq = seen.find(r => r.url.includes(`/anthropic/models`))
    expect((antReq?.headers as Record<string, string>)[`x-api-key`]).toBe(`sk-ant`)
    expect((antReq?.headers as Record<string, string>)[`anthropic-version`]).toBe(`2023-06-01`)
    const gemReq = seen.find(r => r.url.includes(`/google/models`))
    expect(gemReq?.url).toContain(`key=gem-key-secret`)
  })
})

describe(`paths and writing rules`, () => {
  it(`resolves asar paths to app.asar.unpacked and leaves dev paths unchanged`, () => {
    const devPath = resolveUnpackedAgentScript(`/repo/apps/desktop/dist/main`, `image-mcp.js`)
    expect(devPath).toBe(path.resolve(`/repo/apps/desktop/dist/agents/image-mcp.js`))

    const packagedMain = path.join(`/Applications/md.app/Contents/Resources/app.asar`, `dist`, `main`)
    const unpacked = resolveUnpackedAgentScript(packagedMain, `image-mcp.js`)
    expect(unpacked).toContain(`app.asar.unpacked`)
    expect(unpacked).toMatch(/image-mcp\.js$/)
  })

  it(`includes generate_image rule only when image generation is configured`, () => {
    expect(buildArticleWritingRules({ imageGenEnabled: false })).toBe(ARTICLE_WRITING_RULES)
    const withImage = buildArticleWritingRules({ imageGenEnabled: true })
    expect(withImage).toContain(`generate_image`)
    expect(withImage).toContain(ARTICLE_WRITING_RULES.slice(0, 80))

    const promptWithImg = buildPromptText(
      { sessionId: `s1`, text: `Write`, content: ``, postTitle: `T` },
      `/tmp/article.md`,
      true,
      { imageGenEnabled: true },
    )
    expect(promptWithImg).toContain(`generate_image`)
  })
})

describe(`image MCP server & local bridge`, () => {
  it(`enforces bearer auth on bridge and generates workspace PNG via MCP client SDK`, async () => {
    const workspaceDir = await makeTempDir(`md-mcp-ws-`)
    const receivedPrompts: Array<{ prompt: string, size?: string }> = []

    const bridge = new ImageGenBridge({
      getConfig: async () => ({
        providerPreset: `custom`,
        baseUrl: `http://127.0.0.1:1/v1`,
        hasApiKey: true,
        apiKey: `sk-img`,
        model: `mock-img-1`,
        size: `1024x1024`,
        quality: `auto`,
        isConfigured: true,
      }),
      generate: async ({ prompt, size }) => {
        receivedPrompts.push({ prompt, size })
        return {
          bytes: TINY_PNG_BYTES,
          base64: TINY_PNG_BASE64,
          mimeType: `image/png`,
        }
      },
    })
    openBridges.push(bridge)
    const conn = await bridge.ensureStarted()

    // Reject unauthorized direct requests.
    const unauth = await fetch(conn.url, {
      method: `POST`,
      headers: { 'Content-Type': `application/json`, 'Authorization': `Bearer wrong-token` },
      body: JSON.stringify({ prompt: `test` }),
    })
    expect(unauth.status).toBe(401)

    // Drive bundled image-mcp.js with the real MCP Client SDK over stdio.
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
    const client = new McpClient({ name: `test-client`, version: `1.0.0` })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map(t => t.name)).toEqual([`generate_image`])

      const callRes = await client.callTool({
        name: `generate_image`,
        arguments: {
          prompt: `A clean geometric sunset`,
          filename: `My Cover!`,
          size: `1536x1024`,
        },
      })
      expect(callRes.isError).toBeFalsy()
      const textContent = (callRes.content as Array<{ type: string, text?: string }>)
        .map(c => c.text ?? ``)
        .join(`\n`)
      expect(textContent).toContain(`images/my-cover.png`)
      expect(receivedPrompts).toEqual([{ prompt: `A clean geometric sunset`, size: `1536x1024` }])

      const written = await fs.readFile(path.join(workspaceDir, `images`, `my-cover.png`))
      expect(written.equals(TINY_PNG_BYTES)).toBe(true)
    }
    finally {
      await client.close()
    }
  }, 20_000)
})

describe(`api model ACP agent end-to-end through AcpHost`, () => {
  async function createWiredHost(fakeOpenAi: FakeOpenAiServer, options?: {
    configureModelApi?: boolean
    configureImageGen?: boolean
    onEvent?: (event: AcpHostEvent) => void
  }) {
    const dataDir = await makeTempDir(`md-api-host-`)
    const configStore = new AiConfigStore({
      configPath: path.join(dataDir, `ai-config.json`),
      cipher: createMockSafeStorage(true),
    })

    if (options?.configureModelApi !== false) {
      await configStore.updateModelApiConfig({
        protocol: `openai-compatible`,
        providerPreset: `custom`,
        baseUrl: fakeOpenAi.baseUrl,
        apiKey: fakeOpenAi.apiKey,
        enabledModels: [`mock-gpt-pro`, `mock-gpt-mini`],
        defaultModel: `mock-gpt-pro`,
      })
    }

    if (options?.configureImageGen) {
      await configStore.updateImageGenConfig({
        providerPreset: `custom`,
        baseUrl: fakeOpenAi.baseUrl,
        apiKey: fakeOpenAi.apiKey,
        model: `mock-image-1`,
        size: `1024x1024`,
        quality: `standard`,
      })
    }

    const bridge = new ImageGenBridge({
      getConfig: () => configStore.getResolvedImageGenConfig(),
    })
    openBridges.push(bridge)

    const host = new AcpHost({
      dataDir,
      extraBuiltinAgents: [
        {
          id: API_MODEL_AGENT_ID,
          name: `API Model`,
          command: process.execPath,
          args: [API_AGENT_SCRIPT],
          env: {},
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `M`, color: `#0284C7` },
        },
        {
          id: `fake-cli`,
          name: `Fake CLI`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: {},
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `F`, color: `#5B5BD6` },
        },
      ],
      resolveAgentAvailability: async (agentId) => {
        if (agentId !== API_MODEL_AGENT_ID)
          return null
        return configStore.isModelApiConfigured()
      },
      resolveAgentRuntimeEnv: async (agentId, ctx) => {
        if (agentId !== API_MODEL_AGENT_ID)
          return undefined
        const resolved = await configStore.getResolvedModelApiConfig()
        const env: Record<string, string> = {
          MD_API_AGENT_CONFIG: JSON.stringify({
            protocol: resolved.protocol,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            enabledModels: resolved.enabledModels,
            defaultModel: resolved.defaultModel,
          }),
        }
        if (!ctx.forProbe && await configStore.isImageGenConfigured()) {
          const conn = await bridge.ensureStarted()
          env.MD_IMAGE_BRIDGE_URL = conn.url
          env.MD_IMAGE_BRIDGE_TOKEN = conn.token
        }
        return env
      },
      resolveSessionMcpServers: async (agentId, workspaceDir): Promise<McpServer[]> => {
        if (agentId === API_MODEL_AGENT_ID || !(await configStore.isImageGenConfigured()))
          return []
        const conn = await bridge.ensureStarted()
        return [{
          name: `md-image`,
          command: process.execPath,
          args: [IMAGE_MCP_SCRIPT],
          env: [
            { name: `MD_IMAGE_BRIDGE_URL`, value: conn.url },
            { name: `MD_IMAGE_BRIDGE_TOKEN`, value: conn.token },
            { name: `MD_WORKSPACE_DIR`, value: workspaceDir },
          ],
        }]
      },
      isImageGenConfigured: () => configStore.isImageGenConfigured(),
      onEvent: options?.onEvent,
    })
    openHosts.push(host)
    return { host, configStore, bridge }
  }

  it(`marks api-model installed only when configured and never exposes secrets in listAgents`, async () => {
    const fakeServer = await startFakeOpenAiServer()
    const { host, configStore } = await createWiredHost(fakeServer, { configureModelApi: false })

    const before = await host.listAgents()
    const apiBefore = before.find(a => a.id === API_MODEL_AGENT_ID)
    expect(apiBefore?.installed).toBe(false)

    await configStore.updateModelApiConfig({
      protocol: `openai-compatible`,
      baseUrl: fakeServer.baseUrl,
      apiKey: fakeServer.apiKey,
      enabledModels: [`mock-gpt-pro`],
    })
    const after = await host.refreshAgentAvailability()
    const apiAfter = after.find(a => a.id === API_MODEL_AGENT_ID)
    expect(apiAfter?.installed).toBe(true)
    expect(JSON.stringify(after)).not.toContain(fakeServer.apiKey)
  })

  it(`streams replies and reasoning, preserves multi-turn history, and switches model & thinking level`, async () => {
    const fakeServer = await startFakeOpenAiServer()
    const events: AcpHostEvent[] = []
    const { host } = await createWiredHost(fakeServer, { onEvent: e => events.push(e) })

    const started = await host.startSession({
      agentId: API_MODEL_AGENT_ID,
      permissionLevel: `ask`,
      postId: `post-1`,
      postTitle: `Test Article`,
      content: `# Title\n\nOld intro paragraph.\n`,
    })
    expect(started.models.map(m => m.id)).toEqual([`mock-gpt-pro`, `mock-gpt-mini`])
    expect(started.modelId).toBe(`mock-gpt-pro`)
    expect(started.modes.map(m => m.id)).toEqual([`default`, `acceptEdits`, `plan`, `bypassPermissions`])
    expect(started.thinkingOptions.map(o => o.id)).toContain(`high`)

    await host.prompt({
      sessionId: started.sessionId,
      text: `Say hello`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Test Article`,
    })

    const turn1Text = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    const turn1Thought = events
      .filter((e): e is Extract<AcpHostEvent, { type: `thought_chunk` }> => e.type === `thought_chunk`)
      .map(e => e.text)
      .join(``)
    expect(turn1Text).toContain(`Hello from mock-gpt-pro (turns=1, effort=none)`)
    expect(turn1Thought).toContain(`Thinking step for mock-gpt-pro`)
    // The API agent cannot load skills, so its first turn carries the full writing rules.
    const firstUserMessage = String(fakeServer.chatRequests[0].messages?.find(m => m.role === `user`)?.content)
    expect(firstUserMessage).toContain(`[Writing rules]`)
    expect(firstUserMessage.endsWith(`Say hello`)).toBe(true)

    // Switch model & thinking level, then run turn 2 and verify conversation history + params.
    await host.setModel({ sessionId: started.sessionId, modelId: `mock-gpt-mini` })
    await host.setThinkingLevel({ sessionId: started.sessionId, thinkingLevel: `high` })
    events.length = 0

    await host.prompt({
      sessionId: started.sessionId,
      text: `Follow-up question`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Test Article`,
    })

    const turn2Text = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(turn2Text).toContain(`Hello from mock-gpt-mini (turns=2, effort=high)`)
    expect(fakeServer.chatRequests[1].model).toBe(`mock-gpt-mini`)
    expect(fakeServer.chatRequests[1].reasoning_effort).toBe(`high`)
  }, 20_000)

  it(`enforces permission ask/reject/allow/auto_edits/plan and emits article_synced on edit`, async () => {
    const fakeServer = await startFakeOpenAiServer()
    const events: AcpHostEvent[] = []
    let nextDecision: `allow_once` | `reject` = `reject`

    const { host } = await createWiredHost(fakeServer, {
      onEvent: (event) => {
        events.push(event)
        if (event.type === `permission_requested`)
          host.respondPermission({ sessionId: event.sessionId, requestId: event.request.requestId, decision: nextDecision })
      },
    })

    const started = await host.startSession({
      agentId: API_MODEL_AGENT_ID,
      permissionLevel: `ask`,
      postId: `post-edit`,
      postTitle: `Edit Test`,
      content: `# Title\n\nOld intro paragraph.\n`,
    })

    // 1. In `ask` mode, rejecting the edit leaves article unchanged (no article_synced).
    await host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_EDIT`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Edit Test`,
    })
    const perm1 = events.filter(e => e.type === `permission_requested`)
    expect(perm1).toHaveLength(1)
    expect(perm1[0].type === `permission_requested` && perm1[0].request.unifiedDiff).toContain(`Updated intro paragraph`)
    expect(events.filter(e => e.type === `article_synced`)).toHaveLength(0)

    // 2. Allowing the edit updates article.md and emits article_synced.
    events.length = 0
    nextDecision = `allow_once`
    await host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_EDIT`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Edit Test`,
    })
    expect(events.filter(e => e.type === `permission_requested`)).toHaveLength(1)
    const synced1 = events.filter((e): e is Extract<AcpHostEvent, { type: `article_synced` }> => e.type === `article_synced`)
    expect(synced1.length).toBeGreaterThanOrEqual(1)
    expect(synced1[synced1.length - 1].content).toContain(`Updated intro paragraph by mock-gpt-pro.`)

    // 3. In `auto_edits` mode, edit succeeds with ZERO permission prompts.
    await host.setPermissionMode({ sessionId: started.sessionId, permissionLevel: `auto_edits` })
    events.length = 0
    await host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_EDIT`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Edit Test`,
    })
    expect(events.filter(e => e.type === `permission_requested`)).toHaveLength(0)
    const synced2 = events.filter((e): e is Extract<AcpHostEvent, { type: `article_synced` }> => e.type === `article_synced`)
    expect(synced2.length).toBeGreaterThanOrEqual(1)

    // 4. In `plan` mode, edit is blocked and emits no article_synced.
    await host.setPermissionMode({ sessionId: started.sessionId, permissionLevel: `plan` })
    events.length = 0
    await host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_EDIT`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Edit Test`,
    })
    expect(events.filter(e => e.type === `article_synced`)).toHaveLength(0)
  }, 20_000)

  it(`generates workspace images via bridge readable by readWorkspaceImage, supports cancel, and injects MCP for CLI agents`, async () => {
    const fakeServer = await startFakeOpenAiServer()
    const events: AcpHostEvent[] = []
    const { host } = await createWiredHost(fakeServer, {
      configureImageGen: true,
      onEvent: e => events.push(e),
    })

    // 1. API agent generate_image + edit_article in bypass mode.
    const started = await host.startSession({
      agentId: API_MODEL_AGENT_ID,
      permissionLevel: `bypass`,
      postId: `post-img`,
      postTitle: `Image Test`,
      content: `# Title\n\nOld intro paragraph.\n`,
    })
    await host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_IMAGE`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Image Test`,
    })

    expect(fakeServer.imageRequests).toHaveLength(1)
    expect(fakeServer.imageRequests[0].model).toBe(`mock-image-1`)

    const synced = events.filter((e): e is Extract<AcpHostEvent, { type: `article_synced` }> => e.type === `article_synced`)
    expect(synced.length).toBeGreaterThanOrEqual(1)
    expect(synced[synced.length - 1].content).toContain(`![Hero Cover](images/hero-cover.png)`)

    const wsImg = await host.readWorkspaceImage({
      sessionId: started.sessionId,
      path: `images/hero-cover.png`,
    })
    expect(wsImg.mimeType).toBe(`image/png`)
    expect(Buffer.from(wsImg.data).equals(TINY_PNG_BYTES)).toBe(true)

    // 2. Cancel aborts an in-flight streaming turn cleanly.
    const promptPromise = host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_SLOW_STREAM`,
      content: `# Title\n\nOld intro paragraph.\n`,
      postTitle: `Image Test`,
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    await host.cancelTurn(started.sessionId)
    const cancelledRes = await promptPromise
    expect(cancelledRes.stopReason).toBe(`cancelled`)

    // 3. Non-API CLI agent receives the md-image MCP server in session/new.
    const cliEvents: AcpHostEvent[] = []
    const cliStarted = await host.startSession({
      agentId: `fake-cli`,
      permissionLevel: `bypass`,
      postId: `post-cli`,
      postTitle: `CLI MCP Test`,
      content: `# CLI\n`,
    })
    events.length = 0
    await host.prompt({
      sessionId: cliStarted.sessionId,
      text: `Check MCP`,
      content: `# CLI\n`,
      postTitle: `CLI MCP Test`,
    })
    const cliText = events
      .filter((e): e is Extract<AcpHostEvent, { type: `message_chunk` }> => e.type === `message_chunk`)
      .map(e => e.text)
      .join(``)
    expect(cliEvents).toHaveLength(0)
    expect(cliText).toContain(`[mcp:md-image]`)
  }, 25_000)

  it(`ignores commandOverrides for built-in api-model so decrypted API keys never reach overridden commands`, async () => {
    const dir = await makeTempDir(`md-reg-sec-`)
    const registry = new AcpRegistry({
      settingsPath: path.join(dir, `acp-settings.json`),
      extraBuiltinAgents: [
        {
          id: API_MODEL_AGENT_ID,
          name: `API Model`,
          command: process.execPath,
          args: [API_AGENT_SCRIPT],
          env: {},
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `M`, color: `#0284C7` },
        },
      ],
    })

    const updated = await registry.updateSettings({
      commandOverrides: {
        [API_MODEL_AGENT_ID]: {
          command: `/usr/bin/env`,
          args: [`hijacked`],
        },
      },
    })
    expect(updated.commandOverrides[API_MODEL_AGENT_ID]).toBeUndefined()

    const spec = await registry.resolveLaunchSpec(API_MODEL_AGENT_ID)
    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toEqual([API_AGENT_SCRIPT])
  })

  it(`blocks symlink workspace escapes, prevents parallel filename overwrites, and caps generated image size`, async () => {
    const workspaceDir = await makeTempDir(`md-img-ws-`)
    const outsideDir = await makeTempDir(`md-img-outside-`)

    let returnOversized = false
    const bridge = new ImageGenBridge({
      getConfig: async () => ({
        providerPreset: `custom`,
        baseUrl: `http://127.0.0.1:9`,
        model: `mock`,
        size: `1024x1024`,
        quality: ``,
        hasApiKey: true,
        apiKey: `k`,
        isConfigured: true,
      }),
      generate: async () => {
        const bytes = returnOversized ? Buffer.alloc(10 * 1024 * 1024 + 16, 1) : TINY_PNG_BYTES
        return {
          bytes,
          base64: bytes.toString(`base64`),
          mimeType: `image/png`,
        }
      },
    })
    openBridges.push(bridge)
    const endpoint = await bridge.ensureStarted()

    // 1. Symlink `<workspace>/images -> outsideDir` must be rejected without writing outside.
    await fs.symlink(outsideDir, path.join(workspaceDir, `images`))
    await expect(generateAndSaveWorkspaceImage({
      bridgeUrl: endpoint.url,
      bridgeToken: endpoint.token,
      workspaceDir,
      prompt: `Symlink escape attempt`,
      filename: `escaped`,
    })).rejects.toThrow(/symlink|outside|workspace/i)
    expect(await fs.readdir(outsideDir)).toEqual([])

    // Replace symlink with a real workspace directory.
    await fs.unlink(path.join(workspaceDir, `images`))

    // 2. Parallel writes with the same slug must both land as distinct files without clobbering.
    const [resA, resB] = await Promise.all([
      generateAndSaveWorkspaceImage({
        bridgeUrl: endpoint.url,
        bridgeToken: endpoint.token,
        workspaceDir,
        prompt: `First parallel hero`,
        filename: `hero`,
      }),
      generateAndSaveWorkspaceImage({
        bridgeUrl: endpoint.url,
        bridgeToken: endpoint.token,
        workspaceDir,
        prompt: `Second parallel hero`,
        filename: `hero`,
      }),
    ])
    expect(new Set([resA.relativePath, resB.relativePath])).toEqual(
      new Set([`images/hero.png`, `images/hero-2.png`]),
    )

    // 3. Oversized (> 10 MB) generated image must be rejected before writing to disk.
    returnOversized = true
    await expect(generateAndSaveWorkspaceImage({
      bridgeUrl: endpoint.url,
      bridgeToken: endpoint.token,
      workspaceDir,
      prompt: `Huge image`,
      filename: `huge`,
    })).rejects.toThrow(/10 MB|too large|exceeds/i)
    await expect(fs.access(path.join(workspaceDir, `images`, `huge.png`))).rejects.toThrow()
  })

  it(`rejects non-http(s) baseUrl schemes, redacts leaked secrets in bridge errors, and enforces bridge prompt/concurrency limits`, async () => {
    const badModels = await fetchRemoteModels({
      protocol: `openai-compatible`,
      baseUrl: `file:///etc/passwd`,
      apiKey: `sk-secret`,
    })
    expect(badModels.ok).toBe(false)
    expect(badModels.error).toMatch(/http/i)

    await expect(generateDesktopImage({
      baseUrl: `ftp://example.com/v1`,
      apiKey: `sk-secret`,
      model: `gpt-image-1`,
      prompt: `test`,
    })).rejects.toThrow(/http/i)

    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let shouldLeakSecret = true
    const secretKey = `sk-bridge-top-secret-xyz`

    const bridge = new ImageGenBridge({
      getConfig: async () => ({
        providerPreset: `custom`,
        baseUrl: `https://api.example.com/v1`,
        model: `mock`,
        size: `1024x1024`,
        quality: ``,
        hasApiKey: true,
        apiKey: secretKey,
        isConfigured: true,
      }),
      generate: async () => {
        if (shouldLeakSecret)
          throw new Error(`Upstream failed for key=${secretKey}`)
        await slowGate
        return { bytes: TINY_PNG_BYTES, base64: TINY_PNG_BASE64, mimeType: `image/png` }
      },
    })
    openBridges.push(bridge)
    const { url, token } = await bridge.ensureStarted()

    // 1. Secret redaction in bridge error response.
    const errRes = await fetch(url, {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: `hello` }),
    })
    expect(errRes.status).toBe(502)
    const errText = await errRes.text()
    expect(errText).not.toContain(secretKey)

    // 2. Oversized prompt rejected with 400.
    const hugePromptRes = await fetch(url, {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: `x`.repeat(10_000) }),
    })
    expect(hugePromptRes.status).toBe(400)

    // 3. Concurrency limit rejects excess simultaneous image generations with 429.
    shouldLeakSecret = false
    const concurrentCalls = Array.from({ length: 6 }, () =>
      fetch(url, {
        method: `POST`,
        headers: {
          'Content-Type': `application/json`,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt: `concurrent` }),
      }))
    await new Promise(resolve => setTimeout(resolve, 60))
    releaseSlow()
    const statuses = (await Promise.all(concurrentCalls)).map(r => r.status)
    expect(statuses).toContain(429)
  })

  it(`serializes parallel edit_article calls and informs the model when article.md changed externally between turns`, async () => {
    const fakeServer = await startFakeOpenAiServer()
    const events: AcpHostEvent[] = []
    const { host } = await createWiredHost(fakeServer, {
      configureImageGen: true,
      onEvent: e => events.push(e),
    })

    const started = await host.startSession({
      agentId: API_MODEL_AGENT_ID,
      permissionLevel: `bypass`,
      postId: `post-par`,
      postTitle: `Parallel & External Sync Test`,
      content: `# Heading\n\nAlpha paragraph.\n\nBeta paragraph.\n`,
    })

    // 1. Parallel edit_article calls in one step must both survive without clobbering.
    await host.prompt({
      sessionId: started.sessionId,
      text: `TRIGGER_PARALLEL_EDIT`,
      content: `# Heading\n\nAlpha paragraph.\n\nBeta paragraph.\n`,
      postTitle: `Parallel & External Sync Test`,
    })
    const syncedPar = events.filter((e): e is Extract<AcpHostEvent, { type: `article_synced` }> => e.type === `article_synced`)
    expect(syncedPar.length).toBeGreaterThanOrEqual(1)
    const afterParallel = syncedPar[syncedPar.length - 1].content
    expect(afterParallel).toContain(`Alpha updated.`)
    expect(afterParallel).toContain(`Beta updated.`)

    // 2. Simulate renderer uploading an image / user editing article.md between Turn 1 and Turn 2.
    fakeServer.chatRequests.length = 0
    const externallyUpdated = `${afterParallel}\n![Uploaded](https://cdn.example.com/hosted.png)\n`
    await host.prompt({
      sessionId: started.sessionId,
      text: `Add a closing line.`,
      content: externallyUpdated,
      postTitle: `Parallel & External Sync Test`,
    })
    expect(fakeServer.chatRequests.length).toBeGreaterThanOrEqual(1)
    const turn2Payload = JSON.stringify(fakeServer.chatRequests[0].messages)
    expect(turn2Payload).toMatch(/article\.md.*changed|updated outside|read_article/i)
  }, 20_000)

  it(`keeps bundled image-mcp.js compact (< 50 KB)`, async () => {
    const stat = await fs.stat(IMAGE_MCP_SCRIPT)
    expect(stat.size).toBeLessThan(50 * 1024)
  })
})
