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
  loadCueTokens,
  persistCueTokens
} from './cueAuth'
import {
  callCueApi,
  fetchCueAgentById,
  fetchCueAgents,
  fetchCueQuota,
  fetchCueSessionHistory
} from './cueClient'
import { sendCueNativeMessage } from './cueChatSocket'
import { onCueHandoffSignedIn } from './cueDesktopHandoff'
import { getOrCreateCueDeviceId } from './cueDeviceId'
import { runCueOpenApi, verifyCueApiKey } from './cueOpenApi'
import {
  cancelCueLogin,
  closeCueLoginWindow,
  onCueLoginEvent,
  openCueLoginWindow,
  tryCapturePartitionCookies
} from './cueLogin'
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
  let loaded = await loadCueTokens(accountId)
  if (!loaded || (!loaded.accessToken && !loaded.apiKey && !loaded.cookieHeader)) {
    const captured = await tryCapturePartitionCookies(accountId)
    if (captured.captured) {
      loaded = await loadCueTokens(accountId)
    }
  }
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
    let auth = await loadCueTokens(req.accountId)
    if (!auth || (!auth.accessToken && !auth.apiKey && !auth.cookieHeader)) {
      const captured = await tryCapturePartitionCookies(req.accountId)
      if (captured.captured) {
        auth = await loadCueTokens(req.accountId)
      }
    }
    const baseUrl = req.baseUrl || auth?.baseUrl
    if (auth?.apiKey && !baseUrl) {
      return await runCueOpenApi(req, auth.apiKey)
    }
    if (!baseUrl) {
      if (!auth || (!auth.accessToken && !auth.cookieHeader && !(await hasValidCueAuth(req.accountId)))) {
        return { ok: false, status: 401, message: '未登录 Cue，请点击「使用 Cue 登录」在网页窗口完成登录' }
      }
      // Native Cue Desktop protocol (Connect-RPC `api.manus.im` + Engine.IO/Socket.IO WebSocket)
      switch (req.op) {
        case 'health':
          return {
            ok: true,
            data: {
              ok: true,
              status: 'online',
              handle: auth?.handle,
              displayName: auth?.displayName,
              authKind: auth?.authKind ?? 'session'
            }
          }
        case 'listAgents': {
          ensureCueAccountWatch(req.accountId)
          const res = await fetchCueAgents(req.accountId, { limit: 50 }).catch(() => null)
          if (res?.ok && res.agents.length > 0) {
            return { ok: true, data: res.agents }
          }
          return {
            ok: true,
            data: [
              {
                id: 'agent-default',
                name: 'Cue',
                description: 'Cue 个人智能体'
              }
            ]
          }
        }
        case 'listTasks': {
          const res = await fetchCueAgents(req.accountId, { limit: 50 }).catch(() => null)
          if (res?.ok) {
            return { ok: true, data: { tasks: res.agents } }
          }
          return { ok: true, data: { tasks: [] } }
        }
        case 'getHistory': {
          let sessionId = req.sessionId?.trim()
          if (!sessionId && req.agentId && req.agentId !== 'agent-default' && !req.agentId.startsWith('cue_default_')) {
            const agent = await fetchCueAgentById(req.accountId, req.agentId).catch(() => null)
            sessionId = agent?.sessionId
          }
          if (!sessionId) {
            const list = await fetchCueAgents(req.accountId, { limit: 50 }).catch(() => null)
            sessionId = list?.agents.find((a) => Boolean(a.sessionId))?.sessionId
          }
          if (!sessionId) {
            return { ok: true, data: { sessionId: undefined, messages: [] } }
          }
          const hist = await fetchCueSessionHistory(req.accountId, sessionId, { limit: req.limit ?? 300 })
          return { ok: true, data: { sessionId, messages: hist.messages } }
        }
        case 'quota': {
          const quota = await fetchCueQuota(req.accountId)
          return { ok: true, data: quota }
        }
        case 'call': {
          const apiPath = typeof req.path === 'string' ? req.path.trim() : ''
          if (!apiPath.startsWith('/') || apiPath.startsWith('//')) {
            return { ok: false, status: 400, message: 'Invalid Cue API path' }
          }
          const method = req.method === 'GET' ? 'GET' : 'POST'
          const res = await callCueApi(req.accountId, apiPath, {
            method,
            body: method === 'GET' ? undefined : (req.body ?? {})
          })
          if (!res.ok) {
            const rec = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
            const msg = typeof rec?.['message'] === 'string' && rec['message'].trim()
              ? rec['message'].trim()
              : `Cue API call failed (${res.status})`
            return { ok: false, status: res.status, message: msg }
          }
          return { ok: true, data: res.data }
        }
        case 'sendMessage': {
          let sessionId = req.sessionId?.trim()
          if (!sessionId && req.agentId && req.agentId !== 'agent-default' && !req.agentId.startsWith('cue_default_')) {
            const agent = await fetchCueAgentById(req.accountId, req.agentId).catch(() => null)
            sessionId = agent?.sessionId
          }
          if (!sessionId) {
            const list = await fetchCueAgents(req.accountId, { limit: 50 }).catch(() => null)
            if (list && !list.ok && (list.status === 401 || list.status === 403)) {
              return { ok: false, status: list.status, message: 'Cue 会话已失效，请重新登录' }
            }
            const matched = req.agentId ? list?.agents.find((a) => a.id === req.agentId && a.sessionId) : undefined
            sessionId = matched?.sessionId ?? list?.agents.find((a) => Boolean(a.sessionId))?.sessionId
          }
          if (!sessionId) {
            return {
              ok: false,
              status: 400,
              message: '未找到该 Cue Agent 对应的会话（session_uid），请点击「同步 Agent」刷新，或先在 Cue 客户端创建 Agent。'
            }
          }
          const result = await sendCueNativeMessage({
            accountId: req.accountId,
            sessionId,
            agentId: req.agentId,
            conversationId: req.conversationId,
            text: req.text
          })
          return { ok: true, data: result }
        }
        case 'watchUntilReply': {
          return { ok: true, data: { done: true } }
        }
        case 'approve': {
          return { ok: false, status: 400, message: '请在 Cue 客户端确认该审批操作' }
        }
        default:
          return { ok: false, status: 400, message: 'Unsupported Cue RPC op' }
      }
    }
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
      case 'getHistory': {
        return { ok: true, data: { messages: [] } }
      }
      case 'quota': {
        const quota = await fetchCueQuota(req.accountId, { baseUrl })
        return { ok: true, data: quota }
      }
      case 'call': {
        const apiPath = typeof req.path === 'string' ? req.path.trim() : ''
        if (!apiPath.startsWith('/') || apiPath.startsWith('//')) {
          return { ok: false, status: 400, message: 'Invalid Cue API path' }
        }
        const method = req.method === 'GET' ? 'GET' : 'POST'
        const res = await callCueApi(req.accountId, apiPath, {
          method,
          baseUrl,
          body: method === 'GET' ? undefined : (req.body ?? {})
        })
        if (!res.ok) {
          const rec = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
          const msg = typeof rec?.['message'] === 'string' && rec['message'].trim()
            ? rec['message'].trim()
            : `Cue API call failed (${res.status})`
          return { ok: false, status: res.status, message: msg }
        }
        return { ok: true, data: res.data }
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
  onCueHandoffSignedIn((ev) => {
    closeCueLoginWindow(ev.accountId)
    broadcast({
      type: 'auth',
      accountId: ev.accountId,
      signedIn: true,
      handle: ev.handle,
      displayName: ev.displayName,
      accountSlot: ev.accountSlot
    })
    const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.getParentWindow())
    if (main) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
  })
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
      const trimmed = raw.trim()
      const looksLikeSessionOrJwtOrJson =
        /^(?:Cookie\s*:|Bearer\s+|\{|\[|eyJ[A-Za-z0-9_-]+\.)/i.test(trimmed) ||
        (trimmed.includes('=') && /(?:cue_session|session_id|__Secure-)/i.test(trimmed))
      if (req.verifyApiKey && !looksLikeSessionOrJwtOrJson) {
        const apiKey = trimmed.replace(/^x-manus-api-key:\s*/i, '')
        if (!apiKey || /\s/.test(apiKey)) throw new Error('请填入完整的 Manus API Key')
        const identity = await verifyCueApiKey(req.accountId, apiKey)
        const previous = await loadCueTokens(req.accountId)
        if (previous?.apiKey && !previous.baseUrl && previous.accountSlot && previous.accountSlot !== identity.accountSlot) {
          throw new Error('该 API Key 属于其他 Manus 账号，请选择「新增 Cue 账号」')
        }
        await persistCueTokens(req.accountId, { apiKey, authKind: 'api-key', ...identity })
      } else {
        await importCueCredentials(req.accountId, raw)
      }
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
