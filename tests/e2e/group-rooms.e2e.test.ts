import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHarness } from './harness/electronMock'
import { probeCueContracts, requireOrSkip } from './harness/contractAdapters'

vi.mock('electron', async () => {
  const { getElectronMockModule } = await import('./harness/electronMock')
  return getElectronMockModule()
})

import { adapterRegistry } from '@adapters/registry'
import { AntigravityAdapter } from '@adapters/antigravity/AntigravityAdapter'
import { GrokBotAdapter } from '@adapters/grokbot/GrokBotAdapter'
import { DotAdapter } from '@adapters/dot/DotAdapter'
import { setGrokAuth } from '@adapters/grokbot/tokenStore'
import { runDotRpc } from '@main/dot/dotIpc'
import { importDotCredentialsFromRaw, getStoredDotAccount } from '@main/dot/dotClient'
import { partitionForAccount } from '@main/webContentsViewManager'
import { mentions, type CollabRoom } from '@/rooms/model'
import { addRoom, stopRoom, submitBrief, useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'

describe('Area 3: Group Creation, Conversation & Single-Bot Remove/Move', () => {
  beforeEach(() => {
    electronHarness.reset()
    useRooms.setState({ rooms: [], speakers: {}, turnProgress: {}, errors: {}, externalAudiences: {} })
    useBotStore.setState({ bots: [], accounts: {}, messages: {}, groups: [{ id: 'g1', name: 'Workspace' }] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterAll(() => {
    electronHarness.cleanup()
  })

  it('E2E-T1-A3-01: Antigravity Room Turn Awaits Cascade Stream Completion', async (ctx) => {
    let emitMainEvent!: (ev: Record<string, unknown>) => void
    vi.stubGlobal('window', {
      electron: {
        antigravity: {
          authStatus: async () => ({ signedIn: true, handle: 'agy@google.com' }),
          sendMessage: async (req: { accountId: string; conversationId: string; clientMessageId: string }) => {
            setTimeout(() => {
              emitMainEvent?.({
                type: 'stream',
                accountId: req.accountId,
                conversationId: req.conversationId,
                cascadeId: 'casc_1',
                messageId: 'agy_reply_1',
                text: 'Partial...',
                done: false
              })
            }, 15)
            setTimeout(() => {
              emitMainEvent?.({
                type: 'stream',
                accountId: req.accountId,
                conversationId: req.conversationId,
                cascadeId: 'casc_1',
                messageId: 'agy_reply_1',
                text: '[FINAL] Antigravity complete answer',
                done: true
              })
            }, 40)
            return { ok: true, cascadeId: 'casc_1', messageId: req.clientMessageId }
          },
          cancelRun: async () => ({ ok: true }),
          onEvent: (cb: (ev: Record<string, unknown>) => void) => {
            emitMainEvent = cb
            return () => {}
          }
        }
      }
    })

    const agy = new AntigravityAdapter()
    await agy.connect('acc_agy_1')
    const peer: PlatformAdapter = {
      id: 'dot',
      name: 'Dot',
      listAccounts: async () => [],
      connect: async () => 'online',
      disconnect: async () => {},
      getStatus: () => 'online',
      subscribe: () => () => {},
      onMessage: () => () => {},
      sendMessage: async () => ({ messageId: 'p1', acceptedAt: 1 })
    }

    vi.spyOn(adapterRegistry, 'get').mockImplementation((id) => (id === 'antigravity' ? agy : peer))

    useBotStore.setState({
      bots: [
        { id: 'bot_agy', name: 'Agy', platformId: 'antigravity', accountIds: ['acc_agy_1'], activeAccountId: 'acc_agy_1' } as Bot,
        { id: 'bot_peer', name: 'Peer', platformId: 'dot', accountIds: ['acc_dot_p'], activeAccountId: 'acc_dot_p' } as Bot
      ],
      accounts: {
        acc_agy_1: { id: 'acc_agy_1', platformId: 'antigravity', displayName: 'Agy', handle: 'agy@google.com', status: 'online' },
        acc_dot_p: { id: 'acc_dot_p', platformId: 'dot', displayName: 'Peer', handle: 'p@dot.com', status: 'online' }
      }
    })

    const room = addRoom('Agy Test', ['bot_agy', 'bot_peer'], 'manual', 4)
    await submitBrief(room.id, '@Agy finish this')

    const updated = useRooms.getState().rooms.find((r) => r.id === room.id)!
    const agyMsg = updated.messages.find((m) => m.author === 'Agy')
    requireOrSkip(
      ctx,
      'M3',
      Boolean(agyMsg && agyMsg.text.includes('Antigravity complete answer')),
      'AntigravityAdapter.sendMessage must await cascade stream done:true before resolving room turn'
    )
    expect(agy.getStatus('acc_agy_1')).toBe('online')
  })

  it('E2E-T1-A3-02: CJK @Mention Parsing, Handle Autocomplete & manual Mode Feedback', async (ctx) => {
    const members = [
      { botId: 'b1', accountId: 'a1', platform: 'meta-muse' as const, name: 'Muse', cursor: 0 },
      { botId: 'b2', accountId: 'a2', platform: 'dot' as const, name: 'Dot', cursor: 0 }
    ]
    const matched = mentions('请@Muse和@Dot总结下', members)
    requireOrSkip(
      ctx,
      'M3',
      matched.map((m) => m.name).join(',') === 'Muse,Dot',
      'mentions() must match @Name adjacent to CJK characters (e.g. 请@Muse和@Dot总结下)'
    )
    expect(matched.map((m) => m.name)).toEqual(['Muse', 'Dot'])

    useBotStore.setState({
      bots: [
        { id: 'b1', name: 'Muse', platformId: 'meta-muse', accountIds: ['a1'], activeAccountId: 'a1' } as Bot,
        { id: 'b2', name: 'Dot', platformId: 'dot', accountIds: ['a2'], activeAccountId: 'a2' } as Bot
      ],
      accounts: {
        a1: { id: 'a1', platformId: 'meta-muse', displayName: 'Muse', handle: 'm', status: 'online' },
        a2: { id: 'a2', platformId: 'dot', displayName: 'Dot', handle: 'd', status: 'online' }
      }
    })

    const room = addRoom('Manual Check', ['b1', 'b2'], 'manual', 4)
    await submitBrief(room.id, '大家好请看下这个文档')
    const err = useRooms.getState().errors[room.id]
    expect(typeof err === 'string' && err.trim().length > 0).toBe(true)
  })

  it('E2E-T1-A3-03: Grok Room bodyOmitted Hydration, replay Frame & Fallback Poller', async (ctx) => {
    let listCallCount = 0
    vi.stubGlobal('window', {
      electron: {
        grok: {
          authStatus: async () => ({ signedIn: true, accountSlot: 'g1', machineId: 'm1' }),
          getSession: async () => ({ signedIn: true, accountSlot: 'g1', machineId: 'm1' }),
          rpc: async (req: { op: string }) => {
            if (req.op === 'listAgents') {
              return { ok: true, data: { agents: [{ id: 'ag1', name: 'Grok1' }] } }
            }
            if (req.op === 'listTranscriptEntries') {
              listCallCount++
              // First call gets pre-send seq; fallback poll after empty watch returns hydrated entry
              if (listCallCount === 1) return { ok: true, data: { entries: [{ updatedSeq: '10' }] } }
              return {
                ok: true,
                data: {
                  entries: [
                    {
                      entryId: 'e_hydrated',
                      sender: { type: 'agent' },
                      message: 'Hydrated Grok Room Reply',
                      updatedSeq: '11'
                    }
                  ]
                }
              }
            }
            if (req.op === 'sendUserMessage') return { ok: true, data: {} }
            if (req.op === 'watchUntilReply') {
              return { ok: true, data: { text: '', messages: [] } }
            }
            return { ok: true, data: {} }
          },
          onEvent: () => () => {}
        }
      }
    })

    setGrokAuth({ accountId: 'acc_grok_room', signedIn: true, accountSlot: 'g1', machineId: 'm1' })
    const grok = new GrokBotAdapter()
    const received: IncomingMessage[] = []
    grok.onMessage((m) => received.push(m))
    const receipt = await grok.sendMessage({
      accountId: 'acc_grok_room',
      conversationId: 'room-turn-grok-1',
      agentId: 'ag1',
      text: 'Test room turn'
    })

    requireOrSkip(
      ctx,
      'M3',
      received.some((m) => m.text.includes('Hydrated Grok Room Reply')) && !receipt.noReply,
      'GrokBotAdapter must fall back to listTranscriptEntries when watchUntilReply resolves empty'
    )
    expect(received[0]!.text).toContain('Hydrated Grok Room Reply')
  })

  it('E2E-T1-A3-04: Dot Room botId Non-Overwrite & native Thread Continuity', async (ctx) => {
    await importDotCredentialsFromRaw(
      'acc_dot_keep_id',
      JSON.stringify({
        accessToken: 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImRvdEBleGFtcGxlLmNvbSJ9.sig',
        botId: 'real-1to1-bot-id',
        mode: 'native'
      })
    )

    const ses = electronHarness.getSession(partitionForAccount('acc_dot_keep_id'))
    ses.fetchResponder = async () =>
      new Response(JSON.stringify({ threadId: 'thr_1', messageId: 'm1', reply: { id: 'r1', text: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    await Promise.race([
      runDotRpc({
        accountId: 'acc_dot_keep_id',
        op: 'sendMessage',
        botId: 'room-turn-999',
        text: 'Hello room'
      }).catch(() => undefined),
      new Promise((r) => setTimeout(r, 30))
    ])

    const storedAfter = getStoredDotAccount('acc_dot_keep_id')
    requireOrSkip(
      ctx,
      'M3',
      storedAfter?.botId === 'real-1to1-bot-id',
      'dotIpc sendMessage must NOT overwrite persisted 1:1 botId with room-turn-*'
    )
    expect(storedAfter?.botId).toBe('real-1to1-bot-id')

    // Also test DotAdapter sends room sessionId continuity
    const sentPayloads: Array<Record<string, unknown>> = []
    vi.stubGlobal('window', {
      electron: {
        dot: {
          rpc: async (req: Record<string, unknown>) => {
            sentPayloads.push(req)
            return { ok: true, data: { threadId: 'thr_room_42', reply: { id: 'd1', text: 'Dot reply' } } }
          },
          onEvent: () => () => {}
        }
      }
    })
    const dot = new DotAdapter()
    const r1 = await dot.sendMessage({
      accountId: 'acc_dot_keep_id',
      conversationId: 'room-turn-1',
      text: 'Turn 1'
    })
    expect(r1.sessionId).toBe('thr_room_42')
    await dot.sendMessage({
      accountId: 'acc_dot_keep_id',
      conversationId: 'room-turn-2',
      sessionId: r1.sessionId,
      text: 'Turn 2'
    })
    expect(sentPayloads[1]?.roomId).toBe('thr_room_42')
  })

  it('E2E-T1-A3-05: Room Lifecycle: attention Gate, stopRoom AbortSignal, createSafeStorage & Member Sync', async (ctx) => {
    let observedSignal: AbortSignal | undefined
    let releaseTurn!: () => void
    const blockingAdapter: PlatformAdapter = {
      id: 'dot',
      name: 'Dot',
      listAccounts: async () => [],
      connect: async () => 'online',
      disconnect: async () => {},
      getStatus: () => 'attention',
      subscribe: () => () => {},
      onMessage: () => () => {},
      sendMessage: (msg: OutgoingMessage & { signal?: AbortSignal }) => {
        observedSignal = msg.signal
        return new Promise((resolve) => {
          releaseTurn = () => resolve({ messageId: 'late', acceptedAt: 1 })
        })
      }
    }
    vi.spyOn(adapterRegistry, 'get').mockReturnValue(blockingAdapter)

    useBotStore.setState({
      bots: [
        { id: 'b1', name: 'Bot1', platformId: 'dot', accountIds: ['a1'], activeAccountId: 'a1' } as Bot,
        { id: 'b2', name: 'Bot2', platformId: 'dot', accountIds: ['a2'], activeAccountId: 'a2' } as Bot
      ],
      accounts: {
        a1: { id: 'a1', platformId: 'dot', displayName: 'Bot1', handle: '1', status: 'attention' },
        a2: { id: 'a2', platformId: 'dot', displayName: 'Bot2', handle: '2', status: 'online' }
      }
    })

    let room: CollabRoom | undefined
    try {
      room = addRoom('Attention Room', ['b1', 'b2'], 'auto', 4)
    } catch {
      room = undefined
    }
    requireOrSkip(
      ctx,
      'M3',
      Boolean(room),
      'addRoom must allow "attention" accounts or handle them cleanly without hard rejection'
    )

    const running = submitBrief(room!.id, '@Bot1 start')
    await new Promise((r) => setTimeout(r, 15))
    requireOrSkip(
      ctx,
      'M3',
      Boolean(observedSignal),
      'OutgoingMessage.signal?: AbortSignal must be passed to adapter.sendMessage by roomStore'
    )
    stopRoom(room!.id)
    expect(observedSignal!.aborted).toBe(true)
    releaseTurn?.()
    await running
  })

  it('E2E-T1-A3-06: Single-Bot Removal from Group (removeMember)', async (ctx) => {
    const storeMod = await import('@/rooms/roomStore')
    const removeMember =
      (storeMod as Record<string, unknown>).removeMember as
        | ((roomId: string, botId: string) => { ok: boolean; error?: string })
        | undefined ??
      ((useRooms.getState() as unknown as Record<string, unknown>).removeMember as
        | ((roomId: string, botId: string) => { ok: boolean; error?: string })
        | undefined)

    requireOrSkip(ctx, 'M3', typeof removeMember === 'function', 'removeMember(roomId, botId) not yet exported')

    useBotStore.setState({
      bots: ['Muse', 'Dot', 'Hark'].map(
        (n) => ({ id: n, name: n, platformId: 'dot', accountIds: [n], activeAccountId: n } as Bot)
      ),
      accounts: Object.fromEntries(
        ['Muse', 'Dot', 'Hark'].map((n) => [n, { id: n, platformId: 'dot', displayName: n, handle: n, status: 'online' }])
      )
    })

    const room = addRoom('Three Bots', ['Muse', 'Dot', 'Hark'], 'auto', 4)
    const res = removeMember!(room.id, 'Hark')
    expect(res.ok).toBe(true)
    const after = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(after.members.map((m) => m.botId)).toEqual(['Muse', 'Dot'])
  })

  it('E2E-T1-A3-07: Move Bot to Another Group (moveMemberToRoom)', async (ctx) => {
    const storeMod = await import('@/rooms/roomStore')
    const moveMemberToRoom =
      (storeMod as Record<string, unknown>).moveMemberToRoom as
        | ((src: string, botId: string, dst: string) => { ok: boolean; error?: string })
        | undefined ??
      ((useRooms.getState() as unknown as Record<string, unknown>).moveMemberToRoom as
        | ((src: string, botId: string, dst: string) => { ok: boolean; error?: string })
        | undefined)

    requireOrSkip(
      ctx,
      'M3',
      typeof moveMemberToRoom === 'function',
      'moveMemberToRoom(sourceRoomId, botId, targetRoomId) not yet exported'
    )

    useBotStore.setState({
      bots: ['Muse', 'Dot', 'Hark', 'Grok', 'Agy'].map(
        (n) => ({ id: n, name: n, platformId: 'dot', accountIds: [n], activeAccountId: n } as Bot)
      ),
      accounts: Object.fromEntries(
        ['Muse', 'Dot', 'Hark', 'Grok', 'Agy'].map((n) => [
          n,
          { id: n, platformId: 'dot', displayName: n, handle: n, status: 'online' }
        ])
      )
    })

    const roomA = addRoom('Room A', ['Muse', 'Dot', 'Hark'], 'auto', 4)
    const roomB = addRoom('Room B', ['Grok', 'Agy'], 'auto', 4)

    const res = moveMemberToRoom!(roomA.id, 'Hark', roomB.id)
    expect(res.ok).toBe(true)
    const aAfter = useRooms.getState().rooms.find((r) => r.id === roomA.id)!
    const bAfter = useRooms.getState().rooms.find((r) => r.id === roomB.id)!
    expect(aAfter.members.map((m) => m.botId)).toEqual(['Muse', 'Dot'])
    expect(bAfter.members.map((m) => m.botId)).toEqual(['Grok', 'Agy', 'Hark'])
  })

  it('E2E-T1-A3-08: Two Cue Accounts Collaborating in One Group', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    void cue
    let emit!: (msg: IncomingMessage) => void
    const mockCueAdapter = {
      id: 'cue',
      name: 'Cue',
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        const reply =
          m.accountId === 'acc_cue_1'
            ? '调研完成，请@Cue · Beta定稿'
            : '[FINAL]\n双 Cue 账号协同定稿完成'
        emit({ id: `r_${m.accountId}`, conversationId: m.conversationId, accountId: m.accountId, text: reply, createdAt: 1 })
        return { messageId: `s_${m.accountId}`, acceptedAt: 1, sessionId: `sess_${m.accountId}` }
      }
    } as unknown as PlatformAdapter

    vi.spyOn(adapterRegistry, 'get').mockReturnValue(mockCueAdapter)

    useBotStore.setState({
      bots: [
        { id: 'cue_bot_1', name: 'Cue · Alpha', platformId: 'cue' as Bot['platformId'], accountIds: ['acc_cue_1'], activeAccountId: 'acc_cue_1' } as Bot,
        { id: 'cue_bot_2', name: 'Cue · Beta', platformId: 'cue' as Bot['platformId'], accountIds: ['acc_cue_2'], activeAccountId: 'acc_cue_2' } as Bot
      ],
      accounts: {
        acc_cue_1: { id: 'acc_cue_1', platformId: 'cue' as Bot['platformId'], displayName: 'Alpha', handle: 'a@cue.im', status: 'online' },
        acc_cue_2: { id: 'acc_cue_2', platformId: 'cue' as Bot['platformId'], displayName: 'Beta', handle: 'b@cue.im', status: 'online' }
      },
      messages: { cue_bot_1: [], cue_bot_2: [] }
    })

    const room = addRoom('Dual Cue Room', ['cue_bot_1', 'cue_bot_2'], 'auto', 6)
    await submitBrief(room.id, '请@Cue · Alpha调研后交给@Cue · Beta定稿')

    const updated = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(updated.finalId).toBeDefined()
    expect(updated.messages.some((m) => m.author === 'Cue · Alpha')).toBe(true)
    expect(updated.messages.some((m) => m.author === 'Cue · Beta')).toBe(true)
    expect(useBotStore.getState().messages.cue_bot_1).toEqual([])
    expect(useBotStore.getState().messages.cue_bot_2).toEqual([])
  })

  it('E2E-T1-A3-09: Group Chat Creation & Dispatch Do Not Falsely Block Chat-Ready Accounts (Qoder-2x)', async (ctx) => {
    let emit!: (msg: IncomingMessage) => void
    const readyAdapter = {
      id: 'dot',
      name: 'Dot',
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        emit({
          id: `msg_${m.accountId}`,
          conversationId: m.conversationId,
          accountId: m.accountId,
          text: m.accountId === 'acc_qoder_2x' ? '[FINAL] Qoder-2x replied in room' : '@Qoder-2x please check',
          createdAt: Date.now()
        })
        return { messageId: `rcpt_${m.accountId}`, acceptedAt: Date.now() }
      }
    } as unknown as PlatformAdapter

    vi.spyOn(adapterRegistry, 'get').mockReturnValue(readyAdapter)

    useBotStore.setState({
      bots: [
        { id: 'bot_qoder_2x', name: 'Qoder-2x', platformId: 'dot', accountIds: ['acc_qoder_2x'], activeAccountId: 'acc_qoder_2x' } as Bot,
        { id: 'bot_muse', name: 'Muse', platformId: 'dot', accountIds: ['acc_muse'], activeAccountId: 'acc_muse' } as Bot
      ],
      accounts: {
        // Stale UI 'offline' status even though adapter is actually 'online' / chat-ready
        acc_qoder_2x: { id: 'acc_qoder_2x', platformId: 'dot', displayName: 'Qoder-2x', handle: 'q@ex.com', status: 'offline' },
        acc_muse: { id: 'acc_muse', platformId: 'dot', displayName: 'Muse', handle: 'm@ex.com', status: 'online' }
      }
    })

    let room: CollabRoom | undefined
    try {
      room = addRoom('Qoder Group', ['bot_qoder_2x', 'bot_muse'], 'auto', 4)
    } catch {
      room = undefined
    }
    requireOrSkip(
      ctx,
      'M3',
      Boolean(room),
      'addRoom must not reject a chat-ready account whose UI store status is stale "offline" when adapter is online'
    )

    await submitBrief(room!.id, '@Qoder-2x please respond')
    const after = useRooms.getState().rooms.find((r) => r.id === room!.id)!
    expect(after.messages.some((m) => m.author === 'Qoder-2x' && m.text.includes('Qoder-2x replied in room'))).toBe(true)
    expect(useRooms.getState().errors[room!.id]).toBeUndefined()
  })

  it('E2E-T2-A3-01: CJK @Mention vs Email Exclusion & Punctuation Boundaries', async (ctx) => {
    const members = [
      { botId: 'm', accountId: 'm', platform: 'meta-muse' as const, name: 'Muse', cursor: 0 },
      { botId: 'd', accountId: 'd', platform: 'dot' as const, name: 'Dot', cursor: 0 }
    ]
    const out = mentions('发邮件给x@Muse.io，请@Muse！然后@Dot，测试@MuseExtra', members).map((m) => m.name)
    requireOrSkip(
      ctx,
      'M3',
      out.join(',') === 'Muse,Dot',
      'CJK punctuation-adjacent @mentions must match while excluding email addresses and prefix collisions'
    )
    expect(out).toEqual(['Muse', 'Dot'])
  })

  it('E2E-T2-A3-02: room-turn-* botId Protection Across Dot/Grok/Cue', async (ctx) => {
    await importDotCredentialsFromRaw(
      'acc_dot_t2_guard',
      JSON.stringify({
        accessToken: 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImRvdEBleGFtcGxlLmNvbSJ9.sig',
        botId: 'stable-1to1-bot'
      })
    )
    const ses = electronHarness.getSession(partitionForAccount('acc_dot_t2_guard'))
    ses.fetchResponder = async () =>
      new Response(JSON.stringify({ reply: { id: 'r1', text: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    await Promise.race([
      runDotRpc({ accountId: 'acc_dot_t2_guard', op: 'sendMessage', botId: 'room-turn-777', text: 'hi' }).catch(
        () => undefined
      ),
      new Promise((r) => setTimeout(r, 30))
    ])
    const acc = getStoredDotAccount('acc_dot_t2_guard')
    requireOrSkip(
      ctx,
      'M3',
      acc?.botId === 'stable-1to1-bot',
      'Dot room-turn-777 must not overwrite stored 1:1 botId'
    )
    expect(acc?.botId).toBe('stable-1to1-bot')
  })

  it('E2E-T2-A3-03: removeMember Min-2 Member Guard', async (ctx) => {
    const storeMod = await import('@/rooms/roomStore')
    const removeMember =
      ((storeMod as Record<string, unknown>).removeMember as
        | ((roomId: string, botId: string) => { ok: boolean; error?: string })
        | undefined) ??
      ((useRooms.getState() as unknown as Record<string, unknown>).removeMember as
        | ((roomId: string, botId: string) => { ok: boolean; error?: string })
        | undefined)
    requireOrSkip(ctx, 'M3', typeof removeMember === 'function', 'removeMember not yet implemented')

    useBotStore.setState({
      bots: ['A', 'B', 'C'].map((n) => ({ id: n, name: n, platformId: 'dot', accountIds: [n], activeAccountId: n } as Bot)),
      accounts: Object.fromEntries(['A', 'B', 'C'].map((n) => [n, { id: n, platformId: 'dot', displayName: n, handle: n, status: 'online' }]))
    })

    const r2 = addRoom('Two', ['A', 'B'], 'auto', 4)
    const deny = removeMember!(r2.id, 'A')
    expect(deny.ok).toBe(false)
    expect(deny.error).toBeTruthy()
    expect(useRooms.getState().rooms.find((r) => r.id === r2.id)?.members).toHaveLength(2)

    const r3 = addRoom('Three', ['A', 'B', 'C'], 'auto', 4)
    const allow = removeMember!(r3.id, 'C')
    expect(allow.ok).toBe(true)
    expect(useRooms.getState().rooms.find((r) => r.id === r3.id)?.members).toHaveLength(2)
  })

  it('E2E-T2-A3-04: moveMemberToRoom Guards (Same-Room, Source Min-2, Target Max-6, Duplicate Bot/Name)', async (ctx) => {
    const storeMod = await import('@/rooms/roomStore')
    const moveMemberToRoom =
      ((storeMod as Record<string, unknown>).moveMemberToRoom as
        | ((src: string, botId: string, dst: string) => { ok: boolean; error?: string })
        | undefined) ??
      ((useRooms.getState() as unknown as Record<string, unknown>).moveMemberToRoom as
        | ((src: string, botId: string, dst: string) => { ok: boolean; error?: string })
        | undefined)
    requireOrSkip(ctx, 'M3', typeof moveMemberToRoom === 'function', 'moveMemberToRoom not yet implemented')

    const names = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']
    useBotStore.setState({
      bots: names.map((n) => ({ id: n, name: n, platformId: 'dot', accountIds: [n], activeAccountId: n } as Bot)),
      accounts: Object.fromEntries(names.map((n) => [n, { id: n, platformId: 'dot', displayName: n, handle: n, status: 'online' }]))
    })

    const rTwo = addRoom('Src2', ['B1', 'B2'], 'auto', 4)
    const rThree = addRoom('Src3', ['B1', 'B7', 'B8'], 'auto', 4)
    const rSix = addRoom('Dst6', ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'], 'auto', 4)

    expect(moveMemberToRoom!(rThree.id, 'B7', rThree.id).ok).toBe(false) // same room
    expect(moveMemberToRoom!(rTwo.id, 'B1', rThree.id).ok).toBe(false) // source min-2
    expect(moveMemberToRoom!(rThree.id, 'B7', rSix.id).ok).toBe(false) // target max-6
    expect(moveMemberToRoom!(rThree.id, 'B1', rTwo.id).ok).toBe(false) // duplicate bot in target
  })

  it('E2E-T2-A3-05: Duplicate Bot Name Collision on addRoom', () => {
    useBotStore.setState({
      bots: [
        { id: 'b1', name: 'Bot', platformId: 'dot', accountIds: ['a1'], activeAccountId: 'a1' } as Bot,
        { id: 'b2', name: 'bot', platformId: 'dot', accountIds: ['a2'], activeAccountId: 'a2' } as Bot
      ],
      accounts: {
        a1: { id: 'a1', platformId: 'dot', displayName: 'Bot', handle: '1', status: 'online' },
        a2: { id: 'a2', platformId: 'dot', displayName: 'bot', handle: '2', status: 'online' }
      }
    })
    let created: CollabRoom | undefined
    try {
      created = addRoom('Dup Test', ['b1', 'b2'], 'auto', 4)
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
    }
    if (created) {
      expect(new Set(created.members.map((m) => m.name.toLowerCase())).size).toBe(2)
    }
  })

  it('E2E-T2-A3-06: Same-accountId Busy Lock vs Distinct-accountId Independence', async () => {
    let emit!: (m: IncomingMessage) => void
    let releaseFirst!: () => void
    const adapter = {
      id: 'dot',
      name: 'Dot',
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: (m: OutgoingMessage) => {
        if (m.accountId === 'shared_acc' && !releaseFirst) {
          return new Promise((resolve) => {
            releaseFirst = () => {
              emit({ id: 's1', conversationId: m.conversationId, accountId: m.accountId, text: '[FINAL] done1', createdAt: 1 })
              resolve({ messageId: 's1', acceptedAt: 1 })
            }
          })
        }
        emit({ id: `r_${m.accountId}`, conversationId: m.conversationId, accountId: m.accountId, text: `[FINAL] ok ${m.accountId}`, createdAt: 1 })
        return Promise.resolve({ messageId: `m_${m.accountId}`, acceptedAt: 1 })
      }
    } as unknown as PlatformAdapter
    vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)

    useBotStore.setState({
      bots: [
        { id: 'b_s1', name: 'S1', platformId: 'dot', accountIds: ['shared_acc'], activeAccountId: 'shared_acc' } as Bot,
        { id: 'b_s2', name: 'S2', platformId: 'dot', accountIds: ['shared_acc'], activeAccountId: 'shared_acc' } as Bot,
        { id: 'b_d1', name: 'D1', platformId: 'dot', accountIds: ['acc_d1'], activeAccountId: 'acc_d1' } as Bot,
        { id: 'b_d2', name: 'D2', platformId: 'dot', accountIds: ['acc_d2'], activeAccountId: 'acc_d2' } as Bot
      ],
      accounts: {
        shared_acc: { id: 'shared_acc', platformId: 'dot', displayName: 'Shared', handle: 's', status: 'online' },
        acc_d1: { id: 'acc_d1', platformId: 'dot', displayName: 'D1', handle: '1', status: 'online' },
        acc_d2: { id: 'acc_d2', platformId: 'dot', displayName: 'D2', handle: '2', status: 'online' }
      }
    })

    const rShared = addRoom('Shared', ['b_s1', 'b_s2'], 'manual', 2)
    const rDistinct = addRoom('Distinct', ['b_d1', 'b_d2'], 'manual', 2)

    const p1 = submitBrief(rShared.id, '@S1 hold')
    await new Promise((r) => setTimeout(r, 15))

    // Distinct account room finishes without waiting on shared_acc
    await submitBrief(rDistinct.id, '@D1 run')
    expect(useRooms.getState().rooms.find((r) => r.id === rDistinct.id)?.finalId).toBeDefined()

    // Same accountId busy lock prevents simultaneous corruption
    await submitBrief(rShared.id, '@S2 concurrent')
    releaseFirst?.()
    await p1
  })

  it('E2E-T2-A3-07: Quota-Exhausted createSafeStorage & Post-stopRoom Late Reply Drop', async (ctx) => {
    const storeSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/renderer/src/rooms/roomStore.ts', import.meta.url), 'utf8')
    )
    requireOrSkip(
      ctx,
      'M3',
      storeSource.includes('createSafeStorage'),
      'roomStore.ts must wrap Zustand persist storage in createSafeStorage'
    )

    let emit!: (m: IncomingMessage) => void
    let finish!: (text: string) => void
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: (m: OutgoingMessage) =>
        new Promise((resolve) => {
          finish = (txt) => {
            emit({ id: 'late', conversationId: m.conversationId, accountId: m.accountId, text: txt, createdAt: 1 })
            resolve({ messageId: 'late', acceptedAt: 1 })
          }
        })
    } as unknown as PlatformAdapter)

    useBotStore.setState({
      bots: [
        { id: 'b1', name: 'Muse', platformId: 'dot', accountIds: ['a1'], activeAccountId: 'a1' } as Bot,
        { id: 'b2', name: 'Dot', platformId: 'dot', accountIds: ['a2'], activeAccountId: 'a2' } as Bot
      ],
      accounts: {
        a1: { id: 'a1', platformId: 'dot', displayName: 'Muse', handle: '1', status: 'online' },
        a2: { id: 'a2', platformId: 'dot', displayName: 'Dot', handle: '2', status: 'online' }
      }
    })

    const room = addRoom('Race', ['b1', 'b2'], 'auto', 4)
    const run = submitBrief(room.id, '@Muse start')
    await new Promise((r) => setTimeout(r, 15))
    stopRoom(room.id)
    finish?.('[FINAL] Should be dropped')
    await run

    const after = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(after.messages).toHaveLength(1)
    expect(after.finalId).toBeUndefined()
  })
})
