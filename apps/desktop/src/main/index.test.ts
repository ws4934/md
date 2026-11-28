import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { AcpAgentStatus, AcpHostEvent, AcpProbeResult, DesktopSkill } from '@md/shared/types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { AcpEventBatcher } from './acp/event-batcher'
import { AcpHost } from './acp/host'

const electronMock = vi.hoisted(() => {
  let resolveReady!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const appListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const webContentsSend = vi.fn()
  const appQuit = vi.fn()
  const appExit = vi.fn()
  let userDataDir = ``

  class MockBrowserWindow {
    static getAllWindows(): MockBrowserWindow[] {
      return []
    }

    static getFocusedWindow(): MockBrowserWindow | null {
      return null
    }

    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      send: webContentsSend,
    }

    loadURL = vi.fn(async () => undefined)
    on = vi.fn()
    close = vi.fn()
    isDestroyed = () => false
  }

  return {
    resolveReady: () => resolveReady(),
    ipcHandlers,
    appListeners,
    webContentsSend,
    appQuit,
    appExit,
    setUserDataDir: (dir: string) => {
      userDataDir = dir
    },
    app: {
      setName: vi.fn(),
      getVersion: () => `2.1.0`,
      isPackaged: false,
      getPath: () => userDataDir,
      getAppPath: () => `/`,
      getLocale: () => `en-US`,
      whenReady: () => readyPromise,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        const list = appListeners.get(event) ?? []
        list.push(listener)
        appListeners.set(event, list)
      },
      quit: appQuit,
      exit: appExit,
    },
    BrowserWindow: MockBrowserWindow,
    dialog: {
      showOpenDialog: vi.fn(),
      showMessageBox: vi.fn(),
    },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler)
      },
    },
    Menu: {
      buildFromTemplate: vi.fn(() => ({})),
      setApplicationMenu: vi.fn(),
    },
    nativeTheme: {
      shouldUseDarkColors: false,
    },
    net: {
      fetch: vi.fn(),
    },
    powerMonitor: {
      on: vi.fn(),
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn(),
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => new Uint8Array(),
      decryptString: () => ``,
    },
    shell: {
      openExternal: vi.fn(),
    },
    autoUpdater: {
      autoDownload: false,
      on: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  }
})

vi.mock(`electron`, () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  dialog: electronMock.dialog,
  ipcMain: electronMock.ipcMain,
  Menu: electronMock.Menu,
  nativeTheme: electronMock.nativeTheme,
  net: electronMock.net,
  powerMonitor: electronMock.powerMonitor,
  protocol: electronMock.protocol,
  safeStorage: electronMock.safeStorage,
  shell: electronMock.shell,
}))

vi.mock(`electron-updater`, () => ({
  autoUpdater: electronMock.autoUpdater,
}))

const trustedSenderEvent = {
  senderFrame: {
    parent: null,
    url: `app://md/`,
  },
}

function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = electronMock.ipcHandlers.get(channel)
  if (!handler)
    throw new Error(`Missing IPC handler for ${channel}`)
  return Promise.resolve(handler(trustedSenderEvent, ...args)) as Promise<T>
}

describe(`desktop main index wiring`, () => {
  let userDataDir = ``
  let apiAgentScriptExists = true
  let sigintBefore = new Set<unknown>()
  let sigtermBefore = new Set<unknown>()

  beforeAll(async () => {
    userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `md-main-index-`))
    electronMock.setUserDataDir(userDataDir)

    sigintBefore = new Set(process.listeners(`SIGINT`))
    sigtermBefore = new Set(process.listeners(`SIGTERM`))

    const origExistsSync = fs.existsSync.bind(fs)
    vi.spyOn(fs, `existsSync`).mockImplementation((target) => {
      if (String(target).endsWith(`${path.sep}api-agent.js`))
        return apiAgentScriptExists
      return origExistsSync(target)
    })

    const origAccess = fs.promises.access.bind(fs.promises)
    vi.spyOn(fs.promises, `access`).mockImplementation(async (target, mode) => {
      if (/[\\/](?:image|search)-mcp\.js$/.test(String(target)))
        return
      if (String(target).endsWith(`${path.sep}api-agent.js`)) {
        if (!apiAgentScriptExists) {
          const err = new Error(`ENOENT: no such file or directory`) as NodeJS.ErrnoException
          err.code = `ENOENT`
          throw err
        }
        return
      }
      return origAccess(target, mode)
    })

    await import(`./index`)
    electronMock.resolveReady()
    for (let i = 0; i < 50 && !electronMock.ipcHandlers.has(IPC_CHANNELS.ACP_PROBE_AGENT); i++)
      await new Promise(resolve => setTimeout(resolve, 10))
  })

  afterAll(async () => {
    for (const listener of process.listeners(`SIGINT`)) {
      if (!sigintBefore.has(listener))
        process.removeListener(`SIGINT`, listener as NodeJS.SignalsListener)
    }
    for (const listener of process.listeners(`SIGTERM`)) {
      if (!sigtermBefore.has(listener))
        process.removeListener(`SIGTERM`, listener as NodeJS.SignalsListener)
    }
    vi.restoreAllMocks()
    if (userDataDir)
      await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it(`reports api-model unavailable and skips direct probe when api-agent.js is missing`, async () => {
    await invokeIpc(IPC_CHANNELS.AI_UPDATE_MODEL_API, {
      protocol: `openai-compatible`,
      baseUrl: `https://api.openai.com/v1`,
      apiKey: `sk-main-test-key`,
      enabledModels: [`gpt-5.4`],
      defaultModel: `gpt-5.4`,
    })

    // Present: available in detection and probed directly in-process.
    apiAgentScriptExists = true
    const detectedPresent = await invokeIpc<AcpAgentStatus[]>(IPC_CHANNELS.ACP_DETECT_AGENTS)
    expect(detectedPresent.find(a => a.id === API_MODEL_AGENT_ID)?.installed).toBe(true)

    const probePresent = await invokeIpc<AcpProbeResult>(IPC_CHANNELS.ACP_PROBE_AGENT, API_MODEL_AGENT_ID, { force: true })
    expect(probePresent.error).toBeUndefined()
    expect(probePresent.models.map(m => m.id)).toEqual([`gpt-5.4`])

    // Missing: availability flips to false and probe refuses to report a healthy agent.
    apiAgentScriptExists = false
    const detectedMissing = await invokeIpc<AcpAgentStatus[]>(IPC_CHANNELS.ACP_DETECT_AGENTS)
    expect(detectedMissing.find(a => a.id === API_MODEL_AGENT_ID)?.installed).toBe(false)

    const probeMissing = await invokeIpc<AcpProbeResult>(IPC_CHANNELS.ACP_PROBE_AGENT, API_MODEL_AGENT_ID, { force: true })
    expect(probeMissing.models).toEqual([])
    expect(probeMissing.error).toBeTruthy()
  })

  it(`serves skills over IPC and applies changes to the API model's slash commands`, async () => {
    apiAgentScriptExists = true
    await invokeIpc(IPC_CHANNELS.AI_UPDATE_MODEL_API, {
      protocol: `openai-compatible`,
      baseUrl: `https://api.openai.com/v1`,
      apiKey: `sk-main-test-key`,
      enabledModels: [`gpt-5.4`],
      defaultModel: `gpt-5.4`,
    })
    const commandNames = async () =>
      (await invokeIpc<AcpProbeResult>(IPC_CHANNELS.ACP_PROBE_AGENT, API_MODEL_AGENT_ID)).commands.map(c => c.name)

    const created = await invokeIpc<DesktopSkill[]>(IPC_CHANNELS.SKILLS_CREATE, `ipc-skill`)
    expect(created.find(s => s.name === `ipc-skill`)).toMatchObject({ source: `custom`, enabled: true })
    expect(await invokeIpc<string>(IPC_CHANNELS.SKILLS_READ, `ipc-skill`)).toContain(`name: ipc-skill`)
    expect(await commandNames()).toContain(`ipc-skill`)

    await invokeIpc(IPC_CHANNELS.SKILLS_SET_ENABLED, `ipc-skill`, false)
    expect(await commandNames()).not.toContain(`ipc-skill`)
    await expect(invokeIpc(IPC_CHANNELS.SKILLS_SAVE, `ipc-skill`, `no front matter`)).rejects.toThrow(/invalidFrontMatter/)
    expect((await invokeIpc<DesktopSkill[]>(IPC_CHANNELS.SKILLS_LIST)).find(s => s.name === `ipc-skill`)?.enabled).toBe(false)
  })

  it(`attaches md-search next to md-image only when web search is configured`, async () => {
    const spy = vi.spyOn(AcpHost.prototype, `getSettings`)
    await invokeIpc(IPC_CHANNELS.ACP_GET_SETTINGS)
    const host = spy.mock.contexts[0]
    spy.mockRestore()
    const resolveServers = (host as unknown as {
      resolveSessionMcpServers: (agentId: string, workspaceDir: string) => Promise<McpServer[]>
    }).resolveSessionMcpServers
    const names = async () => (await resolveServers(`claude`, userDataDir)).map(server => server.name)

    expect(await names()).toEqual([])

    // A saved key alone is not enough: the section must be enabled.
    await invokeIpc(IPC_CHANNELS.AI_UPDATE_WEB_SEARCH, { apiKey: `sk-search-main`, model: `gpt-5-mini` })
    expect(await names()).toEqual([])
    await invokeIpc(IPC_CHANNELS.AI_UPDATE_WEB_SEARCH, { enabled: true })
    expect(await names()).toEqual([`md-search`])

    await invokeIpc(IPC_CHANNELS.AI_UPDATE_IMAGE_GEN, { baseUrl: `https://api.openai.com/v1`, apiKey: `sk-img-main`, model: `gpt-image-1` })
    const servers = await resolveServers(`claude`, userDataDir)
    expect(servers.map(server => server.name)).toEqual([`md-image`, `md-search`])
    const searchEnv = (servers[1] as { env: Array<{ name: string, value: string }> }).env
    expect(searchEnv.map(e => e.name)).toEqual([`ELECTRON_RUN_AS_NODE`, `MD_SEARCH_BRIDGE_URL`, `MD_SEARCH_BRIDGE_TOKEN`])
    expect(JSON.stringify(servers)).not.toContain(`sk-search-main`)

    await invokeIpc(IPC_CHANNELS.AI_UPDATE_WEB_SEARCH, { enabled: false })
    expect(await names()).toEqual([`md-image`])

    const configs = await invokeIpc<{ webSearch: Record<string, unknown> }>(IPC_CHANNELS.AI_GET_CONFIGS)
    expect(configs.webSearch).toMatchObject({ enabled: false, hasApiKey: true })
    expect(`apiKey` in configs.webSearch).toBe(false)

    // Test connection runs one query through the (stubbed) provider and reports the source count or a redacted error.
    const requests: string[] = []
    vi.stubGlobal(`fetch`, async (input: string, init: RequestInit) => {
      requests.push(`${input} ${JSON.parse(String(init.body)).tools[0].type}`)
      const auth = (init.headers as Record<string, string>).Authorization
      if (auth !== `Bearer sk-search-main`)
        return new Response(JSON.stringify({ error: { message: `bad key ${auth}` } }), { status: 401 })
      return new Response(JSON.stringify({
        output: [{ type: `message`, content: [{ type: `output_text`, text: `ok`, annotations: [
          { type: `url_citation`, url: `https://a.example/`, title: `A` },
          { type: `url_citation`, url: `https://b.example/`, title: `B` },
        ] }] }],
      }), { status: 200 })
    })
    try {
      expect(await invokeIpc(IPC_CHANNELS.AI_TEST_WEB_SEARCH, { toolType: `web_search_preview` }))
        .toEqual({ ok: true, sourceCount: 2 })
      const failed = await invokeIpc<{ ok: boolean, error?: string }>(IPC_CHANNELS.AI_TEST_WEB_SEARCH, { apiKey: `sk-wrong-key` })
      expect(failed.ok).toBe(false)
      expect(failed.error).toMatch(/^HTTP 401/)
      expect(failed.error).not.toContain(`sk-wrong-key`)
      expect(requests).toEqual([
        `https://api.openai.com/v1/responses web_search_preview`,
        `https://api.openai.com/v1/responses web_search`,
      ])
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it(`disposes acpEventBatcher after awaiting acpHost.dispose in QuitGuard shutdown`, async () => {
    const order: string[] = []
    const origHostDispose = AcpHost.prototype.dispose
    const origBatcherDispose = AcpEventBatcher.prototype.dispose

    vi.spyOn(AcpHost.prototype, `dispose`).mockImplementation(async function (this: AcpHost) {
      order.push(`host.dispose:start`)
      await new Promise(resolve => setTimeout(resolve, 20))
      const emit = (this as unknown as { onEvent?: (event: AcpHostEvent) => void }).onEvent
      emit?.({ type: `message_chunk`, sessionId: `s-shutdown`, text: `final-` })
      emit?.({ type: `message_chunk`, sessionId: `s-shutdown`, text: `chunk` })
      await origHostDispose.call(this)
      order.push(`host.dispose:end`)
    })

    vi.spyOn(AcpEventBatcher.prototype, `dispose`).mockImplementation(function (this: AcpEventBatcher) {
      order.push(`batcher.dispose`)
      origBatcherDispose.call(this)
    })

    electronMock.webContentsSend.mockClear()
    const beforeQuitListeners = electronMock.appListeners.get(`before-quit`) ?? []
    expect(beforeQuitListeners.length).toBeGreaterThan(0)

    const event = { preventDefault: vi.fn() }
    for (const listener of beforeQuitListeners)
      listener(event)

    for (let i = 0; i < 50 && electronMock.appQuit.mock.calls.length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 15))

    expect(order).toEqual([`host.dispose:start`, `host.dispose:end`, `batcher.dispose`])

    // Chunks emitted during acpHost.dispose() were coalesced by the still-active batcher and flushed on batcher.dispose().
    const shutdownChunks = electronMock.webContentsSend.mock.calls
      .filter(([ch, payload]) =>
        ch === IPC_CHANNELS.ACP_EVENT
        && (payload as AcpHostEvent).type === `message_chunk`
        && (payload as Extract<AcpHostEvent, { type: `message_chunk` }>).sessionId === `s-shutdown`,
      )
      .map(([, payload]) => (payload as Extract<AcpHostEvent, { type: `message_chunk` }>).text)
    expect(shutdownChunks).toEqual([`final-chunk`])
  })
})
