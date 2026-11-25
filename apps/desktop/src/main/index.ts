import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type {
  AcpAgentConfig,
  AcpHostEvent,
  DesktopImageGenConfigUpdate,
  DesktopListRemoteModelsParams,
  DesktopModelApiConfigUpdate,
  DesktopTestImageGenParams,
  WeChatPublishProgressEvent,
  WeChatPublishRequest,
  WeChatUploadImageRequest,
} from '@md/shared/types'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { API_MODEL_AGENT_ID } from '@md/shared/types'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, powerMonitor, protocol, safeStorage, shell } from 'electron'
import { API_AGENT_MODES, API_THOUGHT_LEVEL_OPTIONS } from '../agents/api-agent/provider'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { AcpEventBatcher } from './acp/event-batcher'
import { AcpHost } from './acp/host'
import { AiConfigStore } from './ai/config-store'
import { ImageGenBridge } from './ai/image-bridge'
import { generateDesktopImage } from './ai/image-service'
import { resolveUnpackedAgentScript } from './ai/paths'
import { fetchRemoteModels } from './ai/remote-models'
import { redactSecret } from './ai/sanitize'
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
let aiConfigStore: AiConfigStore | null = null
let imageGenBridge: ImageGenBridge | null = null
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

function buildExtraBuiltinAgents(): AcpAgentConfig[] {
  const agents: AcpAgentConfig[] = []
  const apiAgentScript = resolveUnpackedAgentScript(__dirname, `api-agent.js`)
  if (fs.existsSync(apiAgentScript)) {
    agents.push({
      id: API_MODEL_AGENT_ID,
      name: `API Model`,
      command: process.execPath,
      args: [apiAgentScript],
      // Keep API secrets out of AcpAgentConfig.env (which is sent to the renderer in AcpAgentStatus).
      env: { ELECTRON_RUN_AS_NODE: `1` },
      detectBinaries: [process.execPath],
      builtin: true,
      avatar: { letter: `M`, color: `#0284C7` },
    })
  }

  if (process.env.MD_DESKTOP_FAKE_AGENT === `1`) {
    const fakeScript = path.resolve(__dirname, `../../scripts/fake-acp-agent.mjs`)
    if (fs.existsSync(fakeScript)) {
      agents.push({
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
      })
    }
  }

  return agents
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

function registerIpc(host: AcpHost, publisher: WeChatPublisher, configStore: AiConfigStore): void {
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

  ipcMain.handle(IPC_CHANNELS.AI_GET_CONFIGS, () => configStore.getPublicConfigs())
  ipcMain.handle(IPC_CHANNELS.AI_UPDATE_MODEL_API, (_event, patch: DesktopModelApiConfigUpdate) =>
    configStore.updateModelApiConfig(patch))
  ipcMain.handle(IPC_CHANNELS.AI_UPDATE_IMAGE_GEN, (_event, patch: DesktopImageGenConfigUpdate) =>
    configStore.updateImageGenConfig(patch))
  ipcMain.handle(IPC_CHANNELS.AI_LIST_REMOTE_MODELS, async (_event, params: DesktopListRemoteModelsParams) => {
    const saved = await configStore.getResolvedModelApiConfig()
    const apiKey = params.apiKey?.trim() || saved.apiKey
    return fetchRemoteModels({
      protocol: params.protocol,
      baseUrl: params.baseUrl,
      apiKey,
    })
  })
  ipcMain.handle(IPC_CHANNELS.AI_TEST_IMAGE_GEN, async (_event, params?: DesktopTestImageGenParams) => {
    let usedApiKey = ``
    try {
      const saved = await configStore.getResolvedImageGenConfig()
      const baseUrl = params?.baseUrl?.trim() || saved.baseUrl
      const apiKey = params?.apiKey?.trim() || saved.apiKey
      usedApiKey = apiKey
      const model = params?.model?.trim() || saved.model
      const size = params?.size?.trim() || saved.size
      const quality = params?.quality?.trim() || saved.quality
      const prompt = params?.prompt?.trim() || `A minimal flat editorial illustration of a warm desk lamp lighting an open notebook, clean composition`

      const generated = await generateDesktopImage({
        baseUrl,
        apiKey,
        model,
        prompt,
        size,
        quality,
      })
      return {
        ok: true,
        mimeType: generated.mimeType,
        dataUrl: `data:${generated.mimeType};base64,${generated.base64}`,
      }
    }
    catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: redactSecret(rawMessage, usedApiKey),
      }
    }
  })

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
  ipcMain.handle(IPC_CHANNELS.ACP_READ_WORKSPACE_IMAGE, (_event, params) => host.readWorkspaceImage(params))
}

app.whenReady().then(() => {
  if (!DEV_SERVER_URL)
    registerAppProtocol()

  const userDataDir = app.getPath(`userData`)
  const imageMcpScript = resolveUnpackedAgentScript(__dirname, `image-mcp.js`)

  aiConfigStore = new AiConfigStore({
    configPath: path.join(userDataDir, `ai-config.json`),
    cipher: safeStorage,
    onChange: (scope) => {
      if (scope === `modelApi`) {
        acpHost?.invalidateAgentProbe(API_MODEL_AGENT_ID)
        void acpHost?.refreshAgentAvailability()
      }
    },
  })
  imageGenBridge = new ImageGenBridge({
    getConfig: () => aiConfigStore!.getResolvedImageGenConfig(),
  })

  acpEventBatcher = new AcpEventBatcher({
    batchMs: 16,
    onEmit: sendAcpEventImmediate,
  })
  acpHost = new AcpHost({
    dataDir: userDataDir,
    extraBuiltinAgents: buildExtraBuiltinAgents(),
    resolveAgentAvailability: async (agentId) => {
      if (agentId !== API_MODEL_AGENT_ID)
        return null
      return aiConfigStore!.isModelApiConfigured()
    },
    resolveDirectProbe: async (agentId) => {
      if (agentId !== API_MODEL_AGENT_ID)
        return null
      const { modelApi } = await aiConfigStore!.getPublicConfigs()
      if (!modelApi.hasApiKey || modelApi.enabledModels.length === 0)
        return null
      const currentModelId = modelApi.defaultModel && modelApi.enabledModels.includes(modelApi.defaultModel)
        ? modelApi.defaultModel
        : modelApi.enabledModels[0]
      return {
        agentId: API_MODEL_AGENT_ID,
        models: modelApi.enabledModels.map(id => ({
          id,
          name: id,
          isDefault: id === currentModelId,
        })),
        currentModelId,
        thinkingOptions: API_THOUGHT_LEVEL_OPTIONS.map(o => ({
          id: o.value,
          name: o.name,
        })),
        currentThinkingLevel: `default`,
        modes: API_AGENT_MODES.map(m => ({ ...m })),
        currentModeId: `default`,
        commands: [],
        probedAt: Date.now(),
      }
    },
    resolveAgentRuntimeEnv: async (agentId, context) => {
      if (agentId !== API_MODEL_AGENT_ID)
        return undefined
      const resolved = await aiConfigStore!.getResolvedModelApiConfig()
      if (!resolved.isConfigured)
        throw new Error(`API Model is not configured. Open Settings > Model API to add your key and enable at least one model.`)
      const env: Record<string, string> = {
        ELECTRON_RUN_AS_NODE: `1`,
        MD_API_AGENT_CONFIG: JSON.stringify({
          protocol: resolved.protocol,
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          enabledModels: resolved.enabledModels,
          defaultModel: resolved.defaultModel,
        }),
      }
      if (!context.forProbe && await aiConfigStore!.isImageGenConfigured()) {
        const bridge = await imageGenBridge!.ensureStarted()
        env.MD_IMAGE_BRIDGE_URL = bridge.url
        env.MD_IMAGE_BRIDGE_TOKEN = bridge.token
      }
      return env
    },
    resolveSessionMcpServers: async (agentId, workspaceDir): Promise<McpServer[]> => {
      // The built-in API agent calls the local image bridge directly without MCP overhead.
      if (agentId === API_MODEL_AGENT_ID)
        return []
      if (!fs.existsSync(imageMcpScript) || !(await aiConfigStore!.isImageGenConfigured()))
        return []
      const bridge = await imageGenBridge!.ensureStarted()
      return [
        {
          name: `md-image`,
          command: process.execPath,
          args: [imageMcpScript],
          env: [
            { name: `ELECTRON_RUN_AS_NODE`, value: `1` },
            { name: `MD_IMAGE_BRIDGE_URL`, value: bridge.url },
            { name: `MD_IMAGE_BRIDGE_TOKEN`, value: bridge.token },
            { name: `MD_WORKSPACE_DIR`, value: workspaceDir },
          ],
        },
      ]
    },
    isImageGenConfigured: () => aiConfigStore!.isImageGenConfigured(),
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
      await imageGenBridge?.close()
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
  registerIpc(acpHost, wechatPublisher, aiConfigStore)
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
