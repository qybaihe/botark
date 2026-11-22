import { BrowserWindow, ipcMain } from 'electron'
import {
  HERMES_CHANNELS,
  type HermesAuthStatus,
  type HermesConfigureRequest,
  type HermesLocalDetection,
  type HermesMainEvent,
  type HermesRpcRequest,
  type HermesRpcResponse
} from '@shared/ipc'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import {
  cancelAllHermesRuns,
  createHermesSession,
  decideHermesApproval,
  deleteHermesJob,
  deleteHermesSession,
  getHermesCapabilities,
  getHermesHealth,
  getHermesSessionMessages,
  HermesApiError,
  listHermesApprovals,
  listHermesJobs,
  listHermesModels,
  listHermesSessions,
  listHermesSkills,
  listHermesToolsets,
  probeHermesServer,
  runHermesJob,
  sendHermesMessage,
  stopHermesRun,
  toggleHermesJob
} from './hermesClient'
import {
  clearHermesAccount,
  getHermesAccount,
  hermesHandleFromUrl,
  listHermesAccountRecords,
  normalizeHermesBaseUrl,
  readLocalHermesEnv,
  saveHermesAccount,
  updateHermesAccountModel
} from './hermesStore'

function broadcast(payload: HermesMainEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(HERMES_CHANNELS.event, payload)
  }
}

async function statusFor(accountId: string, verifyLive = true): Promise<HermesAuthStatus> {
  const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => false))
  let acc: ReturnType<typeof getHermesAccount>
  try {
    acc = getHermesAccount(accountId)
  } catch (error) {
    return {
      accountId,
      signedIn: false,
      hasProxy,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (!acc) {
    return { accountId, signedIn: false, hasProxy }
  }
  const handle = hermesHandleFromUrl(acc.baseUrl, acc.model)
  if (!verifyLive) {
    return {
      accountId,
      signedIn: true,
      baseUrl: acc.baseUrl,
      handle,
      displayName: acc.displayName || 'Hermes',
      model: acc.model,
      hasApiKey: acc.hasApiKey,
      hasProxy
    }
  }
  const probe = await probeHermesServer({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey
  })
  return {
    accountId,
    signedIn: probe.reachable && probe.authenticated,
    baseUrl: acc.baseUrl,
    handle,
    displayName: acc.displayName || 'Hermes',
    model: acc.model || probe.defaultModel,
    version: probe.version,
    hasApiKey: acc.hasApiKey,
    hasProxy,
    supportsSessions: probe.supportsSessions,
    error: probe.error
  }
}

async function runHermesRpc(req: HermesRpcRequest): Promise<HermesRpcResponse> {
  try {
    switch (req.op) {
      case 'health':
        return { ok: true, data: await getHermesHealth(req.accountId) }
      case 'models':
        return { ok: true, data: await listHermesModels(req.accountId) }
      case 'capabilities':
        return { ok: true, data: await getHermesCapabilities(req.accountId) }
      case 'skills':
        return { ok: true, data: await listHermesSkills(req.accountId) }
      case 'toolsets':
        return { ok: true, data: await listHermesToolsets(req.accountId) }
      case 'listJobs':
        return { ok: true, data: await listHermesJobs(req.accountId) }
      case 'toggleJob':
        return { ok: true, data: await toggleHermesJob(req.accountId, req.jobId, Boolean(req.pause)) }
      case 'runJob':
        return { ok: true, data: await runHermesJob(req.accountId, req.jobId) }
      case 'deleteJob':
        return { ok: true, data: await deleteHermesJob(req.accountId, req.jobId) }
      case 'listSessions':
        return { ok: true, data: await listHermesSessions(req.accountId, req.limit ?? 50) }
      case 'createSession':
        return { ok: true, data: await createHermesSession(req.accountId, { title: req.title, model: req.model }) }
      case 'deleteSession':
        return { ok: true, data: await deleteHermesSession(req.accountId, req.sessionId) }
      case 'getSessionMessages':
        return { ok: true, data: await getHermesSessionMessages(req.accountId, req.sessionId) }
      case 'setModel': {
        const updated = await updateHermesAccountModel(req.accountId, req.model)
        return {
          ok: true,
          data: {
            accountId: updated.accountId,
            model: updated.model,
            handle: hermesHandleFromUrl(updated.baseUrl, updated.model)
          }
        }
      }
      case 'listApprovals':
        return { ok: true, data: listHermesApprovals(req.accountId) }
      case 'decideApproval':
        await decideHermesApproval(req.accountId, req.approvalId, req.decision, (pending) => {
          broadcast({ type: 'approvals', accountId: req.accountId, pending })
        })
        return { ok: true, data: { ok: true } }
      case 'stopRun':
        await stopHermesRun(req.accountId)
        broadcast({ type: 'activity', accountId: req.accountId, activityCode: 'idle', busy: false })
        return { ok: true, data: { ok: true } }
      case 'sendMessage': {
        const result = await sendHermesMessage({
          accountId: req.accountId,
          botId: req.botId,
          sessionId: req.sessionId,
          text: req.text,
          model: req.model,
          attachments: req.attachments,
          callbacks: {
            onAccepted: () => {
              if (req.requestId) broadcast({ type: 'accepted', accountId: req.accountId, requestId: req.requestId })
            },
            onDelta: (payload) => {
              broadcast({
                type: 'stream',
                accountId: req.accountId,
                conversationId: req.botId,
                sessionId: payload.sessionId,
                messageId: payload.messageId,
                text: payload.text,
                done: payload.done,
                ...(payload.tools ? { tools: payload.tools } : {}),
                ...(payload.media ? { media: payload.media } : {})
              })
            },
            onActivity: (act) => {
              broadcast({
                type: 'activity',
                accountId: req.accountId,
                activityCode: act.code,
                activityText: act.text,
                activityEmoji: act.emoji,
                busy: act.busy
              })
            },
            onApprovals: (pending) => {
              broadcast({
                type: 'approvals',
                accountId: req.accountId,
                pending
              })
            }
          }
        })
        return { ok: true, data: result }
      }
      default:
        return { ok: false, status: 400, message: 'Unknown Hermes RPC op' }
    }
  } catch (error) {
    if (error instanceof HermesApiError) {
      return {
        ok: false,
        status: error.status,
        code: error.code,
        message: error.message,
        body: typeof error.body === 'string' ? error.body : error.body ? JSON.stringify(error.body) : undefined
      }
    }
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

let registered = false

export function registerHermesIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle(HERMES_CHANNELS.detectLocal, async (_event, customBaseUrl?: unknown): Promise<HermesLocalDetection> => {
    const local = readLocalHermesEnv()
    const targetUrl =
      typeof customBaseUrl === 'string' && customBaseUrl.trim()
        ? (() => {
            try {
              return normalizeHermesBaseUrl(customBaseUrl)
            } catch {
              return local.baseUrl
            }
          })()
        : local.baseUrl
    const probe = await probeHermesServer({
      baseUrl: targetUrl,
      apiKey: local.apiKey
    })
    return {
      reachable: probe.reachable,
      baseUrl: targetUrl,
      version: probe.version,
      platform: probe.platform,
      hasLocalEnvKey: local.hasApiKey,
      localEnvHost: local.host,
      localEnvPort: local.port,
      requiresAuth: probe.requiresAuth
    }
  })

  ipcMain.handle(HERMES_CHANNELS.configure, async (_event, request: unknown): Promise<HermesAuthStatus> => {
    if (typeof request !== 'object' || request === null) {
      throw new TypeError('Invalid hermes configure request')
    }
    const req = request as HermesConfigureRequest
    const accountId = typeof req.accountId === 'string' ? req.accountId.trim() : ''
    if (!accountId) throw new TypeError('accountId required')
    const baseUrl = normalizeHermesBaseUrl(req.baseUrl)

    let effectiveKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
    if (!effectiveKey && req.useLocalKey) {
      const local = readLocalHermesEnv()
      if (local.apiKey) effectiveKey = local.apiKey
    }
    if (!effectiveKey && req.keepExistingKey) {
      const prev = getHermesAccount(accountId)
      if (prev?.apiKey) effectiveKey = prev.apiKey
    }

    const probe = await probeHermesServer({
      accountId,
      baseUrl,
      apiKey: effectiveKey || undefined
    })
    if (!probe.reachable || !probe.authenticated) {
      return {
        accountId,
        signedIn: false,
        baseUrl,
        version: probe.version,
        hasApiKey: Boolean(effectiveKey),
        error: probe.error || '无法验证 Hermes API Server 连接'
      }
    }

    const saved = await saveHermesAccount({
      accountId,
      baseUrl,
      apiKey: effectiveKey || undefined,
      keepExistingKey: Boolean(req.keepExistingKey && !effectiveKey),
      displayName: req.displayName?.trim() || 'Hermes',
      model: req.model?.trim() || probe.defaultModel
    })

    const handle = hermesHandleFromUrl(saved.baseUrl, saved.model)
    broadcast({
      type: 'login',
      accountId,
      signedIn: true,
      handle,
      displayName: saved.displayName || 'Hermes'
    })

    const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => false))
    return {
      accountId,
      signedIn: true,
      baseUrl: saved.baseUrl,
      handle,
      displayName: saved.displayName || 'Hermes',
      model: saved.model,
      version: probe.version,
      hasApiKey: saved.hasApiKey,
      hasProxy,
      supportsSessions: probe.supportsSessions
    }
  })

  ipcMain.handle(HERMES_CHANNELS.authStatus, async (_event, accountId: unknown): Promise<HermesAuthStatus> => {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new TypeError('Invalid accountId')
    }
    return statusFor(accountId.trim(), true)
  })

  ipcMain.handle(HERMES_CHANNELS.listAccounts, async (): Promise<HermesAuthStatus[]> => {
    const records = listHermesAccountRecords()
    return Promise.all(records.map((r) => statusFor(r.accountId, false)))
  })

  ipcMain.handle(HERMES_CHANNELS.clearAuth, async (_event, accountId: unknown): Promise<HermesAuthStatus> => {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new TypeError('Invalid accountId')
    }
    const id = accountId.trim()
    cancelAllHermesRuns(id)
    await clearHermesAccount(id)
    broadcast({ type: 'login', accountId: id, signedIn: false })
    return { accountId: id, signedIn: false }
  })

  ipcMain.handle(HERMES_CHANNELS.rpc, async (_event, request: unknown): Promise<HermesRpcResponse> => {
    if (typeof request !== 'object' || request === null) {
      return { ok: false, status: 0, message: 'Invalid hermes rpc request' }
    }
    const req = request as HermesRpcRequest
    if (typeof req.accountId !== 'string' || typeof req.op !== 'string') {
      return { ok: false, status: 0, message: 'accountId and op required' }
    }
    return runHermesRpc(req)
  })
}
