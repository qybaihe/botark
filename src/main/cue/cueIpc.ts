import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  CUE_CHANNELS,
  type CueAuthSessionPayload,
  type CueAuthStatus,
  type CueImportCredentialsRequest,
  type CueOpenLoginRequest,
  type CueRpcRequest,
  type CueRpcResponse
} from '@shared/ipc'
import type { CueTurnEvent } from '../../adapters/cue/events'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import {
  clearCueAccountAuth,
  currentCueAuthForIdentity,
  getCueCredentialRevision,
  hasValidCueAuth,
  importCueCredentials,
  listSavedCueAccountIds,
  loadCueTokens,
  parseAnyCueCredentialInput,
  persistCueTokens
} from './cueAuth'
import {
  callCueApi,
  downloadCueMedia,
  fetchCueAgentById,
  fetchCueAgents,
  fetchCueQuota,
  fetchCueSessionHistory,
  verifyCueNativeCredentials
} from './cueClient'
import {
  cancelCueNativeTurn,
  sendCueNativeMessage,
  syncCueWatchedSessions
} from './cueChatSocket'
import { onCueHandoffSignedIn, revokeCueLoginNonce } from './cueDesktopHandoff'
import { getOrCreateCueDeviceId } from './cueDeviceId'
import {
  runCueOpenApi,
  stopCueOpenApiTask,
  uploadCueOpenApiAttachment,
  verifyCueApiKey
} from './cueOpenApi'
import {
  cancelCueLogin,
  closeCueLoginWindow,
  onCueLoginEvent,
  openCueLoginWindow,
  tryCapturePartitionCookies
} from './cueLogin'
import {
  emitCueWatchEvent,
  ensureCueAccountWatch,
  setCueWatchEventEmitter,
  stopCueAccountWatch
} from './cueWatchManager'

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function broadcast(payload: CueTurnEvent): void {
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
  const signedIn =
    Boolean(loaded && (loaded.accessToken || loaded.apiKey || loaded.cookieHeader)) ||
    (await hasValidCueAuth(accountId))
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

async function resolveNativeSession(
  req: { accountId: string; sessionId?: string; agentId?: string }
): Promise<{ sessionId: string } | Extract<CueRpcResponse, { ok: false }>> {
  const sessionId = req.sessionId?.trim()
  if (sessionId) return { sessionId }
  const agentId = req.agentId?.trim()
  const named = agentId && agentId !== 'agent-default' && !agentId.startsWith('cue_default_')
  if (named) {
    const agent = await fetchCueAgentById(req.accountId, agentId).catch(() => null)
    if (agent?.id === agentId && agent.sessionId) return { sessionId: agent.sessionId }
  }
  const roster = await fetchCueAgents(req.accountId, { limit: 50 }).catch(() => null)
  if (roster && !roster.ok && [401, 403].includes(roster.status)) {
    return { ok: false, status: roster.status, message: 'Cue 会话已失效，请重新登录' }
  }
  const exact = roster?.agents.find((agent) => agent.id === agentId && agent.sessionId)
  const chosen = exact ?? (!named ? roster?.agents.find((agent) => agent.sessionId) : undefined)
  if (chosen?.sessionId) return { sessionId: chosen.sessionId }
  return {
    ok: false,
    status: 404,
    message: '未找到该 Cue Agent 对应的会话（session_uid），请点击「同步 Agent」刷新，或先在 Cue 客户端创建 Agent。'
  }
}

export async function runCueRpc(req: CueRpcRequest & { requestId?: string }): Promise<CueRpcResponse> {
  try {
    let auth = await loadCueTokens(req.accountId)
    if (!auth || (!auth.accessToken && !auth.apiKey && !auth.cookieHeader)) {
      const captured = await tryCapturePartitionCookies(req.accountId)
      if (captured.captured) {
        auth = await loadCueTokens(req.accountId)
      }
    }
    if (req.op === 'downloadMedia') {
      return await downloadCueMedia(req.accountId, req.url, { name: req.name })
    }
    const baseUrl = req.baseUrl || auth?.baseUrl
    if (auth?.apiKey && !baseUrl) {
      const openedWith = auth
      return await runCueOpenApi(req, auth.apiKey, {
        requestId: req.requestId,
        onEvent: (event) => emitCueWatchEvent(event),
        beforeRequest: () => {
          if (!currentCueAuthForIdentity(openedWith)) throw new Error('Cue 账号已更改，请重试')
        }
      })
    }
    if (!baseUrl) {
      if (!auth || (!auth.accessToken && !auth.cookieHeader && !(await hasValidCueAuth(req.accountId)))) {
        return { ok: false, status: 401, message: '未登录 Cue，请点击「使用 Cue 登录」在网页窗口完成登录' }
      }
      // Native Cue Desktop protocol (Connect-RPC `api.manus.im` + Engine.IO/Socket.IO WebSocket)
      switch (req.op) {
        case 'health': {
          const probe = await fetchCueAgents(req.accountId, { limit: 1 }).catch(() => null)
          if (probe && !probe.ok && (probe.status === 401 || probe.status === 403)) {
            return { ok: false, status: probe.status, message: 'Cue 会话已失效，请重新登录' }
          }
          if (probe && !probe.ok) {
            return {
              ok: false,
              status: probe.status,
              message: probe.error || `Cue 健康检查失败（${probe.status}）`
            }
          }
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
        }
        case 'listAgents': {
          ensureCueAccountWatch(req.accountId)
          const res = await fetchCueAgents(req.accountId, { limit: 50 }).catch(() => null)
          if (res && !res.ok && (res.status === 401 || res.status === 403)) {
            return { ok: false, status: res.status, message: 'Cue 会话已失效，请重新登录' }
          }
          if (res?.ok && res.agents.length > 0) {
            const sessions = res.agents
              .filter((agent): agent is typeof agent & { sessionId: string } => Boolean(agent.sessionId))
              .map((agent) => ({ sessionId: agent.sessionId, agentId: agent.id }))
            if (sessions.length > 0 && typeof syncCueWatchedSessions === 'function') {
              void syncCueWatchedSessions(req.accountId, sessions).catch(() => undefined)
            }
            return { ok: true, data: res.agents }
          }
          if (res && !res.ok) {
            return {
              ok: false,
              status: res.status,
              message: res.error || `加载 Cue Agent 列表失败（${res.status}）`
            }
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
          if (res && !res.ok && (res.status === 401 || res.status === 403)) {
            return { ok: false, status: res.status, message: 'Cue 会话已失效，请重新登录' }
          }
          if (res?.ok) {
            return { ok: true, data: { tasks: res.agents } }
          }
          return { ok: true, data: { tasks: [] } }
        }
        case 'getHistory': {
          const resolved = await resolveNativeSession(req)
          if ('ok' in resolved) return resolved
          const { sessionId } = resolved
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
            const rec =
              res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
            const msg =
              typeof rec?.['message'] === 'string' && rec['message'].trim()
                ? rec['message'].trim()
                : `Cue API call failed (${res.status})`
            return { ok: false, status: res.status, message: msg }
          }
          return { ok: true, data: res.data }
        }
        case 'sendMessage': {
          const resolved = await resolveNativeSession(req)
          if ('ok' in resolved) return resolved
          if (auth && !currentCueAuthForIdentity(auth)) {
            return { ok: false, status: 409, message: 'Cue 账号在发送前已更改，请重试' }
          }
          const openedWith = auth
          const result = await sendCueNativeMessage({
            accountId: req.accountId,
            sessionId: resolved.sessionId,
            agentId: req.agentId,
            conversationId: req.conversationId,
            requestId: req.requestId,
            text: req.text,
            ...(req.attachments?.length
              ? {
                  attachments: req.attachments,
                  uploadAttachment: async (att) => {
                    const token = openedWith?.accessToken?.trim()
                    if (!token) throw new Error('Cue 会话凭据缺失，无法上传附件')
                    return uploadCueOpenApiAttachment(req.accountId, token, att, {
                      asWebToken: true,
                      beforeRequest: () => {
                        if (openedWith && !currentCueAuthForIdentity(openedWith)) {
                          throw new Error('Cue 账号在上传前已更改，请重试')
                        }
                      }
                    })
                  }
                }
              : {})
          })
          return { ok: true, data: result }
        }
        case 'stopRun': {
          const cancelled =
            typeof cancelCueNativeTurn === 'function'
              ? cancelCueNativeTurn({
                  accountId: req.accountId,
                  sessionId: req.sessionId,
                  requestId: req.requestId
                })
              : { cancelledCount: 0, sessionIds: [] }
          let targetSessionId = req.sessionId?.trim() || cancelled.sessionIds[0]
          if (!targetSessionId && req.agentId) {
            const resolved = await resolveNativeSession(req).catch(() => null)
            if (resolved && !('ok' in resolved)) targetSessionId = resolved.sessionId
          }
          let remoteStopped = false
          if (targetSessionId && auth?.accessToken) {
            const remote = await stopCueOpenApiTask(req.accountId, auth.accessToken, targetSessionId, {
              asWebToken: true
            }).catch(() => null)
            remoteStopped = Boolean(remote?.ok)
          }
          return {
            ok: true,
            data: {
              stopped: true,
              cancelledTurns: cancelled.cancelledCount,
              remoteStopped,
              ...(targetSessionId ? { sessionId: targetSessionId } : {})
            }
          }
        }
        case 'watchUntilReply': {
          return { ok: true, data: { done: true } }
        }
        case 'approve': {
          return { ok: false, status: 400, message: '请在 Cue 客户端或内置网页视图中确认该审批操作' }
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
            text: req.text,
            ...(req.attachments?.length ? { attachments: req.attachments } : {})
          }
        })
        if (!res.ok) {
          return { ok: false, status: res.status, message: `Cue sendMessage failed (${res.status})` }
        }
        return { ok: true, data: res.data }
      }
      case 'stopRun': {
        const res = await callCueApi(req.accountId, '/messages/stop', {
          method: 'POST',
          baseUrl,
          body: {
            agentId: req.agentId,
            sessionId: req.sessionId,
            requestId: req.requestId
          }
        })
        if (!res.ok && res.status !== 404) {
          return { ok: false, status: res.status, message: `Cue stopRun failed (${res.status})` }
        }
        return { ok: true, data: res.ok ? res.data : { stopped: true } }
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
          const rec =
            res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null
          const msg =
            typeof rec?.['message'] === 'string' && rec['message'].trim()
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
    const code =
      error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined
    return {
      ok: false,
      status: code === 'cancelled' ? 499 : 500,
      ...(code ? { code } : {}),
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function importAndVerifyCueCredentials(
  req: CueImportCredentialsRequest
): Promise<CueAuthStatus> {
  const raw = req.credential ?? req.rawInput ?? req.accessToken ?? ''
  revokeCueLoginNonce(req.accountId)
  const revision = getCueCredentialRevision(req.accountId)
  const trimmed = raw.trim()
  const looksLikeSessionOrJwtOrJson =
    /^(?:Cookie\s*:|Bearer\s+|\{|\[|eyJ[A-Za-z0-9_-]+\.)/i.test(trimmed) ||
    (trimmed.includes('=') && /(?:cue_session|session_id|__Secure-)/i.test(trimmed))

  const shouldLiveVerify = Boolean(req.verifyApiKey) && !req.skipVerify

  if (!shouldLiveVerify) {
    await importCueCredentials(req.accountId, raw)
  } else {
    let parsed: ReturnType<typeof parseAnyCueCredentialInput>
    try {
      parsed = parseAnyCueCredentialInput(raw)
    } catch (parseErr) {
      if (!looksLikeSessionOrJwtOrJson) {
        const apiKey = trimmed.replace(/^x-manus-api-key:\s*/i, '')
        if (!apiKey || /\s/.test(apiKey)) throw new Error('请填入完整的 Manus API Key')
        parsed = { apiKey, authKind: 'api-key' }
      } else {
        throw parseErr
      }
    }

    if (parsed.authKind === 'api-key' && parsed.apiKey && !parsed.baseUrl) {
      const identity = await verifyCueApiKey(req.accountId, parsed.apiKey)
      const previous = await loadCueTokens(req.accountId)
      if (
        previous?.apiKey &&
        !previous.baseUrl &&
        previous.accountSlot &&
        previous.accountSlot !== identity.accountSlot
      ) {
        throw new Error('该 API Key 属于其他 Manus 账号，请选择「新增 Cue 账号」')
      }
      await persistCueTokens(
        req.accountId,
        { ...parsed, apiKey: parsed.apiKey, authKind: 'api-key', ...identity },
        {
          shouldSave: () => revision === getCueCredentialRevision(req.accountId)
        }
      )
    } else if (
      (parsed.authKind === 'session' || parsed.authKind === 'oauth') &&
      !parsed.baseUrl
    ) {
      const verified = await verifyCueNativeCredentials(req.accountId, parsed)
      if (!verified.ok) {
        throw new Error(verified.message || 'Cue 凭据验证失败')
      }
      await persistCueTokens(req.accountId, parsed, {
        shouldSave: () => revision === getCueCredentialRevision(req.accountId)
      })
    } else {
      await persistCueTokens(req.accountId, parsed, {
        shouldSave: () => revision === getCueCredentialRevision(req.accountId)
      })
    }
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

export function registerCueIpc(): void {
  setCueWatchEventEmitter((ev) => broadcast(ev))
  onCueHandoffSignedIn((ev) => {
    closeCueLoginWindow(ev.accountId, true)
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
      return importAndVerifyCueCredentials(req)
    }
  )

  ipcMain.handle(CUE_CHANNELS.clearAuth, async (_event, accountId: string) => {
    const signedOut = accountId === '*' ? listSavedCueAccountIds() : [accountId]
    revokeCueLoginNonce(accountId)
    closeCueLoginWindow(accountId, true)
    stopCueAccountWatch(accountId)
    await clearCueAccountAuth(accountId)
    for (const id of signedOut) broadcast({ type: 'auth', accountId: id, signedIn: false })
    if (accountId === '*') return { accountId, signedIn: false } satisfies CueAuthStatus
    return buildAuthStatus(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.authStatus, async (_event, accountId: string) => {
    return buildAuthStatus(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.getSession, async (_event, accountId: string) => {
    return buildSessionPayload(accountId)
  })

  ipcMain.handle(CUE_CHANNELS.rpc, async (_event, req: CueRpcRequest & { requestId?: string }) => {
    return runCueRpc(req)
  })
}
