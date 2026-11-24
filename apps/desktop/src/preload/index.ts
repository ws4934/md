import type {
  AcpHostEvent,
  AcpPermissionDecision,
  AcpPromptParams,
  AcpSettings,
  AcpStartSessionParams,
  DesktopBridge,
} from '@md/shared/types'
import process from 'node:process'
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'

const desktopBridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,
  pickFiles: () => ipcRenderer.invoke(IPC_CHANNELS.PICK_FILES),
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
    syncArticleContent: params => ipcRenderer.invoke(IPC_CHANNELS.ACP_SYNC_ARTICLE_CONTENT, params),
    prompt: (params: AcpPromptParams) => ipcRenderer.invoke(IPC_CHANNELS.ACP_PROMPT, params),
    cancelTurn: sessionId => ipcRenderer.invoke(IPC_CHANNELS.ACP_CANCEL_TURN, sessionId),
    setModel: params => ipcRenderer.invoke(IPC_CHANNELS.ACP_SET_MODEL, params),
    respondPermission: (params: {
      sessionId: string
      requestId: string
      decision: AcpPermissionDecision
      optionId?: string
    }) => ipcRenderer.invoke(IPC_CHANNELS.ACP_RESPOND_PERMISSION, params),
    closeSession: sessionId => ipcRenderer.invoke(IPC_CHANNELS.ACP_CLOSE_SESSION, sessionId),
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
}

contextBridge.exposeInMainWorld(`mdDesktop`, desktopBridge)
