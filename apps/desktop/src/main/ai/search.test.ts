import type { SecretCipher } from './config-store'
import type { WebSearchResult } from './search-service'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatWebSearchResult } from '../../agents/shared/search-client'
import { AiConfigStore } from './config-store'
import { WebSearchBridge } from './search-bridge'
import { buildWebSearchRequestBody, parseWebSearchResponse, PROVIDER_COOLDOWN_MS, searchWeb, searchWithFailover } from './search-service'

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
      query: `  latest node  `,
      fetchImpl,
    })
    expect(result.sources).toEqual([{ title: `S1`, url: `https://s.example/1` }])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://search.example/v1/responses`)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer sk-search`)
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body).toEqual(buildWebSearchRequestBody({ model: `gpt-5-mini`, toolType: `web_search`, query: `latest node`, includeSources: true }))
    expect(body.tools).toEqual([{ type: `web_search` }])
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

    const result = await searchWeb({ baseUrl: `https://s.example/v1`, apiKey: `sk-x`, model: `m`, query: `q`, fetchImpl })
    expect(result.answer).toBe(`Answer`)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].include).toBeDefined()
    expect(`include` in bodies[1]).toBe(false)
  })

  it(`falls back to web_search_preview when the provider rejects the tool name`, async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const [tool] = body.tools as Array<{ type: string }>
      if (body.include)
        return new Response(JSON.stringify({ error: { message: `Unknown parameter: 'include'.`, param: `include` } }), { status: 400 })
      if (tool.type === `web_search`)
        return new Response(JSON.stringify({ error: { message: `Invalid value: 'web_search'. Supported values are: 'web_search_preview'.`, param: `tools[0].type` } }), { status: 400 })
      return new Response(JSON.stringify(okPayload), { status: 200 })
    }

    const result = await searchWeb({ baseUrl: `https://s.example/v1`, apiKey: `sk-x`, model: `m`, query: `q`, fetchImpl })
    expect(result.answer).toBe(`Answer`)
    expect(bodies.map(body => [(body.tools as Array<{ type: string }>)[0].type, `include` in body])).toEqual([
      [`web_search`, true],
      [`web_search`, false],
      [`web_search_preview`, false],
    ])
  })

  it(`does not retry other errors and redacts the API key`, async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: `Invalid key sk-secret-search-key for model` } }), { status: 401 })
    }
    await expect(searchWeb({ baseUrl: `https://s.example/v1`, apiKey: `sk-secret-search-key`, model: `m`, query: `q`, fetchImpl }))
      .rejects
      .toThrow(/^HTTP 401: Invalid key \*\*\* for model$/)
    expect(calls).toBe(1)
  })

  it(`rejects empty results, non-JSON bodies, missing config, and aborts`, async () => {
    const base = { baseUrl: `https://s.example/v1`, apiKey: `sk-x`, model: `m`, query: `q` }
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
  async function makeConfigPath(prefix: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return path.join(dir, `ai-config.json`)
  }

  const provider = (overrides: Record<string, unknown> = {}) => ({
    name: ``,
    enabled: true,
    protocol: `openai-responses` as const,
    baseUrl: `https://a.example/v1`,
    model: `m`,
    ...overrides,
  })

  it(`encrypts each provider key, never exposes keys publicly, and requires the switch plus one usable provider`, async () => {
    const configPath = await makeConfigPath(`md-search-cfg-`)
    const cipher = createMockSafeStorage()
    const scopes: string[] = []
    const store = new AiConfigStore({ configPath, cipher, onChange: scope => scopes.push(scope) })

    expect((await store.getPublicConfigs()).webSearch).toEqual({ enabled: false, providers: [] })

    const saved = await store.updateWebSearchConfig({
      enabled: false,
      providers: [
        provider({ name: `Primary`, apiKey: `sk-search-a` }),
        provider({ baseUrl: `https://b.example/v1/`, apiKey: `sk-search-b` }),
      ],
    })
    expect(scopes).toEqual([`webSearch`])
    expect(saved.providers.map(p => [p.name, p.baseUrl, p.hasApiKey])).toEqual([
      [`Primary`, `https://a.example/v1`, true],
      [``, `https://b.example/v1`, true],
    ])
    expect(saved.providers[0].id).toMatch(/\S/)
    expect(saved.providers[0].id).not.toBe(saved.providers[1].id)
    expect(JSON.stringify(saved)).not.toMatch(/sk-search|apiKey/)
    expect(await store.isWebSearchConfigured()).toBe(false)

    const [idA, idB] = saved.providers.map(p => p.id)
    await store.updateWebSearchConfig({ enabled: true, providers: [provider({ id: idA }), provider({ id: idB, baseUrl: `https://b.example/v1` })] })
    expect(await store.isWebSearchConfigured()).toBe(true)
    const rawOnDisk = await fs.readFile(configPath, `utf8`)
    expect(rawOnDisk).not.toContain(`sk-search-a`)
    expect(rawOnDisk).not.toContain(`sk-search-b`)

    const reloaded = new AiConfigStore({ configPath, cipher })
    const resolved = await reloaded.getResolvedWebSearchConfig()
    expect(resolved.isConfigured).toBe(true)
    expect(resolved.providers.map(p => [p.id, p.apiKey, p.isUsable])).toEqual([[idA, `sk-search-a`, true], [idB, `sk-search-b`, true]])

    // Reorder by id keeps each key; empty string clears, a new origin without a key drops it, unknown ids are new.
    const next = await reloaded.updateWebSearchConfig({
      enabled: true,
      providers: [
        provider({ id: idB, baseUrl: `https://b.example/v1`, apiKey: `` }),
        provider({ id: idA, baseUrl: `https://moved.example/v1` }),
        provider({ id: `made-up`, apiKey: `sk-search-c` }),
      ],
    })
    expect(next.providers.map(p => p.hasApiKey)).toEqual([false, false, true])
    expect(next.providers.slice(0, 2).map(p => p.id)).toEqual([idB, idA])
    expect(next.providers[2].id).not.toBe(`made-up`)
    expect((await reloaded.getResolvedWebSearchConfig()).providers.map(p => p.isUsable)).toEqual([false, false, true])

    // Disabled, keyless, or model-less providers are not usable.
    await reloaded.updateWebSearchConfig({
      enabled: true,
      providers: [provider({ id: next.providers[2].id, enabled: false })],
    })
    expect(await reloaded.isWebSearchConfigured()).toBe(false)
    await reloaded.updateWebSearchConfig({ enabled: true, providers: [provider({ id: next.providers[2].id, model: ` ` })] })
    expect(await reloaded.isWebSearchConfigured()).toBe(false)
    await expect(reloaded.updateWebSearchConfig({ enabled: true, providers: [provider({ baseUrl: `ftp://x` })] })).rejects.toThrow()
  })

  it(`migrates the single-provider config into a one-item list and keeps its encrypted key`, async () => {
    const configPath = await makeConfigPath(`md-search-cfg-legacy-`)
    const cipher = createMockSafeStorage()
    const encrypted = cipher.encryptString(`sk-legacy`).toString(`base64`)
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      webSearch: {
        enabled: true,
        protocol: `openai-responses`,
        baseUrl: `https://legacy.example/v1`,
        apiKey: { encoding: `safeStorage`, value: encrypted },
        model: `legacy-model`,
      },
    }))

    const store = new AiConfigStore({ configPath, cipher })
    expect((await store.getPublicConfigs()).webSearch).toEqual({
      enabled: true,
      providers: [{
        id: `default`,
        name: ``,
        enabled: true,
        protocol: `openai-responses`,
        baseUrl: `https://legacy.example/v1`,
        hasApiKey: true,
        model: `legacy-model`,
      }],
    })
    const resolved = await store.getResolvedWebSearchConfig()
    expect(resolved.isConfigured).toBe(true)
    expect(resolved.providers[0].apiKey).toBe(`sk-legacy`)

    // Saving writes the new shape and keeps the migrated key under the same id.
    await store.updateWebSearchConfig({ enabled: true, providers: [provider({ id: `default`, baseUrl: `https://legacy.example/v1`, model: `legacy-model` })] })
    const onDisk = JSON.parse(await fs.readFile(configPath, `utf8`)).webSearch
    expect(onDisk.providers[0]).toMatchObject({ id: `default`, apiKey: { encoding: `safeStorage`, value: encrypted } })
    expect(`baseUrl` in onDisk).toBe(false)
  })

  it(`sanitizes invalid stored values`, async () => {
    const configPath = await makeConfigPath(`md-search-cfg-bad-`)
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      webSearch: {
        enabled: `yes`,
        providers: [
          { id: `a`, protocol: `x`, baseUrl: `nope`, apiKey: `plain-string`, enabled: false },
          null,
          { id: `a`, baseUrl: `https://ok.example/v1/`, model: ` m ` },
          ...Array.from({ length: 6 }, () => ({})),
        ],
      },
    }))
    const store = new AiConfigStore({ configPath, cipher: createMockSafeStorage() })
    const { webSearch } = await store.getPublicConfigs()
    expect(webSearch.enabled).toBe(false)
    expect(webSearch.providers).toHaveLength(5)
    expect(webSearch.providers[0]).toEqual({ id: `a`, name: ``, enabled: false, protocol: `openai-responses`, baseUrl: ``, hasApiKey: false, model: `gpt-5-mini` })
    expect(webSearch.providers[1]).toMatchObject({ enabled: true, baseUrl: `https://ok.example/v1`, model: `m` })
    expect(new Set(webSearch.providers.map(p => p.id)).size).toBe(5)

    await fs.writeFile(configPath, JSON.stringify({ version: 1, webSearch: { enabled: true } }))
    expect((await new AiConfigStore({ configPath }).getPublicConfigs()).webSearch).toEqual({ enabled: true, providers: [] })
  })
})

describe(`searchWithFailover`, () => {
  const okPayload = (answer: string) => ({ output: [message(answer, [citation(`https://s.example/1`, `S1`)])] })
  const providers = [
    { id: `a`, name: `Alpha`, baseUrl: `https://a.example/v1`, apiKey: `sk-alpha-secret`, model: `m` },
    { id: `b`, name: ``, baseUrl: `https://b.example/v1`, apiKey: `sk-bravo-secret`, model: `m` },
    { id: `c`, name: `Charlie`, baseUrl: `https://c.example/v1`, apiKey: `sk-charlie-secret`, model: `m` },
  ]

  /** Each host answers with the given status (or throws for `network`); records hit order. */
  function fakeFetch(behavior: Record<string, number | `network` | `empty`>, hits: string[]): typeof fetch {
    return async (input) => {
      const host = new URL(String(input)).host
      hits.push(host)
      const mode = behavior[host] ?? 200
      if (mode === `network`)
        throw new TypeError(`fetch failed`)
      if (mode === `empty`)
        return new Response(JSON.stringify({ output: [] }), { status: 200 })
      if (mode !== 200)
        return new Response(JSON.stringify({ error: { message: `rejected key sk-${host[0] === `a` ? `alpha` : `bravo`}-secret` } }), { status: mode })
      return new Response(JSON.stringify(okPayload(`from ${host}`)), { status: 200 })
    }
  }

  it(`returns the first provider's result unchanged without touching the rest`, async () => {
    const hits: string[] = []
    const cooldowns = new Map<string, number>()
    const result = await searchWithFailover({ providers, query: `q`, cooldowns, fetchImpl: fakeFetch({}, hits) })
    expect(result).toEqual({ answer: `from a.example`, sources: [{ title: `S1`, url: `https://s.example/1` }], queries: [] })
    expect(hits).toEqual([`a.example`])
    expect(cooldowns.size).toBe(0)
  })

  it(`moves down the list on network errors, non-2xx, and empty results, then cools failed providers down`, async () => {
    let now = 1_000
    const cooldowns = new Map<string, number>()
    for (const failure of [`network`, 401, 429, 503, `empty`] as const) {
      const hits: string[] = []
      cooldowns.clear()
      const result = await searchWithFailover({
        providers,
        query: `q`,
        cooldowns,
        now: () => now,
        fetchImpl: fakeFetch({ 'a.example': failure }, hits),
      })
      expect(result.answer, String(failure)).toBe(`from b.example`)
      expect(hits).toEqual([`a.example`, `b.example`])
      expect([...cooldowns]).toEqual([[`a`, now + PROVIDER_COOLDOWN_MS]])
    }

    // While cooling down, `a` is skipped even though it would now succeed.
    const hits: string[] = []
    expect((await searchWithFailover({ providers, query: `q`, cooldowns, now: () => now, fetchImpl: fakeFetch({}, hits) })).answer).toBe(`from b.example`)
    expect(hits).toEqual([`b.example`])

    // After the cooldown it is first in line again and success clears its entry.
    now += PROVIDER_COOLDOWN_MS + 1
    hits.length = 0
    expect((await searchWithFailover({ providers, query: `q`, cooldowns, now: () => now, fetchImpl: fakeFetch({}, hits) })).answer).toBe(`from a.example`)
    expect(hits).toEqual([`a.example`])
    expect(cooldowns.has(`a`)).toBe(false)
  })

  it(`tries every provider in order when all of them are cooling down`, async () => {
    const now = 5_000
    const cooldowns = new Map(providers.map(p => [p.id, now + 60_000]))
    const hits: string[] = []
    const result = await searchWithFailover({
      providers,
      query: `q`,
      cooldowns,
      now: () => now,
      fetchImpl: fakeFetch({ 'a.example': 500 }, hits),
    })
    expect(result.answer).toBe(`from b.example`)
    expect(hits).toEqual([`a.example`, `b.example`])
    expect(cooldowns.has(`b`)).toBe(false)
  })

  it(`throws one redacted error naming every provider when all fail`, async () => {
    const hits: string[] = []
    const cooldowns = new Map<string, number>()
    const error = await searchWithFailover({
      providers,
      query: `q`,
      cooldowns,
      fetchImpl: fakeFetch({ 'a.example': 401, 'b.example': 401, 'c.example': `network` }, hits),
    }).catch((e: Error) => e)
    expect(hits).toEqual([`a.example`, `b.example`, `c.example`])
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `Web search failed on every provider tried: Alpha: HTTP 401: rejected key ***; b.example: HTTP 401: rejected key ***; Charlie: fetch failed`,
    )
    expect([...cooldowns.keys()]).toEqual([`a`, `b`, `c`])
    await expect(searchWithFailover({ providers: [], query: `q`, cooldowns })).rejects.toThrow(/No usable/)
  })

  it(`stops on a caller abort without trying other providers or cooling down`, async () => {
    const controller = new AbortController()
    const hits: string[] = []
    const cooldowns = new Map<string, number>()
    const pending = searchWithFailover({
      providers,
      query: `q`,
      cooldowns,
      abortSignal: controller.signal,
      fetchImpl: (input, init) => {
        hits.push(new URL(String(input)).host)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(`abort`, () => reject(init.signal!.reason))
        })
      },
    })
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(hits).toEqual([`a.example`])
    expect(cooldowns.size).toBe(0)
  })

  it(`fails over when a provider times out`, async () => {
    const hits: string[] = []
    const result = await searchWithFailover({
      providers,
      query: `q`,
      cooldowns: new Map(),
      timeoutMs: 20,
      fetchImpl: (input, init) => {
        const host = new URL(String(input)).host
        hits.push(host)
        if (host !== `a.example`)
          return fakeFetch({}, [])(input, init)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(`abort`, () => reject(init.signal!.reason))
        })
      },
    })
    expect(result.answer).toBe(`from b.example`)
    expect(hits).toEqual([`a.example`, `b.example`])
  })
})

describe(`web search bridge`, () => {
  const configured = {
    enabled: true,
    providers: [{
      id: `p1`,
      name: ``,
      enabled: true,
      protocol: `openai-responses` as const,
      baseUrl: `https://s.example/v1`,
      hasApiKey: true,
      apiKey: `sk-bridge-secret`,
      model: `m`,
      isUsable: true,
    }],
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

  it(`fails over across usable providers only, honors cooldown reset, and redacts every key`, async () => {
    const realFetch = globalThis.fetch
    const hosts: string[] = []
    let upStatus = 200
    vi.stubGlobal(`fetch`, async (input: string, init: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === `127.0.0.1`)
        return realFetch(input, init)
      hosts.push(url.host)
      const status = url.host === `down.example` ? 503 : upStatus
      if (status !== 200)
        return new Response(JSON.stringify({ error: { message: `failed for ${(init.headers as Record<string, string>).Authorization}` } }), { status })
      return new Response(JSON.stringify({ output: [message(`from ${url.host}`)] }), { status: 200 })
    })
    const base = { ...configured.providers[0], name: `` }
    const config = {
      ...configured,
      providers: [
        { ...base, id: `off`, baseUrl: `https://off.example/v1`, apiKey: `sk-off-secret`, enabled: false, isUsable: false },
        { ...base, id: `down`, baseUrl: `https://down.example/v1`, apiKey: `sk-down-secret` },
        { ...base, id: `up`, name: `Up`, baseUrl: `https://up.example/v1`, apiKey: `sk-up-secret` },
      ],
    }
    try {
      const bridge = new WebSearchBridge({ getConfig: async () => config })
      openBridges.push(bridge)
      const conn = await bridge.ensureStarted()
      const post = () => realFetch(conn.url, {
        method: `POST`,
        headers: { 'Content-Type': `application/json`, 'Authorization': `Bearer ${conn.token}` },
        body: JSON.stringify({ query: `q` }),
      })

      const first = await post()
      expect(await first.json()).toEqual({ answer: `from up.example`, sources: [], queries: [] })
      expect(hosts).toEqual([`down.example`, `up.example`])

      hosts.length = 0
      await post()
      expect(hosts).toEqual([`up.example`])

      bridge.resetCooldowns()
      hosts.length = 0
      upStatus = 429
      const failed = await post()
      expect(failed.status).toBe(502)
      expect(hosts).toEqual([`down.example`, `up.example`])
      expect((await failed.json()).error).toBe(
        `Web search failed on every provider tried: down.example: HTTP 503: failed for Bearer ***; Up: HTTP 429: failed for Bearer ***`,
      )
    }
    finally {
      vi.unstubAllGlobals()
    }
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
