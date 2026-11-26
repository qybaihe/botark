import { BrowserWindow, ipcMain } from 'electron'
import {
  DS_BOT_CHANNELS,
  type DsBotAuthStatus,
  type DsBotConfigureRequest,
  type DsBotLocalDetection,
  type DsBotMainEvent,
  type DsBotRpcRequest,
  type DsBotRpcResponse
} from '@shared/ipc'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import {
  addDsBotMemory,
  answerDsBotQuestion,
  cancelAllDsBotRuns,
  createDsBotMember,
  decideDsBotApproval,
  deleteDsBotSchedule,
  detectLocalDsBot,
  DsBotApiError,
  forgetDsBotMemory,
  getDsBotHistory,
  getDsBotMemory,
  getDsBotTeamState,
  getDsBotUsage,
  listDsBotModels,
  listDsBotSchedules,
  listDsBotTargets,
  listDsBotWaiting,
  probeDsBotConnection,
  sendDsBotMessage,
  setDsBotEventBroadcaster,
  setDsBotModel,
  startDsBotChannelFeed,
  stopDsBotRun,
  toggleDsBotSchedule
} from './dsBotClient'
import {
  clearDsBotAccount,
  dsBotHandleForAccount,
  getDsBotAccount,
  getDsBotAccountMetadata,
  getDsBotAccountRevision,
  listDsBotAccountRecords,
  normalizeDsBotChannelUrl,
  normalizeDsBotMcpUrl,
  sameDsBotOrigin,
  saveDsBotAccount
} from './dsBotStore'

function broadcast(payload: DsBotMainEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(DS_BOT_CHANNELS.event, payload)
  }
}

function capabilitiesForMode(mode: 'mcp' | 'channel' | 'relay') {
  const isNative = mode === 'channel' || mode === 'relay'
  return {
    supportsLiveStream: isNative,
    supportsApprovals: isNative,
    supportsMemory: isNative,
    supportsSchedules: isNative,
    supportsImages: isNative
  }
}

async function statusFor(accountId: string, verifyLive = true): Promise<DsBotAuthStatus> {
  const hasProxy = Boolean(await loadAccountProxyUrl(accountId).catch(() => false))
  let accMeta: ReturnType<typeof getDsBotAccountMetadata>
  let resolved: ReturnType<typeof getDsBotAccount> = null
  try {
    if (verifyLive) {
      resolved = getDsBotAccount(accountId)
      accMeta = resolved
    } else {
      accMeta = getDsBotAccountMetadata(accountId)
    }
  } catch (error) {
    return {
      accountId,
      signedIn: false,
      hasProxy,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (!accMeta) {
    return { accountId, signedIn: false, hasProxy }
  }
  const handle = dsBotHandleForAccount(accMeta)
  const caps = capabilitiesForMode(accMeta.mode)
  if (!verifyLive || !resolved) {
    return {
      accountId,
      signedIn: true,
      mode: accMeta.mode,
      baseUrl: accMeta.baseUrl,
      relayServer: accMeta.relayServer,
      hostDeviceId: accMeta.hostDeviceId,
      hostName: accMeta.hostName,
      handle,
      displayName: accMeta.displayName || accMeta.hostName || 'DS Bot',
      hasSecret: accMeta.hasSecret,
      hasProxy,
      ...caps
    }
  }

  const probe = await probeDsBotConnection({
    accountId,
    mode: resolved.mode,
    endpointUrl: resolved.baseUrl,
    secret: resolved.secret,
    ...(resolved.mode === 'relay' &&
    resolved.relayServer &&
    resolved.hostDeviceId &&
    resolved.hostKey &&
    resolved.deviceId &&
    resolved.publicKey &&
    resolved.privateKey &&
    resolved.accessToken
      ? {
          existingRelay: {
            relayServer: resolved.relayServer,
            hostDeviceId: resolved.hostDeviceId,
            hostKey: resolved.hostKey,
            hostName: resolved.hostName,
            deviceId: resolved.deviceId,
            publicKey: resolved.publicKey,
            privateKey: resolved.privateKey,
            accessToken: resolved.accessToken
          }
        }
      : {})
  })

  if (probe.authenticated && resolved.mode === 'channel') {
    startDsBotChannelFeed(accountId)
  }

  return {
    accountId,
    signedIn: probe.authenticated,
    mode: accMeta.mode,
    baseUrl: accMeta.baseUrl,
    relayServer: accMeta.relayServer,
    hostDeviceId: accMeta.hostDeviceId,
    hostName: probe.hostName || accMeta.hostName,
    handle,
    displayName: accMeta.displayName || probe.hostName || accMeta.hostName || 'DS Bot',
    version: probe.version,
    hasSecret: accMeta.hasSecret,
    hasProxy,
    botCount: probe.botCount,
    groupCount: probe.groupCount,
    ...caps,
    error: probe.error
  }
}

async function runDsBotRpc(req: DsBotRpcRequest): Promise<DsBotRpcResponse> {
  try {
    switch (req.op) {
      case 'listTargets':
        return { ok: true, data: await listDsBotTargets(req.accountId) }
      case 'getState':
        return { ok: true, data: await getDsBotTeamState(req.accountId) }
      case 'listModels':
        return { ok: true, data: await listDsBotModels(req.accountId) }
      case 'getHistory':
        return { ok: true, data: await getDsBotHistory(req.accountId, req.agentId) }
      case 'listWaiting':
        return { ok: true, data: await listDsBotWaiting(req.accountId) }
      case 'decideApproval':
        await decideDsBotApproval(req.accountId, req.approvalId, req.choice)
        return { ok: true, data: { ok: true } }
      case 'answerQuestion':
        await answerDsBotQuestion(req.accountId, req.sessionId, req.questionId, req.answer)
        return { ok: true, data: { ok: true } }
      case 'getMemory':
        return { ok: true, data: await getDsBotMemory(req.accountId, req.agentId) }
      case 'addMemory':
        return { ok: true, data: await addDsBotMemory(req.accountId, req.agentId, req.text, req.scope, req.topic) }
      case 'forgetMemory':
        return { ok: true, data: await forgetDsBotMemory(req.accountId, req.agentId, req.text, req.scope, req.topic) }
      case 'listSchedules':
        return { ok: true, data: await listDsBotSchedules(req.accountId) }
      case 'toggleSchedule':
        await toggleDsBotSchedule(req.accountId, req.scheduleId, req.sessionId, req.active)
        return { ok: true, data: { ok: true } }
      case 'deleteSchedule':
        await deleteDsBotSchedule(req.accountId, req.scheduleId, req.sessionId)
        return { ok: true, data: { ok: true } }
      case 'getUsage':
        return { ok: true, data: await getDsBotUsage(req.accountId, req.agentId) }
      case 'setBotModel':
        return { ok: true, data: await setDsBotModel(req.accountId, req.agentId, req.model) }
      case 'createBot':
        return {
          ok: true,
          data: await createDsBotMember(req.accountId, {
            name: req.name,
            role: req.role,
            model: req.model,
            instructions: req.instructions
          })
        }
      case 'stopRun':
        await stopDsBotRun(req.accountId, req.agentId, req.requestId)
        return { ok: true, data: { ok: true } }
      case 'sendMessage': {
        const result = await sendDsBotMessage({
          accountId: req.accountId,
          agentId: req.agentId,
          botId: req.botId,
          requestId: req.requestId,
          text: req.text,
          attachments: req.attachments,
          callbacks: {
            onAccepted: () => {
              if (req.requestId) {
                broadcast({
                  type: 'accepted',
                  accountId: req.accountId,
                  requestId: req.requestId,
                  agentId: req.agentId
                })
              }
            },
            onDelta: (payload) => {
              broadcast({
                type: 'stream',
                accountId: req.accountId,
                agentId: req.agentId,
                conversationId: req.botId,
                requestId: req.requestId,
                messageId: payload.messageId,
                text: payload.text,
                done: payload.done
              })
            },
            onActivity: (act) => {
              broadcast({
                type: 'activity',
                accountId: req.accountId,
                agentId: req.agentId,
                requestId: req.requestId,
                activityCode: act.code,
                activityText: act.text,
                activityEmoji: act.emoji,
                busy: act.busy
              })
            }
          }
        })
        return { ok: true, data: result }
      }
      default:
        return { ok: false, status: 400, message: 'Unknown DS Bot RPC op' }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, status: 0, code: 'aborted', message: error.message }
    }
    if (error instanceof DsBotApiError) {
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

export function registerDsBotIpc(): void {
  if (registered) return
  registered = true
  setDsBotEventBroadcaster(broadcast)

  ipcMain.handle(DS_BOT_CHANNELS.detectLocal, async (): Promise<DsBotLocalDetection> => {
    return detectLocalDsBot()
  })

  ipcMain.handle(DS_BOT_CHANNELS.configure, async (_event, req: DsBotConfigureRequest): Promise<DsBotAuthStatus> => {
    const accountId = (req?.accountId ?? '').trim()
    if (!accountId) throw new Error('accountId required')
    const revision = getDsBotAccountRevision(accountId)
    const prev = getDsBotAccount(accountId)

    let endpointUrl = req.endpointUrl?.trim()
    let secret = req.secret?.trim()

    if (req.mode === 'mcp') {
      const normalized = normalizeDsBotMcpUrl(endpointUrl ?? '')
      if (!secret && req.keepExistingSecret && prev?.mode === 'mcp' && sameDsBotOrigin(normalized, prev.baseUrl)) {
        secret = prev.secret
      }
      endpointUrl = normalized
    } else if (req.mode === 'channel') {
      const { baseUrl } = normalizeDsBotChannelUrl(endpointUrl ?? '')
      if (!secret && req.keepExistingSecret && prev?.mode === 'channel' && sameDsBotOrigin(baseUrl, prev.baseUrl)) {
        secret = prev.secret
      }
    }

    const probe = await probeDsBotConnection({
      accountId,
      mode: req.mode,
      endpointUrl,
      secret,
      pairingUri: req.pairingUri?.trim() || undefined,
      ...(req.mode === 'relay' && !req.pairingUri?.trim() && prev?.mode === 'relay' && prev.relayServer && prev.hostDeviceId && prev.hostKey && prev.deviceId && prev.publicKey && prev.privateKey && prev.accessToken
        ? {
            existingRelay: {
              relayServer: prev.relayServer,
              hostDeviceId: prev.hostDeviceId,
              hostKey: prev.hostKey,
              hostName: prev.hostName,
              deviceId: prev.deviceId,
              publicKey: prev.publicKey,
              privateKey: prev.privateKey,
              accessToken: prev.accessToken
            }
          }
        : {})
    })

    if (!probe.authenticated) {
      return {
        accountId,
        signedIn: false,
        mode: req.mode,
        baseUrl: endpointUrl,
        error: probe.error || '无法连接到 DS Bot'
      }
    }

    const saved = await saveDsBotAccount({
      accountId,
      mode: req.mode,
      expectedRevision: revision,
      displayName: req.displayName?.trim() || probe.hostName || undefined,
      baseUrl: req.mode === 'channel' ? normalizeDsBotChannelUrl(endpointUrl ?? '').baseUrl : endpointUrl,
      secret: probe.exchangedCookie || secret,
      keepExistingSecret: req.keepExistingSecret,
      ...(probe.pairedIdentity
        ? {
            relayServer: probe.pairedIdentity.relayServer,
            hostDeviceId: probe.pairedIdentity.hostDeviceId,
            hostKey: probe.pairedIdentity.hostKey,
            hostName: probe.pairedIdentity.hostName,
            deviceId: probe.pairedIdentity.deviceId,
            publicKey: probe.pairedIdentity.publicKey,
            privateKey: probe.pairedIdentity.privateKey,
            accessToken: probe.pairedIdentity.accessToken
          }
        : {})
    })

    if (saved.mode === 'channel') {
      startDsBotChannelFeed(accountId)
    }

    const handle = dsBotHandleForAccount(saved)
    const displayName = saved.displayName || saved.hostName || 'DS Bot'
    broadcast({ type: 'login', accountId, signedIn: true, handle, displayName })
    broadcast({ type: 'roster_changed', accountId })

    return {
      accountId,
      signedIn: true,
      mode: saved.mode,
      baseUrl: saved.baseUrl,
      relayServer: saved.relayServer,
      hostDeviceId: saved.hostDeviceId,
      hostName: saved.hostName,
      handle,
      displayName,
      version: probe.version,
      hasSecret: saved.hasSecret,
      hasProxy: Boolean(await loadAccountProxyUrl(accountId).catch(() => false)),
      botCount: probe.botCount,
      groupCount: probe.groupCount,
      ...capabilitiesForMode(saved.mode)
    }
  })

  ipcMain.handle(DS_BOT_CHANNELS.authStatus, async (_event, accountId: string): Promise<DsBotAuthStatus> => {
    return statusFor(accountId, true)
  })

  ipcMain.handle(DS_BOT_CHANNELS.listAccounts, async (): Promise<DsBotAuthStatus[]> => {
    const records = listDsBotAccountRecords()
    return Promise.all(records.map((rec) => statusFor(rec.accountId, false)))
  })

  ipcMain.handle(DS_BOT_CHANNELS.clearAuth, async (_event, accountId: string): Promise<DsBotAuthStatus> => {
    cancelAllDsBotRuns(accountId)
    await clearDsBotAccount(accountId)
    if (accountId !== '*') {
      broadcast({ type: 'login', accountId, signedIn: false })
    }
    return { accountId, signedIn: false }
  })

  ipcMain.handle(DS_BOT_CHANNELS.rpc, async (_event, req: DsBotRpcRequest): Promise<DsBotRpcResponse> => {
    return runDsBotRpc(req)
  })
}
