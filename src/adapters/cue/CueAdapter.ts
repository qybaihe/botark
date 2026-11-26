/**
 * Cue by Manus (`cue.im` / `app.cue.im` / `api.manus.im`) platform adapter.
 *
 * Modeled on `GrokBotAdapter.ts`:
 * - Multi-account state isolation (`accounts`, `statuses`, `agentsByAccount`, `pendingApprovals`)
 * - Per-conversation agent binding that skips `room-turn-*` ephemeral turns so 1:1 chats are never mutated
 * - Full `AbortSignal` support for `stopRoom` cancellation
 */
import { createId } from '@shared/id'
import type {
  CueAttachmentPayload,
  CueMediaPayload,
  CueRpcRequest,
  CueRpcResponse,
  CueToolCallPayload
} from '@shared/ipc'
import type { CueTurnEvent } from './events'
import { getBotHubBridge } from '../meta-muse/electronBridge'
import { statusAfterSendFailure } from '../sendFailure'
import {
  AdapterError,
  type AdapterEvent,
  type AdapterListener,
  type ApprovalDecision,
  type ConnectionStatus,
  type IncomingMessage,
  type MuseApproval,
  type MuseMediaPart,
  type MuseToolCall,
  type OutgoingMessage,
  type PlatformAccount,
  type PlatformAdapter,
  type SendReceipt,
  type Unsubscribe
} from '../types'

export interface CueAgentItem {
  id: string
  name: string
  description?: string
  sessionId?: string
  avatarShape?: string
  avatarColor?: string
}

function extractCueAgents(payload: unknown): CueAgentItem[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>)['agents'])
      ? ((payload as Record<string, unknown>)['agents'] as unknown[])
      : []
  const out: CueAgentItem[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = String(rec['id'] ?? rec['agentId'] ?? rec['agent_id'] ?? '').trim()
    if (!id) continue
    const sessionId = rec['sessionId'] ?? rec['sessionUid'] ?? rec['session_uid'] ?? rec['taskId'] ?? rec['task_id']
    out.push({
      id,
      name: String(rec['name'] ?? rec['title'] ?? 'Cue').trim() || 'Cue',
      description: typeof rec['description'] === 'string' ? rec['description'] : undefined,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      avatarShape: typeof rec['avatarShape'] === 'string' ? rec['avatarShape'] : undefined,
      avatarColor: typeof rec['avatarColor'] === 'string' ? rec['avatarColor'] : undefined
    })
  }
  return out
}

export class CueAdapter implements PlatformAdapter {
  readonly id = 'cue' as const
  readonly name = 'Cue'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly agentsByAccount = new Map<string, CueAgentItem[]>()
  private readonly convAgentByAccount = new Map<string, Map<string, string>>()
  private readonly pendingApprovals = new Map<string, MuseApproval[]>()
  private readonly sendQueues = new Map<string, Promise<SendReceipt>>()
  private readonly sendingByAccount = new Map<string, number>()
  private readonly pendingSends = new Map<
    string,
    { accountId: string; accept: () => void; touchProgress: () => void; isCurrent: () => boolean }
  >()
  private readonly credentialGenerations = new Map<string, number>()
  private readonly listeners = new Set<AdapterListener>()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.ensureMainEventWired()
  }

  private ensureMainEventWired(): void {
    const bridge = getBotHubBridge()?.cue
    if (!bridge?.onEvent || this.bridgeUnsub) return
    this.bridgeUnsub = bridge.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: CueTurnEvent): void {
    const pending = event.requestId ? this.pendingSends.get(event.requestId) : undefined
    if (event.requestId && (pending?.accountId !== event.accountId || !pending.isCurrent())) return
    if (event.type === 'accepted') {
      pending?.accept()
      return
    }
    if (event.type === 'auth') {
      if (event.signedIn || !event.windowClosed) {
        const generation = this.credentialGenerations.get(event.accountId) ?? 0
        this.credentialGenerations.set(event.accountId, generation + 1)
      }
      if (event.signedIn) {
        const prev = this.accounts.get(event.accountId)
        const handle = event.handle ?? event.accountSlot ?? prev?.handle ?? event.accountId
        const displayName = event.displayName ?? prev?.displayName ?? (handle || 'Cue')
        this.accounts.set(event.accountId, {
          id: event.accountId,
          platformId: 'cue',
          displayName,
          handle
        })
        this.setStatus(event.accountId, 'online')
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: true,
          handle,
          displayName
        })
      } else {
        // Do not downgrade an already online account if a secondary login window simply closed
        if (event.windowClosed && this.statuses.get(event.accountId) === 'online') {
          return
        }
        this.setStatus(event.accountId, 'offline')
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: false,
          windowClosed: event.windowClosed
        })
      }
      return
    }

    if (event.type === 'activity') {
      if (event.busy) {
        pending?.touchProgress()
        this.setStatus(event.accountId, 'busy')
      } else if (!this.sendingByAccount.has(event.accountId) && this.getStatus(event.accountId) !== 'attention') {
        this.setStatus(event.accountId, 'online')
      }
      this.emit({
        type: 'activity',
        accountId: event.accountId,
        sessionId: event.sessionId,
        activity: {
          code: event.activityCode ?? (event.busy ? 'running' : 'idle'),
          text: event.activityText ?? null,
          emoji: null,
          agentId: event.agentId ?? null,
          subagents: 0,
          busy: event.busy
        }
      })
      return
    }

    if (event.type === 'stream') {
      pending?.touchProgress()
      const convId = event.conversationId ?? event.accountId
      const tools = event.tools?.length ? (event.tools as MuseToolCall[]) : undefined
      const media = event.media?.length ? (event.media as MuseMediaPart[]) : undefined
      const hasContent = Boolean(event.text || tools?.length || media?.length)
      if (!event.done) {
        this.setStatus(event.accountId, 'busy')
        this.emit({
          type: 'typing',
          conversationId: convId,
          sessionId: event.sessionId,
          accountId: event.accountId,
          isTyping: true
        })
        if (hasContent) {
          this.emit({
            type: 'message_delta',
            messageId: event.messageId,
            conversationId: convId,
            sessionId: event.sessionId,
            accountId: event.accountId,
            text: event.text || '',
            ...(tools ? { tools } : {}),
            ...(media ? { media } : {})
          })
        }
      } else {
        this.emit({
          type: 'typing',
          conversationId: convId,
          sessionId: event.sessionId,
          accountId: event.accountId,
          isTyping: false
        })
        this.setStatus(event.accountId, 'online')
        if (hasContent) {
          this.emit({
            type: 'message',
            message: {
              id: event.messageId,
              conversationId: convId,
              sessionId: event.sessionId,
              accountId: event.accountId,
              text: event.text || '',
              createdAt: Date.now(),
              ...(tools ? { tools } : {}),
              ...(media ? { media } : {})
            }
          })
        }
      }
      return
    }

    if (event.type === 'approvals') {
      const list = (event.pending ?? []) as unknown as MuseApproval[]
      this.pendingApprovals.set(event.accountId, list)
      this.setStatus(event.accountId, list.length > 0 ? 'attention' : 'online')
      this.emit({
        type: 'approvals',
        accountId: event.accountId,
        pending: list
      })
    }
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[cue] listener error', err)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  private getConvAgentMap(accountId: string): Map<string, string> {
    let map = this.convAgentByAccount.get(accountId)
    if (!map) {
      map = new Map()
      this.convAgentByAccount.set(accountId, map)
    }
    return map
  }

  bindConversationAgent(conversationId: string, agentId: string, accountId?: string): void {
    if (conversationId.startsWith('room-turn-')) return
    this.getConvAgentMap(accountId || '*').set(conversationId, agentId)
  }

  getBoundAgentId(accountId: string, conversationId: string): string | undefined {
    return (
      this.convAgentByAccount.get(accountId)?.get(conversationId) ??
      this.convAgentByAccount.get('*')?.get(conversationId)
    )
  }

  listCachedAgents(accountId: string): CueAgentItem[] {
    return this.agentsByAccount.get(accountId) ?? []
  }

  async refreshAgents(accountId: string): Promise<CueAgentItem[]> {
    const bridge = getBotHubBridge()?.cue
    if (!bridge?.rpc) return this.listCachedAgents(accountId)
    const res = await bridge.rpc({ accountId, op: 'listAgents' })
    if (!res.ok) {
      throw new AdapterError(res.status === 401 || res.status === 403 ? 'not-connected' : 'network', res.message)
    }
    const agents = extractCueAgents(res.data)
    this.agentsByAccount.set(accountId, agents)
    return agents
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    this.ensureMainEventWired()
    const bridge = getBotHubBridge()?.cue
    if (!bridge?.authStatus) {
      this.setStatus(accountId, 'offline', '需要 Electron 环境')
      return 'offline'
    }
    try {
      const st = await bridge.authStatus(accountId)
      if (!st.signedIn) {
        this.setStatus(accountId, 'offline', '未登录 Cue')
        return 'offline'
      }
      const handle = st.handle || st.accountSlot || accountId
      const displayName = st.displayName || handle || 'Cue'
      this.accounts.set(accountId, {
        id: accountId,
        platformId: 'cue',
        displayName,
        handle
      })
      await this.refreshAgents(accountId)
      this.setStatus(accountId, 'online')
      return 'online'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const status = error instanceof AdapterError && error.code === 'not-connected' ? 'offline' : 'error'
      this.setStatus(accountId, status, msg)
      return status
    }
  }

  async disconnect(accountId: string): Promise<void> {
    this.setStatus(accountId, 'offline')
  }

  async openLogin(accountId: string): Promise<ConnectionStatus> {
    this.ensureMainEventWired()
    const bridge = getBotHubBridge()?.cue
    if (!bridge?.openLogin) {
      throw new AdapterError('unsupported', 'Cue login requires Electron')
    }
    this.setStatus(accountId, 'offline', '请在弹出的窗口完成 Cue 登录…')
    const st = await bridge.openLogin({ accountId })
    if (st.signedIn) {
      this.setStatus(accountId, 'online')
      return 'online'
    }
    return this.getStatus(accountId)
  }

  async cancelLogin(accountId: string): Promise<void> {
    const bridge = getBotHubBridge()?.cue
    await bridge?.cancelLogin?.(accountId)
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    this.ensureMainEventWired()
    if (message.signal?.aborted) {
      throw new AdapterError('network', 'Aborted')
    }
    const bridge = getBotHubBridge()?.cue
    if (!bridge?.rpc) {
      throw new AdapterError('not-connected', 'Cue IPC unavailable')
    }

    const agentId =
      message.agentId ??
      this.getBoundAgentId(message.accountId, message.conversationId) ??
      this.listCachedAgents(message.accountId)[0]?.id

    // OpenAPI separates delivery from polling and carries no turn ID, so reserve
    // the session through both RPCs. Native IPC also serializes by its resolved session.
    const knownSession = message.sessionId ?? this.listCachedAgents(message.accountId).find((item) => item.id === agentId)?.sessionId
    const key = JSON.stringify([message.accountId, knownSession || agentId])
    const credentialGeneration = this.credentialGenerations.get(message.accountId)
    const isCurrent = () => this.credentialGenerations.get(message.accountId) === credentialGeneration
    const send = (this.sendQueues.get(key) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.sendTurn(message, bridge, agentId, isCurrent))
    this.sendQueues.set(key, send)
    try {
      return await send
    } finally {
      if (this.sendQueues.get(key) === send) this.sendQueues.delete(key)
    }
  }

  private async sendTurn(
    message: OutgoingMessage,
    bridge: NonNullable<NonNullable<ReturnType<typeof getBotHubBridge>>['cue']>,
    agentId: string | undefined,
    isCurrent: () => boolean
  ): Promise<SendReceipt> {
    const assertCredentials = () => {
      if (!isCurrent()) throw new AdapterError('network', 'Cue 账号在发送期间已更改')
    }
    if (message.signal?.aborted) throw new AdapterError('network', 'Aborted')
    assertCredentials()
    if (!message.conversationId.startsWith('room-turn-') && agentId) {
      this.bindConversationAgent(message.conversationId, agentId, message.accountId)
    }

    this.sendingByAccount.set(message.accountId, (this.sendingByAccount.get(message.accountId) ?? 0) + 1)
    this.setStatus(message.accountId, 'busy')
    this.emit({
      type: 'typing',
      conversationId: message.conversationId,
      sessionId: message.sessionId,
      accountId: message.accountId,
      isTyping: true
    })

    const requestId = createId('cue_req')
    let accepted = false
    let activeSessionId = message.sessionId
    let lastProgressAt = Date.now()
    const accept = () => {
      if (accepted) return
      accepted = true
      message.onAccepted?.()
    }
    const touchProgress = () => {
      lastProgressAt = Date.now()
    }
    this.pendingSends.set(requestId, { accountId: message.accountId, accept, touchProgress, isCurrent })

    let abortReject: ((err: Error) => void) | undefined
    const abortRace = message.signal
      ? new Promise<never>((_resolve, reject) => {
          abortReject = reject
        })
      : null
    const onSignalAbort = () => {
      void bridge
        .rpc({
          accountId: message.accountId,
          op: 'stopRun',
          agentId,
          sessionId: activeSessionId,
          requestId
        })
        .catch(() => undefined)
      abortReject?.(new AdapterError('network', 'Aborted'))
    }
    message.signal?.addEventListener('abort', onSignalAbort, { once: true })

    const raceWithAbort = <T>(promise: Promise<T>): Promise<T> =>
      abortRace ? Promise.race([promise, abortRace]) : promise

    try {
      const wireAttachments: CueAttachmentPayload[] = []
      if (message.attachments?.length) {
        for (const att of message.attachments) {
          if (!att.dataBase64) {
            throw new AdapterError('network', `附件「${att.name}」数据不可用，请重新添加后发送`)
          }
          wireAttachments.push({
            id: att.id,
            name: att.name,
            mimeType: att.mimeType,
            size: att.size,
            dataBase64: att.dataBase64
          })
        }
      }
      const req: CueRpcRequest & { requestId: string } = {
        accountId: message.accountId,
        op: 'sendMessage',
        requestId,
        agentId,
        sessionId: message.sessionId,
        conversationId: message.conversationId,
        text: message.text,
        ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {})
      }
      const res: CueRpcResponse = await raceWithAbort(bridge.rpc(req))
      if (message.signal?.aborted) {
        throw new AdapterError('network', 'Aborted')
      }
      if (!res.ok) {
        if (res.code === 'cancelled' || res.status === 499) {
          this.emit({
            type: 'typing',
            conversationId: message.conversationId,
            sessionId: activeSessionId,
            accountId: message.accountId,
            isTyping: false
          })
          if (this.sendingByAccount.get(message.accountId) === 1) {
            this.setStatus(message.accountId, 'online')
          }
          if (message.signal?.aborted) {
            throw new AdapterError('network', 'Aborted')
          }
          return {
            messageId: createId('cue_msg'),
            acceptedAt: Date.now(),
            sessionId: activeSessionId
          }
        }
        throw new AdapterError(
          res.status === 401 || res.status === 403 ? 'not-connected' : 'network',
          res.message || `Cue sendMessage failed (${res.status})`
        )
      }
      accept()
      assertCredentials()
      const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<
        string,
        unknown
      >
      const sessionId =
        typeof data['sessionId'] === 'string' && data['sessionId']
          ? data['sessionId']
          : message.sessionId
      activeSessionId = sessionId
      let replyObj =
        data['reply'] && typeof data['reply'] === 'object'
          ? (data['reply'] as Record<string, unknown>)
          : undefined
      if (data.awaitReply === true && sessionId) {
        const startedAt = Date.now()
        const maxPollMs = 10 * 60_000
        const idlePollMs = 180_000
        while (Date.now() - startedAt < maxPollMs && Date.now() - lastProgressAt < idlePollMs) {
          message.signal?.throwIfAborted()
          assertCredentials()
          const polled = await raceWithAbort(
            bridge.rpc({
              accountId: message.accountId,
              op: 'watchUntilReply',
              requestId,
              agentId,
              sessionId,
              conversationId: message.conversationId,
              afterMessageId: typeof data.afterMessageId === 'string' ? data.afterMessageId : undefined,
              expectedUserText: message.text
            } as CueRpcRequest & { requestId?: string })
          )
          message.signal?.throwIfAborted()
          assertCredentials()
          if (!polled.ok) {
            if (polled.code === 'cancelled' || polled.status === 499) {
              if (message.signal?.aborted) {
                throw new AdapterError('network', 'Aborted')
              }
              this.emit({
                type: 'typing',
                conversationId: message.conversationId,
                sessionId,
                accountId: message.accountId,
                isTyping: false
              })
              if (this.sendingByAccount.get(message.accountId) === 1) {
                this.setStatus(message.accountId, 'online')
              }
              return {
                messageId: createId('cue_msg'),
                acceptedAt: Date.now(),
                sessionId
              }
            }
            throw new AdapterError(
              polled.status === 401 || polled.status === 403 ? 'not-connected' : 'network',
              polled.message
            )
          }
          const result = polled.data as { done?: boolean; reply?: Record<string, unknown> } | null
          if (result?.done) {
            replyObj = result.reply
            break
          }
          await raceWithAbort(new Promise((resolve) => setTimeout(resolve, 2500)))
        }
      }
      const replyText =
        typeof replyObj?.['text'] === 'string'
          ? replyObj['text']
          : typeof data['text'] === 'string'
            ? data['text']
            : ''
      const replyTools = Array.isArray(replyObj?.['tools'])
        ? (replyObj['tools'] as CueToolCallPayload[])
        : undefined
      const replyMedia = Array.isArray(replyObj?.['media'])
        ? (replyObj['media'] as CueMediaPayload[])
        : undefined
      const replyId =
        typeof replyObj?.['id'] === 'string'
          ? replyObj['id']
          : typeof data['messageId'] === 'string'
            ? data['messageId']
            : createId('cue_msg')

      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        sessionId,
        accountId: message.accountId,
        isTyping: false
      })
      if (this.sendingByAccount.get(message.accountId) === 1) this.setStatus(message.accountId, 'online')

      const replies = Array.isArray(data.replies)
        ? (data.replies as Array<{
            id: string
            text: string
            tools?: CueToolCallPayload[]
            media?: CueMediaPayload[]
          }>)
        : replyText || replyMedia?.length
          ? [
              {
                id: replyId,
                text: replyText,
                ...(replyTools?.length ? { tools: replyTools } : {}),
                ...(replyMedia?.length ? { media: replyMedia } : {})
              }
            ]
          : []
      for (const reply of replies) {
        const incoming = {
          id: reply.id,
          conversationId: message.conversationId,
          sessionId,
          accountId: message.accountId,
          text: reply.text,
          createdAt: Date.now(),
          authoritative: true,
          ...(reply.tools?.length ? { tools: reply.tools as MuseToolCall[] } : {}),
          ...(reply.media?.length ? { media: reply.media as MuseMediaPart[] } : {})
        }
        this.emit({
          type: 'message',
          message: incoming
        })
      }

      return {
        messageId: typeof data['messageId'] === 'string' ? data['messageId'] : replyId,
        acceptedAt: Date.now(),
        sessionId,
        ...(replies.some((reply) => reply.text || reply.media?.length) ? {} : { noReply: true })
      }
    } catch (error) {
      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        sessionId: activeSessionId,
        accountId: message.accountId,
        isTyping: false
      })
      if (!isCurrent()) throw error
      if (message.signal?.aborted) {
        if (this.sendingByAccount.get(message.accountId) === 1) this.setStatus(message.accountId, 'online')
        throw error instanceof AdapterError ? error : new AdapterError('network', 'Aborted')
      }
      const next = statusAfterSendFailure(error)
      const detail = error instanceof Error ? error.message : String(error)
      if (next === 'error' || this.sendingByAccount.get(message.accountId) === 1) {
        this.setStatus(message.accountId, next, next === 'error' ? detail : undefined)
      }
      throw error instanceof AdapterError ? error : new AdapterError('network', detail)
    } finally {
      message.signal?.removeEventListener('abort', onSignalAbort)
      this.pendingSends.delete(requestId)
      const remaining = (this.sendingByAccount.get(message.accountId) ?? 1) - 1
      if (remaining) this.sendingByAccount.set(message.accountId, remaining)
      else this.sendingByAccount.delete(message.accountId)
    }
  }

  async listApprovals(accountId: string): Promise<MuseApproval[]> {
    return this.pendingApprovals.get(accountId) ?? []
  }

  async decideApproval(
    accountId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const bridge = getBotHubBridge()?.cue
    if (!bridge?.rpc) throw new AdapterError('not-connected', 'Cue IPC unavailable')
    const res = await bridge.rpc({
      accountId,
      op: 'approve',
      approvalId,
      decision
    })
    if (!res.ok) {
      throw new AdapterError('network', res.message || 'Cue approval failed')
    }
    const next = (this.pendingApprovals.get(accountId) ?? []).filter((a) => a.id !== approvalId)
    this.pendingApprovals.set(accountId, next)
    this.emit({ type: 'approvals', accountId, pending: next })
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.ensureMainEventWired()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onMessage(listener: (message: IncomingMessage) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === 'message') listener(event.message)
    })
  }
}

export function createCueAdapter(): CueAdapter {
  return new CueAdapter()
}
