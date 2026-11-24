import type { AcpAgentConfig, AcpHostEvent, WeChatPublishProgressEvent, WeChatPublishRequest } from '@md/shared/types'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { AcpHost } from './acp/host'
import { mimeForExtension, WeChatPublisher } from './wechat/publisher'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const APP_SCHEME = `app`
const APP_HOST = `md`
const DEV_SERVER_URL = process.env.MD_DESKTOP_DEV_URL

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
  const resolvedRoot = path.resolve(rendererDir)

  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === `/` || pathname === ``)
      pathname = `/index.html`

    const candidate = path.resolve(resolvedRoot, `.${pathname}`)
    // Prevent escaping the renderer dist directory via crafted URLs.
    if (!candidate.startsWith(resolvedRoot))
      return new Response(`Forbidden`, { status: 403 })

    const target = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(resolvedRoot, `index.html`)

    return net.fetch(pathToFileURL(target).toString())
  })
}

let mainWindow: BrowserWindow | null = null
let acpHost: AcpHost | null = null
let wechatPublisher: WeChatPublisher | null = null

function broadcastAcpEvent(event: AcpHostEvent): void {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC_CHANNELS.ACP_EVENT, event)
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
    if (/^https?:\/\//i.test(url))
      void shell.openExternal(url)
    return { action: `deny` }
  })

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL)
  }
  else {
    void win.loadURL(`${APP_SCHEME}://${APP_HOST}/`)
  }

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
    const raw = await fs.promises.readFile(filePath)
    const mime = mimeForExtension(path.extname(filePath))
    return {
      path: filePath,
      name: path.basename(filePath),
      dataUrl: `data:${mime};base64,${Buffer.from(raw).toString(`base64`)}`,
    }
  })

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url === `string` && /^https?:\/\//i.test(url.trim()))
      await shell.openExternal(url.trim())
  })

  ipcMain.handle(IPC_CHANNELS.WECHAT_PUBLISH, (_event, request: WeChatPublishRequest) =>
    publisher.publish(request))

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
  ipcMain.handle(IPC_CHANNELS.ACP_RESPOND_PERMISSION, (_event, params) => host.respondPermission(params))
  ipcMain.handle(IPC_CHANNELS.ACP_CLOSE_SESSION, (_event, sessionId) => host.closeSession(sessionId))
}

app.whenReady().then(() => {
  if (!DEV_SERVER_URL)
    registerAppProtocol()

  acpHost = new AcpHost({
    dataDir: app.getPath(`userData`),
    extraBuiltinAgents: buildOptionalFakeAgents(),
    onEvent: broadcastAcpEvent,
  })
  wechatPublisher = new WeChatPublisher({
    onProgress: broadcastWeChatProgress,
  })
  registerIpc(acpHost, wechatPublisher)
  mainWindow = createMainWindow()

  const smokeExitMs = Number(process.env.MD_DESKTOP_SMOKE_EXIT_MS ?? 0)
  if (smokeExitMs > 0) {
    mainWindow.webContents.once(`did-finish-load`, () => {
      console.log(`[md-desktop] window finished loading`)
      setTimeout(() => app.quit(), smokeExitMs)
    })
  }

  app.on(`activate`, () => {
    if (BrowserWindow.getAllWindows().length === 0)
      mainWindow = createMainWindow()
  })
})

let isQuitting = false

app.on(`before-quit`, (event) => {
  if (isQuitting || !acpHost)
    return
  isQuitting = true
  event.preventDefault()
  void acpHost.dispose().finally(() => {
    app.quit()
  })
})

app.on(`window-all-closed`, () => {
  if (process.platform !== `darwin`)
    app.quit()
})
