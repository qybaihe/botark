import { statusAfterSendFailure } from '../sendFailure'
import { createId } from '@shared/id'
import { decodeTranscriptBody, parseGrokTranscriptEntry } from '../../main/grok/grokTranscriptDecoder'
import { grokRpc, type GrokRequest } from './grokRequests'
import { GrokConnectError } from './connectClient'
import { grokApprovalRpcRequest, type GrokApprovalKind } from './approvals'
import { clearGrokAuth, getGrokAuth, setGrokAuth } from './tokenStore'
import type { GrokAgentSummary, GrokAuthSession } from './types'
import {
  AdapterError,
  type AdapterEvent,
  type AdapterListener,
  type ApprovalDecision,
  type ConnectionStatus,
  type IncomingMessage,
  type MuseApproval,
  type MuseOptionWidget,
  type OutgoingMessage,
  type PlatformAccount,
  type PlatformAdapter,
  type SendReceipt,
  type Unsubscribe
} from '../types'

function mapAgent(raw: Record<string, unknown>): GrokAgentSummary {
  return {
    id: String(raw['agentId'] ?? raw['agent_id'] ?? raw['legacyAgentId'] ?? raw['id'] ?? ''),
    name: String(raw['name'] ?? raw['title'] ?? 'Grok Bot'),
    description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
    harness: typeof raw['harness'] === 'string' ? raw['harness'] : undefined,
    visibility: typeof raw['visibility'] === 'string' ? raw['visibility'] : undefined,
    avatarShape:
      typeof raw['avatarShape'] === 'string'
        ? raw['avatarShape']
        : typeof raw['avatar_shape'] === 'string'
          ? raw['avatar_shape']
          : undefined,
    avatarColor:
      typeof raw['avatarColor'] === 'string'
        ? raw['avatarColor']
        : typeof raw['avatar_color'] === 'string'
          ? raw['avatar_color']
          : undefined,
    voiceId:
      typeof raw['voiceId'] === 'string'
        ? raw['voiceId']
        : typeof raw['voice_id'] === 'string'
          ? raw['voice_id']
          : undefined,
    isGroup: Boolean(raw['isGroup'] ?? raw['is_group']),
    unreadCount:
      typeof raw['unreadCount'] === 'number'
        ? raw['unreadCount']
        : typeof raw['unread_count'] === 'number'
          ? raw['unread_count']
          : undefined,
    lastMessageId: typeof raw['lastMessageId'] === 'string' ? raw['lastMessageId'] : undefined,
    awaitingUserResponse: Boolean(raw['awaitingUserResponse'] ?? raw['awaiting_user_response'])
  }
}

export function extractAgents(payload: unknown): GrokAgentSummary[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  const list =
    (Array.isArray(root['agents']) && root['agents']) ||
    (Array.isArray(root['rows']) && root['rows']) ||
    (Array.isArray(root['agent']) && root['agent']) ||
    []
  return (list as Record<string, unknown>[]).map(mapAgent).filter((a) => a.id)
}

type GrokReplyRow = Pick<IncomingMessage, 'id' | 'text' | 'widgets' | 'richWidgets' | 'media' | 'tools'> & {
  role: string
  clientNonce?: string
  requestId?: string
  isStreaming?: boolean
}

function findTranscriptReply(payload: unknown, afterMessageId?: string): GrokReplyRow | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const page = payload as Record<string, unknown>
  const rows: GrokReplyRow[] = Array.isArray(page['hydrated'])
    ? page['hydrated'].filter((row): row is GrokReplyRow => Boolean(row && typeof row.id === 'string' && typeof row.text === 'string'))
    : (Array.isArray(page['entries']) ? page['entries'] : Array.isArray(page['items']) ? page['items'] : [])
      .flatMap((row) => {
        const item = parseGrokTranscriptEntry(row, '')
        return item ? [{
          id: item.entryId, text: item.text, role: item.role, clientNonce: item.clientNonce, requestId: item.requestId,
          isStreaming: item.isStreaming, widgets: item.widgets, richWidgets: item.richWidgets, media: item.media
        }] : []
      })
  const anchor = afterMessageId ? rows.findIndex((row) => row.role === 'user' &&
    (row.id === afterMessageId || row.clientNonce === afterMessageId)) : -1
  if (afterMessageId && anchor === -1) return undefined
  const requestId = rows[anchor]?.requestId
  const following = rows.slice(anchor + 1)
  const nextPrompt = anchor >= 0 ? following.findIndex((row) => row.role === 'user') : -1
  return following.findLast((row, index) => (row.role === 'assistant' || row.role === 'bot') && !row.isStreaming &&
    (requestId && row.requestId ? row.requestId === requestId : nextPrompt < 0 || index < nextPrompt) &&
    Boolean(row.text.trim() || row.widgets?.length || row.richWidgets?.length || row.media?.length))
}

export function extractReplyText(entries: unknown, afterMessageId?: string): string {
  return findTranscriptReply(entries, afterMessageId)?.text.trim() ?? ''
}

function maxUpdatedSeq(entries: unknown): string {
  if (!entries || typeof entries !== 'object') return '0'
  const root = entries as Record<string, unknown>
  const list = (Array.isArray(root['entries']) ? root['entries'] : []) as Record<string, unknown>[]
  let max = 0n
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const e = decodeTranscriptBody(raw)
    for (const key of ['updatedSeq', 'updated_seq', 'seq', 'currentUpdatedSeq'] as const) {
      const v = e[key]
      if (v == null) continue
      try {
        const n = BigInt(String(v))
        if (n > max) max = n
      } catch {
        /* ignore */
      }
    }
  }
  const top = root['currentUpdatedSeq'] ?? root['current_updated_seq'] ?? root['updatedSeq'] ?? root['updated_seq']
  if (top != null) {
    try {
      const n = BigInt(String(top))
      if (n > max) max = n
    } catch {
      /* ignore */
    }
  }
  return max.toString()
}

function mapRawApprovalToMuseApproval(raw: Record<string, unknown>): MuseApproval {
  const opts = Array.isArray(raw['decisionOptions'])
    ? (raw['decisionOptions'] as ApprovalDecision[])
    : (['allow_once', 'allow_always', 'deny'] as ApprovalDecision[])
  return {
    id: String(raw['id'] ?? raw['requestId'] ?? createId('appr')),
    approvalType: String(raw['kind'] ?? raw['approvalType'] ?? 'auto-review'),
    status: String(raw['status'] ?? 'pending'),
    title: String(raw['title'] ?? 'Grok Bot 请求审批'),
    detail: typeof raw['detail'] === 'string' ? raw['detail'] : undefined,
    reason: typeof raw['reason'] === 'string' ? raw['reason'] : undefined,
    host: typeof raw['host'] === 'string' ? raw['host'] : undefined,
    decisionOptions: opts,
    raw
  }
}

async function invokeGrokRpc(request: GrokRequest, signal?: AbortSignal): Promise<unknown> {
  const bridge = typeof window !== 'undefined' ? window.electron?.grok : undefined
  if (!bridge?.rpc) {
    throw new AdapterError('not-connected', 'Grok IPC unavailable (Electron main required)')
  }
  const res = await grokRpc(bridge, request, signal)
  if (!res.ok) {
    throw new GrokConnectError(res.status, res.body ?? res.message, res.code)
  }
  return res.data
}

/**
 * Grok Bot 0.79.3 platform adapter.
 * ConnectRPC unary & persistent streaming run in Electron main via IPC + per-account proxy.
 */
export class GrokBotAdapter implements PlatformAdapter {
  readonly id = 'grok' as const
  readonly name = 'Grok Bot'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private readonly agentsByAccount = new Map<string, GrokAgentSummary[]>()
  private readonly rosterRequests = new Map<string, Promise<GrokAgentSummary[]>>()
  private readonly pendingApprovals = new Map<string, MuseApproval[]>()
  private readonly agentForConversation = new Map<string, Map<string, string>>()
  private mainEventWired = false

  private getConvAgentMap(accountId: string): Map<string, string> {
    let map = this.agentForConversation.get(accountId)
    if (!map) {
      map = new Map<string, string>()
      this.agentForConversation.set(accountId, map)
    }
    return map
  }

  private getBoundAgentId(accountId: string, conversationId: string): string | undefined {
    return (
      this.agentForConversation.get(accountId)?.get(conversationId) ??
      this.agentForConversation.get('*')?.get(conversationId)
    )
  }

  private ensureMainEventWired(): void {
    if (this.mainEventWired) return
    const bridge = typeof window !== 'undefined' ? window.electron?.grok : undefined
    if (!bridge?.onEvent) return
    this.mainEventWired = true
    bridge.onEvent((ev) => {
      if (ev.type === 'auth') {
        if (ev.signedIn) {
          this.setAuth({
            accountId: ev.accountId,
            signedIn: true,
            accountSlot: ev.accountSlot,
            teamId: ev.teamId,
            machineId: ev.machineId
          })
          this.emit({
            type: 'login',
            accountId: ev.accountId,
            signedIn: true,
            handle: ev.accountSlot,
            displayName: ev.accountSlot
          })
        } else {
          clearGrokAuth(ev.accountId)
          this.rosterRequests.delete(ev.accountId)
          this.agentsByAccount.delete(ev.accountId)
          this.pendingApprovals.delete(ev.accountId)
          this.setStatus(
            ev.accountId,
            'offline',
            ev.windowClosed ? '登录窗口已关闭，未完成授权' : '已退出 Grok Bot'
          )
          this.emit({
            type: 'login',
            accountId: ev.accountId,
            signedIn: false,
            windowClosed: ev.windowClosed
          })
        }
      } else if (ev.type === 'stream') {
        if (ev.done) {
          if (this.getStatus(ev.accountId) !== 'online') {
            this.setStatus(ev.accountId, 'online')
          }
        } else if (this.getStatus(ev.accountId) === 'offline') {
          this.setStatus(ev.accountId, 'busy')
        }
      } else if (ev.type === 'activity') {
        if (!ev.busy && this.getStatus(ev.accountId) !== 'online') {
          this.setStatus(ev.accountId, 'online')
        } else if (ev.busy && this.getStatus(ev.accountId) === 'offline') {
          this.setStatus(ev.accountId, 'busy')
        }
      } else if (ev.type === 'approvals') {
        const list = (Array.isArray(ev.pending) ? ev.pending : [])
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
          .map(mapRawApprovalToMuseApproval)
        this.pendingApprovals.set(ev.accountId, list)
        if (this.getStatus(ev.accountId) === 'offline' && list.length > 0) {
          this.setStatus(ev.accountId, 'attention')
        }
        this.emit({ type: 'approvals', accountId: ev.accountId, pending: list })
      } else if (ev.type === 'roster_changed') {
        if (this.getStatus(ev.accountId) === 'offline') {
          this.setStatus(ev.accountId, 'online')
        }
        void this.refreshAgents(ev.accountId).catch(() => undefined)
      }
    })
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[grok] listener failed', error)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  private requireAuth(accountId: string) {
    const auth = getGrokAuth(accountId)
    if (!auth || auth.signedIn === false) {
      throw new AdapterError(
        'not-connected',
        'Sign in to Grok Bot first (Sand PKCE login or paste token/API key).'
      )
    }
    return auth
  }

  setAuth(session: GrokAuthSession): void {
    this.ensureMainEventWired()
    const previous = getGrokAuth(session.accountId)
    if (previous && (previous.accountSlot !== session.accountSlot || previous.teamId !== session.teamId)) {
      this.rosterRequests.delete(session.accountId)
      this.agentsByAccount.delete(session.accountId)
      this.agentForConversation.delete(session.accountId)
      this.pendingApprovals.delete(session.accountId)
    }
    setGrokAuth({ ...session, signedIn: true })
    if (!this.accounts.has(session.accountId)) {
      this.accounts.set(session.accountId, {
        id: session.accountId,
        platformId: 'grok',
        displayName: session.accountSlot ?? 'Grok account',
        handle: session.accountSlot ?? session.accountId
      })
    }
    this.setStatus(session.accountId, 'online')
  }

  clearAuth(accountId: string): void {
    clearGrokAuth(accountId)
    this.rosterRequests.delete(accountId)
    this.agentsByAccount.delete(accountId)
    this.agentForConversation.delete(accountId)
    this.pendingApprovals.delete(accountId)
    this.setStatus(accountId, 'offline', 'Signed out')
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  upsertAccount(account: PlatformAccount): void {
    this.ensureMainEventWired()
    this.accounts.set(account.id, account)
    if (!this.statuses.has(account.id)) this.statuses.set(account.id, 'offline')
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    this.ensureMainEventWired()
    if (!this.accounts.has(accountId)) {
      this.upsertAccount({
        id: accountId,
        platformId: 'grok',
        displayName: 'Grok account',
        handle: accountId
      })
    }
    // Hydrate session metadata from main safeStorage (no raw Bearer token needed in renderer).
    if (!getGrokAuth(accountId)?.signedIn) {
      try {
        const bridge = typeof window !== 'undefined' ? window.electron : undefined
        const session = await bridge?.grok?.getSession?.(accountId)
        if (session?.signedIn) {
          this.setAuth({
            accountId,
            signedIn: true,
            accountSlot: session.accountSlot,
            teamId: session.teamId,
            machineId: session.machineId
          })
        }
      } catch {
        /* ignore hydrate errors */
      }
    }
    if (!getGrokAuth(accountId)?.signedIn) {
      this.setStatus(accountId, 'offline', '需要 Grok / Cursor 登录')
      return 'offline'
    }
    try {
      const agents = await this.refreshAgents(accountId)
      await this.syncWatchTargets(accountId)
      this.setStatus(
        accountId,
        agents.length ? 'online' : 'busy',
        agents.length ? undefined : '已登录，但暂无可用 Agent'
      )
      return this.getStatus(accountId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', detail)
      return 'error'
    }
  }

  async disconnect(accountId: string): Promise<void> {
    try {
      await invokeGrokRpc({ accountId, op: 'stopWatch' })
    } catch {
      /* ignore */
    }
    this.setStatus(accountId, 'offline')
  }

  async openLogin(accountId: string, _botId?: string): Promise<ConnectionStatus> {
    this.ensureMainEventWired()
    if (!this.accounts.has(accountId)) {
      this.upsertAccount({
        id: accountId,
        platformId: 'grok',
        displayName: 'Grok account',
        handle: accountId
      })
    }
    try {
      const bridge = typeof window !== 'undefined' ? window.electron : undefined
      if (bridge?.grok?.openLogin) {
        await bridge.grok.openLogin({ accountId })
      } else if (typeof window !== 'undefined') {
        window.open('https://authenticator.cursor.sh', '_blank', 'noopener,noreferrer')
      }
    } catch (error) {
      this.setStatus(accountId, 'error', error instanceof Error ? error.message : String(error))
      return 'error'
    }
    // Keep status 'offline' until auth actually completes (`usePlatformLogin` treats 'busy' as already signed-in).
    if (!getGrokAuth(accountId)?.signedIn) {
      this.setStatus(accountId, 'offline', '请在弹出的窗口完成 Grok Bot 登录…')
      return 'offline'
    }
    return this.getStatus(accountId)
  }

  async cancelLogin(accountId: string): Promise<void> {
    const bridge = typeof window !== 'undefined' ? window.electron : undefined
    await bridge?.grok?.cancelLogin?.(accountId).catch(() => undefined)
    if (!getGrokAuth(accountId)?.signedIn) {
      this.accounts.delete(accountId)
      this.statuses.delete(accountId)
    }
  }

  private async syncWatchTargets(accountId: string): Promise<void> {
    const agents = this.agentsByAccount.get(accountId) ?? []
    const convMap: Record<string, string[]> = {}
    const accountConvs = this.agentForConversation.get(accountId)
    if (accountConvs) {
      for (const [convId, agentId] of accountConvs.entries()) {
        if (!agentId || !convId) continue
        const list = convMap[agentId] ?? []
        if (!list.includes(convId)) list.push(convId)
        convMap[agentId] = list
      }
    }
    try {
      const res = (await invokeGrokRpc({
        accountId,
        op: 'ensureWatch',
        agentIds: agents.map((a) => a.id),
        conversationMap: convMap
      })) as { approvals?: Array<Record<string, unknown>> } | undefined
      if (res && Array.isArray(res.approvals)) {
        const mapped = res.approvals.map(mapRawApprovalToMuseApproval)
        this.pendingApprovals.set(accountId, mapped)
        this.emit({ type: 'approvals', accountId, pending: mapped })
      }
    } catch {
      /* watch is best-effort */
    }
  }

  refreshAgents(accountId: string): Promise<GrokAgentSummary[]> {
    this.requireAuth(accountId)
    const pending = this.rosterRequests.get(accountId)
    if (pending) return pending
    const request = invokeGrokRpc({
      accountId,
      op: 'listAgents',
      includeTeamAgents: true,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }).then((payload) => {
      const agents = extractAgents(payload)
      if (this.rosterRequests.get(accountId) !== request) return []
      this.agentsByAccount.set(accountId, agents)
      return agents
    }).finally(() => {
      if (this.rosterRequests.get(accountId) === request) this.rosterRequests.delete(accountId)
    })
    this.rosterRequests.set(accountId, request)
    return request
  }

  listCachedAgents(accountId: string): GrokAgentSummary[] {
    return this.agentsByAccount.get(accountId) ?? []
  }

  bindConversationAgent(conversationId: string, agentId: string, accountId?: string): void {
    if (conversationId.startsWith('room-turn-')) return
    this.getConvAgentMap(accountId || '*').set(conversationId, agentId)
    if (accountId && getGrokAuth(accountId)?.signedIn) {
      void this.syncWatchTargets(accountId)
    }
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    this.ensureMainEventWired()
    message.signal?.throwIfAborted()

    if (!getGrokAuth(message.accountId)?.signedIn) {
      try {
        const bridge = typeof window !== 'undefined' ? window.electron : undefined
        const session = await bridge?.grok?.getSession?.(message.accountId)
        if (session?.signedIn) {
          this.setAuth({
            accountId: message.accountId,
            signedIn: true,
            accountSlot: session.accountSlot,
            teamId: session.teamId,
            machineId: session.machineId
          })
        }
      } catch {
        /* ignore */
      }
    }

    const auth = this.requireAuth(message.accountId)

    let agents = this.agentsByAccount.get(message.accountId)
    if (!agents?.length) {
      agents = await raceWithAbort(this.refreshAgents(message.accountId), message.signal)
    }
    const agentId =
      message.agentId ?? this.getBoundAgentId(message.accountId, message.conversationId) ?? agents[0]?.id
    if (!agentId) throw new AdapterError('unknown-account', 'No Grok Bot agents on this account.')

    if (!message.conversationId.startsWith('room-turn-')) {
      this.getConvAgentMap(message.accountId).set(message.conversationId, agentId)
      void this.syncWatchTargets(message.accountId)
    }

    const messageId = createId('tNu')
    const sessionId = message.sessionId ?? ''
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

    this.setStatus(message.accountId, 'busy')
    this.emit({
      type: 'typing',
      conversationId: message.conversationId,
      accountId: message.accountId,
      isTyping: true
    })

    const requestId = createId('grok_send')
    const controller = new AbortController()
    const signal = message.signal ? AbortSignal.any([message.signal, controller.signal]) : controller.signal
    const call = (request: GrokRequest) => invokeGrokRpc({ ...request, requestId }, signal)
    const sentAtMs = Date.now()
    try {
      let afterSeq = '0'
      try {
        afterSeq = maxUpdatedSeq(await call({
          accountId: message.accountId, timeZone, op: 'listTranscriptEntries', agentId,
          sessionId, limit: 5, watermarkOnly: true
        }))
      } catch { signal.throwIfAborted() }

      const attachments = message.attachments?.flatMap((a) => a.dataBase64 ? [{
        name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64, size: a.size
      }] : [])
      await call({
        accountId: message.accountId, timeZone, op: 'sendUserMessage', agentId, messageId,
        text: message.text, sessionId, machineId: auth.machineId, sentAtMs,
        replyToId: message.replyToId, replyQuote: message.replyQuote, attachments
      })
      const acceptedAt = Date.now()
      message.onAccepted?.()
      if (sessionId && !message.conversationId.startsWith('room-turn-')) {
        void invokeGrokRpc({ op: 'ensureWatch', accountId: message.accountId, timeZone,
          targets: [{ agentId, sessionId, conversationId: message.conversationId }]
        }).catch(() => undefined)
      }

      type Bubble = Pick<GrokReplyRow, 'text' | 'widgets' | 'richWidgets' | 'tools' | 'media'> & { messageId?: string }
      let bubbles: Bubble[] = []
      let replyAnchor = messageId
      const watched = await call({
        accountId: message.accountId, timeZone, op: 'watchUntilReply', agentId, sessionId,
        conversationId: message.conversationId, afterUpdatedSeq: afterSeq, afterMessageId: messageId,
        timeoutMs: 600_000
      }).catch((error) => {
        signal.throwIfAborted()
        if (error instanceof GrokConnectError && (error.code === 'aborted' || error.status === 401 || error.status === 403)) throw error
        return undefined
      }) as (Bubble & { messages?: Bubble[]; echoEntryId?: string; turnFailed?: { code?: string; summary?: string } }) | undefined
      if (watched?.turnFailed) {
        throw new AdapterError('no-reply', watched.turnFailed.summary || `Turn failed (${watched.turnFailed.code})`)
      }
      if (watched?.echoEntryId) replyAnchor = watched.echoEntryId
      if (Array.isArray(watched?.messages) && watched.messages.length) bubbles = watched.messages
      else if (watched && (watched.text || watched.widgets?.length || watched.richWidgets?.length || watched.media?.length)) {
        bubbles = [watched]
      }

      for (let attempt = 0; bubbles.length === 0 && attempt < 15; attempt++) {
        if (attempt > 0) await sleep(1000, signal)
        try {
          const history = await call({ accountId: message.accountId, timeZone, op: 'listTranscriptEntries', agentId, sessionId, limit: 40 })
          const reply = findTranscriptReply(history, replyAnchor) ??
            (replyAnchor === messageId ? undefined : findTranscriptReply(history, messageId))
          if (reply) bubbles = [{
            messageId: reply.id, text: reply.text, widgets: reply.widgets,
            richWidgets: reply.richWidgets, media: reply.media, tools: reply.tools
          }]
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof GrokConnectError && (error.code === 'aborted' || error.status === 401 || error.status === 403)) throw error
        }
      }

      signal.throwIfAborted()
      for (const { messageId: replyId, ...bubble } of bubbles) {
        this.emit({
          type: 'message',
          message: {
            ...bubble,
            id: replyId ? (replyId.startsWith('grok_') ? replyId : `grok_${replyId}`) : createId('msg'),
            conversationId: message.conversationId, accountId: message.accountId,
            sessionId: sessionId || undefined, createdAt: Date.now()
          }
        })
      }
      this.setStatus(message.accountId, 'online')
      return { messageId, acceptedAt, ...(bubbles.length ? {} : { noReply: true }) }
    } catch (error) {
      if (message.signal?.aborted) {
        if (getGrokAuth(message.accountId)?.signedIn) this.setStatus(message.accountId, 'online')
        throw error
      }
      if (error instanceof GrokConnectError && error.code === 'aborted') throw error
      const detail = error instanceof Error ? error.message : String(error)
      const next = statusAfterSendFailure(error)
      this.setStatus(message.accountId, next, next === 'error' ? detail : undefined)
      throw error instanceof AdapterError ? error : new AdapterError('network', detail)
    } finally {
      controller.abort()
      this.emit({
        type: 'typing', conversationId: message.conversationId, accountId: message.accountId, isTyping: false
      })
    }
  }

  async selectOptionWidget(args: {
    accountId: string
    conversationId: string
    hostMessageId: string
    widget: MuseOptionWidget
    selectedText: string
    optionIndex: number
    sessionId?: string
    agentId?: string
  }): Promise<void> {
    this.requireAuth(args.accountId)
    const agents = this.agentsByAccount.get(args.accountId) ?? []
    const agentId =
      args.agentId ?? this.getBoundAgentId(args.accountId, args.conversationId) ?? agents[0]?.id
    if (!agentId) throw new AdapterError('unknown-account', 'No Grok Bot agent selected.')

    const value = args.widget.optionValues?.[args.optionIndex] ?? args.selectedText
    const entryId =
      args.widget.entryId ?? args.hostMessageId.replace(/^grok_/, '')

    if (args.widget.widgetSource === 'grok-card') {
      await invokeGrokRpc({
        accountId: args.accountId,
        op: 'answerMessagingCard',
        cardId: entryId,
        version: args.widget.cardVersion ?? args.widget.baseVersion ?? 1,
        answer: 'CHOOSE',
        optionId: value
      })
      return
    }

    await invokeGrokRpc({
      accountId: args.accountId,
      op: 'respondWidget',
      agentId,
      entryId,
      value,
      sessionId: args.sessionId ?? ''
    })
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.ensureMainEventWired()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onMessage(listener: (message: IncomingMessage) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === 'message') listener(event.message)
    })
  }

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }

  async listApprovals(accountId: string): Promise<MuseApproval[]> {
    try {
      const res = (await invokeGrokRpc({ accountId, op: 'listApprovals' })) as
        | { pending?: Array<Record<string, unknown>> }
        | undefined
      if (res && Array.isArray(res.pending)) {
        const list = res.pending.map(mapRawApprovalToMuseApproval)
        this.pendingApprovals.set(accountId, list)
        return list
      }
    } catch {
      /* fallback to memory */
    }
    return this.pendingApprovals.get(accountId) ?? []
  }

  async decideApproval(
    accountId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    this.requireAuth(accountId)
    const pending = this.pendingApprovals.get(accountId) ?? []
    const card = pending.find((a) => a.id === approvalId)
    const raw = (card?.raw ?? {}) as Record<string, unknown>
    const kind = (card?.approvalType ?? raw['kind'] ?? 'auto-review') as GrokApprovalKind
    const agentId = String(
      raw['agentId'] ?? raw['agent_id'] ?? this.agentsByAccount.get(accountId)?.[0]?.id ?? ''
    )
    const requestId = String(raw['requestId'] ?? raw['request_id'] ?? approvalId)
    const entryId = typeof raw['entryId'] === 'string' ? raw['entryId'] : undefined
    const cardVersion = typeof raw['cardVersion'] === 'number' ? raw['cardVersion'] : undefined
    const sessionId = typeof raw['sessionId'] === 'string' ? raw['sessionId'] : ''

    if (!agentId && kind !== 'messaging-card') {
      throw new AdapterError('unknown-account', 'No agent for approval.')
    }

    await invokeGrokRpc(
      grokApprovalRpcRequest(accountId, kind, {
        agentId,
        requestId,
        entryId,
        cardVersion,
        decision,
        sessionId
      })
    )

    const next = pending.filter((a) => a.id !== approvalId)
    this.pendingApprovals.set(accountId, next)
    this.emit({ type: 'approvals', accountId, pending: next })
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(new AdapterError('network', 'Aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AdapterError('network', 'Aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new AdapterError('network', 'Aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AdapterError('network', 'Aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

export function createGrokBotAdapter(): GrokBotAdapter {
  return new GrokBotAdapter()
}
