import type {
  AcpHostEvent,
  AcpPermissionDecision,
  AcpPromptParams,
  AcpSettings,
  AcpStartSessionParams,
  DesktopBridge,
  DesktopImageGenConfigUpdate,
  DesktopListRemoteModelsParams,
  DesktopModelApiConfigUpdate,
  DesktopTestImageGenParams,
  DesktopUpdateState,
  WeChatPublishProgressEvent,
  WeChatPublishRequest,
  WeChatUploadImageRequest,
} from '@md/shared/types'
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'

// Sandboxed Electron preload exposes global `process` without allowing `node:process` imports.
// eslint-disable-next-line node/prefer-global/process
const hostPlatform = typeof process !== `undefined` ? process.platform : `unknown`

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
    onProgress: (listener: (event: WeChatPublishProgressEvent) => void) => {
      const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: WeChatPublishProgressEvent) => {
        listener(payload)
      }
      ipcRenderer.on(IPC_CHANNELS.WECHAT_PUBLISH_PROGRESS, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.WECHAT_PUBLISH_PROGRESS, handler)
      }
    },
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
    onEvent: (listener: (event: AcpHostEvent) => void) => {
      const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: AcpHostEvent) => {
        listener(payload)
      }
      ipcRenderer.on(IPC_CHANNELS.ACP_EVENT, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.ACP_EVENT, handler)
      }
    },
  },
  updates: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATES_GET_STATE),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATES_CHECK),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATES_INSTALL),
    onState: (listener: (state: DesktopUpdateState) => void) => {
      const handler = (_ipcEvent: Electron.IpcRendererEvent, payload: DesktopUpdateState) => {
        listener(payload)
      }
      ipcRenderer.on(IPC_CHANNELS.UPDATES_STATE, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATES_STATE, handler)
      }
    },
  },
}

contextBridge.exposeInMainWorld(`mdDesktop`, desktopBridge)
