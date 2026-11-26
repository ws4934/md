import { describe, expect, it, vi } from 'vitest'
import { createDesktopMarketplaceClient, DEFAULT_MARKETPLACE_API_URL } from './marketplace'

describe(`createDesktopMarketplaceClient`, () => {
  it(`fetches public themes list with sanitized query parameters`, async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }), { status: 200 }))

    const client = createDesktopMarketplaceClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    const res = await client.listThemes({ q: `  tech  `, sort: `popular`, page: 2, pageSize: 999 })

    expect(res.items).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_MARKETPLACE_API_URL}/marketplace/themes?q=tech&sort=popular&page=2&pageSize=50`,
      expect.objectContaining({ method: `GET` }),
    )
  })

  it(`gets detail and posts install for valid item IDs`, async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: `39128414-c754-4506-9049-638461a852c8`,
      payload: `body {}`,
    }), { status: 200 }))

    const client = createDesktopMarketplaceClient({
      apiUrl: `https://custom.example.com/`,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await client.getItem(`39128414-c754-4506-9049-638461a852c8`)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://custom.example.com/marketplace/39128414-c754-4506-9049-638461a852c8`,
      expect.objectContaining({ method: `GET` }),
    )

    await client.installItem(`39128414-c754-4506-9049-638461a852c8`)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://custom.example.com/marketplace/39128414-c754-4506-9049-638461a852c8/install`,
      expect.objectContaining({ method: `POST` }),
    )
  })

  it(`rejects malformed item IDs and surfaces upstream JSON error messages`, async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: `not_found` }), { status: 404 }))
    const client = createDesktopMarketplaceClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await expect(client.getItem(`../me`)).rejects.toThrow(`Invalid marketplace item id`)
    await expect(client.installItem(`a/b`)).rejects.toThrow(`Invalid marketplace item id`)
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(client.getItem(`missing-id`)).rejects.toThrow(`not_found`)
  })

  it(`handles invalid apiUrl overrides, timeouts, malformed JSON/shapes, and gateway error payloads`, async () => {
    const seenUrls: string[] = []
    const fallbackClient = createDesktopMarketplaceClient({
      apiUrl: `https://user:pass@evil.example.com?bad=1`,
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        seenUrls.push(String(url))
        return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await fallbackClient.listThemes()
    expect(seenUrls[0]).toBe(`${DEFAULT_MARKETPLACE_API_URL}/marketplace/themes`)

    await expect(fallbackClient.listThemes(`invalid` as never)).rejects.toThrow(TypeError)

    const htmlPortalClient = createDesktopMarketplaceClient({
      fetchImpl: vi.fn(async () => new Response(`<html>captive portal</html>`, { status: 200 })) as unknown as typeof fetch,
    })
    await expect(htmlPortalClient.listThemes()).rejects.toThrow(`Invalid marketplace JSON response`)

    const badShapeClient = createDesktopMarketplaceClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    })
    await expect(badShapeClient.listThemes()).rejects.toThrow(`Invalid marketplace response payload`)
    await expect(badShapeClient.getItem(`valid-id`)).rejects.toThrow(`Invalid marketplace response payload`)

    const nestedErrClient = createDesktopMarketplaceClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: `   `, message: `Upstream gateway unavailable` }), {
        status: 503,
        statusText: ``,
      })) as unknown as typeof fetch,
    })
    await expect(nestedErrClient.getItem(`valid-id`)).rejects.toThrow(`Upstream gateway unavailable`)

    const timeoutClient = createDesktopMarketplaceClient({
      fetchImpl: vi.fn(async () => {
        const err = new Error(`aborted`)
        err.name = `TimeoutError`
        throw err
      }) as unknown as typeof fetch,
    })
    await expect(timeoutClient.listThemes()).rejects.toThrow(`Marketplace request timed out`)
  })
})
