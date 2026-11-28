import type {
  AcpHostEvent,
  AcpPermissionDecision,
  AcpPromptParams,
  AcpSettings,
  AcpStartSessionParams,
  DesktopBridge,
  DesktopImageGenConfigUpdate,
  DesktopIpCharacterUpdate,
  DesktopIpLibrary,
  DesktopListRemoteModelsParams,
  DesktopMarketplaceListParams,
  DesktopModelApiConfigUpdate,
  DesktopSkill,
  DesktopTestImageGenParams,
  DesktopTestWebSearchParams,
  DesktopUpdateState,
  DesktopWebSearchConfigUpdate,
  WeChatPublishProgressEvent,
  WeChatPublishRequest,
  WeChatUploadImageRequest,
} from '@md/shared/types'
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'

// Sandboxed Electron preload exposes global `process` without allowing `node:process` imports.
// eslint-disable-next-line node/prefer-global/process
const hostPlatform = typeof process !== `undefined` ? process.platform : `unknown`

function subscribeChannel<T>(channel: string, listener: (payload: T) => void): () => void {
  if (typeof listener !== `function`)
    throw new TypeError(`Listener must be a function`)
  const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: T) => {
    listener(payload)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const desktopBridge: DesktopBridge = {
  isDesktop: true,
  platform: hostPlatform,
  pickFiles: () => ipcRenderer.invoke(IPC_CHANNELS.PICK_FILES),
  pickImage: () => ipcRenderer.invoke(IPC_CHANNELS.PICK_IMAGE),
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  setLocale: (locale: string) => ipcRenderer.invoke(IPC_CHANNELS.SET_LOCALE, locale),
  wechat: {
    publish: (request: WeChatPublishRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.WECHAT_PUBLISH, request),
    uploadImage: (request: WeChatUploadImageRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.WECHAT_UPLOAD_IMAGE, request),
    onProgress: (listener: (event: WeChatPublishProgressEvent) => void) =>
      subscribeChannel(IPC_CHANNELS.WECHAT_PUBLISH_PROGRESS, listener),
  },
  ai: {
    getConfigs: () => ipcRenderer.invoke(IPC_CHANNELS.AI_GET_CONFIGS),
    updateModelApiConfig: (patch: DesktopModelApiConfigUpdate) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_UPDATE_MODEL_API, patch),
    updateImageGenConfig: (patch: DesktopImageGenConfigUpdate) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_UPDATE_IMAGE_GEN, patch),
    listRemoteModels: (params: DesktopListRemoteModelsParams) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_LIST_REMOTE_MODELS, params),
    testImageGen: (params?: DesktopTestImageGenParams) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_TEST_IMAGE_GEN, params),
    updateWebSearchConfig: (patch: DesktopWebSearchConfigUpdate) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_UPDATE_WEB_SEARCH, patch),
    testWebSearch: (params?: DesktopTestWebSearchParams) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_TEST_WEB_SEARCH, params),
  },
  acp: {
    listAgents: () => ipcRenderer.invoke(IPC_CHANNELS.ACP_LIST_AGENTS),
    detectAgents: () => ipcRenderer.invoke(IPC_CHANNELS.ACP_DETECT_AGENTS),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.ACP_GET_SETTINGS),
    updateSettings: (patch: Partial<AcpSettings>) =>
      ipcRenderer.invoke(IPC_CHANNELS.ACP_UPDATE_SETTINGS, patch),
    addCustomAgent: agent => ipcRenderer.invoke(IPC_CHANNELS.ACP_ADD_CUSTOM_AGENT, agent),
    removeCustomAgent: agentId => ipcRenderer.invoke(IPC_CHANNELS.ACP_REMOVE_CUSTOM_AGENT, agentId),
    installAgent: agentId => ipcRenderer.invoke(IPC_CHANNELS.ACP_INSTALL_AGENT, agentId),
    cancelInstall: agentId => ipcRenderer.invoke(IPC_CHANNELS.ACP_CANCEL_INSTALL, agentId),
    probeAgent: (agentId, options) => ipcRenderer.invoke(IPC_CHANNELS.ACP_PROBE_AGENT, agentId, options),
    startSession: (params: AcpStartSessionParams) =>
      ipcRenderer.invoke(IPC_CHANNELS.ACP_START_SESSION, params),
    prompt: (params: AcpPromptParams) => ipcRenderer.invoke(IPC_CHANNELS.ACP_PROMPT, params),
    cancelTurn: sessionId => ipcRenderer.invoke(IPC_CHANNELS.ACP_CANCEL_TURN, sessionId),
    setModel: params => ipcRenderer.invoke(IPC_CHANNELS.ACP_SET_MODEL, params),
    setThinkingLevel: params => ipcRenderer.invoke(IPC_CHANNELS.ACP_SET_THINKING_LEVEL, params),
    setPermissionMode: params => ipcRenderer.invoke(IPC_CHANNELS.ACP_SET_PERMISSION_MODE, params),
    respondPermission: (params: {
      sessionId: string
      requestId: string
      decision: AcpPermissionDecision
      optionId?: string
    }) => ipcRenderer.invoke(IPC_CHANNELS.ACP_RESPOND_PERMISSION, params),
    closeSession: sessionId => ipcRenderer.invoke(IPC_CHANNELS.ACP_CLOSE_SESSION, sessionId),
    readWorkspaceImage: params => ipcRenderer.invoke(IPC_CHANNELS.ACP_READ_WORKSPACE_IMAGE, params),
    onEvent: (listener: (event: AcpHostEvent) => void) =>
      subscribeChannel(IPC_CHANNELS.ACP_EVENT, listener),
  },
  updates: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATES_GET_STATE),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATES_CHECK),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATES_INSTALL),
    onState: (listener: (state: DesktopUpdateState) => void) =>
      subscribeChannel(IPC_CHANNELS.UPDATES_STATE, listener),
  },
  marketplace: {
    listThemes: (params?: DesktopMarketplaceListParams) =>
      ipcRenderer.invoke(IPC_CHANNELS.MARKETPLACE_LIST_THEMES, params),
    getItem: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MARKETPLACE_GET_ITEM, id),
    installItem: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MARKETPLACE_INSTALL_ITEM, id),
  },
  ipCharacters: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.IP_LIST),
    update: (id: string, patch: DesktopIpCharacterUpdate) =>
      ipcRenderer.invoke(IPC_CHANNELS.IP_UPDATE, id, patch),
    setDefault: (id: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.IP_SET_DEFAULT, id),
    remove: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.IP_REMOVE, id),
    readImage: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.IP_READ_IMAGE, id),
    onChanged: (callback: (library: DesktopIpLibrary) => void) =>
      subscribeChannel(IPC_CHANNELS.IP_CHANGED, callback),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST),
    read: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_READ, name),
    save: (name: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_SAVE, name, content),
    create: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_CREATE, name),
    remove: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_REMOVE, name),
    reset: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_RESET, name),
    keepModified: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_KEEP_MODIFIED, name),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_SET_ENABLED, name, enabled),
    onChanged: (callback: (skills: DesktopSkill[]) => void) =>
      subscribeChannel(IPC_CHANNELS.SKILLS_CHANGED, callback),
  },
}

contextBridge.exposeInMainWorld(`mdDesktop`, desktopBridge)
