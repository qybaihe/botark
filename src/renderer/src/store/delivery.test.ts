import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotAccount, ChatMessage } from '@/types'
import {
  clearNoReplyFlag,
  createDeliveryAttempts,
  createInFlightSet,
  hasLostAttachments,
  deliveryAfterError,
  formatDeliveryError,
  INTERRUPTED_REPLY_TEXT,
  createSafeStorage,
  INTERRUPTED_SEND_TEXT,
  SEND_STILL_PENDING_TEXT,
  SUPERSEDED_REPLY_TEXT,
  SUPERSEDED_SEND_TEXT,
  sanitizePersisted,
  SendTimeoutError,
  toPersistedMessages,
  withTimeout
} from './delivery'

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: over.id ?? 'm',
  botId: 'b',
  accountId: 'a',
  role: 'user',
  text: 'hi',
  createdAt: 1,
  ...over
})

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7)
  })

  it('rejects with SendTimeoutError and reports a late result', async () => {
    let finish!: (v: number) => void
    const slow = new Promise<number>((r) => (finish = r))
    const late = vi.fn()
    const raced = withTimeout(slow, 1000, late)
    const assertion = expect(raced).rejects.toBeInstanceOf(SendTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    finish(3)
    await Promise.resolve()
    expect(late).toHaveBeenCalledWith({ ok: true, value: 3 })
  })

  it('passes through rejections before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom')
  })
})

describe('sanitizePersisted', () => {
  it('turns in-flight messages into failed ones and clears pending accounts', () => {
    const accounts: Record<string, BotAccount> = {
      a: { id: 'a', platformId: 'meta-muse', displayName: 'A', handle: '', status: 'busy', pending: true },
      b: { id: 'b', platformId: 'grok', displayName: 'B', handle: '', status: 'online' }
    }
    const out = sanitizePersisted({
      messages: { b: [msg({ id: '1', delivery: 'sent' }), msg({ id: '2', delivery: 'sending' })] },
      accounts
    })
    expect(out.messages!.b![0]!.delivery).toBe('sent')
    expect(out.messages!.b![1]).toMatchObject({ delivery: 'failed', error: INTERRUPTED_SEND_TEXT })
    expect(out.accounts!.a).toMatchObject({ pending: false, status: 'offline' })
    expect(out.accounts!.b).toBe(accounts.b)
  })

  it('returns the same object when nothing needs fixing', () => {
    const state = { messages: { b: [msg({ delivery: 'sent' })] }, accounts: {} }
    expect(sanitizePersisted(state)).toBe(state)
  })

  it('restores a timed-out send as ambiguous after its transport is gone', () => {
    const out = sanitizePersisted({
      messages: { b: [msg({ delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })] }
    })
    expect(out.messages.b[0]).toMatchObject({ delivery: 'no-reply', error: INTERRUPTED_SEND_TEXT })
  })
})

describe('toPersistedMessages', () => {
  it('drops attachment bytes and keeps only the newest messages', () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      msg({ id: String(i), attachments: [{ id: 'f', name: 'a.png', size: 9, mimeType: 'image/png', dataBase64: 'AAAA' }] })
    )
    const out = toPersistedMessages({ b: list }, 3)
    expect(out.b!.map((m) => m.id)).toEqual(['2', '3', '4'])
    expect(out.b![0]!.attachments![0]).toEqual({ id: 'f', name: 'a.png', size: 9, mimeType: 'image/png' })
    // The in-memory message is untouched.
    expect(list[4]!.attachments![0]!.dataBase64).toBe('AAAA')
  })
})

describe('createSafeStorage', () => {
  it('coalesces both serialization and writes, flushes on demand, and drops removed pending values', () => {
    vi.useFakeTimers()
    try {
      const setItem = vi.fn()
      const removeItem = vi.fn()
      const storage = createSafeStorage(
        () => ({ getItem: () => null, setItem, removeItem }),
        undefined,
        { debounceMs: 350 }
      )
      const stale = vi.fn(() => 'first')
      const latest = vi.fn(() => 'latest')
      storage.setItem('workspace', stale)
      vi.advanceTimersByTime(300)
      storage.setItem('workspace', latest)
      vi.advanceTimersByTime(349)
      expect(setItem).not.toHaveBeenCalled()
      expect(stale).not.toHaveBeenCalled()
      expect(latest).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(setItem).toHaveBeenCalledExactlyOnceWith('workspace', 'latest')
      expect(latest).toHaveBeenCalledOnce()
      storage.setItem('workspace', 'critical')
      storage.flush()
      expect(setItem).toHaveBeenLastCalledWith('workspace', 'critical')
      storage.setItem('workspace', 'removed')
      storage.removeItem('workspace')
      vi.runOnlyPendingTimers()
      expect(setItem).toHaveBeenCalledTimes(2)
      expect(removeItem).toHaveBeenCalledExactlyOnceWith('workspace')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps existing state changes usable when the localStorage getter throws', () => {
    const onError = vi.fn()
    const blocked = new Error('Storage access denied')
    const storage = createSafeStorage(() => { throw blocked }, onError)

    expect(() => storage.setItem('workspace', '{}')).not.toThrow()
    expect(onError).toHaveBeenCalledExactlyOnceWith(blocked)
  })

  it('keeps the workspace and full history when inline media alone exceeds quota', () => {
    let saved = ''
    const storage = createSafeStorage(() => ({
      getItem: () => saved,
      removeItem: () => undefined,
      setItem: (_key, value) => {
        if (value.length > 16_000) throw new Error('QuotaExceededError')
        saved = value
      }
    }))
    const path = `data:image/png;base64,${'A'.repeat(20_000)}`
    const media = [{ kind: 'image' as const, path }, { kind: 'file' as const, path: 'https://example.test/report.pdf' }]
    const messages = [
      ...Array.from({ length: 169 }, (_, i) => msg({ id: String(i), text: 'Message' })),
      msg({ id: 'with-media', role: 'bot', media })
    ]
    const state = { messages: { b: messages }, selectedBotId: 'b' }

    storage.setItem('workspace', JSON.stringify({ state, version: 0 }))

    const restored = JSON.parse(saved).state as typeof state
    expect(restored.selectedBotId).toBe('b')
    expect(restored.messages.b).toHaveLength(messages.length)
    expect(restored.messages.b.at(-1)?.media).toEqual([media[1]])
    expect(messages.at(-1)?.media).toEqual(media)
  })

  it('swallows quota errors and reports them', () => {
    const onError = vi.fn()
    const storage = createSafeStorage(
      () => ({
        getItem: () => 'x',
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => undefined
      }),
      onError
    )
    expect(() => storage.setItem('k', 'v')).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(storage.getItem('k')).toBe('x')
  })

  it('auto-compacts persisted message history when initial setItem hits QuotaExceededError', () => {
    const saved = new Map<string, string>()
    const onError = vi.fn()
    const storage = createSafeStorage(
      () => ({
        getItem: (k) => saved.get(k) ?? null,
        setItem: (k, v) => {
          if (v.length > 5_000) {
            throw new Error('QuotaExceededError')
          }
          saved.set(k, v)
        },
        removeItem: (k) => {
          saved.delete(k)
        }
      }),
      onError
    )

    const manyMessages = Array.from({ length: 200 }, (_, i) =>
      msg({ id: `m_${i}`, text: 'x'.repeat(40) })
    )
    const bigPayload = JSON.stringify({
      version: 0,
      state: {
        bots: [{ id: 'bot_1', name: 'Test Bot' }],
        messages: { bot_1: manyMessages }
      }
    })
    expect(bigPayload.length).toBeGreaterThan(5_000)

    storage.setItem('bothub-workspace-v1', bigPayload)
    expect(onError).not.toHaveBeenCalled()
    const persisted = JSON.parse(saved.get('bothub-workspace-v1')!) as {
      state: { bots: Array<{ id: string }>; messages: Record<string, ChatMessage[]> }
    }
    expect(persisted.state.bots[0]!.id).toBe('bot_1')
    expect(persisted.state.messages['bot_1']!.length).toBe(30)
  })

  it('compacts one oversized reply and retains its identity along with the rest of the workspace', () => {
    let saved = ''
    const onError = vi.fn()
    const storage = createSafeStorage(() => ({
      getItem: () => saved,
      removeItem: () => undefined,
      setItem: (_name, value) => {
        if (value.length * 2 > 12_000) throw new DOMException('Storage is full', 'QuotaExceededError')
        saved = value
      }
    }), onError)
    const reply = msg({ id: 'giant', role: 'bot', text: '海\n'.repeat(80_000), createdAt: 19 })
    const state = {
      bots: [{ id: 'b', name: 'Saved bot' }],
      accounts: { a: { label: 'Saved account' } },
      messages: { b: [reply], other: [msg({ text: 'ordinary' })] }
    }

    storage.setItem('workspace', JSON.stringify({ state, version: 0 }))

    const restored: typeof state = JSON.parse(saved).state
    expect(restored.accounts).toEqual(state.accounts)
    expect(restored.bots).toEqual(state.bots)
    expect(restored.messages.b[0]).toMatchObject({ id: reply.id, role: 'bot', createdAt: 19 })
    expect(restored.messages.b[0]?.text).toMatch(/^\[Message body omitted/)
    expect(restored.messages.other).toEqual(state.messages.other)
    expect(reply.text).toHaveLength(160_000)
    expect(onError).not.toHaveBeenCalled()
  })

  it('budgets the whole workspace across bot histories', () => {
    let saved = ''
    const storage = createSafeStorage(() => ({
      getItem: () => saved,
      removeItem: () => undefined,
      setItem: (_name, value) => {
        if (value.length * 2 > 50_000) throw new DOMException('Storage is full', 'QuotaExceededError')
        saved = value
      }
    }))
    const messages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
      `bot-${i}`,
      [msg({ id: `m-${i}`, text: 'a'.repeat(9000) })]
    ]))
    storage.setItem('workspace', JSON.stringify({ state: { messages } }))
    expect(saved.length * 2).toBeLessThanOrEqual(50_000)
    expect(Object.keys(JSON.parse(saved).state.messages)).toHaveLength(12)
  })
})

describe('clearNoReplyFlag', () => {
  it('clears the newest user no-reply flag once a bot message lands', () => {
    const list = [
      msg({ id: '1', delivery: 'no-reply', error: 'x' }),
      msg({ id: '2', role: 'bot' })
    ]
    const out = clearNoReplyFlag(list)
    expect(out[0]).toMatchObject({ delivery: 'sent', error: undefined })
  })

  it('leaves older flags alone when the latest user message is fine', () => {
    const list = [msg({ id: '1', delivery: 'no-reply' }), msg({ id: '2', delivery: 'sent' }), msg({ id: '3', role: 'bot' })]
    expect(clearNoReplyFlag(list)).toBe(list)
  })
})

describe('accepted delivery', () => {
  const msg = (delivery: ChatMessage['delivery']): ChatMessage =>
    ({ id: 'm1', botId: 'b', accountId: 'a', role: 'user', text: 'hi', createdAt: 1, delivery }) as ChatMessage

  it('never reports an accepted message as failed', () => {
    expect(deliveryAfterError(true, 'other', 'socket closed').delivery).toBe('no-reply')
    expect(deliveryAfterError(true, 'timeout', 't').delivery).toBe('no-reply')
    expect(deliveryAfterError(false, 'other', 'boom')).toEqual({ delivery: 'failed', error: 'boom' })
    expect(deliveryAfterError(false, 'no-reply', 'x')).toEqual({ delivery: 'no-reply', error: 'x' })
  })

  it('strips Electron IPC prefixes and maps Muse turn superseded into concise copy', () => {
    expect(
      formatDeliveryError(new Error("Error invoking remote method 'bothub:muse:sessions:start': Error: session.start: HTTP 400"))
    ).toBe('session.start: HTTP 400')
    expect(
      deliveryAfterError(true, 'other', "Error invoking remote method 'bothub:muse:rpc': Error: Muse turn superseded")
    ).toEqual({ delivery: 'no-reply', error: SUPERSEDED_REPLY_TEXT })
    expect(
      deliveryAfterError(false, 'other', "Error invoking remote method 'bothub:muse:rpc': Error: Muse turn superseded")
    ).toEqual({ delivery: 'failed', error: SUPERSEDED_SEND_TEXT })
    expect(
      deliveryAfterError(true, 'other', "Error invoking remote method 'bothub:muse:rpc': Error: socket closed").error
    ).toContain('（socket closed）')
  })

  it('lets only one delivery per message run', () => {
    const set = createInFlightSet()
    expect(set.enter('m1')).toBe(true)
    expect(set.enter('m1')).toBe(false)
    set.leave('m1')
    expect(set.enter('m1')).toBe(true)
  })

  it('ignores completion from an earlier transport attempt', () => {
    const attempts = createDeliveryAttempts()
    const first = attempts.begin('m')!
    expect(attempts.begin('m')).toBeUndefined()
    attempts.finish('m', first)
    const second = attempts.begin('m')!
    expect(attempts.isCurrent('m', first)).toBe(false)
    attempts.finish('m', first)
    expect(attempts.isCurrent('m', second)).toBe(true)
    expect(attempts.begin('m')).toBeUndefined()
  })

  it('turns an accepted message into no-reply after a restart', () => {
    const out = sanitizePersisted({ messages: { b: [msg('accepted')] } })
    expect(out.messages!.b![0]).toMatchObject({ delivery: 'no-reply', error: INTERRUPTED_REPLY_TEXT })
  })

  it('marks an accepted message sent when the reply lands', () => {
    expect(clearNoReplyFlag([msg('accepted')])[0]!.delivery).toBe('sent')
  })
})

describe('hasLostAttachments', () => {
  it('flags attachments whose bytes were stripped on save', () => {
    expect(hasLostAttachments({ attachments: [{ name: 'a.png', mimeType: 'image/png' } as never] })).toBe(true)
    expect(hasLostAttachments({ attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AA==' } as never] })).toBe(false)
    expect(hasLostAttachments({})).toBe(false)
  })
})
