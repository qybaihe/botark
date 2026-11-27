import type { GeminiEvent } from '@shared/gemini'
import { SLACK_CHANNEL, SLACK_INBOUND, type SlackInbound } from '@shared/slack'
import { WORKSPACE_CHANNEL } from '@shared/workspace'
import { WORKSPACE_PORTAL_CHANNEL } from '@shared/workspacePortal'
import { contextBridge, ipcRenderer } from 'electron'
import type { BotHubBridge } from '@shared/bridge'
import {
  ANTIGRAVITY_CHANNELS,
  CUE_CHANNELS,
  DOT_CHANNELS,
  DS_BOT_CHANNELS,
  GEMINI_CHANNELS,
  GROK_CHANNELS,
  HARK_CHANNELS,
  HERMES_CHANNELS,
  MUSE_CHANNELS,
  UPDATE_CHANNELS,
  VAULT_CHANNELS,
  WEB_VIEW_CHANNELS,
  type AntigravityMainEvent,
  type CueMainEvent,
  type DotMainEvent,
  type DsBotMainEvent,
  type GrokMainEvent,
  type HarkMainEvent,
  type HermesMainEvent,
  type MuseMainEvent,
  type UpdateStatusEvent
} from '@shared/ipc'
import {
  MOBILE_SYNC_CHANNELS,
  type MobileRelayCommand,
  type MobileSendCommand,
  type MobileSendResult,
  type MobileSyncStateView
} from '@shared/mobileSync'

const bridge: BotHubBridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  },
  webViews: {
    create: (request) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.create, request),
    attach: (viewId, bounds) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.attach, viewId, bounds),
    resize: (viewId, bounds) => ipcRenderer.send(WEB_VIEW_CHANNELS.resize, viewId, bounds),
    detach: (viewId) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.detach, viewId),
    destroy: (viewId) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.destroy, viewId),
    clearPartition: (accountId) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.clearPartition, accountId),
    navigate: (viewId, url) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.navigate, viewId, url),
    openInPartition: (request) => ipcRenderer.invoke(WEB_VIEW_CHANNELS.openInPartition, request)
  },
  muse: {
    ensure: (request) => ipcRenderer.invoke(MUSE_CHANNELS.ensure, request),
    rpc: (request) => ipcRenderer.invoke(MUSE_CHANNELS.rpc, request),
    status: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.status, accountId),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: MuseMainEvent) => listener(payload)
      ipcRenderer.on(MUSE_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(MUSE_CHANNELS.event, handler)
    },
    signOut: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.signOut, accountId),
    openLogin: (request) => ipcRenderer.invoke(MUSE_CHANNELS.openLogin, request),
    cancelLogin: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.cancelLogin, accountId),
    autoLogin: (request) => ipcRenderer.invoke(MUSE_CHANNELS.autoLogin, request),
    showLogin: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.showLogin, accountId),
    getQuota: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.getQuota, accountId),
    refreshQuota: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.refreshQuota, accountId),
    getInvite: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.getInvite, accountId),
    refreshInvite: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.refreshInvite, accountId),
    redeemInvite: (accountId, code) => ipcRenderer.invoke(MUSE_CHANNELS.redeemInvite, accountId, code),
    listSchedules: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.listSchedules, accountId),
    listScheduleRuns: (accountId, jobId) =>
      ipcRenderer.invoke(MUSE_CHANNELS.listScheduleRuns, accountId, jobId),
    runSchedule: (accountId, jobId) => ipcRenderer.invoke(MUSE_CHANNELS.runSchedule, accountId, jobId),
    deleteSchedule: (accountId, jobId) =>
      ipcRenderer.invoke(MUSE_CHANNELS.deleteSchedule, accountId, jobId),
    listSessions: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.listSessions, accountId),
    mutateSession: (accountId, mutation) =>
      ipcRenderer.invoke(MUSE_CHANNELS.mutateSession, accountId, mutation),
    startSession: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.startSession, accountId),
    loadSessionHistory: (accountId, sessionId) =>
      ipcRenderer.invoke(MUSE_CHANNELS.loadSessionHistory, accountId, sessionId),
    cancelChat: (accountId, sessionId) =>
      ipcRenderer.invoke(MUSE_CHANNELS.cancelChat, accountId, sessionId),
    listFiles: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.listFiles, accountId),
    listConnectors: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.listConnectors, accountId),
    connectConnector: (accountId, connectorId) =>
      ipcRenderer.invoke(MUSE_CHANNELS.connectConnector, accountId, connectorId),
    disconnectConnector: (accountId, connectorId) =>
      ipcRenderer.invoke(MUSE_CHANNELS.disconnectConnector, accountId, connectorId),
    openExternal: (url) => ipcRenderer.invoke(MUSE_CHANNELS.openExternal, url),
    openHttps: (url) => ipcRenderer.invoke(MUSE_CHANNELS.openHttps, url),
    selectOption: (request) => ipcRenderer.invoke(MUSE_CHANNELS.selectOption, request),
    previewWorkspaceFile: (accountId, path) =>
      ipcRenderer.invoke(MUSE_CHANNELS.previewWorkspaceFile, accountId, path),
    uploadWorkspaceFile: (accountId, args) =>
      ipcRenderer.invoke(MUSE_CHANNELS.uploadWorkspaceFile, accountId, args),
    syncIdentity: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.syncIdentity, accountId),
    getProxy: (accountId) => ipcRenderer.invoke(MUSE_CHANNELS.getProxy, accountId),
    setProxy: (accountId, config) => ipcRenderer.invoke(MUSE_CHANNELS.setProxy, accountId, config),
    testProxy: (accountId, config) => ipcRenderer.invoke(MUSE_CHANNELS.testProxy, accountId, config),
    listProxyPool: () => ipcRenderer.invoke(MUSE_CHANNELS.listProxyPool),
    importProxyPool: (rawText, defaultMode) =>
      ipcRenderer.invoke(MUSE_CHANNELS.importProxyPool, rawText, defaultMode),
    removeProxyPoolItem: (id) => ipcRenderer.invoke(MUSE_CHANNELS.removeProxyPoolItem, id),
    clearProxyPool: () => ipcRenderer.invoke(MUSE_CHANNELS.clearProxyPool),
    assignProxyPool: (accountIds, keepIds) => ipcRenderer.invoke(MUSE_CHANNELS.assignProxyPool, accountIds, keepIds),
    testProxyPool: (ids) => ipcRenderer.invoke(MUSE_CHANNELS.testProxyPool, ids)
  },
  updates: {
    check: () => ipcRenderer.invoke(UPDATE_CHANNELS.check),
    install: () => ipcRenderer.invoke(UPDATE_CHANNELS.install),
    version: () => ipcRenderer.invoke(UPDATE_CHANNELS.version),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: UpdateStatusEvent) => listener(payload)
      ipcRenderer.on(UPDATE_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(UPDATE_CHANNELS.event, handler)
    }
  },
  grok: {
    openLogin: (request) => ipcRenderer.invoke(GROK_CHANNELS.openLogin, request),
    cancelLogin: (accountId) => ipcRenderer.invoke(GROK_CHANNELS.cancelLogin, accountId),
    setAccessToken: (request) => ipcRenderer.invoke(GROK_CHANNELS.setAccessToken, request),
    clearAuth: (accountId) => ipcRenderer.invoke(GROK_CHANNELS.clearAuth, accountId),
    authStatus: (accountId) => ipcRenderer.invoke(GROK_CHANNELS.authStatus, accountId),
    getSession: (accountId) => ipcRenderer.invoke(GROK_CHANNELS.getSession, accountId),
    rpc: (request) => ipcRenderer.invoke(GROK_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: GrokMainEvent) => listener(payload)
      ipcRenderer.on(GROK_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(GROK_CHANNELS.event, handler)
    }
  },
  hark: {
    openLogin: (request) => ipcRenderer.invoke(HARK_CHANNELS.openLogin, request),
    cancelLogin: (accountId) => ipcRenderer.invoke(HARK_CHANNELS.cancelLogin, accountId),
    authStatus: (accountId) => ipcRenderer.invoke(HARK_CHANNELS.authStatus, accountId),
    importCredentials: (request) => ipcRenderer.invoke(HARK_CHANNELS.importCredentials, request),
    clearAuth: (accountId) => ipcRenderer.invoke(HARK_CHANNELS.clearAuth, accountId),
    rpc: (request) => ipcRenderer.invoke(HARK_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: HarkMainEvent) => listener(payload)
      ipcRenderer.on(HARK_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(HARK_CHANNELS.event, handler)
    }
  },
  dot: {
    openLogin: (request) => ipcRenderer.invoke(DOT_CHANNELS.openLogin, request),
    cancelLogin: (accountId) => ipcRenderer.invoke(DOT_CHANNELS.cancelLogin, accountId),
    authStatus: (accountId) => ipcRenderer.invoke(DOT_CHANNELS.authStatus, accountId),
    importCredentials: (request) => ipcRenderer.invoke(DOT_CHANNELS.importCredentials, request),
    clearAuth: (accountId) => ipcRenderer.invoke(DOT_CHANNELS.clearAuth, accountId),
    rpc: (request) => ipcRenderer.invoke(DOT_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: DotMainEvent) => listener(payload)
      ipcRenderer.on(DOT_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(DOT_CHANNELS.event, handler)
    }
  },
  hermes: {
    configure: (request) => ipcRenderer.invoke(HERMES_CHANNELS.configure, request),
    detectLocal: (baseUrl) => ipcRenderer.invoke(HERMES_CHANNELS.detectLocal, baseUrl),
    authStatus: (accountId) => ipcRenderer.invoke(HERMES_CHANNELS.authStatus, accountId),
    listAccounts: () => ipcRenderer.invoke(HERMES_CHANNELS.listAccounts),
    clearAuth: (accountId) => ipcRenderer.invoke(HERMES_CHANNELS.clearAuth, accountId),
    rpc: (request) => ipcRenderer.invoke(HERMES_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: HermesMainEvent) => listener(payload)
      ipcRenderer.on(HERMES_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(HERMES_CHANNELS.event, handler)
    }
  },
  antigravity: {
    openLogin: (request) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.openLogin, request),
    cancelLogin: (accountId) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.cancelLogin, accountId),
    importCredentials: (request) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.importCredentials, request),
    clearAuth: (accountId) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.clearAuth, accountId),
    authStatus: (accountId) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.authStatus, accountId),
    sendMessage: (request) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.sendMessage, request),
    cancelRun: (accountId) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.cancelRun, accountId),
    rpc: (request) => ipcRenderer.invoke(ANTIGRAVITY_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: AntigravityMainEvent) => listener(payload)
      ipcRenderer.on(ANTIGRAVITY_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(ANTIGRAVITY_CHANNELS.event, handler)
    }
  },
  cue: {
    openLogin: (request) => ipcRenderer.invoke(CUE_CHANNELS.openLogin, request),
    cancelLogin: (accountId) => ipcRenderer.invoke(CUE_CHANNELS.cancelLogin, accountId),
    importCredentials: (request) => ipcRenderer.invoke(CUE_CHANNELS.importCredentials, request),
    clearAuth: (accountId) => ipcRenderer.invoke(CUE_CHANNELS.clearAuth, accountId),
    authStatus: (accountId) => ipcRenderer.invoke(CUE_CHANNELS.authStatus, accountId),
    getSession: (accountId) => ipcRenderer.invoke(CUE_CHANNELS.getSession, accountId),
    rpc: (request) => ipcRenderer.invoke(CUE_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: CueMainEvent) => listener(payload)
      ipcRenderer.on(CUE_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(CUE_CHANNELS.event, handler)
    }
  },
  gemini: {
    config: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.config, ...args),
    configure: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.configure, ...args),
    verifyAndListModels: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.verifyAndListModels, ...args),
    listAccounts: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.listAccounts, ...args),
    clearAuth: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.clearAuth, ...args),
    createSession: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.createSession, ...args),
    listSessions: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.listSessions, ...args),
    clearHistory: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.clearHistory, ...args),
    getHistory: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.getHistory, ...args),
    renameSession: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.renameSession, ...args),
    deleteSession: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.deleteSession, ...args),
    streamChat: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.streamChat, ...args),
    cancelChat: (...args) => ipcRenderer.invoke(GEMINI_CHANNELS.cancelChat, ...args),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: GeminiEvent) => listener(payload)
      ipcRenderer.on(GEMINI_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(GEMINI_CHANNELS.event, handler)
    }
  },
  dsBot: {
    configure: (request) => ipcRenderer.invoke(DS_BOT_CHANNELS.configure, request),
    detectLocal: () => ipcRenderer.invoke(DS_BOT_CHANNELS.detectLocal),
    authStatus: (accountId) => ipcRenderer.invoke(DS_BOT_CHANNELS.authStatus, accountId),
    listAccounts: () => ipcRenderer.invoke(DS_BOT_CHANNELS.listAccounts),
    clearAuth: (accountId) => ipcRenderer.invoke(DS_BOT_CHANNELS.clearAuth, accountId),
    rpc: (request) => ipcRenderer.invoke(DS_BOT_CHANNELS.rpc, request),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: DsBotMainEvent) => listener(payload)
      ipcRenderer.on(DS_BOT_CHANNELS.event, handler)
      return () => ipcRenderer.removeListener(DS_BOT_CHANNELS.event, handler)
    }
  },
  slack: {
    request: (req) => ipcRenderer.invoke(SLACK_CHANNEL, req),
    onMessage: (callback) => {
      const handler = (_event: unknown, msg: SlackInbound) => callback(msg)
      ipcRenderer.on(SLACK_INBOUND, handler)
      return () => { ipcRenderer.off(SLACK_INBOUND, handler) }
    }
  },
  workspace: {
    manage: (scope, request) => ipcRenderer.invoke(WORKSPACE_CHANNEL, scope, request),
    run: (scope, tool, args, recipient) => ipcRenderer.invoke(WORKSPACE_CHANNEL, scope, { op: 'run', tool, args, recipient })
  },
  workspacePortal: {
    manage: (request) => ipcRenderer.invoke(WORKSPACE_PORTAL_CHANNEL, request)
  },
  mobileSync: {
    getState: () => ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.getState),
    start: () => ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.start),
    stop: () => ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.stop),
    rotatePairing: () => ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.rotatePairing),
    setIncludeDirectCredentials: (enabled) =>
      ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.setIncludeDirectCredentials, enabled),
    revokeDevice: (deviceId) => ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.revokeDevice, deviceId),
    exportOfflineBundle: () => ipcRenderer.invoke(MOBILE_SYNC_CHANNELS.exportOfflineBundle),
    pushSnapshot: (snapshot) => ipcRenderer.send(MOBILE_SYNC_CHANNELS.pushSnapshot, snapshot),
    pushEvent: (event) => ipcRenderer.send(MOBILE_SYNC_CHANNELS.pushEvent, event),
    onStateChanged: (listener) => {
      const handler = (_event: unknown, payload: MobileSyncStateView) => listener(payload)
      ipcRenderer.on(MOBILE_SYNC_CHANNELS.stateChanged, handler)
      return () => ipcRenderer.removeListener(MOBILE_SYNC_CHANNELS.stateChanged, handler)
    },
    onCommand: (listener) => {
      const handler = (_event: unknown, payload: MobileRelayCommand) => listener(payload)
      ipcRenderer.on(MOBILE_SYNC_CHANNELS.command, handler)
      return () => ipcRenderer.removeListener(MOBILE_SYNC_CHANNELS.command, handler)
    },
    onSendCommand: (listener) => {
      const handler = (_event: unknown, requestId: string, command: MobileSendCommand) => {
        let result: MobileSendResult
        try {
          result = listener(command)
        } catch {
          result = { ok: false, status: 503, message: 'Desktop could not queue the message' }
        }
        ipcRenderer.send(MOBILE_SYNC_CHANNELS.sendCommandResult, requestId, result)
      }
      ipcRenderer.on(MOBILE_SYNC_CHANNELS.sendCommand, handler)
      return () => ipcRenderer.removeListener(MOBILE_SYNC_CHANNELS.sendCommand, handler)
    }
  },
  vault: {
    status: (request) => ipcRenderer.invoke(VAULT_CHANNELS.status, request ?? {}),
    getSecret: (key) => ipcRenderer.invoke(VAULT_CHANNELS.getSecret, key),
    setSecret: (key, value) => ipcRenderer.invoke(VAULT_CHANNELS.setSecret, key, value),
    deleteSecret: (key) => ipcRenderer.invoke(VAULT_CHANNELS.deleteSecret, key),
    clearAll: () => ipcRenderer.invoke(VAULT_CHANNELS.clearAll),
    hardenPermissions: () => ipcRenderer.invoke(VAULT_CHANNELS.hardenPermissions)
  }
}

try {
  contextBridge.exposeInMainWorld('electron', bridge)
} catch (error) {
  console.error('[preload] failed to expose bridge', error)
}
