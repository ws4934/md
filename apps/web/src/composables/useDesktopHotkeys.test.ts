// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, onBeforeUnmount, onMounted } from 'vue'

Object.assign(globalThis, { onMounted, onBeforeUnmount })

const { agentMock } = vi.hoisted(() => ({
  agentMock: {
    isPanelOpen: true,
    isSidebarOpen: true,
    isNewArticleHero: false,
    togglePanel: vi.fn(() => {
      agentMock.isPanelOpen = !agentMock.isPanelOpen
    }),
    setPanelOpen: vi.fn((open: boolean) => {
      agentMock.isPanelOpen = open
    }),
    toggleSidebar: vi.fn(() => {
      agentMock.isSidebarOpen = !agentMock.isSidebarOpen
    }),
  },
}))

vi.mock(`@/stores/agent`, () => ({
  useAgentStore: () => agentMock,
}))

function pressModKey(key: string, code?: string): KeyboardEvent {
  const event = new KeyboardEvent(`keydown`, {
    key,
    code,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(event)
  return event
}

describe(`desktop panel and sidebar hotkeys`, () => {
  const originalDesktop = window.mdDesktop
  let host: HTMLDivElement | null = null
  let unmount: (() => void) | null = null

  beforeEach(async () => {
    vi.clearAllMocks()
    agentMock.isPanelOpen = true
    agentMock.isSidebarOpen = true
    agentMock.isNewArticleHero = false
    window.mdDesktop = { isDesktop: true } as never

    const { useAgentPanelHotkey } = await import(`./useAgentPanelHotkey`)
    const { useDesktopSidebarHotkey } = await import(`./useDesktopSidebarHotkey`)

    const Harness = defineComponent({
      setup() {
        useAgentPanelHotkey()
        useDesktopSidebarHotkey()
        return () => h(`div`)
      },
    })

    host = document.createElement(`div`)
    document.body.append(host)
    const app = createApp(Harness)
    app.mount(host)
    unmount = () => app.unmount()
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    host?.remove()
    host = null
    document.querySelectorAll(`[role="dialog"], [data-testid="desktop-settings-page"]`).forEach(el => el.remove())
    window.mdDesktop = originalDesktop
  })

  it(`ignores Mod+J and Mod+\\ while a dialog or full-screen settings page is open`, () => {
    const dialog = document.createElement(`div`)
    dialog.setAttribute(`role`, `dialog`)
    document.body.append(dialog)

    pressModKey(`j`, `KeyJ`)
    pressModKey(`\\`, `Backslash`)
    expect(agentMock.togglePanel).not.toHaveBeenCalled()
    expect(agentMock.toggleSidebar).not.toHaveBeenCalled()
    dialog.remove()

    const settings = document.createElement(`div`)
    settings.setAttribute(`data-testid`, `desktop-settings-page`)
    document.body.append(settings)

    pressModKey(`j`, `KeyJ`)
    pressModKey(`\\`, `Backslash`)
    expect(agentMock.togglePanel).not.toHaveBeenCalled()
    expect(agentMock.toggleSidebar).not.toHaveBeenCalled()
    settings.remove()

    pressModKey(`\\`, `Backslash`)
    expect(agentMock.toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it(`leaves hero mode and opens the agent panel on Mod+J instead of flipping invisibly`, () => {
    agentMock.isNewArticleHero = true
    agentMock.isPanelOpen = false

    pressModKey(`j`, `KeyJ`)
    expect(agentMock.isNewArticleHero).toBe(false)
    expect(agentMock.setPanelOpen).toHaveBeenCalledWith(true)
    expect(agentMock.isPanelOpen).toBe(true)
    expect(agentMock.togglePanel).not.toHaveBeenCalled()

    pressModKey(`j`, `KeyJ`)
    expect(agentMock.togglePanel).toHaveBeenCalledTimes(1)
    expect(agentMock.isPanelOpen).toBe(false)
  })
})
