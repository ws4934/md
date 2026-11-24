import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'

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

function registerBaseIpc(): void {
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
}

app.whenReady().then(() => {
  if (!DEV_SERVER_URL)
    registerAppProtocol()

  registerBaseIpc()
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

app.on(`window-all-closed`, () => {
  if (process.platform !== `darwin`)
    app.quit()
})
