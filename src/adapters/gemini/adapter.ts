import type { GeminiMessage } from '@shared/gemini'
import { createId } from '@shared/id'
import { getBotHubBridge } from '../meta-muse/electronBridge'
import { statusAfterSendFailure } from '../sendFailure'
import {
  AdapterError, type AdapterEvent, type AdapterListener, type ConnectionStatus, type IncomingMessage,
  type OutgoingMessage, type PlatformAccount, type PlatformAdapter, type SendReceipt
} from '../types'

function bridge() {
  const gemini = getBotHubBridge()?.gemini
  if (!gemini) throw new AdapterError('not-connected', 'Gemini requires the desktop app')
  return gemini
}
export function thoughtTools(id: string, thought?: string, done = true) {
  return thought ? [{ id: id + '_thought', name: 'Thinking', summary: thought,
    status: done ? 'completed' as const : 'running' as const }] : undefined
}

export class GeminiAdapter implements PlatformAdapter {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'
  private readonly listeners = new Set<AdapterListener>()
  private readonly statuses = new Map<string, ConnectionStatus>()
  private readonly runs = new Map<string, string>()

  subscribe(listener: AdapterListener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  onMessage(listener: (message: IncomingMessage) => void) {
    return this.subscribe((event) => { if (event.type === 'message') listener(event.message) })
  }
  private emit(event: AdapterEvent) {
    for (const listener of this.listeners) listener(event)
  }
  private status(accountId: string, status: ConnectionStatus, detail?: string) {
    this.statuses.set(accountId, status)
    this.emit({ type: 'status', accountId, status, detail })
    return status
  }
  getStatus(id: string) { return this.statuses.get(id) ?? 'offline' }
  async listAccounts(): Promise<PlatformAccount[]> {
    return (await bridge().listAccounts()).map((id) => ({ id, platformId: this.id, displayName: this.name, handle: id }))
  }
  health(id: string) { return bridge().verifyAndListModels(id) }
  async connect(id: string) {
    if (!await bridge().config(id)) return this.status(id, 'offline')
    try {
      await this.health(id)
      return this.status(id, [...this.runs.values()].includes(id) ? 'busy' : 'online')
    } catch (error) {
      this.status(id, 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  async disconnect(id: string) {
    this.status(id, 'offline')
    await Promise.all([...this.runs].filter(([, owner]) => owner === id)
      .map(([requestId]) => bridge().cancelChat(id, { requestId })))
  }
  getHistory(accountId: string, sessionId: string): Promise<GeminiMessage[]> {
    return bridge().getHistory(accountId, sessionId)
  }
  async sendMessage(input: OutgoingMessage): Promise<SendReceipt> {
    const { accountId, conversationId, signal, onAccepted } = input
    signal?.throwIfAborted()
    const api = bridge()
    const requestId = createId('gemini')
    let accepted = false
    let acceptedAt = 0
    let sessionId = input.sessionId
    const accept = () => {
      if (accepted) return
      accepted = true
      acceptedAt = Date.now()
      onAccepted?.()
    }
    const off = api.onEvent((event) => {
      if (event.requestId !== requestId || event.accountId !== accountId || signal?.aborted) return
      sessionId = event.sessionId
      accept()
      if (event.type === 'progress') this.emit({
        type: 'message_delta', accountId, sessionId, conversationId, messageId: requestId, text: event.text,
        tools: thoughtTools(requestId, event.thought, false)
      })
    })
    const abort = () => { void api.cancelChat(accountId, { requestId }).catch(() => undefined) }
    signal?.addEventListener('abort', abort, { once: true })
    this.runs.set(requestId, accountId)
    this.status(accountId, 'busy')
    this.emit({ type: 'typing', accountId, sessionId, conversationId, isTyping: true })
    let settled: ConnectionStatus = 'online'
    try {
      signal?.throwIfAborted()
      const result = await api.streamChat({
        accountId, conversationId, sessionId, requestId, userMessageId: input.userMessageId,
        text: input.text, attachments: input.attachments
      })
      signal?.throwIfAborted()
      sessionId = result.sessionId
      accept()
      const message = result.message
      this.emit({ type: 'message', message: {
        accountId, sessionId, conversationId, id: message.id, text: message.text, createdAt: message.createdAt,
        tools: thoughtTools(message.id, message.thought), richWidgets: message.richWidgets
      } })
      return { messageId: requestId, sessionId, acceptedAt }
    } catch (error) {
      signal?.throwIfAborted()
      settled = statusAfterSendFailure(error)
      if (accepted) throw new AdapterError('no-reply', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      off()
      signal?.removeEventListener('abort', abort)
      this.runs.delete(requestId)
      this.emit({ type: 'typing', accountId, sessionId, conversationId, isTyping: false })
      if (this.getStatus(accountId) !== 'offline') {
        this.status(accountId, [...this.runs.values()].includes(accountId) ? 'busy' : settled)
      }
    }
  }
}
