import { createId } from '@shared/id'
import type {
  DsBotApprovalView,
  DsBotMainEvent,
  DsBotRpcRequest,
  DsBotRpcResponse,
  DsBotTargetInfo
} from '@shared/ipc'
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

export interface DsBotAgentEntry {
  id: string
  name: string
  description?: string
  avatarColor?: string
  avatarShape?: string
}

async function invokeDsBotRpc(request: DsBotRpcRequest): Promise<unknown> {
  const bridge = getBotHubBridge()?.dsBot
  if (!bridge?.rpc) {
    throw new AdapterError('not-connected', 'DS Bot IPC unavailable (Electron main required)')
  }
  const res = (await bridge.rpc(request)) as DsBotRpcResponse
  if (!res.ok) {
    if (res.code === 'aborted') throw new DOMException(res.message, 'AbortError')
    throw new AdapterError(
      res.status === 401 || res.status === 403 ? 'not-connected' : 'network',
      res.message || `DS Bot RPC failed (${res.status})`
    )
  }
  return res.data
}

function toPlatformAgent(target: DsBotTargetInfo): DsBotAgentEntry {
  const roleDesc =
    target.kind === 'room'
      ? target.members?.length
        ? `群聊 · ${target.members.join('、')}`
        : 'DS Bot 群聊'
      : target.role || (target.main ? 'Main Bot (Chief)' : undefined)
  return {
    id: target.id,
    name: target.kind === 'room' ? `${target.name}` : target.name,
    description: roleDesc,
    avatarColor: target.color,
    avatarShape: target.avatarShape
  }
}

function toMuseApproval(entry: DsBotApprovalView): MuseApproval {
  const who = entry.roomName
    ? `${entry.roomName}${entry.botName ? ` · ${entry.botName}` : ''}`
    : entry.botName || entry.botId || 'DS Bot'
  return {
    id: entry.id,
    status: 'pending',
    title: `${who} · ${entry.tool}`,
    detail: entry.detail || entry.reason,
    approvalType: entry.tool,
    reason: entry.reason,
    decisionOptions: entry.answerable ? ['allow_once', 'deny'] : [],
    raw: entry
  }
}

/**
 * Full native `Fei-Craft/DS-Bot` platform adapter.
 *
 * Supports all three official DS-Bot protocols transparently via Electron main:
 * - Native DSH Web / Docker HTTP + Live SSE (`/api/bot`, `/api/bot/feed`)
 * - End-to-end encrypted Phone/Remote Link (`Noise_IK_25519_ChaChaPoly_SHA256` relay)
 * - Official DS-Bot MCP Streamable HTTP (`POST /mcp`, local or remote)
 *
 * Auto-expands every Bot and Group Chat in a connected DS-Bot team into first-class
 * BotArk sidebar bots and Multi-Agent Collaboration Room participants.
 */
export class DsBotAdapter implements PlatformAdapter {
  readonly id = 'ds-bot' as const
  readonly name = 'DS Bot'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly cachedAgents = new Map<string, DsBotAgentEntry[]>()
  private readonly conversationAgents = new Map<string, string>()
  private readonly activeSends = new Map<
    string,
    { accountId: string; conversationId: string; agentId: string; requestId: string }
  >()
  private readonly pendingAcceptances = new Map<string, () => void>()
  private readonly listeners = new Set<AdapterListener>()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.bindBridgeEvents()
  }

  private bindBridgeEvents(): void {
    const bridge = getBotHubBridge()?.dsBot
    if (!bridge || this.bridgeUnsub) return
    this.bridgeUnsub = bridge.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: DsBotMainEvent): void {
    if (event.type === 'accepted') {
      this.pendingAcceptances.get(event.requestId)?.()
      return
    }
    if (event.type === 'login') {
      if (event.signedIn) {
        this.upsert(event.accountId, {
          displayName: event.displayName,
          handle: event.handle
        })
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: true,
          handle: event.handle,
          displayName: event.displayName
        })
        this.setStatus(event.accountId, 'online')
      } else {
        this.emit({
          type: 'login',
          accountId: event.accountId,
          signedIn: false
        })
        this.setStatus(event.accountId, 'offline')
      }
      return
    }
    if (event.type === 'approvals') {
      const pending = event.pending.map(toMuseApproval)
      this.emit({ type: 'approvals', accountId: event.accountId, pending })
      if (pending.length > 0) {
        this.setStatus(event.accountId, 'attention', '等待工具审批')
      }
      return
    }
    if (event.type === 'activity') {
      this.emit({
        type: 'activity',
        accountId: event.accountId,
        activity: {
          code: event.activityCode,
          text: event.activityText ?? null,
          emoji: event.activityEmoji ?? null,
          agentId: event.agentId ?? null,
          subagents: 0,
          busy: event.busy
        }
      })
      return
    }
    if (event.type === 'stream') {
      const active = event.requestId ? this.activeSends.get(event.requestId) : undefined
      const convId = event.conversationId || active?.conversationId
      if (!convId) return
      const tools = event.tools as MuseToolCall[] | undefined
      const media = event.media as MuseMediaPart[] | undefined
      if (!event.done) {
        this.emit({
          type: 'typing',
          conversationId: convId,
          accountId: event.accountId,
          isTyping: true
        })
        if (event.text || tools?.length || media?.length) {
          this.emit({
            type: 'message_delta',
            messageId: event.messageId,
            conversationId: convId,
            accountId: event.accountId,
            text: event.text,
            tools,
            media
          })
        }
      } else {
        this.emit({
          type: 'typing',
          conversationId: convId,
          accountId: event.accountId,
          isTyping: false
        })
        this.setStatus(event.accountId, 'online')
        if (event.text || tools?.length || media?.length) {
          this.emit({
            type: 'message',
            message: {
              id: event.messageId,
              conversationId: convId,
              accountId: event.accountId,
              text: event.text,
              createdAt: Date.now(),
              ...(tools?.length ? { tools } : {}),
              ...(media?.length ? { media } : {})
            }
          })
        }
      }
    }
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[ds-bot] listener failed', error)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  private upsert(accountId: string, patch?: Partial<PlatformAccount>): void {
    const prev = this.accounts.get(accountId)
    this.accounts.set(accountId, {
      id: accountId,
      platformId: 'ds-bot',
      displayName: patch?.displayName ?? prev?.displayName ?? 'DS Bot',
      handle: patch?.handle ?? prev?.handle ?? accountId,
      avatarUrl: patch?.avatarUrl ?? prev?.avatarUrl
    })
    if (!this.statuses.has(accountId)) this.statuses.set(accountId, 'offline')
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    this.upsert(accountId)
    const bridge = getBotHubBridge()?.dsBot
    if (!bridge) {
      this.setStatus(accountId, 'offline', '需要 Electron')
      return 'offline'
    }
    try {
      const status = await bridge.authStatus(accountId)
      if (!status.signedIn) {
        const nextStatus: ConnectionStatus = status.mode ? 'error' : 'offline'
        this.setStatus(accountId, nextStatus, status.error || '未连接 DS Bot')
        return nextStatus
      }
      this.upsert(accountId, {
        displayName: status.displayName || status.hostName || 'DS Bot',
        handle: status.handle || status.baseUrl || status.relayServer || accountId
      })
      await this.refreshAgents(accountId).catch(() => [])
      this.setStatus(accountId, 'online')
      return 'online'
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', detail)
      return 'error'
    }
  }

  async disconnect(accountId: string): Promise<void> {
    await invokeDsBotRpc({ accountId, op: 'stopRun' }).catch(() => undefined)
    this.setStatus(accountId, 'offline')
  }

  async signOut(accountId: string): Promise<void> {
    const bridge = getBotHubBridge()?.dsBot
    await bridge?.clearAuth(accountId).catch(() => undefined)
    this.cachedAgents.delete(accountId)
    this.accounts.delete(accountId)
    this.setStatus(accountId, 'offline')
  }

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }

  listCachedAgents(accountId: string): DsBotAgentEntry[] {
    return this.cachedAgents.get(accountId) ?? []
  }

  async refreshAgents(accountId: string): Promise<DsBotAgentEntry[]> {
    const raw = (await invokeDsBotRpc({ accountId, op: 'listTargets' })) as DsBotTargetInfo[]
    const agents = Array.isArray(raw) ? raw.map(toPlatformAgent) : []
    this.cachedAgents.set(accountId, agents)
    return agents
  }

  bindConversationAgent(conversationId: string, agentId: string): void {
    this.conversationAgents.set(conversationId, agentId)
  }

  async listApprovals(accountId: string): Promise<MuseApproval[]> {
    const raw = (await invokeDsBotRpc({ accountId, op: 'listWaiting' })) as {
      approvals?: DsBotApprovalView[]
    }
    return Array.isArray(raw?.approvals) ? raw.approvals.map(toMuseApproval) : []
  }

  async decideApproval(
    accountId: string,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const choice = decision === 'deny' || decision === 'deny_always' ? 'reject' : 'allow'
    await invokeDsBotRpc({ accountId, op: 'decideApproval', approvalId, choice })
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    this.bindBridgeEvents()
    const { accountId, conversationId, text, attachments, onAccepted, signal } = message
    let agentId = message.agentId || this.conversationAgents.get(conversationId)
    if (!agentId) {
      const agents = this.listCachedAgents(accountId)
      const resolved = agents.length > 0 ? agents : await this.refreshAgents(accountId)
      agentId = resolved[0]?.id
      if (!agentId) {
        throw new AdapterError('not-connected', '该 DS Bot 实例下没有可用的 Bot 或群聊')
      }
      this.conversationAgents.set(conversationId, agentId)
    }

    const requestId = createId('dsreq')
    const sendEntry = { accountId, conversationId, agentId, requestId }
    this.activeSends.set(requestId, sendEntry)

    let accepted = false
    const markAccepted = (): void => {
      if (accepted) return
      accepted = true
      onAccepted?.()
    }
    this.pendingAcceptances.set(requestId, markAccepted)

    const onAbort = (): void => {
      void invokeDsBotRpc({ accountId, op: 'stopRun', agentId, requestId }).catch(() => undefined)
    }
    if (signal?.aborted) {
      this.activeSends.delete(requestId)
      this.pendingAcceptances.delete(requestId)
      throw new DOMException('DS Bot request aborted', 'AbortError')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    this.setStatus(accountId, 'busy')
    this.emit({ type: 'typing', conversationId, accountId, isTyping: true })

    try {
      const res = (await invokeDsBotRpc({
        accountId,
        op: 'sendMessage',
        agentId,
        botId: conversationId,
        requestId,
        text,
        attachments: attachments
          ?.filter((a) => Boolean(a.dataBase64))
          .map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            dataBase64: a.dataBase64!
          }))
      })) as {
        messageId?: string
        replyText?: string
        noReply?: boolean
      }

      markAccepted()
      this.setStatus(accountId, 'online')
      this.emit({ type: 'typing', conversationId, accountId, isTyping: false })

      return {
        messageId: res?.messageId || createId('dsmsg'),
        acceptedAt: Date.now(),
        ...(res?.noReply ? { noReply: true } : {})
      }
    } catch (error) {
      const nextStatus = statusAfterSendFailure(error)
      this.setStatus(accountId, nextStatus, error instanceof Error ? error.message : undefined)
      this.emit({ type: 'typing', conversationId, accountId, isTyping: false })
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.activeSends.delete(requestId)
      this.pendingAcceptances.delete(requestId)
    }
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onMessage(listener: (message: IncomingMessage) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === 'message') listener(event.message)
    })
  }

  /** Helper for renderer tests to simulate incoming events. */
  emitIncoming(message: IncomingMessage): void {
    this.emit({ type: 'message', message })
  }
}

export function createDsBotAdapter(): PlatformAdapter {
  return new DsBotAdapter()
}
