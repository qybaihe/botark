import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterListener, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'
import { addRoom, submitBrief, useRooms } from './roomStore'

describe('Collaboration room Muse session start resilience', () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  const originalMuseAdapter = adapterRegistry.get('meta-muse')
  const originalHarkAdapter = adapterRegistry.get('hark')

  beforeEach(() => {
    useRooms.setState({
      rooms: [],
      speakers: {},
      turnProgress: {},
      errors: {},
      externalAudiences: {}
    })
  })

  afterEach(() => {
    if (originalMuseAdapter) adapterRegistry.register(originalMuseAdapter)
    if (originalHarkAdapter) adapterRegistry.register(originalHarkAdapter)
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it('falls back to chat.stream session allocation if muse.startSession rejects and persists receipt.sessionId', async () => {
    const sentMessages: OutgoingMessage[] = []
    const listeners = new Set<AdapterListener>()
    const fakeMuse: PlatformAdapter = {
      id: 'meta-muse',
      name: 'Meta Muse',
      listAccounts: async () => [],
      connect: async () => 'online',
      disconnect: async () => undefined,
      getStatus: () => 'online',
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      onMessage: (cb) =>
        fakeMuse.subscribe((e) => {
          if (e.type === 'message') cb(e.message)
        }),
      sendMessage: async (msg) => {
        sentMessages.push(msg)
        for (const l of listeners) {
          l({
            type: 'message',
            message: {
              id: `reply_${sentMessages.length}`,
              conversationId: msg.conversationId,
              accountId: msg.accountId,
              text: sentMessages.length === 1 ? 'Muse first reply in room' : 'Muse second reply in room',
              createdAt: Date.now()
            }
          })
        }
        return {
          messageId: `out_${sentMessages.length}`,
          acceptedAt: Date.now(),
          sessionId: msg.sessionId ?? 'sess_allocated_by_stream'
        }
      }
    }
    const fakeHark: PlatformAdapter = {
      ...fakeMuse,
      id: 'hark',
      name: 'Hark'
    }
    adapterRegistry.register(fakeMuse)
    adapterRegistry.register(fakeHark)

    const startSession = vi.fn().mockRejectedValue(
      new Error('MuseGatewayError: session.start: HTTP 400 {"ok":false,"error":{"code":"invalid_params","message":"`method` must be `/api/session/start`"}}')
    )
    ;(globalThis as { window?: unknown }).window = {
      electron: {
        muse: { startSession }
      }
    }

    useBotStore.setState({
      bots: [
        { id: 'bot_muse', name: 'Muse · Muse', platformId: 'meta-muse', accountIds: ['acc_m1'], activeAccountId: 'acc_m1' } as Bot,
        { id: 'bot_hark', name: 'Hark 1', platformId: 'hark', accountIds: ['acc_h1'], activeAccountId: 'acc_h1' } as Bot
      ],
      accounts: {
        acc_m1: { id: 'acc_m1', platformId: 'meta-muse', displayName: 'Muse · Muse', handle: 'm', status: 'online' },
        acc_h1: { id: 'acc_h1', platformId: 'hark', displayName: 'Hark 1', handle: 'h', status: 'online' }
      }
    })

    const room = addRoom('Admin交流', ['bot_muse', 'bot_hark'], 'auto', 4)

    await submitBrief(room.id, 'hi')
    expect(startSession).toHaveBeenCalledWith('acc_m1')
    expect(useRooms.getState().errors[room.id]).toBeUndefined()
    expect(sentMessages[0]?.sessionId).toBeUndefined()
    const afterTurn1 = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(afterTurn1.messages.some((m) => m.author === 'Muse · Muse' && m.text.includes('Muse first reply'))).toBe(true)
    expect(afterTurn1.members.find((m) => m.botId === 'bot_muse')?.sessionId).toBe('sess_allocated_by_stream')

    // Turn 2 reuses the persisted sessionId without calling startSession again.
    await submitBrief(room.id, 'follow up')
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(sentMessages[1]?.sessionId).toBe('sess_allocated_by_stream')
  })
})
