// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock(`@/i18n/translate`, () => ({
  t: (key: string) => key,
}))

vi.mock(`@/services/account/config`, () => ({
  MD_API_URL: ``,
  isAccountConfigured: () => false,
}))

describe(`marketplace client desktop IPC bridge`, () => {
  const originalDesktop = window.mdDesktop

  afterEach(() => {
    window.mdDesktop = originalDesktop
  })

  it(`reports configured and delegates listThemes/get/install through window.mdDesktop.marketplace`, async () => {
    const { isMarketplaceConfigured, isMarketplaceUiEnabled, MarketplaceClient } = await import(`./client`)

    window.mdDesktop = undefined
    expect(isMarketplaceConfigured()).toBe(false)
    expect(isMarketplaceUiEnabled()).toBe(false)

    const listThemes = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }))
    const getItem = vi.fn(async (id: string) => ({ id, payload: `h1 { color: red; }` }))
    const installItem = vi.fn(async (id: string) => ({ id, payload: `h1 { color: red; }` }))

    window.mdDesktop = {
      isDesktop: true,
      marketplace: { listThemes, getItem, installItem },
    } as never

    expect(isMarketplaceConfigured()).toBe(true)
    expect(isMarketplaceUiEnabled()).toBe(true)

    const client = new MarketplaceClient(() => null)
    await client.listThemes({ q: `green`, sort: `popular` })
    expect(listThemes).toHaveBeenCalledWith({ q: `green`, sort: `popular` })

    await client.get(`theme-1`)
    expect(getItem).toHaveBeenCalledWith(`theme-1`)

    await client.install(`theme-1`)
    expect(installItem).toHaveBeenCalledWith(`theme-1`)
  })

  it(`normalizes desktop IPC rejections so error codes and localized messages match web ApiError`, async () => {
    const {
      getMarketplaceErrorCode,
      getMarketplaceErrorMessage,
      MarketplaceApiError,
      MarketplaceClient,
    } = await import(`./client`)

    const listThemes = vi.fn(async () => {
      throw new Error(`Error invoking remote method 'marketplace:list-themes': Error: HTTP 502`)
    })
    const getItem = vi.fn(async () => {
      throw new Error(`Error invoking remote method 'marketplace:get-item': TypeError: Marketplace request timed out`)
    })
    const installItem = vi.fn(async () => {
      throw new Error(`Error invoking remote method 'marketplace:install-item': Error: rate_limited`)
    })

    window.mdDesktop = {
      isDesktop: true,
      marketplace: { listThemes, getItem, installItem },
    } as never

    const client = new MarketplaceClient(() => null)

    await expect(client.install(`theme-1`)).rejects.toBeInstanceOf(MarketplaceApiError)
    const installErr = await client.install(`theme-1`).catch((e: unknown) => e)
    expect(getMarketplaceErrorCode(installErr)).toBe(`rate_limited`)
    expect(getMarketplaceErrorMessage(installErr, `marketplace.installFailed`)).toBe(`marketplace.validation.rateLimited`)

    const getErr = await client.get(`theme-1`).catch((e: unknown) => e)
    expect(getMarketplaceErrorCode(getErr)).toBe(`Marketplace request timed out`)
    expect(getMarketplaceErrorMessage(getErr, `marketplace.loadFailed`)).toBe(`Marketplace request timed out`)

    const listErr = await client.listThemes().catch((e: unknown) => e)
    expect(getMarketplaceErrorCode(listErr)).toBe(`HTTP 502`)
    expect(getMarketplaceErrorMessage(listErr, `marketplace.loadFailed`)).toBe(`marketplace.loadFailed`)

    // Raw Electron IPC Error passed directly to helpers also normalizes cleanly.
    const rawIpcErr = new Error(`Error invoking remote method 'marketplace:install-item': Error: unauthorized`)
    expect(getMarketplaceErrorCode(rawIpcErr)).toBe(`unauthorized`)
    expect(getMarketplaceErrorMessage(rawIpcErr)).toBe(`marketplace.validation.unauthorized`)

    // Non-IPC network TypeError on web still falls back to generic key.
    const webNetworkErr = new TypeError(`Failed to fetch`)
    expect(getMarketplaceErrorCode(webNetworkErr)).toBeNull()
    expect(getMarketplaceErrorMessage(webNetworkErr, `marketplace.loadFailed`)).toBe(`marketplace.loadFailed`)
  })
})
