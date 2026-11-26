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
})
