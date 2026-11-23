import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { MuseChatChannel, streamChat } from './chat'
import type { MuseNativeGateway, SubscriptionHandle } from './gateway'

class FakeGateway extends EventEmitter {
  ready = true
  subscribeCount = 0
  historyCalls = 0
  historyPayload: unknown = { events: [] }
  private activeSubDone?: () => void
  private activeSubEmit?: (e: Record<string, unknown>) => void
  blockReopen = false

  isReady(): boolean {
    return this.ready
  }

  async connect(): Promise<void> {
    this.ready = true
  }

  async subscribe(
    method: string,
    _params: Record<string, unknown>,
    onEvent: (e: Record<string, unknown>) => void
  ): Promise<SubscriptionHandle> {
    if (method === 'chat.stream') {
      return {
        ack: Promise.resolve({ session_id: 'sess_1', message_id: 'usr_1' }),
        done: Promise.resolve(),
        cancel: () => undefined
      }
    }
    if (this.blockReopen && this.subscribeCount > 0) {
      throw new Error('offline')
    }
    this.subscribeCount += 1
    this.activeSubEmit = onEvent
    let resolveDone!: () => void
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    this.activeSubDone = resolveDone
    return {
      ack: Promise.resolve({ ok: true }),
      done,
      cancel: () => resolveDone()
    }
  }

  async request(method: string): Promise<unknown> {
    if (method === 'chat.history') {
      this.historyCalls += 1
      return this.historyPayload
    }
    return {}
  }

  endChatSubscribe(): void {
    this.activeSubDone?.()
  }

  pushChatEvent(name: string, payload: Record<string, unknown>): void {
    this.activeSubEmit?.({ type: 'event', event: name, seq: 1, payload })
  }
}

describe('streamChat subscription recovery', () => {
  it('clears gapTimer when chat.subscribe reopens while silent (e.g. waiting for Sentinel approval)', async () => {
    const gw = new FakeGateway()
    const channel = new MuseChatChannel(gw as unknown as MuseNativeGateway)
    const updates: Array<{ text: string; done: boolean }> = []

    const turnPromise = streamChat(
      gw as unknown as MuseNativeGateway,
      channel,
      { text: 'upload file', nodeId: 'dev_1', sessionId: 'sess_1' },
      (u) => updates.push({ text: u.text, done: u.done }),
      { recoverMs: 80, settleMs: 30, timeoutMs: 3000 }
    )

    // Let chat.stream ack settle.
    await new Promise((r) => setTimeout(r, 20))
    // Server resets chat.subscribe while WS stays open; MuseChatChannel auto-reopens it.
    gw.endChatSubscribe()

    // Wait LONGER than recoverMs (80ms) with ZERO chat events (simulating waiting for user approval).
    await new Promise((r) => setTimeout(r, 160))
    expect(gw.subscribeCount).toBeGreaterThanOrEqual(2)

    // Now user approves and assistant finishes.
    gw.pushChatEvent('delta.message_done', {
      session_id: 'sess_1',
      message_id: 'asst_1',
      status: 'completed',
      display_text: 'Screenshot uploaded to issue #41.'
    })

    const res = await turnPromise
    expect(res.text).toBe('Screenshot uploaded to issue #41.')
    expect(updates.some((u) => u.done && u.text.includes('Screenshot uploaded'))).toBe(true)
    channel.stop()
  })

  it('backfills missed reply from chat.history even when order was empty before disconnect', async () => {
    const gw = new FakeGateway()
    const channel = new MuseChatChannel(gw as unknown as MuseNativeGateway)
    const now = Date.now()
    gw.historyPayload = {
      events: [
        {
          event_name: 'message.assistant',
          message_id: 'asst_missed',
          occurred_at_ms: now + 500,
          display_text: 'Recovered from history after reconnect.',
          payload: { status: 'completed' }
        }
      ]
    }

    const turnPromise = streamChat(
      gw as unknown as MuseNativeGateway,
      channel,
      { text: 'run task', nodeId: 'dev_1', sessionId: 'sess_1' },
      () => undefined,
      { recoverMs: 250, settleMs: 30, timeoutMs: 3000 }
    )

    await new Promise((r) => setTimeout(r, 20))
    // Drop subscription before any assistant bubble started (order is empty []).
    gw.ready = false
    gw.endChatSubscribe()

    await new Promise((r) => setTimeout(r, 40))
    gw.ready = true
    gw.emit('phase', 'ready')

    const res = await turnPromise
    expect(gw.historyCalls).toBeGreaterThanOrEqual(1)
    expect(res.text).toBe('Recovered from history after reconnect.')
    channel.stop()
  })

  it('still fails with recovery error when gateway stays disconnected past recoverMs', async () => {
    const gw = new FakeGateway()
    const channel = new MuseChatChannel(gw as unknown as MuseNativeGateway)

    const turnPromise = streamChat(
      gw as unknown as MuseNativeGateway,
      channel,
      { text: 'hello', nodeId: 'dev_1', sessionId: 'sess_1' },
      () => undefined,
      { recoverMs: 60, settleMs: 30, timeoutMs: 3000 }
    )

    await new Promise((r) => setTimeout(r, 20))
    gw.ready = false
    gw.blockReopen = true
    gw.endChatSubscribe()

    await expect(turnPromise).rejects.toThrow('Muse gateway did not recover mid-reply')
    channel.stop()
  })
})
