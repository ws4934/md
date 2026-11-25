import type { AcpAgentConfig, AcpHostEvent, WeChatPublishProgressEvent, WeChatPublishRequest, WeChatUploadImageRequest } from '@md/shared/types'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, powerMonitor, protocol, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { AcpEventBatcher } from './acp/event-batcher'
import { AcpHost } from './acp/host'
import { APP_HOST, APP_SCHEME, isSafeExternalUrl, resolveAppProtocolTarget } from './app-protocol'
import { QuitGuard } from './quit-guard'
import { mimeForExtension, WeChatPublisher } from './wechat/publisher'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEV_SERVER_URL = process.env.MD_DESKTOP_DEV_URL
const QUIT_DISPOSE_TIMEOUT_MS = 4_000

app.setName(`md`)

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

function resolveRendererDir(): string {
  const bundledDir = path.resolve(__dirname, `../renderer`)
  if (fs.existsSync(path.join(bundledDir, `index.html`)))
    return bundledDir
  return path.resolve(__dirname, `../../../web/dist`)
}

function registerAppProtocol(): void {
  const rendererDir = resolveRendererDir()

  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = await resolveAppProtocolTarget(request.url, rendererDir)
    if (resolved.status !== 200)
      return new Response(resolved.body, { status: resolved.status })
    return net.fetch(pathToFileURL(resolved.filePath).toString())
  })
}

let mainWindow: BrowserWindow | null = null
let acpHost: AcpHost | null = null
let acpEventBatcher: AcpEventBatcher | null = null
let wechatPublisher: WeChatPublisher | null = null
let quitGuard: QuitGuard | null = null

const testQuitResponses: Array<`cancel` | `confirm`> = (process.env.MD_DESKTOP_TEST_QUIT_RESPONSES ?? ``)
  .split(`,`)
  .map(s => s.trim().toLowerCase())
  .filter((s): s is `cancel` | `confirm` => s === `cancel` || s === `confirm`)

function sendAcpEventImmediate(event: AcpHostEvent): void {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC_CHANNELS.ACP_EVENT, event)
}

function broadcastAcpEvent(event: AcpHostEvent): void {
  if (acpEventBatcher)
    acpEventBatcher.push(event)
  else
    sendAcpEventImmediate(event)
}

function broadcastWeChatProgress(event: WeChatPublishProgressEvent): void {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC_CHANNELS.WECHAT_PUBLISH_PROGRESS, event)
}

function buildOptionalFakeAgents(): AcpAgentConfig[] {
  if (process.env.MD_DESKTOP_FAKE_AGENT !== `1`)
    return []

  const fakeScript = path.resolve(__dirname, `../../scripts/fake-acp-agent.mjs`)
  if (!fs.existsSync(fakeScript))
    return []

  return [
    {
      id: `fake-acp`,
      name: `Fake ACP Agent`,
      command: process.execPath,
      args: [fakeScript],
      env: {
        ELECTRON_RUN_AS_NODE: `1`,
        FAKE_AGENT_MODEL_STYLE: `both`,
        FAKE_AGENT_EMIT_COMMANDS: `1`,
      },
      detectBinaries: [process.execPath],
      builtin: true,
      avatar: { letter: `F`, color: `#5B5BD6` },
    },
  ]
}

function createMainWindow(): BrowserWindow {
  const isMac = process.platform === `darwin`
  const bg = nativeTheme.shouldUseDarkColors ? `#181817` : `#FBFAF7`

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: bg,
    titleBarStyle: isMac ? `hiddenInset` : `default`,
    ...(isMac ? { trafficLightPosition: { x: 18, y: 20 } } : {}),
    webPreferences: {
      preload: path.resolve(__dirname, `../preload/index.cjs`),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = isSafeExternalUrl(url)
    if (safeUrl)
      void shell.openExternal(safeUrl)
    return { action: `deny` }
  })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  }
  else {
    void win.loadURL(`${APP_SCHEME}://${APP_HOST}/`)
  }

  win.on(`close`, (event) => {
    quitGuard?.handleWindowClose(event)
  })

  win.on(`closed`, () => {
    if (mainWindow === win)
      mainWindow = null
  })

  return win
}

function registerIpc(host: AcpHost, publisher: WeChatPublisher): void {
  ipcMain.handle(IPC_CHANNELS.PICK_FILES, async () => {
    const owner = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined
    const options: Electron.OpenDialogOptions = {
      properties: [`openFile`, `multiSelections`],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled)
      return []
    return result.filePaths.map(filePath => ({
      path: filePath,
      name: path.basename(filePath),
    }))
  })

  ipcMain.handle(IPC_CHANNELS.PICK_IMAGE, async () => {
    const owner = mainWindow ?? BrowserWindow.getFocusedWindow() ?? undefined
    const options: Electron.OpenDialogOptions = {
      properties: [`openFile`],
      filters: [
        { name: `Images`, extensions: [`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`] },
      ],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0)
      return null

    const filePath = result.filePaths[0]
    publisher.allowLocalImagePath(filePath)
    const raw = await fs.promises.readFile(filePath)
    const mime = mimeForExtension(path.extname(filePath))
    return {
      path: filePath,
      name: path.basename(filePath),
      dataUrl: `data:${mime};base64,${raw.toString(`base64`)}`,
    }
  })

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url: string) => {
    const safeUrl = isSafeExternalUrl(url)
    if (safeUrl)
      await shell.openExternal(safeUrl)
  })

  ipcMain.handle(IPC_CHANNELS.SET_LOCALE, (_event, locale: string) => {
    quitGuard?.setLocale(locale)
  })

  ipcMain.handle(IPC_CHANNELS.WECHAT_PUBLISH, (_event, request: WeChatPublishRequest) =>
    publisher.publish(request))
  ipcMain.handle(IPC_CHANNELS.WECHAT_UPLOAD_IMAGE, (_event, request: WeChatUploadImageRequest) =>
    publisher.uploadImage(request))

  ipcMain.handle(IPC_CHANNELS.ACP_LIST_AGENTS, () => host.listAgents())
  ipcMain.handle(IPC_CHANNELS.ACP_DETECT_AGENTS, () => host.detectAgents())
  ipcMain.handle(IPC_CHANNELS.ACP_GET_SETTINGS, () => host.getSettings())
  ipcMain.handle(IPC_CHANNELS.ACP_UPDATE_SETTINGS, (_event, patch) => host.updateSettings(patch))
  ipcMain.handle(IPC_CHANNELS.ACP_ADD_CUSTOM_AGENT, (_event, agent) => host.addCustomAgent(agent))
  ipcMain.handle(IPC_CHANNELS.ACP_REMOVE_CUSTOM_AGENT, (_event, agentId) => host.removeCustomAgent(agentId))
  ipcMain.handle(IPC_CHANNELS.ACP_INSTALL_AGENT, (_event, agentId) => host.installAgent(agentId))
  ipcMain.handle(IPC_CHANNELS.ACP_CANCEL_INSTALL, (_event, agentId) => host.cancelInstall(agentId))
  ipcMain.handle(IPC_CHANNELS.ACP_PROBE_AGENT, (_event, agentId, options) => host.probeAgent(agentId, options))
  ipcMain.handle(IPC_CHANNELS.ACP_START_SESSION, (_event, params) => host.startSession(params))
  ipcMain.handle(IPC_CHANNELS.ACP_PROMPT, (_event, params) => host.prompt(params))
  ipcMain.handle(IPC_CHANNELS.ACP_CANCEL_TURN, (_event, sessionId) => host.cancelTurn(sessionId))
  ipcMain.handle(IPC_CHANNELS.ACP_SET_MODEL, (_event, params) => host.setModel(params))
  ipcMain.handle(IPC_CHANNELS.ACP_SET_THINKING_LEVEL, (_event, params) => host.setThinkingLevel(params))
  ipcMain.handle(IPC_CHANNELS.ACP_SET_PERMISSION_MODE, (_event, params) => host.setPermissionMode(params))
  ipcMain.handle(IPC_CHANNELS.ACP_RESPOND_PERMISSION, (_event, params) => host.respondPermission(params))
  ipcMain.handle(IPC_CHANNELS.ACP_CLOSE_SESSION, (_event, sessionId) => host.closeSession(sessionId))
}

app.whenReady().then(() => {
  if (!DEV_SERVER_URL)
    registerAppProtocol()

  acpEventBatcher = new AcpEventBatcher({
    batchMs: 16,
    onEmit: sendAcpEventImmediate,
  })
  acpHost = new AcpHost({
    dataDir: app.getPath(`userData`),
    extraBuiltinAgents: buildOptionalFakeAgents(),
    onEvent: broadcastAcpEvent,
  })
  wechatPublisher = new WeChatPublisher({
    onProgress: broadcastWeChatProgress,
  })
  quitGuard = new QuitGuard({
    getActiveSessions: () => acpHost?.getActiveSessions() ?? [],
    dispose: async () => {
      acpEventBatcher?.dispose()
      await acpHost?.dispose()
    },
    confirmQuit: async (copy) => {
      // Allow automated CDP smoke runs to drive cancel/confirm without a native OS sheet.
      if (testQuitResponses.length > 0) {
        const decision = testQuitResponses.shift()!
        console.log(`[md-desktop:quit-confirm] decision=${decision} title=${JSON.stringify(copy.title)} detail=${JSON.stringify(copy.detail)}`)
        return decision === `confirm`
      }
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      const options: Electron.MessageBoxOptions = {
        type: `warning`,
        buttons: [copy.cancelLabel, copy.confirmLabel],
        defaultId: 0,
        cancelId: 0,
        title: copy.title,
        message: copy.title,
        detail: copy.detail,
        noLink: true,
      }
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options)
      return result.response === 1
    },
    quitApp: () => app.quit(),
    forceExit: code => app.exit(code),
    getFallbackLocale: () => app.getLocale(),
    isSmokeRun: () => Number(process.env.MD_DESKTOP_SMOKE_EXIT_MS ?? 0) > 0,
    disposeTimeoutMs: QUIT_DISPOSE_TIMEOUT_MS,
  })
  registerIpc(acpHost, wechatPublisher)
  mainWindow = createMainWindow()

  if (process.platform === `win32`) {
    // Windows fires `session-end` on user logout / OS shutdown.
    (powerMonitor as NodeJS.EventEmitter).on(`session-end`, () => {
      quitGuard?.requestNonInteractiveQuit()
    })
  }
  else {
    powerMonitor.on(`shutdown`, () => {
      quitGuard?.requestNonInteractiveQuit()
    })
  }

  const smokeExitMs = Number(process.env.MD_DESKTOP_SMOKE_EXIT_MS ?? 0)
  if (smokeExitMs > 0) {
    mainWindow.webContents.once(`did-finish-load`, () => {
      console.log(`[md-desktop] window finished loading`)
      setTimeout(() => quitGuard?.requestNonInteractiveQuit(), smokeExitMs)
    })
  }

  // Register after app.whenReady() so libuv installs over Chromium's C signal handlers,
  // preventing SIGINT/SIGTERM from routing into the interactive before-quit confirmation.
  for (const signal of [`SIGINT`, `SIGTERM`] as const) {
    process.on(signal, () => {
      if (quitGuard)
        quitGuard.requestNonInteractiveQuit()
      else
        app.quit()
    })
  }

  // Automated test-only signals to trigger real main-process close / app.quit paths.
  if (testQuitResponses.length > 0 && process.platform !== `win32`) {
    process.on(`SIGUSR1`, () => {
      mainWindow?.close()
    })
    process.on(`SIGUSR2`, () => {
      app.quit()
    })
  }
})

app.on(`before-quit`, (event) => {
  quitGuard?.handleBeforeQuit(event)
})

app.on(`window-all-closed`, () => {
  app.quit()
})
