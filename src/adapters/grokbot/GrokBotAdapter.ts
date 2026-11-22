import { statusAfterSendFailure } from '../sendFailure'
import { createId } from '@shared/id'
import type { GrokRpcRequest, GrokRpcResponse } from '@shared/ipc'
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

function decodeEntryBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body = raw['body']
  if (typeof body === 'string' && body.length > 0) {
    try {
      const json = atob(body)
      const parsed = JSON.parse(json) as Record<string, unknown>
      return { ...raw, ...parsed }
    } catch {
      return raw
    }
  }
  return raw
}

function entryText(e: Record<string, unknown>): string {
  const rawMsg = e['message']
  const msg = rawMsg && typeof rawMsg === 'object' ? (rawMsg as Record<string, unknown>) : undefined
  const widget = msg?.['widget'] as Record<string, unknown> | undefined
  const text =
    (typeof e['text'] === 'string' && e['text']) ||
    (typeof e['content'] === 'string' && e['content']) ||
    (typeof rawMsg === 'string' && rawMsg) ||
    (typeof msg?.['text'] === 'string' && (msg['text'] as string)) ||
    (typeof msg?.['content'] === 'string' && (msg['content'] as string)) ||
    (typeof widget?.['prompt'] === 'string' && (widget['prompt'] as string)) ||
    (typeof widget?.['title'] === 'string' && (widget['title'] as string)) ||
    ''
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * Newest assistant text in a transcript page. With `afterMessageId`, only
 * entries newer than that user message count, and the message itself must
 * be on the page; otherwise the previous turn's answer was returned as the
 * reply to the new message.
 */
export function extractReplyText(entries: unknown, afterMessageId?: string): string {
  if (!entries || typeof entries !== 'object') return ''
  const root = entries as Record<string, unknown>
  const list = (
    Array.isArray(root['entries'])
      ? root['entries']
      : Array.isArray(root['items'])
        ? root['items']
        : []
  ) as Record<string, unknown>[]
  let candidate = ''
  for (let i = list.length - 1; i >= 0; i--) {
    const e = decodeEntryBody(list[i]!)
    const id = String(e['id'] ?? e['message_id'] ?? e['messageId'] ?? e['clientNonce'] ?? '')
    if (
      afterMessageId &&
      (id === afterMessageId || String(e['clientNonce'] ?? '') === afterMessageId)
    ) {
      return candidate
    }
    if (candidate) continue
    const role = String(e['role'] ?? '')
    const kind = String(e['kind'] ?? e['entryKind'] ?? e['type'] ?? '')
    if (/^user$/i.test(role) || /^user-attachment$/i.test(kind) || /^event$/i.test(kind)) continue
    const text = entryText(e)
    if (!text) continue
    if (
      /assistant|bot|message/i.test(role) ||
      /assistant|message|send-message|bot/i.test(kind) ||
      role === ''
    ) {
      if (!afterMessageId) return text
      candidate = text
    }
  }
  return ''
}

function maxUpdatedSeq(entries: unknown): string {
  if (!entries || typeof entries !== 'object') return '0'
  const root = entries as Record<string, unknown>
  const list = (Array.isArray(root['entries']) ? root['entries'] : []) as Record<string, unknown>[]
  let max = 0n
  for (const e of list) {
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
  const top = root['updatedSeq'] ?? root['updated_seq']
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

async function invokeGrokRpc(request: GrokRpcRequest): Promise<unknown> {
  const bridge = typeof window !== 'undefined' ? window.electron?.grok : undefined
  if (!bridge?.rpc) {
    throw new AdapterError('not-connected', 'Grok IPC unavailable (Electron main required)')
  }
  const res = (await bridge.rpc(request)) as GrokRpcResponse
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

  async refreshAgents(accountId: string): Promise<GrokAgentSummary[]> {
    this.requireAuth(accountId)
    const payload = await invokeGrokRpc({
      accountId,
      op: 'listAgents',
      includeTeamAgents: true,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    const agents = extractAgents(payload)
    this.agentsByAccount.set(accountId, agents)
    return agents
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
    if (message.signal?.aborted) {
      throw new AdapterError('network', 'Aborted')
    }

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

    try {
      let afterSeq = '0'
      try {
        const hist = await raceWithAbort(
          invokeGrokRpc({
            accountId: message.accountId,
            timeZone,
            op: 'listTranscriptEntries',
            agentId,
            sessionId,
            limit: 5
          }),
          message.signal
        )
        afterSeq = maxUpdatedSeq(hist)
      } catch (err) {
        if (message.signal?.aborted) throw err
        /* start from 0 */
      }

      const uploadableAttachments = (message.attachments ?? [])
        .filter((a): a is typeof a & { dataBase64: string } => Boolean(a.dataBase64))
        .map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          dataBase64: a.dataBase64,
          size: a.size
        }))

      await raceWithAbort(
        invokeGrokRpc({
          accountId: message.accountId,
          timeZone,
          op: 'sendUserMessage',
          agentId,
          messageId,
          text: message.text,
          sessionId,
          machineId: auth.machineId,
          replyToId: message.replyToId,
          replyQuote: message.replyQuote,
          ...(uploadableAttachments.length ? { attachments: uploadableAttachments } : {})
        }),
        message.signal
      )
      message.onAccepted?.()

      let reply = ''
      let replyMessageId = ''
      let replyWidgets: IncomingMessage['widgets']
      let replyTools: IncomingMessage['tools']
      let replyMedia: IncomingMessage['media']
      let turnFailed = false
      let multiBubbles: Array<{
        messageId: string
        text: string
        widgets?: IncomingMessage['widgets']
        tools?: IncomingMessage['tools']
        media?: IncomingMessage['media']
      }> = []

      try {
        const watched = await raceWithAbort(
          invokeGrokRpc({
            accountId: message.accountId,
            timeZone,
            op: 'watchUntilReply',
            agentId,
            conversationId: message.conversationId,
            sessionId,
            afterUpdatedSeq: afterSeq,
            afterMessageId: messageId,
            timeoutMs: 600_000
          }),
          message.signal
        )
        if (watched && typeof watched === 'object') {
          const w = watched as Record<string, unknown>
          const tf = w['turnFailed'] as { code?: string; summary?: string } | undefined
          if (tf && !w['text'] && !Array.isArray(w['messages'])) {
            turnFailed = true
            throw new AdapterError('network', tf.summary || `Turn failed (${tf.code})`)
          }
          if (Array.isArray(w['messages']) && w['messages'].length > 0) {
            multiBubbles = w['messages'] as typeof multiBubbles
          }
          if (typeof w['text'] === 'string') reply = w['text']
          else reply = extractReplyText(watched, messageId)
          if (typeof w['messageId'] === 'string') replyMessageId = w['messageId']
          if (Array.isArray(w['widgets'])) replyWidgets = w['widgets'] as IncomingMessage['widgets']
          if (Array.isArray(w['tools'])) replyTools = w['tools'] as IncomingMessage['tools']
          if (Array.isArray(w['media'])) replyMedia = w['media'] as IncomingMessage['media']
        }
      } catch (err) {
        if (message.signal?.aborted) throw err
        if (err instanceof AdapterError) throw err
      }

      if (
        !multiBubbles.length &&
        !reply &&
        !replyWidgets?.length &&
        !replyMedia?.length &&
        !turnFailed &&
        !message.signal?.aborted
      ) {
        // Fallback: poll listTranscriptEntries when watchUntilReply resolves empty or fails.
        for (let i = 0; i < 15; i++) {
          if (message.signal?.aborted) throw new AdapterError('network', 'Aborted')
          if (i > 0) await sleep(1000, message.signal)
          try {
            const hist = (await raceWithAbort(
              invokeGrokRpc({
                accountId: message.accountId,
                timeZone,
                op: 'listTranscriptEntries',
                agentId,
                sessionId,
                limit: 40
              }),
              message.signal
            )) as Record<string, unknown> | undefined
            reply = extractReplyText(hist, messageId)
            if (!reply && hist && Array.isArray(hist['entries'])) {
              const entriesList = hist['entries'] as Array<Record<string, unknown>>
              let baseSeq = 0n
              try {
                baseSeq = BigInt(afterSeq || '0')
              } catch {
                baseSeq = 0n
              }
              for (let j = entriesList.length - 1; j >= 0; j--) {
                const e = decodeEntryBody(entriesList[j]!)
                const senderObj =
                  e['sender'] && typeof e['sender'] === 'object'
                    ? (e['sender'] as Record<string, unknown>)
                    : undefined
                const role = String(e['role'] ?? senderObj?.['type'] ?? '')
                if (/^user$/i.test(role)) continue
                const rawSeq = e['updatedSeq'] ?? e['updated_seq'] ?? e['seq']
                let isNewer = false
                if (rawSeq != null) {
                  try {
                    isNewer = BigInt(String(rawSeq)) > baseSeq
                  } catch {
                    isNewer = false
                  }
                }
                if (isNewer) {
                  const candidateText = entryText(e)
                  if (candidateText) {
                    reply = candidateText
                    if (typeof e['entryId'] === 'string') replyMessageId = e['entryId']
                    else if (typeof e['id'] === 'string') replyMessageId = e['id']
                    break
                  }
                }
              }
            }
            if (!reply && hist && Array.isArray(hist['hydrated'])) {
              const hydrated = hist['hydrated'] as Array<Record<string, unknown>>
              const anchorIdx = hydrated.findIndex((item) => item['id'] === messageId)
              if (anchorIdx >= 0) {
                for (let j = hydrated.length - 1; j > anchorIdx; j--) {
                  const item = hydrated[j]!
                  if (item['role'] === 'bot') {
                    const t = typeof item['text'] === 'string' ? item['text'].trim() : ''
                    if (t || Array.isArray(item['widgets']) || Array.isArray(item['media'])) {
                      reply = t
                      if (typeof item['id'] === 'string') replyMessageId = item['id']
                      if (Array.isArray(item['widgets'])) {
                        replyWidgets = item['widgets'] as IncomingMessage['widgets']
                      }
                      if (Array.isArray(item['tools'])) {
                        replyTools = item['tools'] as IncomingMessage['tools']
                      }
                      if (Array.isArray(item['media'])) {
                        replyMedia = item['media'] as IncomingMessage['media']
                      }
                      break
                    }
                  }
                }
              }
            }
            if (reply || replyWidgets?.length || replyMedia?.length) break
          } catch (pollErr) {
            if (message.signal?.aborted) throw pollErr
            /* keep polling */
          }
        }
      }

      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        accountId: message.accountId,
        isTyping: false
      })

      if (multiBubbles.length > 0) {
        for (const b of multiBubbles) {
          this.emit({
            type: 'message',
            message: {
              id: b.messageId || createId('msg'),
              conversationId: message.conversationId,
              accountId: message.accountId,
              text: b.text,
              createdAt: Date.now(),
              ...(b.widgets ? { widgets: b.widgets } : {}),
              ...(b.tools ? { tools: b.tools } : {}),
              ...(b.media ? { media: b.media } : {})
            }
          })
        }
      } else if (reply || replyWidgets?.length || replyMedia?.length) {
        this.emit({
          type: 'message',
          message: {
            id: replyMessageId || createId('msg'),
            conversationId: message.conversationId,
            accountId: message.accountId,
            text: reply,
            createdAt: Date.now(),
            ...(replyWidgets ? { widgets: replyWidgets } : {}),
            ...(replyTools ? { tools: replyTools } : {}),
            ...(replyMedia ? { media: replyMedia } : {})
          }
        })
      }

      this.setStatus(message.accountId, 'online')
      const gotReply = Boolean(
        multiBubbles.length > 0 || reply || replyWidgets?.length || replyMedia?.length
      )
      return { messageId, acceptedAt: Date.now(), ...(gotReply ? {} : { noReply: true }) }
    } catch (error) {
      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        accountId: message.accountId,
        isTyping: false
      })
      if (message.signal?.aborted) {
        this.setStatus(message.accountId, 'online')
        throw error instanceof AdapterError ? error : new AdapterError('network', 'Aborted')
      }
      const detail =
        error instanceof GrokConnectError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      const next = statusAfterSendFailure(error)
      this.setStatus(message.accountId, next, next === 'error' ? detail : undefined)
      throw error instanceof AdapterError ? error : new AdapterError('network', detail)
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
