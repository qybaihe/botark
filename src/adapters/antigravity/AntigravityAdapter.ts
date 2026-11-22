import { createId } from '@shared/id'
import type { AntigravityMainEvent } from '@shared/ipc'
import { getBotHubBridge } from '../meta-muse/electronBridge'
import { statusAfterSendFailure } from '../sendFailure'
import {
  AdapterError,
  type AdapterEvent,
  type AdapterListener,
  type ConnectionStatus,
  type IncomingMessage,
  type OutgoingMessage,
  type PlatformAccount,
  type PlatformAdapter,
  type SendReceipt,
  type Unsubscribe
} from '../types'

/**
 * Google Antigravity Cloud Agents adapter (`https://antigravity.google.com/`).
 *
 * Uses Google first-party sign-in inside an isolated Electron partition, then
 * talks directly to `JetskiRemoteAgentProxyService` (`aicode.clients6.google.com`)
 * with real-time `StreamAgentStateUpdates` streaming.
 */
export class AntigravityAdapter implements PlatformAdapter {
  readonly id = 'antigravity' as const
  readonly name = 'Antigravity'

  private readonly accounts = new Map<string, PlatformAccount>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly listeners = new Set<AdapterListener>()
  private readonly pendingTurns = new Map<
    string,
    {
      conversationId: string
      serverMessageId?: string
      needsApproval?: boolean
      settled: boolean
      resolve: (outcome: { hasReply: boolean; sessionId?: string }) => void
      reject: (error: unknown) => void
      cleanupAbort?: () => void
    }
  >()
  private bridgeUnsub: Unsubscribe | null = null

  constructor() {
    this.bindBridgeEvents()
  }

  private bindBridgeEvents(): void {
    const b = getBotHubBridge()
    if (!b?.antigravity || this.bridgeUnsub) return
    this.bridgeUnsub = b.antigravity.onEvent((event) => this.handleMainEvent(event))
  }

  private handleMainEvent(event: AntigravityMainEvent): void {
    if (event.type === 'activity') {
      this.emit({
        type: 'activity',
        accountId: event.accountId,
        activity: {
          code: event.activityCode,
          text: event.activityText ?? null,
          emoji: event.activityEmoji ?? null,
          agentId: null,
          subagents: 0,
          busy: event.busy
        }
      })
      const pending = this.pendingTurns.get(event.accountId)
      if (event.activityCode === 'needs_approval') {
        if (pending && !pending.settled) pending.needsApproval = true
        this.setStatus(event.accountId, 'attention', event.activityText ?? undefined)
      } else if (event.busy) {
        if (this.getStatus(event.accountId) === 'offline') {
          this.setStatus(event.accountId, 'busy')
        }
      } else if (!pending || pending.settled) {
        if (this.getStatus(event.accountId) !== 'online') {
          this.setStatus(event.accountId, 'online')
        }
      }
      return
    }

    if (event.type === 'stream') {
      const convId = event.conversationId ?? event.accountId
      const pending = this.pendingTurns.get(event.accountId)
      if (!event.done) {
        if (this.getStatus(event.accountId) === 'offline') {
          this.setStatus(event.accountId, 'busy')
        }
        this.emit({
          type: 'typing',
          conversationId: convId,
          accountId: event.accountId,
          isTyping: true
        })
        if (event.text || event.tools?.length) {
          this.emit({
            type: 'message_delta',
            messageId: event.messageId,
            conversationId: convId,
            accountId: event.accountId,
            text: event.text,
            tools: event.tools
          })
        }
      } else {
        const matchesPending =
          pending &&
          !pending.settled &&
          (convId === pending.conversationId ||
            (pending.serverMessageId !== undefined && pending.serverMessageId === event.messageId))
        const hasReply = Boolean(event.text || event.tools?.length)
        const keepAttention =
          Boolean(matchesPending && pending.needsApproval) ||
          this.getStatus(event.accountId) === 'attention'

        this.emit({
          type: 'typing',
          conversationId: convId,
          accountId: event.accountId,
          isTyping: false
        })
        if (!keepAttention) {
          this.emit({
            type: 'activity',
            accountId: event.accountId,
            activity: {
              code: 'idle',
              text: null,
              emoji: null,
              agentId: null,
              subagents: 0,
              busy: false
            }
          })
          this.setStatus(event.accountId, 'online')
        } else {
          this.setStatus(event.accountId, 'attention')
        }
        if (hasReply) {
          this.emit({
            type: 'message',
            message: {
              id: event.messageId,
              conversationId: convId,
              accountId: event.accountId,
              text: event.text,
              createdAt: Date.now(),
              tools: event.tools
            }
          })
        }
        if (matchesPending) {
          pending.settled = true
          this.pendingTurns.delete(event.accountId)
          pending.cleanupAbort?.()
          pending.resolve({ hasReply, sessionId: event.sessionId })
        }
      }
      return
    }

    if (event.type !== 'login') return
    if (event.signedIn) {
      this.emit({
        type: 'login',
        accountId: event.accountId,
        signedIn: true,
        handle: event.handle,
        displayName: event.displayName
      })
      const existing = this.accounts.get(event.accountId)
      this.accounts.set(event.accountId, {
        id: event.accountId,
        platformId: 'antigravity',
        displayName: event.displayName ?? existing?.displayName ?? 'Antigravity',
        handle: event.handle ?? existing?.handle ?? event.accountId
      })
      this.setStatus(event.accountId, 'online')
      return
    }

    this.rejectPendingTurn(event.accountId, new AdapterError('not-connected', 'Signed out'))
    this.emit({
      type: 'login',
      accountId: event.accountId,
      signedIn: false,
      windowClosed: event.windowClosed
    })
    this.setStatus(event.accountId, 'offline')
  }

  private rejectPendingTurn(accountId: string, error: unknown): void {
    const pending = this.pendingTurns.get(accountId)
    if (!pending || pending.settled) return
    pending.settled = true
    this.pendingTurns.delete(accountId)
    pending.cleanupAbort?.()
    this.emit({
      type: 'typing',
      conversationId: pending.conversationId,
      accountId,
      isTyping: false
    })
    pending.reject(error)
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[antigravity] listener error', error)
      }
    }
  }

  private setStatus(accountId: string, status: ConnectionStatus, detail?: string): void {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
  }

  async listAccounts(): Promise<PlatformAccount[]> {
    return [...this.accounts.values()]
  }

  getStatus(accountId: string): ConnectionStatus {
    return this.statuses.get(accountId) ?? 'offline'
  }

  async connect(accountId: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    const bridge = getBotHubBridge()?.antigravity
    if (!bridge) {
      this.setStatus(accountId, 'offline', 'Electron main required')
      return 'offline'
    }
    try {
      const status = await bridge.authStatus(accountId)
      if (status.signedIn) {
        const existing = this.accounts.get(accountId)
        this.accounts.set(accountId, {
          id: accountId,
          platformId: 'antigravity',
          displayName: status.displayName ?? existing?.displayName ?? 'Antigravity',
          handle: status.handle ?? existing?.handle ?? accountId
        })
        this.setStatus(accountId, 'online')
        return 'online'
      }
      this.setStatus(accountId, 'offline', status.error || '需要重新登录 Google Antigravity')
      return 'offline'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.setStatus(accountId, 'error', msg)
      return 'error'
    }
  }

  async disconnect(accountId: string): Promise<void> {
    this.rejectPendingTurn(accountId, new AdapterError('not-connected', 'Disconnected'))
    const bridge = getBotHubBridge()?.antigravity
    await bridge?.cancelRun(accountId).catch(() => undefined)
    this.setStatus(accountId, 'offline')
  }

  async openLogin(accountId: string): Promise<ConnectionStatus> {
    this.bindBridgeEvents()
    const bridge = getBotHubBridge()?.antigravity
    if (!bridge) {
      throw new AdapterError('not-connected', 'Antigravity IPC unavailable')
    }
    const status = await bridge.openLogin({ accountId })
    if (status.signedIn) {
      this.accounts.set(accountId, {
        id: accountId,
        platformId: 'antigravity',
        displayName: status.displayName ?? 'Antigravity',
        handle: status.handle ?? accountId
      })
      this.setStatus(accountId, 'online')
      return 'online'
    }
    this.setStatus(accountId, 'offline', '在弹出的窗口里完成 Google Antigravity 登录')
    return 'offline'
  }

  async cancelLogin(accountId: string): Promise<void> {
    this.rejectPendingTurn(accountId, new AdapterError('not-connected', 'Login cancelled'))
    const bridge = getBotHubBridge()?.antigravity
    await bridge?.cancelLogin(accountId).catch(() => undefined)
    this.accounts.delete(accountId)
    this.statuses.delete(accountId)
  }

  async sendMessage(message: OutgoingMessage): Promise<SendReceipt> {
    this.bindBridgeEvents()
    const bridge = getBotHubBridge()?.antigravity
    if (!bridge) {
      throw new AdapterError('not-connected', 'Antigravity IPC unavailable')
    }
    if (message.signal?.aborted) {
      throw new AdapterError('network', 'Aborted')
    }

    this.rejectPendingTurn(message.accountId, new AdapterError('network', 'Superseded by new message'))

    const clientMessageId = createId('agy_msg')
    let resolveTurn!: (outcome: { hasReply: boolean; sessionId?: string }) => void
    let rejectTurn!: (error: unknown) => void
    const turnPromise = new Promise<{ hasReply: boolean; sessionId?: string }>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    const pendingTurn: {
      conversationId: string
      serverMessageId?: string
      needsApproval?: boolean
      settled: boolean
      resolve: (outcome: { hasReply: boolean; sessionId?: string }) => void
      reject: (error: unknown) => void
      cleanupAbort?: () => void
    } = {
      conversationId: message.conversationId,
      settled: false,
      resolve: resolveTurn,
      reject: rejectTurn
    }
    this.pendingTurns.set(message.accountId, pendingTurn)

    const onAbort = () => {
      if (pendingTurn.settled) return
      pendingTurn.settled = true
      if (this.pendingTurns.get(message.accountId) === pendingTurn) {
        this.pendingTurns.delete(message.accountId)
      }
      pendingTurn.cleanupAbort?.()
      void bridge.cancelRun(message.accountId).catch(() => undefined)
      this.emit({
        type: 'typing',
        conversationId: message.conversationId,
        accountId: message.accountId,
        isTyping: false
      })
      this.emit({
        type: 'activity',
        accountId: message.accountId,
        activity: {
          code: 'idle',
          text: null,
          emoji: null,
          agentId: null,
          subagents: 0,
          busy: false
        }
      })
      this.setStatus(message.accountId, 'online')
      pendingTurn.reject(new AdapterError('network', 'Aborted'))
    }

    if (message.signal) {
      message.signal.addEventListener('abort', onAbort, { once: true })
      pendingTurn.cleanupAbort = () => message.signal?.removeEventListener('abort', onAbort)
    }

    this.setStatus(message.accountId, 'busy')
    try {
      const res = await bridge.sendMessage({
        accountId: message.accountId,
        conversationId: message.conversationId,
        sessionId: message.sessionId,
        text: message.text,
        clientMessageId
      })
      if (pendingTurn.settled) {
        const outcome = await turnPromise
        return {
          messageId: clientMessageId,
          acceptedAt: Date.now(),
          sessionId: res.ok ? res.cascadeId : outcome.sessionId,
          ...(outcome.hasReply ? {} : { noReply: true })
        }
      }
      if (!res.ok) {
        pendingTurn.settled = true
        if (this.pendingTurns.get(message.accountId) === pendingTurn) {
          this.pendingTurns.delete(message.accountId)
        }
        pendingTurn.cleanupAbort?.()
        const err = new AdapterError(
          res.status === 401 || res.status === 403 ? 'not-connected' : 'network',
          res.message || `Antigravity send failed (${res.status})`
        )
        const nextStatus = statusAfterSendFailure(err)
        this.setStatus(message.accountId, nextStatus, err.message)
        throw err
      }
      pendingTurn.serverMessageId = res.messageId
      message.onAccepted?.()
      if (message.signal?.aborted) {
        onAbort()
      }
      const outcome = await turnPromise
      return {
        messageId: clientMessageId,
        acceptedAt: Date.now(),
        sessionId: res.cascadeId || outcome.sessionId,
        ...(outcome.hasReply ? {} : { noReply: true })
      }
    } catch (error) {
      if (!pendingTurn.settled) {
        pendingTurn.settled = true
        if (this.pendingTurns.get(message.accountId) === pendingTurn) {
          this.pendingTurns.delete(message.accountId)
        }
        pendingTurn.cleanupAbort?.()
      }
      if (message.signal?.aborted) {
        this.setStatus(message.accountId, 'online')
        throw error instanceof AdapterError ? error : new AdapterError('network', 'Aborted')
      }
      const err =
        error instanceof AdapterError
          ? error
          : new AdapterError('network', error instanceof Error ? error.message : String(error))
      this.setStatus(message.accountId, statusAfterSendFailure(err), err.message)
      throw err
    }
  }

  subscribe(listener: AdapterListener): Unsubscribe {
    this.bindBridgeEvents()
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

export function createAntigravityAdapter(): AntigravityAdapter {
  return new AntigravityAdapter()
}
