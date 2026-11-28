import type { SecretCipher } from './config-store'
import type { WebSearchResult } from './search-service'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatWebSearchResult } from '../../agents/shared/search-client'
import { AiConfigStore } from './config-store'
import { WebSearchBridge } from './search-bridge'
import { buildWebSearchRequestBody, parseWebSearchResponse, searchWeb } from './search-service'

const tempDirs: string[] = []
const openBridges: WebSearchBridge[] = []

afterEach(async () => {
  while (openBridges.length > 0)
    await openBridges.pop()!.close()
  while (tempDirs.length > 0)
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
})

function createMockSafeStorage(): SecretCipher {
  const prefix = `ENC_V1:`
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`${prefix}${plainText.split(``).reverse().join(``)}`, `utf8`),
    decryptString: (encrypted: Buffer) => encrypted.toString(`utf8`).slice(prefix.length).split(``).reverse().join(``),
  }
}

function message(text: string, annotations: unknown[] = []) {
  return {
    type: `message`,
    role: `assistant`,
    content: [{ type: `output_text`, text, annotations }],
  }
}

function citation(url: string, title?: string) {
  return { type: `url_citation`, url, title, start_index: 0, end_index: 5 }
}

function searchCall(query: string, sources?: unknown[]) {
  return {
    type: `web_search_call`,
    status: `completed`,
    action: { type: `search`, query, ...(sources ? { sources } : {}) },
  }
}

describe(`parseWebSearchResponse`, () => {
  it(`reads sources from url_citation annotations`, () => {
    const result = parseWebSearchResponse({
      output: [
        searchCall(`2025 城镇储户问卷`),
        message(`央行停发了这份问卷 ([pbc.gov.cn](https://www.pbc.gov.cn/a))。`, [
          citation(`https://www.pbc.gov.cn/a?utm_source=openai`, `中国人民银行`),
          citation(`https://news.example.com/b`, `报道`),
        ]),
      ],
    })
    expect(result).toEqual({
      answer: `央行停发了这份问卷 ([pbc.gov.cn](https://www.pbc.gov.cn/a))。`,
      sources: [
        { title: `中国人民银行`, url: `https://www.pbc.gov.cn/a` },
        { title: `报道`, url: `https://news.example.com/b` },
      ],
      queries: [`2025 城镇储户问卷`],
    })
  })

  it(`falls back to web_search_call action.sources`, () => {
    const result = parseWebSearchResponse({
      output: [
        searchCall(`node lts`, [{ type: `url`, url: `https://nodejs.org/en` }, { type: `url`, url: `https://github.com/nodejs/release`, title: `Release` }]),
        message(`Node.js 24 is the active LTS.`),
      ],
    })
    expect(result.sources).toEqual([
      { title: ``, url: `https://nodejs.org/en` },
      { title: `Release`, url: `https://github.com/nodejs/release` },
    ])
    expect(result.queries).toEqual([`node lts`])
  })

  it(`dedupes by URL in order of first appearance, citations before action sources`, () => {
    const result = parseWebSearchResponse({
      output: [
        searchCall(`q1`, [{ url: `https://b.example/` }, { url: `https://c.example/x` }, { url: `https://a.example/page` }]),
        searchCall(`q1`),
        searchCall(`q2`, [{ url: `https://b.example` }]),
        message(`answer one`, [citation(`https://a.example/page?utm_source=openai`), citation(`https://b.example/`, `B`), citation(`https://a.example/page`, `A late title`)]),
        message(`answer two`),
      ],
    })
    expect(result.sources).toEqual([
      { title: `A late title`, url: `https://a.example/page` },
      { title: `B`, url: `https://b.example/` },
      { title: ``, url: `https://c.example/x` },
    ])
    expect(result.queries).toEqual([`q1`, `q2`])
    expect(result.answer).toBe(`answer one\n\nanswer two`)
  })

  it(`tolerates malformed items and drops non-http URLs`, () => {
    for (const payload of [null, `text`, 42, [], {}, { output: `nope` }, { output: [null, 1, `x`, []] }])
      expect(parseWebSearchResponse(payload)).toEqual({ answer: ``, sources: [], queries: [] })

    const result = parseWebSearchResponse({
      output: [
        { type: `web_search_call` },
        { type: `web_search_call`, action: null },
        { type: `web_search_call`, action: { query: 7, sources: [null, `x`, { url: `javascript:alert(1)` }, { url: 3 }] } },
        { type: `message` },
        { type: `message`, content: `flat` },
        { type: `message`, content: [null, { type: `refusal`, refusal: `no` }, { type: `output_text`, text: 5, annotations: `bad` }] },
        message(`ok`, [null, { type: `file_citation`, url: `https://x.example` }, citation(`not a url`), citation(`ftp://files.example/a`), citation(` https://ok.example/p `, `  OK  `)]),
      ],
    })
    expect(result).toEqual({
      answer: `ok`,
      sources: [{ title: `OK`, url: `https://ok.example/p` }],
      queries: [],
    })
  })

  it(`drops footnote numbers that some providers send as citation titles`, () => {
    const result = parseWebSearchResponse({
      output: [{
        type: `message`,
        content: [{
          type: `output_text`,
          text: `答案[[1]](https://a.example/x)[[2]](https://b.example/y)`,
          annotations: [
            { type: `url_citation`, url: `https://a.example/x`, title: `1` },
            { type: `url_citation`, url: `https://b.example/y`, title: `[2]` },
          ],
        }],
      }],
    })

    expect(result.sources).toEqual([
      { title: ``, url: `https://a.example/x` },
      { title: ``, url: `https://b.example/y` },
    ])
  })

  it(`parses web_search_preview output and the output_text convenience field`, () => {
    const result = parseWebSearchResponse({
      output: [
        { type: `web_search_call`, id: `ws_1`, status: `completed` },
        { type: `message`, content: [{ text: `Preview answer`, annotations: [citation(`https://preview.example/`, `Preview`)] }] },
      ],
    })
    expect(result).toEqual({
      answer: `Preview answer`,
      sources: [{ title: `Preview`, url: `https://preview.example/` }],
      queries: [],
    })

    expect(parseWebSearchResponse({ output: [], output_text: ` only text ` }).answer).toBe(`only text`)
  })
})

describe(`searchWeb`, () => {
  const okPayload = { output: [message(`Answer`, [citation(`https://s.example/1`, `S1`)])] }

  it(`posts a Responses API request with the web search tool and sources include`, async () => {
    const calls: Array<{ url: string, init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(okPayload), { status: 200 })
    }

    const result = await searchWeb({
      baseUrl: `https://search.example/v1/`,
      apiKey: `sk-search`,
      model: `gpt-5-mini`,
      toolType: `web_search_preview`,
      query: `  latest node  `,
      fetchImpl,
    })
    expect(result.sources).toEqual([{ title: `S1`, url: `https://s.example/1` }])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://search.example/v1/responses`)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer sk-search`)
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body).toEqual(buildWebSearchRequestBody({ model: `gpt-5-mini`, toolType: `web_search_preview`, query: `latest node`, includeSources: true }))
    expect(body.tools).toEqual([{ type: `web_search_preview` }])
    expect(body.include).toEqual([`web_search_call.action.sources`])
    expect(body.input).toContain(`Query: latest node`)
  })

  it(`retries once without include when the provider rejects it`, async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      if (body.include)
        return new Response(JSON.stringify({ error: { message: `Unknown parameter: 'include'.`, param: `include` } }), { status: 400 })
      return new Response(JSON.stringify(okPayload), { status: 200 })
    }

    const result = await searchWeb({ baseUrl: `https://s.example/v1`, apiKey: `sk-x`, model: `m`, toolType: `web_search`, query: `q`, fetchImpl })
    expect(result.answer).toBe(`Answer`)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].include).toBeDefined()
    expect(`include` in bodies[1]).toBe(false)
  })

  it(`does not retry other errors and redacts the API key`, async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: `Invalid key sk-secret-search-key for model` } }), { status: 401 })
    }
    await expect(searchWeb({ baseUrl: `https://s.example/v1`, apiKey: `sk-secret-search-key`, model: `m`, toolType: `web_search`, query: `q`, fetchImpl }))
      .rejects
      .toThrow(/^HTTP 401: Invalid key \*\*\* for model$/)
    expect(calls).toBe(1)
  })

  it(`rejects empty results, non-JSON bodies, missing config, and aborts`, async () => {
    const base = { baseUrl: `https://s.example/v1`, apiKey: `sk-x`, model: `m`, toolType: `web_search` as const, query: `q` }
    await expect(searchWeb({ ...base, fetchImpl: async () => new Response(JSON.stringify({ output: [] }), { status: 200 }) }))
      .rejects
      .toThrow(/no answer or sources/)
    await expect(searchWeb({ ...base, fetchImpl: async () => new Response(`<html>`, { status: 200 }) }))
      .rejects
      .toThrow(/non-JSON/)
    await expect(searchWeb({ ...base, apiKey: `` })).rejects.toThrow(/not fully configured/)
    await expect(searchWeb({ ...base, query: `  ` })).rejects.toThrow(/query is required/)

    const controller = new AbortController()
    const pending = searchWeb({
      ...base,
      abortSignal: controller.signal,
      fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(`abort`, () => reject(init.signal!.reason))
      }),
    })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})

describe(`web search config`, () => {
  it(`encrypts the key, never exposes it publicly, and requires enabled + key + model`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `md-search-cfg-`))
    tempDirs.push(dir)
    const configPath = path.join(dir, `ai-config.json`)
    const cipher = createMockSafeStorage()
    const scopes: string[] = []
    const store = new AiConfigStore({ configPath, cipher, onChange: scope => scopes.push(scope) })

    const initial = (await store.getPublicConfigs()).webSearch
    expect(initial).toEqual({
      enabled: false,
      protocol: `openai-responses`,
      baseUrl: `https://api.openai.com/v1`,
      hasApiKey: false,
      model: `gpt-5-mini`,
      toolType: `web_search`,
    })

    const saved = await store.updateWebSearchConfig({ apiKey: `sk-search-secret`, toolType: `web_search_preview` })
    expect(saved.hasApiKey).toBe(true)
    expect(`apiKey` in saved).toBe(false)
    expect(scopes).toEqual([`webSearch`])
    expect(await store.isWebSearchConfigured()).toBe(false)

    await store.updateWebSearchConfig({ enabled: true })
    expect(await store.isWebSearchConfigured()).toBe(true)
    const rawOnDisk = await fs.readFile(configPath, `utf8`)
    expect(rawOnDisk).not.toContain(`sk-search-secret`)

    const reloaded = new AiConfigStore({ configPath, cipher })
    const resolved = await reloaded.getResolvedWebSearchConfig()
    expect(resolved).toMatchObject({ enabled: true, apiKey: `sk-search-secret`, toolType: `web_search_preview`, isConfigured: true })
    expect(`apiKey` in (await reloaded.getPublicConfigs()).webSearch).toBe(false)

    await reloaded.updateWebSearchConfig({ model: `  ` })
    expect(await reloaded.isWebSearchConfigured()).toBe(false)

    // Moving to another origin without a new key drops the saved key.
    const moved = await reloaded.updateWebSearchConfig({ model: `m`, baseUrl: `https://other.example/v1` })
    expect(moved.hasApiKey).toBe(false)
    await expect(reloaded.updateWebSearchConfig({ baseUrl: `ftp://x` })).rejects.toThrow()
  })

  it(`falls back to defaults for invalid stored values`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `md-search-cfg-bad-`))
    tempDirs.push(dir)
    const configPath = path.join(dir, `ai-config.json`)
    await fs.writeFile(configPath, JSON.stringify({ version: 1, webSearch: { enabled: `yes`, protocol: `x`, toolType: `y`, baseUrl: `nope`, apiKey: `plain-string` } }))
    const store = new AiConfigStore({ configPath, cipher: createMockSafeStorage() })
    expect((await store.getPublicConfigs()).webSearch).toEqual({
      enabled: false,
      protocol: `openai-responses`,
      baseUrl: `https://api.openai.com/v1`,
      hasApiKey: false,
      model: `gpt-5-mini`,
      toolType: `web_search`,
    })
  })
})

describe(`web search bridge`, () => {
  const configured = {
    enabled: true,
    protocol: `openai-responses` as const,
    baseUrl: `https://s.example/v1`,
    hasApiKey: true,
    apiKey: `sk-bridge-secret`,
    model: `m`,
    toolType: `web_search` as const,
    isConfigured: true,
  }

  async function startBridge(options: Partial<ConstructorParameters<typeof WebSearchBridge>[0]> = {}) {
    const bridge = new WebSearchBridge({ getConfig: async () => configured, ...options })
    openBridges.push(bridge)
    const conn = await bridge.ensureStarted()
    const post = (body: unknown, token = conn.token, url = conn.url) => fetch(url, {
      method: `POST`,
      headers: { 'Content-Type': `application/json`, 'Authorization': `Bearer ${token}` },
      body: typeof body === `string` ? body : JSON.stringify(body),
    })
    return { conn, post }
  }

  it(`enforces auth, routes, and query/body limits`, async () => {
    const seen: string[] = []
    const { conn, post } = await startBridge({
      search: async ({ query }) => {
        seen.push(query)
        return { answer: `A`, sources: [{ title: `T`, url: `https://t.example/` }], queries: [query] }
      },
    })
    expect(conn.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/search$/)

    expect((await post({ query: `q` }, `wrong`)).status).toBe(401)
    expect((await post({ query: `q` }, conn.token, conn.url.replace(`/search`, `/generate`))).status).toBe(404)
    expect((await post({ query: `  ` })).status).toBe(400)
    expect((await post({ query: `x`.repeat(1001) })).status).toBe(400)
    expect((await post(`not json`)).status).toBe(400)
    const tooLarge = await post({ query: `q`, pad: `x`.repeat(20 * 1024) })
    expect(tooLarge.status).toBe(400)
    expect((await tooLarge.json()).error).toMatch(/too large/)

    const ok = await post({ query: ` hello ` })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ answer: `A`, sources: [{ title: `T`, url: `https://t.example/` }], queries: [`hello`] })
    expect(seen).toEqual([`hello`])
  })

  it(`returns 503 when not configured and redacts provider errors`, async () => {
    let config = { ...configured, isConfigured: false }
    const { post } = await startBridge({
      getConfig: async () => config,
      search: async () => {
        throw new Error(`upstream rejected sk-bridge-secret`)
      },
    })
    expect((await post({ query: `q` })).status).toBe(503)

    config = configured
    const failed = await post({ query: `q` })
    expect(failed.status).toBe(502)
    expect((await failed.json()).error).toBe(`upstream rejected ***`)
  })

  it(`limits concurrent searches`, async () => {
    const releases: Array<() => void> = []
    const { post } = await startBridge({
      search: () => new Promise<WebSearchResult>((resolve) => {
        releases.push(() => resolve({ answer: `A`, sources: [], queries: [] }))
      }),
    })
    const pending = Array.from({ length: 4 }, () => post({ query: `q` }))
    while (releases.length < 4)
      await new Promise(resolve => setTimeout(resolve, 5))
    expect((await post({ query: `q` })).status).toBe(429)
    releases.forEach(release => release())
    expect((await Promise.all(pending)).map(r => r.status)).toEqual([200, 200, 200, 200])
  })
})

describe(`formatWebSearchResult`, () => {
  it(`prints the answer followed by a numbered source list`, () => {
    expect(formatWebSearchResult({
      answer: ` The answer. `,
      sources: [{ title: `First`, url: `https://a.example/` }, { title: ``, url: `https://b.example/` }],
      queries: [`q`],
    })).toBe(`The answer.\n\nSources:\n1. First - https://a.example/\n2. https://b.example/`)

    expect(formatWebSearchResult({ answer: ``, sources: [], queries: [] }))
      .toBe(`(The provider returned no answer text.)\n\nSources: none returned by the provider.`)
  })
})
