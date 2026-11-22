import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  CUE_CHANNELS,
  type CueAuthSessionPayload,
  type CueAuthStatus,
  type CueImportCredentialsRequest,
  type CueMainEvent,
  type CueOpenLoginRequest,
  type CueRpcRequest,
  type CueRpcResponse
} from '@shared/ipc'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import {
  clearCueAccountAuth,
  hasValidCueAuth,
  importCueCredentials,
  loadCueTokens
} from './cueAuth'
import { callCueApi, fetchCueQuota } from './cueClient'
import { getOrCreateCueDeviceId } from './cueDeviceId'
import { cancelCueLogin, onCueLoginEvent, openCueLoginWindow } from './cueLogin'
import {
  ensureCueAccountWatch,
  setCueWatchEventEmitter,
  stopCueAccountWatch
} from './cueWatchManager'

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function broadcast(payload: CueMainEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(CUE_CHANNELS.event, payload)
  }
}

async function buildAuthStatus(accountId: string): Promise<CueAuthStatus> {
  const loaded = await loadCueTokens(accountId)
  const signedIn = Boolean(
    loaded && (loaded.accessToken || loaded.apiKey || loaded.cookieHeader)
  ) || (await hasValidCueAuth(accountId))
  const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => true))
  const deviceId = loaded?.deviceId ?? getOrCreateCueDeviceId(accountId)
  return {
    accountId,
    signedIn,
    handle: loaded?.handle || loaded?.accountSlot,
    displayName: loaded?.displayName || loaded?.handle || (signedIn ? 'Cue' : undefined),
    accountSlot: loaded?.accountSlot || loaded?.handle,
    deviceId,
    authKind: loaded?.authKind,
    hasProxy
  }
}

async function buildSessionPayload(accountId: string): Promise<CueAuthSessionPayload> {
  const st = await buildAuthStatus(accountId)
  return {
    accountId: st.accountId,
    signedIn: st.signedIn,
    handle: st.handle,
    displayName: st.displayName,
    accountSlot: st.accountSlot,
    deviceId: st.deviceId,
    authKind: st.authKind
  }
}

export async function runCueRpc(req: CueRpcRequest): Promise<CueRpcResponse> {
  try {
    const baseUrl = req.baseUrl
    switch (req.op) {
      case 'health': {
        const res = await callCueApi(req.accountId, '/health', {
          method: 'GET',
          baseUrl
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue health check failed (${res.status})` }
        }
        return { ok: true, data: res.data }
      }
      case 'listAgents': {
        const res = await callCueApi(req.accountId, '/agents', {
          method: 'GET',
          baseUrl
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue listAgents failed (${res.status})` }
        }
        ensureCueAccountWatch(req.accountId)
        return { ok: true, data: res.data }
      }
      case 'listTasks': {
        const res = await callCueApi(req.accountId, '/tasks', {
          method: 'GET',
          baseUrl
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue listTasks failed (${res.status})` }
        }
        return { ok: true, data: res.data }
      }
      case 'sendMessage': {
        const res = await callCueApi(req.accountId, '/messages', {
          method: 'POST',
          baseUrl,
          body: {
            agentId: req.agentId,
            sessionId: req.sessionId,
            conversationId: req.conversationId,
            text: req.text
          }
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue sendMessage failed (${res.status})` }
        }
        return { ok: true, data: res.data }
      }
      case 'watchUntilReply': {
        const res = await callCueApi(req.accountId, '/messages/watch', {
          method: 'POST',
          baseUrl,
          body: {
            agentId: req.agentId,
            sessionId: req.sessionId,
            conversationId: req.conversationId,
            afterMessageId: req.afterMessageId
          }
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue watchUntilReply failed (${res.status})` }
        }
        return { ok: true, data: res.data }
      }
      case 'approve': {
        const res = await callCueApi(req.accountId, '/approve', {
          method: 'POST',
          baseUrl,
          body: {
            approvalId: req.approvalId,
            decision: req.decision,
            sessionId: req.sessionId
          }
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue approve failed (${res.status})` }
        }
        return { ok: true, data: res.data }
      }
      case 'quota': {
        const quota = await fetchCueQuota(req.accountId, { baseUrl })
        return { ok: true, data: quota }
      }
      default:
        return { ok: false, status: 400, message: `Unsupported Cue RPC op` }
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function registerCueIpc(): void {
  setCueWatchEventEmitter((ev) => broadcast(ev))
  onCueLoginEvent((ev) => {
    if (ev.signedIn) {
      broadcast({
        type: 'auth',
        accountId: ev.accountId,
        signedIn: true,
        handle: ev.handle,
        displayName: ev.displayName,
        accountSlot: ev.accountSlot
      })
    } else {
      broadcast({
        type: 'auth',
        accountId: ev.accountId,
        signedIn: false,
        windowClosed: ev.windowClosed
      })
    }
  })

  for (const ch of Object.values(CUE_CHANNELS)) {
    if (ch !== CUE_CHANNELS.event) {
      ipcMain.removeHandler(ch)
    }
  }

  ipcMain.handle(CUE_CHANNELS.openLogin, async (event, req: CueOpenLoginRequest | string) => {
    const accountId = typeof req === 'string' ? req : req.accountId
    const openInBrowser = typeof req === 'object' && Boolean(req?.openInBrowser)
    await openCueLoginWindow(accountId, ownerWindow(event), { openInBrowser })
    return buildAuthStatus(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.cancelLogin, async (_event, accountId: string) => {
    await cancelCueLogin(accountId)
    return buildAuthStatus(accountId)
  })

  ipcMain.handle(
    CUE_CHANNELS.importCredentials,
    async (_event, req: CueImportCredentialsRequest) => {
      const raw = req.credential ?? req.rawInput ?? req.accessToken ?? ''
      await importCueCredentials(req.accountId, raw)
      const st = await buildAuthStatus(req.accountId)
      broadcast({
        type: 'auth',
        accountId: req.accountId,
        signedIn: st.signedIn,
        handle: st.handle,
        displayName: st.displayName,
        accountSlot: st.accountSlot
      })
      return st
    }
  )

  ipcMain.handle(CUE_CHANNELS.clearAuth, async (_event, accountId: string) => {
    stopCueAccountWatch(accountId)
    await clearCueAccountAuth(accountId)
    return buildAuthStatus(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.authStatus, async (_event, accountId: string) => {
    return buildAuthStatus(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.getSession, async (_event, accountId: string) => {
    return buildSessionPayload(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.rpc, async (_event, req: CueRpcRequest) => {
    return runCueRpc(req)
  })
}
