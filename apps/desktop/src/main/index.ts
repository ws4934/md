import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type {
  AcpAgentConfig,
  AcpHostEvent,
  DesktopImageGenConfigUpdate,
  DesktopIpCharacterUpdate,
  DesktopIpLibrary,
  DesktopListRemoteModelsParams,
  DesktopMarketplaceListParams,
  DesktopModelApiConfigUpdate,
  DesktopSkill,
  DesktopTestImageGenParams,
  DesktopUpdateState,
  WeChatPublishProgressEvent,
  WeChatPublishRequest,
  WeChatUploadImageRequest,
} from '@md/shared/types'
import type { UpdateInfo } from 'electron-updater'
import type { UpdateMode, UpdaterStateEvent } from './auto-update'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { API_MODEL_AGENT_ID, DEFAULT_PROTOCOL_BASE_URLS } from '@md/shared/types'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, powerMonitor, protocol, safeStorage, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { API_AGENT_MODES, API_THOUGHT_LEVEL_OPTIONS } from '../agents/api-agent/provider'
import { readSkills } from '../agents/shared/skills'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import {
  resolveEffectiveApiKey,
  validateAcpSettingsPatch,
  validateCustomAgentInput,
  validateIdArg,
  validateImageGenConfigUpdate,
  validateListRemoteModelsParams,
  validateLocaleArg,
  validateModelApiConfigUpdate,
  validateProbeOptions,
  validatePromptParams,
  validateReadWorkspaceImageParams,
  validateRespondPermissionParams,
  validateSetModelParams,
  validateSetPermissionModeParams,
  validateSetThinkingLevelParams,
  validateStartSessionParams,
  validateTestImageGenParams,
} from '../shared/ipc-validators'
import { AcpEventBatcher } from './acp/event-batcher'
import { AcpHost } from './acp/host'
import { AiConfigStore } from './ai/config-store'
import { ImageGenBridge } from './ai/image-bridge'
import { generateDesktopImage } from './ai/image-service'
import { resolveUnpackedAgentScript, resolveUnpackedSkillsDir } from './ai/paths'
import { fetchRemoteModels } from './ai/remote-models'
import { redactSecret } from './ai/sanitize'
import { APP_HOST, APP_SCHEME, isSafeExternalUrl, isTrustedRendererUrl, resolveAppProtocolTarget } from './app-protocol'
import {
  areUpdateStatesEqual,
  createInitialUpdateState,
  createUpdatePromptGate,
  readMacAutoInstallFlag,
  reduceUpdateState,
  releasePageUrl,
  resolveUpdateMode,
  UPDATE_COPY,
} from './auto-update'
import { IpCharacterStore } from './ip-characters'
import { createDesktopMarketplaceClient } from './marketplace'
import { QuitGuard } from './quit-guard'
import { SkillStore } from './skill-store'
import { mimeForExtension, WeChatPublisher } from './wechat/publisher'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEV_SERVER_URL = process.env.MD_DESKTOP_DEV_URL
const QUIT_DISPOSE_TIMEOUT_MS = 4_000
const UPDATE_FIRST_CHECK_DELAY_MS = 10_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_PICKED_IMAGE_BYTES = 10 * 1024 * 1024

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath)
    return true
  }
  catch {
    return false
  }
}

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
    try {
      return await net.fetch(pathToFileURL(resolved.filePath).toString())
    }
    catch {
      return new Response(`Not Found`, { status: 404 })
    }
  })
}

type UpdateCheckOrigin = `background` | `menu` | `settings`

type UpdateCheckOutcome
  = | { ok: true, info: UpdateInfo | null }
    | { ok: false, error: string }

interface InFlightUpdateCheck {
  promise: Promise<UpdateCheckOutcome>
  origins: Set<UpdateCheckOrigin>
}

let mainWindow: BrowserWindow | null = null
let acpHost: AcpHost | null = null
let acpEventBatcher: AcpEventBatcher | null = null
let aiConfigStore: AiConfigStore | null = null
let ipCharacterStore: IpCharacterStore | null = null
let imageGenBridge: ImageGenBridge | null = null
let wechatPublisher: WeChatPublisher | null = null
let quitGuard: QuitGuard | null = null
let updateMode: UpdateMode | null = null
let updateState: DesktopUpdateState = createInitialUpdateState(app.getVersion(), null)
let downloadedUpdateVersion: string | null = null
let installingUpdate = false
let inFlightUpdateCheck: InFlightUpdateCheck | null = null
let promptOnNextDownload = false
let restartPromptActive = false
let menuDownloadingDialogPromise: Promise<void> | null = null
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null
let updateIntervalTimer: ReturnType<typeof setInterval> | null = null
let smokeExitTimer: ReturnType<typeof setTimeout> | null = null
const shouldPromptUpdate = createUpdatePromptGate()

function clearBackgroundTimers(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer)
    updateStartupTimer = null
  }
  if (updateIntervalTimer) {
    clearInterval(updateIntervalTimer)
    updateIntervalTimer = null
  }
  if (smokeExitTimer) {
    clearTimeout(smokeExitTimer)
    smokeExitTimer = null
  }
}

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

function broadcastUpdateState(state: DesktopUpdateState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send(IPC_CHANNELS.UPDATES_STATE, state)
  }
}

function broadcastIpCharactersChanged(library: DesktopIpLibrary): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send(IPC_CHANNELS.IP_CHANGED, library)
  }
}

function broadcastSkillsChanged(skills: DesktopSkill[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send(IPC_CHANNELS.SKILLS_CHANGED, skills)
  }
}

function dispatchUpdateEvent(event: UpdaterStateEvent): void {
  const next = reduceUpdateState(updateState, event)
  if (areUpdateStatesEqual(updateState, next))
    return
  updateState = next
  broadcastUpdateState(next)
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

  // Block top-level navigations away from the app origin so external pages never inherit the preload bridge.
  win.webContents.on(`will-navigate`, (event, url) => {
    if (isTrustedRendererUrl(url, DEV_SERVER_URL))
      return
    event.preventDefault()
    const safeUrl = isSafeExternalUrl(url)
    if (safeUrl)
      void shell.openExternal(safeUrl)
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

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null || !isTrustedRendererUrl(frame.url, DEV_SERVER_URL))
    throw new Error(`Untrusted IPC sender`)
}

function handleTrustedIpc<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event)
    return handler(event, ...(args as TArgs))
  })
}

function registerIpc(
  host: AcpHost,
  publisher: WeChatPublisher,
  configStore: AiConfigStore,
  ipStore: IpCharacterStore,
  skills: SkillStore,
): void {
  handleTrustedIpc(IPC_CHANNELS.PICK_FILES, async () => {
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

  handleTrustedIpc(IPC_CHANNELS.PICK_IMAGE, async () => {
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
    const realPath = await fs.promises.realpath(filePath)
    const stat = await fs.promises.stat(realPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PICKED_IMAGE_BYTES)
      throw new Error(`Selected image must be a non-empty file <= 10 MB`)
    publisher.allowCanonicalLocalImagePath(realPath)
    const raw = await fs.promises.readFile(realPath)
    const mime = mimeForExtension(path.extname(realPath))
    return {
      path: filePath,
      name: path.basename(filePath),
      dataUrl: `data:${mime};base64,${raw.toString(`base64`)}`,
    }
  })

  handleTrustedIpc(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url: unknown) => {
    const safeUrl = isSafeExternalUrl(url)
    if (safeUrl)
      await shell.openExternal(safeUrl)
  })

  handleTrustedIpc(IPC_CHANNELS.SET_LOCALE, (_event, locale: unknown) => {
    const validLocale = validateLocaleArg(locale)
    const previousLocale = quitGuard?.locale
    quitGuard?.setLocale(validLocale)
    if (updateMode && quitGuard?.locale !== previousLocale)
      setAppMenu()
  })

  handleTrustedIpc(IPC_CHANNELS.WECHAT_PUBLISH, (_event, request: WeChatPublishRequest) =>
    publisher.publish(request))
  handleTrustedIpc(IPC_CHANNELS.WECHAT_UPLOAD_IMAGE, (_event, request: WeChatUploadImageRequest) =>
    publisher.uploadImage(request))

  handleTrustedIpc(IPC_CHANNELS.AI_GET_CONFIGS, () => configStore.getPublicConfigs())
  handleTrustedIpc(IPC_CHANNELS.AI_UPDATE_MODEL_API, (_event, patch: DesktopModelApiConfigUpdate) =>
    configStore.updateModelApiConfig(validateModelApiConfigUpdate(patch)))
  handleTrustedIpc(IPC_CHANNELS.AI_UPDATE_IMAGE_GEN, (_event, patch: DesktopImageGenConfigUpdate) =>
    configStore.updateImageGenConfig(validateImageGenConfigUpdate(patch)))
  handleTrustedIpc(IPC_CHANNELS.AI_LIST_REMOTE_MODELS, async (_event, rawParams: DesktopListRemoteModelsParams) => {
    const params = validateListRemoteModelsParams(rawParams)
    const saved = await configStore.getResolvedModelApiConfig()
    const requestedBaseUrl = params.baseUrl.trim() || DEFAULT_PROTOCOL_BASE_URLS[params.protocol]
    const apiKey = resolveEffectiveApiKey({
      explicitApiKey: params.apiKey,
      savedApiKey: saved.apiKey,
      requestedBaseUrl,
      savedBaseUrl: saved.baseUrl,
    })
    return fetchRemoteModels({
      protocol: params.protocol,
      baseUrl: requestedBaseUrl,
      apiKey,
    })
  })
  handleTrustedIpc(IPC_CHANNELS.AI_TEST_IMAGE_GEN, async (_event, rawParams?: DesktopTestImageGenParams) => {
    let usedApiKey = ``
    try {
      const params = validateTestImageGenParams(rawParams)
      const saved = await configStore.getResolvedImageGenConfig()
      const baseUrl = params?.baseUrl?.trim() || saved.baseUrl
      const apiKey = resolveEffectiveApiKey({
        explicitApiKey: params?.apiKey,
        savedApiKey: saved.apiKey,
        requestedBaseUrl: baseUrl,
        savedBaseUrl: saved.baseUrl,
      })
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

  handleTrustedIpc(IPC_CHANNELS.ACP_LIST_AGENTS, () => host.listAgents())
  handleTrustedIpc(IPC_CHANNELS.ACP_DETECT_AGENTS, () => host.detectAgents())
  handleTrustedIpc(IPC_CHANNELS.ACP_GET_SETTINGS, () => host.getSettings())
  handleTrustedIpc(IPC_CHANNELS.ACP_UPDATE_SETTINGS, (_event, patch) =>
    host.updateSettings(validateAcpSettingsPatch(patch)))
  handleTrustedIpc(IPC_CHANNELS.ACP_ADD_CUSTOM_AGENT, (_event, agent) =>
    host.addCustomAgent(validateCustomAgentInput(agent)))
  handleTrustedIpc(IPC_CHANNELS.ACP_REMOVE_CUSTOM_AGENT, (_event, agentId) =>
    host.removeCustomAgent(validateIdArg(agentId, `agentId`)))
  handleTrustedIpc(IPC_CHANNELS.ACP_INSTALL_AGENT, (_event, agentId) =>
    host.installAgent(validateIdArg(agentId, `agentId`)))
  handleTrustedIpc(IPC_CHANNELS.ACP_CANCEL_INSTALL, (_event, agentId) =>
    host.cancelInstall(validateIdArg(agentId, `agentId`)))
  handleTrustedIpc(IPC_CHANNELS.ACP_PROBE_AGENT, (_event, agentId, options) =>
    host.probeAgent(validateIdArg(agentId, `agentId`), validateProbeOptions(options)))
  handleTrustedIpc(IPC_CHANNELS.ACP_START_SESSION, (_event, params) =>
    host.startSession(validateStartSessionParams(params)))
  handleTrustedIpc(IPC_CHANNELS.ACP_PROMPT, (_event, params) =>
    host.prompt(validatePromptParams(params)))
  handleTrustedIpc(IPC_CHANNELS.ACP_CANCEL_TURN, (_event, sessionId) =>
    host.cancelTurn(validateIdArg(sessionId, `sessionId`)))
  handleTrustedIpc(IPC_CHANNELS.ACP_SET_MODEL, (_event, params) =>
    host.setModel(validateSetModelParams(params)))
  handleTrustedIpc(IPC_CHANNELS.ACP_SET_THINKING_LEVEL, (_event, params) =>
    host.setThinkingLevel(validateSetThinkingLevelParams(params)))
  handleTrustedIpc(IPC_CHANNELS.ACP_SET_PERMISSION_MODE, (_event, params) =>
    host.setPermissionMode(validateSetPermissionModeParams(params)))
  handleTrustedIpc(IPC_CHANNELS.ACP_RESPOND_PERMISSION, (_event, params) =>
    host.respondPermission(validateRespondPermissionParams(params)))
  handleTrustedIpc(IPC_CHANNELS.ACP_CLOSE_SESSION, (_event, sessionId) =>
    host.closeSession(validateIdArg(sessionId, `sessionId`)))
  handleTrustedIpc(IPC_CHANNELS.ACP_READ_WORKSPACE_IMAGE, (_event, params) =>
    host.readWorkspaceImage(validateReadWorkspaceImageParams(params)))

  handleTrustedIpc(IPC_CHANNELS.UPDATES_GET_STATE, () => updateState)
  handleTrustedIpc(IPC_CHANNELS.UPDATES_CHECK, () => checkForUpdates(`settings`))
  handleTrustedIpc(IPC_CHANNELS.UPDATES_INSTALL, () => {
    if (updateMode !== `install` || updateState.status !== `downloaded`)
      return
    quitAndInstallThroughGuard()
  })

  const marketplaceClient = createDesktopMarketplaceClient({
    apiUrl: process.env.MD_MARKETPLACE_API_URL,
  })
  handleTrustedIpc(IPC_CHANNELS.MARKETPLACE_LIST_THEMES, (_event, params: DesktopMarketplaceListParams | undefined) =>
    marketplaceClient.listThemes(params))
  handleTrustedIpc(IPC_CHANNELS.MARKETPLACE_GET_ITEM, (_event, id: string) =>
    marketplaceClient.getItem(id))
  handleTrustedIpc(IPC_CHANNELS.MARKETPLACE_INSTALL_ITEM, (_event, id: string) =>
    marketplaceClient.installItem(id))

  handleTrustedIpc(IPC_CHANNELS.IP_LIST, () => ipStore.list())
  handleTrustedIpc(IPC_CHANNELS.IP_UPDATE, (_event, id: string, patch: DesktopIpCharacterUpdate) =>
    ipStore.update(id, patch))
  handleTrustedIpc(IPC_CHANNELS.IP_SET_DEFAULT, (_event, id: string | null) =>
    ipStore.setDefault(id))
  handleTrustedIpc(IPC_CHANNELS.IP_REMOVE, (_event, id: string) =>
    ipStore.remove(id))
  handleTrustedIpc(IPC_CHANNELS.IP_READ_IMAGE, (_event, id: string) =>
    ipStore.readImage(id))

  handleTrustedIpc(IPC_CHANNELS.SKILLS_LIST, () => skills.list())
  handleTrustedIpc(IPC_CHANNELS.SKILLS_READ, (_event, name: string) => skills.read(name))
  handleTrustedIpc(IPC_CHANNELS.SKILLS_SAVE, (_event, name: string, content: string) =>
    skills.save(name, content))
  handleTrustedIpc(IPC_CHANNELS.SKILLS_CREATE, (_event, name: string) => skills.create(name))
  handleTrustedIpc(IPC_CHANNELS.SKILLS_REMOVE, (_event, name: string) => skills.remove(name))
  handleTrustedIpc(IPC_CHANNELS.SKILLS_RESET, (_event, name: string) => skills.reset(name))
  handleTrustedIpc(IPC_CHANNELS.SKILLS_KEEP_MODIFIED, (_event, name: string) => skills.keepModified(name))
  handleTrustedIpc(IPC_CHANNELS.SKILLS_SET_ENABLED, (_event, name: string, enabled: boolean) =>
    skills.setEnabled(name, enabled))
}

function updateCopy() {
  return UPDATE_COPY[quitGuard?.locale ?? `en-US`]
}

async function showUpdateMessage(type: `info` | `error`, message: string, detail: string, buttons: string[]): Promise<number> {
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const options: Electron.MessageBoxOptions = {
    type,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    title: message,
    message,
    detail,
    noLink: true,
  }
  const { response } = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return response
}

function quitAndInstallThroughGuard(): void {
  // Same confirm/dispose path as a normal quit; installing only starts once agents are shut down.
  quitGuard?.requestQuit(() => {
    installingUpdate = true
    autoUpdater.quitAndInstall()
  })
}

async function promptRestartToUpdate(version: string): Promise<void> {
  if (menuDownloadingDialogPromise)
    await menuDownloadingDialogPromise.catch(() => undefined)
  if (restartPromptActive)
    return
  restartPromptActive = true
  try {
    const copy = updateCopy()
    const response = await showUpdateMessage(`info`, copy.downloaded(version), copy.downloadedDetail, [copy.restartNow, copy.later])
    if (response !== 0)
      return
    quitAndInstallThroughGuard()
  }
  finally {
    restartPromptActive = false
  }
}

async function promptDownloadUpdate(version: string, fileUrl: string | undefined): Promise<void> {
  const page = releasePageUrl(fileUrl)
  if (!page) {
    console.warn(`[md-desktop:update] cannot derive a release page from ${fileUrl}`)
    return
  }
  const copy = updateCopy()
  const response = await showUpdateMessage(`info`, copy.available(version), copy.availableDetail, [copy.download, copy.later])
  if (response === 0)
    await shell.openExternal(page)
}

async function showDownloadingDialog(version: string): Promise<void> {
  const copy = updateCopy()
  const p = showUpdateMessage(`info`, copy.downloading(version), copy.downloadingDetail, [copy.ok]).then(() => undefined)
  menuDownloadingDialogPromise = p
  try {
    await p
  }
  finally {
    if (menuDownloadingDialogPromise === p)
      menuDownloadingDialogPromise = null
  }
}

async function checkForUpdates(origin: UpdateCheckOrigin): Promise<DesktopUpdateState> {
  if (!updateMode)
    return updateState

  // Once an update is already staged on disk, never clobber its state or restart Squirrel.Mac's local feed.
  if (updateState.status === `downloaded`) {
    const readyVersion = downloadedUpdateVersion ?? updateState.version
    if (origin === `menu` && readyVersion) {
      shouldPromptUpdate(readyVersion, true)
      await promptRestartToUpdate(readyVersion)
    }
    return updateState
  }

  // Avoid starting duplicate concurrent downloads while an installer is already downloading.
  if (updateState.status === `downloading`) {
    if (origin === `menu` && updateState.version) {
      promptOnNextDownload = true
      await showDownloadingDialog(updateState.version)
    }
    return updateState
  }

  // Avoid queuing duplicate native dialogs if the menu item is clicked again while a menu check is in flight.
  if (origin === `menu` && inFlightUpdateCheck?.origins.has(`menu`)) {
    await inFlightUpdateCheck.promise
    return updateState
  }

  let active = inFlightUpdateCheck
  if (!active) {
    const origins = new Set<UpdateCheckOrigin>([origin])
    const promise = (async (): Promise<UpdateCheckOutcome> => {
      try {
        const result = await autoUpdater.checkForUpdates()
        // Download failures are already reported through the `error` event.
        void result?.downloadPromise?.catch(() => undefined)
        const info = result?.isUpdateAvailable ? result.updateInfo : null
        return { ok: true, info }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        dispatchUpdateEvent({ type: `error`, message })
        return { ok: false, error: message }
      }
      finally {
        if (inFlightUpdateCheck?.origins === origins)
          inFlightUpdateCheck = null
      }
    })()
    active = { promise, origins }
    inFlightUpdateCheck = active
  }
  else {
    active.origins.add(origin)
  }

  const outcome = await active.promise
  const copy = updateCopy()

  if (!outcome.ok) {
    if (origin === `menu`)
      await showUpdateMessage(`error`, copy.checkFailed, outcome.error, [copy.ok])
    else if (origin === `background`)
      console.warn(`[md-desktop:update] background check failed: ${outcome.error}`)
    return updateState
  }

  const info = outcome.info
  if (!info) {
    if (origin === `menu`)
      await showUpdateMessage(`info`, copy.upToDate, copy.upToDateDetail(app.getVersion()), [copy.ok])
    return updateState
  }

  if (updateMode === `notify`) {
    if (origin === `settings`) {
      if (!active.origins.has(`menu`))
        shouldPromptUpdate(info.version, false)
    }
    else if (origin === `menu`) {
      if (shouldPromptUpdate(info.version, true))
        await promptDownloadUpdate(info.version, info.files[0]?.url)
    }
    else if (!active.origins.has(`menu`) && !active.origins.has(`settings`)) {
      if (shouldPromptUpdate(info.version, false))
        await promptDownloadUpdate(info.version, info.files[0]?.url)
    }
    return updateState
  }

  if (origin === `settings`) {
    if (!active.origins.has(`menu`))
      shouldPromptUpdate(info.version, false)
  }
  else if (origin === `menu`) {
    if (downloadedUpdateVersion === info.version) {
      promptOnNextDownload = false
      shouldPromptUpdate(info.version, true)
      await promptRestartToUpdate(info.version)
    }
    else {
      promptOnNextDownload = true
      await showDownloadingDialog(info.version)
    }
  }

  return updateState
}

/** Electron's default menu plus "Check for Updates…" in the app menu (macOS) or Help menu. */
function setAppMenu(): void {
  const isMac = process.platform === `darwin`
  const checkItem: Electron.MenuItemConstructorOptions = {
    label: updateCopy().menuLabel,
    click: () => void checkForUpdates(`menu`),
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: `fileMenu` },
    { role: `editMenu` },
    { role: `viewMenu` },
    { role: `windowMenu` },
    { role: `help`, submenu: isMac ? [] : [checkItem] },
  ]
  if (isMac) {
    template.unshift({
      role: `appMenu`,
      submenu: [
        { role: `about` },
        checkItem,
        { type: `separator` },
        { role: `services` },
        { type: `separator` },
        { role: `hide` },
        { role: `hideOthers` },
        { role: `unhide` },
        { type: `separator` },
        { role: `quit` },
      ],
    })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function startAutoUpdate(mode: UpdateMode): void {
  updateMode = mode
  updateState = createInitialUpdateState(app.getVersion(), mode)
  autoUpdater.autoDownload = mode === `install`
  autoUpdater.on(`checking-for-update`, () => {
    dispatchUpdateEvent({ type: `checking` })
  })
  autoUpdater.on(`update-available`, (info) => {
    dispatchUpdateEvent({
      type: `available`,
      version: info.version,
      fileUrl: info.files[0]?.url,
    })
    // Mark as surfaced before the download completes so settings-triggered checks stay inline.
    if (inFlightUpdateCheck?.origins.has(`settings`) && !inFlightUpdateCheck.origins.has(`menu`))
      shouldPromptUpdate(info.version, false)
  })
  autoUpdater.on(`update-not-available`, () => {
    promptOnNextDownload = false
    dispatchUpdateEvent({ type: `not-available` })
  })
  autoUpdater.on(`download-progress`, (progress) => {
    dispatchUpdateEvent({ type: `download-progress`, percent: progress.percent })
  })
  autoUpdater.on(`update-downloaded`, (info) => {
    downloadedUpdateVersion = info.version
    dispatchUpdateEvent({ type: `downloaded`, version: info.version })
    // If a menu check is still awaiting the same run, it will show the restart dialog directly.
    if (inFlightUpdateCheck?.origins.has(`menu`))
      return
    const forcePrompt = promptOnNextDownload
    promptOnNextDownload = false
    if (shouldPromptUpdate(info.version, forcePrompt))
      void promptRestartToUpdate(info.version)
  })
  autoUpdater.on(`error`, (error) => {
    promptOnNextDownload = false
    dispatchUpdateEvent({
      type: `error`,
      message: error instanceof Error ? error.message : String(error),
    })
    // The quit guard already disposed the agents, so quit rather than linger half shut down.
    if (installingUpdate)
      app.quit()
  })
  setAppMenu()
  updateStartupTimer = setTimeout(() => void checkForUpdates(`background`), UPDATE_FIRST_CHECK_DELAY_MS)
  updateStartupTimer.unref?.()
  updateIntervalTimer = setInterval(() => void checkForUpdates(`background`), UPDATE_CHECK_INTERVAL_MS)
  updateIntervalTimer.unref?.()
}

app.whenReady().then(async () => {
  if (!DEV_SERVER_URL)
    registerAppProtocol()

  const userDataDir = app.getPath(`userData`)
  const apiAgentScript = resolveUnpackedAgentScript(__dirname, `api-agent.js`)
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

  ipCharacterStore = new IpCharacterStore({
    dir: path.join(userDataDir, `ip-characters`),
  })
  const unsubscribeIpCharacters = ipCharacterStore.onChange((library) => {
    broadcastIpCharactersChanged(library)
    void acpHost?.refreshIpSnapshots()
  })

  const skillStore = new SkillStore({
    bundledDir: resolveUnpackedSkillsDir(__dirname),
    dataDir: userDataDir,
  })
  const unsubscribeSkills = skillStore.onChange((skills) => {
    broadcastSkillsChanged(skills)
    // Running sessions keep the skills they started with; new sessions and probes copy the new set.
    acpHost?.invalidateAgentProbe()
  })
  try {
    await skillStore.materialize()
  }
  catch (error) {
    console.warn(`[skills] failed to build the effective skill set:`, error)
  }
  const skillsDir = skillStore.effectiveDir

  acpEventBatcher = new AcpEventBatcher({
    batchMs: 16,
    onEmit: sendAcpEventImmediate,
  })
  acpHost = new AcpHost({
    dataDir: userDataDir,
    appVersion: app.getVersion(),
    skillsDir,
    ipCharacters: ipCharacterStore,
    extraBuiltinAgents: buildExtraBuiltinAgents(),
    resolveAgentAvailability: async (agentId) => {
      if (agentId !== API_MODEL_AGENT_ID)
        return null
      if (!(await fileExists(apiAgentScript)))
        return false
      return aiConfigStore!.isModelApiConfigured()
    },
    resolveDirectProbe: async (agentId) => {
      if (agentId !== API_MODEL_AGENT_ID)
        return null
      if (!(await fileExists(apiAgentScript)))
        return null
      const { modelApi } = await aiConfigStore!.getPublicConfigs()
      if (!modelApi.hasApiKey || modelApi.enabledModels.length === 0)
        return null
      const currentModelId = modelApi.defaultModel && modelApi.enabledModels.includes(modelApi.defaultModel)
        ? modelApi.defaultModel
        : modelApi.enabledModels[0]
      const skills = await readSkills([skillsDir])
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
        commands: skills.map(s => ({ name: s.name, description: s.description })),
        commandsAnnounced: true,
        probedAt: Date.now(),
      }
    },
    resolveAgentRuntimeEnv: async (agentId) => {
      if (agentId !== API_MODEL_AGENT_ID)
        return undefined
      const resolved = await aiConfigStore!.getResolvedModelApiConfig()
      if (!resolved.isConfigured)
        throw new Error(`API Model is not configured. Open Settings > Model API to add your key and enable at least one model.`)
      return {
        ELECTRON_RUN_AS_NODE: `1`,
        MD_API_AGENT_CONFIG: JSON.stringify({
          protocol: resolved.protocol,
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          enabledModels: resolved.enabledModels,
          defaultModel: resolved.defaultModel,
        }),
      }
    },
    resolveSessionMcpServers: async (_agentId, workspaceDir): Promise<McpServer[]> => {
      if (!(await fileExists(imageMcpScript)) || !(await aiConfigStore!.isImageGenConfigured()))
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
      clearBackgroundTimers()
      unsubscribeIpCharacters()
      unsubscribeSkills()
      try {
        await acpHost?.dispose()
      }
      finally {
        acpEventBatcher?.dispose()
      }
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
  const smokeExitMs = Number(process.env.MD_DESKTOP_SMOKE_EXIT_MS ?? 0)
  const mode = resolveUpdateMode({
    isPackaged: app.isPackaged,
    isSmokeRun: smokeExitMs > 0,
    platform: process.platform,
    isAppImage: Boolean(process.env.APPIMAGE),
    macAutoInstall: readMacAutoInstallFlag(app.getAppPath()),
  })
  updateMode = mode
  updateState = createInitialUpdateState(app.getVersion(), mode)

  registerIpc(acpHost, wechatPublisher, aiConfigStore, ipCharacterStore, skillStore)
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

  if (smokeExitMs > 0) {
    mainWindow.webContents.once(`did-finish-load`, () => {
      console.log(`[md-desktop] window finished loading`)
      smokeExitTimer = setTimeout(() => quitGuard?.requestNonInteractiveQuit(), smokeExitMs)
      smokeExitTimer.unref?.()
    })
  }

  if (mode)
    startAutoUpdate(mode)

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
  if (!installingUpdate)
    app.quit()
})
