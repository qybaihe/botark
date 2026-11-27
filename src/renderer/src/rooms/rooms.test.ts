import { afterEach, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import { AdapterError, type IncomingMessage, type OutgoingMessage, type PlatformAdapter, type SendReceipt } from '@adapters/types'
import type { GrokMainEvent } from '@shared/ipc'
import type { Bot } from '@/types'
import { buildRoomJson } from '@/lib/conversationExport'
import { useBotStore } from '@/store/botStore'
import { mentions, roomMarkdown, splitMentionSegments, stripFinalPrefix, turnPrompt, type CollabRoom, type RoomMember } from './model'
import {
  clearRoomTranscript,
  deleteRoom,
  renameRoom,
  setRoomAdministrator,
  stopRoom,
  submitBrief,
  togglePinRoom,
  updateRoomConfig,
  useRooms
} from './roomStore'

const members = ['Muse', 'Dot'].map((name) => ({ name, botId: name, platform: 'dot' as const, accountId: name, cursor: 0 }))
function fixture(
  mode: CollabRoom['mode'],
  respond: (m: OutgoingMessage) => Promise<string | Pick<IncomingMessage, 'text' | 'sessionId' | 'media'>>,
  limit = 8,
  roster: RoomMember[] = members
) {
  const room: CollabRoom = { id: 'room', title: 'Review', brief: '', members: roster, mode, limit, messages: [] }
  useRooms.setState({ rooms: [room], speakers: {}, errors: {}, slackDestinations: {} })
  useBotStore.setState({ bots: roster.map((m) => ({
    id: m.botId, name: m.name, platformId: m.platform,
    accountIds: [m.accountId], activeAccountId: m.accountId, selectedAgentId: m.agentId
  } as Bot)) })
  let emit!: (msg: IncomingMessage) => void
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({ getStatus: () => 'online',
    onMessage: (listener: typeof emit) => { emit = listener; return () => {} },
    sendMessage: async (m: OutgoingMessage): Promise<SendReceipt> => {
      const response = await respond(m)
      const data = typeof response === 'string' ? { text: response } : response
      const message = { ...m, ...data, createdAt: 1, id: 'fixture' }
      emit({ ...message, conversationId: 'private-chat', text: '@Dot wrong transcript' })
      emit(message)
      return { messageId: 'receipt', acceptedAt: 1, sessionId: data.sessionId }
    }
  } as unknown as PlatformAdapter)
}
afterEach(() => {
  for (const room of useRooms.getState().rooms) stopRoom(room.id)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('shows Grok text and files before a room turn completes and stores one final reply', async () => {
  let emitLive: ((event: GrokMainEvent) => void) | undefined
  const unsubscribe = vi.fn()
  vi.stubGlobal('window', { electron: { grok: { onEvent: (listener: typeof emitLive) => {
    emitLive = listener
    return unsubscribe
  } } } })
  const grok: RoomMember = {
    ...members[0]!, botId: 'grok', name: 'Grok', platform: 'grok',
    agentId: 'fixture-agent', sessionId: 'fixture-session'
  }
  const media = [{ kind: 'file' as const, path: 'grokatt://fixture/report.pdf', name: 'report.pdf' }]
  let finishResponse!: () => void
  const response = new Promise<void>((resolve) => { finishResponse = resolve })
  let request: OutgoingMessage | undefined
  fixture('manual', async (message) => {
    request = message
    await response
    return { text: '[FINAL]\n请查收报告', media, sessionId: grok.sessionId }
  }, 8, [grok, members[1]!])
  const run = submitBrief('room', '@Grok 生成报告')
  try {
    await vi.waitFor(() => expect(request).toBeDefined())
    const send = request!
    const event = {
      type: 'stream' as const, accountId: send.accountId, agentId: send.agentId!,
      sessionId: send.sessionId, messageId: 'fixture-live', text: '我来整理资料', done: false
    }
    emitLive?.({ ...event, conversationId: 'another-turn' })
    expect(useRooms.getState().liveReplies?.['room']).toBeUndefined()
    emitLive?.({ ...event, conversationId: send.conversationId })
    expect(useRooms.getState().liveReplies?.['room']).toMatchObject({ text: event.text })
    emitLive?.({ ...event, conversationId: send.conversationId, text: '请查收报告', media, done: true })
    expect(useRooms.getState().liveReplies?.['room']).toMatchObject({ text: '请查收报告', media })
    expect(useRooms.getState().rooms[0]?.messages.filter((message) => message.authorBotId)).toEqual([])
  } finally {
    finishResponse()
    await run
  }
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(useRooms.getState().liveReplies?.['room']).toBeUndefined()
  const room = useRooms.getState().rooms[0]!
  expect(room.messages.filter((message) => message.authorBotId)).toEqual([
    expect.objectContaining({ text: '[FINAL]\n请查收报告', media, final: true })
  ])
  expect(buildRoomJson(room)).not.toContain('mediaSource')
})
it('routes complete names once and ignores email addresses', () => {
  expect(mentions('x@Muse.io @MuseExtra @Dot @Muse @Dot', members).map((m) => m.name)).toEqual(['Dot', 'Muse'])
})

const issueRoster: RoomMember[] = [
  { ...members[0]!, botId: 'admin', name: 'Muse · Admin', platform: 'meta-muse', agentId: 'admin', sessionId: 'admin-session' },
  { ...members[1]!, botId: 'hark', name: 'Admin-hark', platform: 'hark', sessionId: 'hark-session' },
  { ...members[0]!, botId: 'worker', name: 'Muse · agent 1', platform: 'meta-muse', agentId: 'agent-1', sessionId: 'worker-session' }
]

it('normalizes mention spelling and preserves the original text in display segments', () => {
  const accent = { ...members[0]!, botId: 'accent', name: 'Café' }
  const roster = [...members, ...issueRoster, accent]
  const raw = '请＠Muse·agent\u00a01和**@Admin-hark**核实，__@Dot__请看、@Cafe\u0301，再请@Muse • agent 1和@Muse・agent 1。'
  const segments = splitMentionSegments(raw, roster)
  expect(segments.map((segment) => segment.text).join('')).toBe(raw)
  expect(segments.filter((segment) => segment.member).map((segment) => segment.text)).toEqual([
    '＠Muse·agent\u00a01', '@Admin-hark', '@Dot', '@Cafe\u0301', '@Muse • agent 1', '@Muse・agent 1'
  ])
  expect(mentions(raw, roster).map((member) => member.botId)).toEqual(['worker', 'hark', 'Dot', 'accent'])
})

it('skips email and name prefixes, Markdown code and quotes, and URL paths', () => {
  const roster = [...members, ...issueRoster]
  const text = [
    'x@Muse.io @Muse.io @Admin-hark-extra @Admin-hark-助手 https://example.com/?q=@Muse www.example.test/@Dot example.com?q=@Dot',
    '@Muse · unknown-agent',
    '[link](../notes/@Muse) /room/@Dot `@Muse` ``examples ` @Admin-hark``',
    '> @Muse and @Admin-hark',
    '````text', '@Muse', '```', '@Dot', '````',
    '~~~', '@Admin-hark', '~~~',
    '请@Muse・agent 1看看。',
    '```unclosed', '@Admin-hark'
  ].join('\n')
  expect(mentions(text, roster).map((m) => m.botId)).toEqual(['worker'])
  expect(mentions('@Muse (@Muse · agent 1)', roster).map((m) => m.botId)).toEqual(['Muse', 'worker'])
  expect(mentions('请看 https://example.test/@Muse，再请@Dot审阅。', roster).map((m) => m.botId)).toEqual(['Dot'])
})

it.each([
  '@Muse · agent 1 在吗，回一声，让用户看看能不能 @ 到你。',
  '@Muse · agent 1 用户在问你在不在，回一声。',
  '@Muse · agent 1 用户叫你说话呢，回一下。\n\n我等你的回复。'
])('recovers issue #58 in a hydrated manual coordinator room (%s)', async (callout) => {
  const calls: OutgoingMessage[] = []
  fixture('auto', async (msg) => {
    calls.push(msg)
    return [`[FINAL]\n${callout}`, '在，收到。', '[FINAL]\n已经收到 agent 1 的回复。'][calls.length - 1]!
  }, 8, issueRoster)
  const current = useRooms.getState()
  const room = { ...current.rooms[0]!, coordinatorId: 'admin', mode: 'manual' }
  useRooms.setState(useRooms.persist.getOptions().merge!({ rooms: [room] }, current))

  await submitBrief('room', '让 Muse · agent 1 回一声')

  expect(calls.map((msg) => msg.agentId)).toEqual(['admin', 'agent-1', 'admin'])
  expect(calls[0]!.text).toContain('[FINAL] immediately ends the round and prevents @mentions from being delivered')
  expect(calls[0]!.text).toContain('[HANDOFF] ["<botId>"] on the first line')
  expect(calls[0]!.text).toContain('@Muse · agent 1 = "worker"')
  expect(calls[1]!.text).toContain(`[Muse · Admin] ${callout}`)
  const updated = useRooms.getState().rooms[0]!
  expect(updated.messages[1]).toMatchObject({ text: callout, handoffBotIds: ['worker'] })
  expect(updated.messages[1]?.final).toBeUndefined()
  expect(updated.finalId).toBe(updated.messages.at(-1)?.id)
})

it('recovers issue #59 in an ordinary auto room', async () => {
  const callout = '@Admin-hark 在吗，回一声，测试一下 @ 能不能到你。'
  const calls: OutgoingMessage[] = []
  fixture('auto', async (msg) => {
    calls.push(msg)
    return calls.length === 1 ? `[FINAL]\n${callout}` : '在。'
  }, 8, issueRoster.slice(0, 2))

  await submitBrief('room', '@Muse · Admin 试着 @ 一下 hark。')

  expect(calls.map((msg) => msg.accountId)).toEqual(['Muse', 'Dot'])
  expect(calls[1]?.text).toContain(callout)
  expect(calls[1]?.text).not.toMatch(/Collaboration room:|Members:|\[FINAL\]|\[HANDOFF\]/)
  const room = useRooms.getState().rooms[0]!
  expect(room.messages[1]).toMatchObject({ text: callout, handoffBotIds: ['hark'] })
  expect(room.messages[1]?.final).toBeUndefined()
  expect(room.finalId).toBeUndefined()
})

it.each([
  '> Earlier note: @Muse submitted a draft.\n\n**＠Dot** please review the complete report.',
  '@Dot, does the date match?'
])('routes a direct opening request (%s)', async (body) => {
  const send = vi.fn(async (msg: OutgoingMessage) => msg.accountId === 'Muse' ? `[FINAL]\n${body}` : 'Confirmed')
  fixture('auto', send)
  await submitBrief('room', '@Muse review')
  expect(send.mock.calls.map(([msg]) => msg.accountId)).toEqual(['Muse', 'Dot'])
  expect(useRooms.getState().rooms[0]?.messages[1]).toMatchObject({ text: body, handoffBotIds: ['Dot'] })
})

it.each([
  '@Muse，感谢协助',
  '@Muse，感谢协助并确认结果。',
  '@Muse，评估结果如下：测试通过。',
  '@Muse，检查已完成。\n\n报告已提交。',
  '@Muse the final report is complete. Please review the appendix for details.',
  '## Delivery\n\n@Muse please see the report below.',
  '> @Muse please reply\n\nThe attached report is final.',
  '`@Muse` please review the example.'
])('preserves a legitimate final (%s)', async (body) => {
  const respond = vi.fn(async () => `[FINAL]\n${body}`)
  fixture('auto', respond)
  await submitBrief('room', '@Dot review')
  const room = useRooms.getState().rooms[0]!
  expect(respond).toHaveBeenCalledOnce()
  expect(room.messages[1]).toMatchObject({ id: room.finalId, final: true })
  expect(room.messages[1]?.handoffBotIds).toBeUndefined()
  expect(roomMarkdown(room)).toBe(`# Review\n\n${body}\n`)
})

it('ignores a bare final marker and keeps the previously queued turn', async () => {
  fixture('auto', async (msg) => msg.accountId === 'Muse' ? '[FINAL]\n  ' : 'Ready')
  await submitBrief('room', '@Muse @Dot check')
  const room = useRooms.getState().rooms[0]!
  expect(room.messages.map((m) => m.author)).toEqual(['User', 'Dot'])
  expect(room.messages[1]?.final).toBeUndefined()
  expect(room.finalId).toBeUndefined()
})

it('strips an explicit handoff line and routes only eligible roster IDs', async () => {
  const send = vi.fn(async (msg: OutgoingMessage) => msg.agentId === 'admin'
    ? '[HANDOFF] ["worker", "worker", "admin", "external"]\nVerify the figures with @Admin-hark as a reference.'
    : '[FINAL]\nVerified')
  fixture('auto', send, 8, issueRoster)
  await submitBrief('room', 'Start the review')
  const room = useRooms.getState().rooms[0]!
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1]?.[0].agentId).toBe('agent-1')
  expect(room.messages[1]).toMatchObject({
    text: 'Verify the figures with @Admin-hark as a reference.', handoffBotIds: ['worker']
  })
  expect(room.messages[1]?.final).toBeUndefined()
  expect(room.finalId).toBe(room.messages[2]?.id)
})

it('delivers the handoff by bot ID when the target is renamed during the reply', async () => {
  const send = vi.fn(async (msg: OutgoingMessage) => {
    if (msg.accountId === 'Muse') {
      expect(msg.text).toContain('Members: @Muse, @Dot.')
      useBotStore.setState(({ bots }) => ({ bots: bots.map((bot) => bot.id === 'Dot' ? { ...bot, name: 'New Dot' } : bot) }))
      return '[FINAL]\n__@Dot__ please review.'
    }
    expect(msg.text).toContain('You are @New Dot.')
    expect(msg.text).toContain('[Muse] __@Dot__ please review.')
    return '[FINAL]\nDone'
  })
  fixture('auto', send)
  await submitBrief('room', 'Start')
  expect(send).toHaveBeenCalledTimes(2)
  expect(useRooms.getState().rooms[0]?.messages[1]).toMatchObject({ handoffBotIds: ['Dot'] })
  expect(useRooms.getState().rooms[0]?.messages[2]?.author).toBe('New Dot')
})
it('relays tagged context and stops on a final deliverable even if it mentions a peer', async () => {
  const prompts: string[] = []
  fixture('auto', async (m) => { prompts.push(m.text); return m.accountId === 'Muse' ? '@Dot please review' : '[FINAL]\nAccepted @Muse' })
  await submitBrief('room', 'Review this')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('[Muse] @Dot please review')
  expect(roomMarkdown(useRooms.getState().rooms[0]!)).toBe('# Review\n\nAccepted @Muse\n')
})
it.each([['auto', 3], ['manual', 1]] as const)('bounds turns in %s mode', async (mode, count) => {
  fixture(mode, async (m) => m.accountId === 'Muse' ? '@Dot' : '@Muse', 3)
  await submitBrief('room', '@Muse review')
  expect(useRooms.getState().rooms[0]!.messages).toHaveLength(count + 1)
})
it('drops a result that arrives after Stop', async () => {
  let finish!: (text: string) => void
  fixture('auto', () => new Promise((resolve) => { finish = resolve }))
  const run = submitBrief('room', 'Start')
  stopRoom('room')
  finish('@Dot')
  await run
  expect(useRooms.getState().rooms[0]!.messages).toHaveLength(1)
})

it('completes a native room with an approved local tool while Slack is unavailable', async () => {
  const slack = vi.fn().mockRejectedValue(new Error('Slack unavailable'))
  const run = vi.fn().mockResolvedValue('Local fixture result')
  vi.stubGlobal('window', { electron: { workspace: {
    manage: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] }), run
  }, slack: { request: slack, onMessage: slack } } })
  const answers = ['@Dot review', '[TOOL] {"name":"read","args":{"path":"notes.txt"}}', '[FINAL] Accepted']
  fixture('auto', async (msg) => {
    if (answers.length === 1) expect(msg.text).toContain('[Tool] Local fixture result')
    return answers.shift()!
  })
  await submitBrief('room', 'Review the notes')
  const room = useRooms.getState().rooms[0]!
  expect(room.finalId).toBe(room.messages.at(-1)?.id)
  expect(roomMarkdown(room)).toContain('Accepted')
  expect(run).toHaveBeenCalledOnce()
  expect(slack).not.toHaveBeenCalled()
})

it('renames, updates config, clears transcripts, and removes forked Slack threads on delete', () => {
  const manage = vi.fn().mockResolvedValue({ tools: [], servers: [] })
  vi.stubGlobal('window', { electron: { workspace: { manage } } })
  const parent: CollabRoom = {
    id: 'room-parent',
    title: 'Original',
    brief: 'Old brief',
    members,
    mode: 'auto',
    limit: 8,
    finalId: 'm2',
    messages: [
      { id: 'm1', author: 'User', text: 'Brief' },
      { id: 'm2', author: 'Muse', text: '[FINAL]\nSummary' }
    ]
  }
  const child: CollabRoom = {
    ...parent,
    id: 'room-parent/slack/C1/1.0',
    slackParent: 'room-parent',
    messages: []
  }
  useRooms.setState({ rooms: [parent, child], speakers: {}, turnProgress: {}, errors: {} })
  useBotStore.setState({ selectedBotId: parent.id, bots: [{ id: 'fallback-bot', accountIds: [] } as unknown as Bot] })

  expect(stripFinalPrefix('[FINAL]\nSummary')).toBe('Summary')
  renameRoom(parent.id, '  Architecture Review  ')
  updateRoomConfig(parent.id, { mode: 'manual', limit: 99 })
  expect(useRooms.getState().rooms[0]).toMatchObject({
    title: 'Architecture Review',
    mode: 'manual',
    limit: 24
  })

  clearRoomTranscript(parent.id)
  expect(useRooms.getState().rooms[0]).toMatchObject({
    messages: [],
    finalId: undefined,
    brief: ''
  })

  deleteRoom(parent.id)
  expect(useRooms.getState().rooms).toEqual([])
  expect(useBotStore.getState().selectedBotId).toBe('fallback-bot')
  expect(manage.mock.calls).toEqual([[parent.id, { op: 'dispose' }], [child.id, { op: 'dispose' }]])
})

it('stops the old identity before accepting its late reply and resets the new session context', async () => {
  let finish!: (text: string) => void
  fixture('auto', () => new Promise((resolve) => { finish = resolve }))
  const original = useRooms.getState().rooms[0]!
  useRooms.setState({ rooms: [{ ...original, members: original.members.map((m) => ({
    ...m, cursor: 2, sessionId: 'previous-session'
  })) }] })
  const run = submitBrief('room', '@Muse review')
  useBotStore.setState(({ bots }) => ({ bots: bots.map((b) => b.id === 'Muse'
    ? { ...b, accountIds: ['Muse', 'other'], activeAccountId: 'other' } : b) }))
  finish('@Dot old reply')
  await run
  const room = useRooms.getState().rooms[0]!
  expect(room.members[0]).toMatchObject({ accountId: 'other', cursor: 0, sessionId: undefined })
  expect(room.messages.map((m) => m.author)).toEqual(['User'])
})

it('honors a lowered turn cap before routing another reply', async () => {
  fixture('auto', async () => {
    updateRoomConfig('room', { limit: 1 })
    return '@Dot check this'
  })
  await submitBrief('room', '@Muse start')
  expect(useRooms.getState().rooms[0]!.messages.map((m) => m.author)).toEqual(['User', 'Muse'])
  expect(useRooms.getState().rooms[0]!.messages[1]?.handoffBotIds).toBeUndefined()
})

it('records only handoffs that start before a queued peer ends the round', async () => {
  const roster = [...members, { ...members[1]!, name: 'Helper', botId: 'helper', accountId: 'helper' }]
  fixture('auto', async (msg) => msg.accountId === 'Muse' ? '@Helper review this' : '[FINAL]\nDone', 8, roster)
  await submitBrief('room', '@Muse @Dot start')
  const room = useRooms.getState().rooms[0]!
  expect(room.messages.map((m) => m.author)).toEqual(['User', 'Muse', 'Dot'])
  expect(room.messages[1]?.handoffBotIds).toBeUndefined()
})

it('attaches a new assignment to a peer already queued by the user', async () => {
  const assignment = '@Dot check the date on page two.'
  const send = vi.fn(async (msg: OutgoingMessage) => {
    if (msg.accountId === 'Muse') return assignment
    expect(msg.text).toContain(`[Muse] ${assignment}`)
    return '[FINAL]\nDate checked'
  })
  fixture('auto', send)
  await submitBrief('room', '@Muse @Dot start')
  expect(send).toHaveBeenCalledTimes(2)
  expect(useRooms.getState().rooms[0]?.messages[1]?.handoffBotIds).toEqual(['Dot'])
})

it('does not restore a session allocated after the user cleared the room', async () => {
  let finish!: (response: { sessionId: string }) => void
  const startSession = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  vi.stubGlobal('window', { electron: { muse: { startSession } } })
  const respond = vi.fn(async () => 'reply')
  fixture('auto', respond)
  const original = useRooms.getState().rooms[0]!
  useRooms.setState({ rooms: [{ ...original, members: original.members.map((m) => ({
    ...m, platform: 'meta-muse'
  })) }] })
  const run = submitBrief('room', '@Muse start')
  expect(startSession).toHaveBeenCalledOnce()
  clearRoomTranscript('room')
  finish({ sessionId: 'cleared-session' })
  await run
  expect(useRooms.getState().rooms[0]!.members[0]!.sessionId).toBeUndefined()
  expect(respond).not.toHaveBeenCalled()
})

function adminFixture(respond: (m: OutgoingMessage) => Promise<string>) {
  fixture('auto', respond)
  useBotStore.setState({ bots: members.map((m) => ({
    id: m.botId, name: m.name, platformId: m.platform,
    accountIds: [m.accountId], activeAccountId: m.accountId
  } as Bot)) })
  return setRoomAdministrator('Muse', true)!
}

it('pins and unpins only the dispatch room while preserving its coordinator and transcript', async () => {
  const id = adminFixture(async () => '[FINAL] Approved')
  await submitBrief(id, 'Review')
  const [other, dispatch] = useRooms.getState().rooms
  expect(dispatch).toMatchObject({ coordinatorId: 'Muse', messages: [{ text: 'Review' }, { final: true }] })

  togglePinRoom(id)
  expect(useRooms.getState().rooms).toEqual([other, { ...dispatch, pinned: true }])
  expect(useRooms.getState().rooms[1]?.messages).toBe(dispatch?.messages)

  togglePinRoom(id)
  expect(useRooms.getState().rooms).toEqual([other, { ...dispatch, pinned: false }])
  expect(useRooms.getState().rooms[1]?.messages).toBe(dispatch?.messages)
})

it('hydrates persisted pins and leaves legacy rooms unpinned', async () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => { data.set(name, value) },
    removeItem: (name: string) => data.delete(name)
  })
  fixture('manual', async () => 'reply')
  const original = useRooms.getState().rooms[0]!
  const legacy = { ...original, id: 'legacy-room' }
  useRooms.setState({ rooms: [original, legacy] })

  togglePinRoom(original.id)
  const beforeHydration = useRooms.getState().rooms[0]
  await useRooms.persist.rehydrate()
  const [pinned, hydratedLegacy] = useRooms.getState().rooms
  expect(pinned).not.toBe(beforeHydration)
  expect(pinned).toMatchObject({ id: original.id, pinned: true })
  expect(hydratedLegacy).toMatchObject({ id: legacy.id, pinned: undefined })

  togglePinRoom(original.id)
  await useRooms.persist.rehydrate()
  expect(useRooms.getState().rooms[0]?.pinned).toBe(false)
})

it('assigns tasks to a newly added bot and returns the result to the administrator', async () => {
  const calls: OutgoingMessage[] = []
  const id = adminFixture(async (m) => {
    calls.push(m)
    return ['@Notes check dates', '[FINAL] dates verified @Dot', '[FINAL] schedule approved'][calls.length - 1]!
  })
  useBotStore.setState(({ bots }) => ({ bots: [...bots, {
    ...bots[0]!, id: 'notes', name: 'Notes', accountIds: ['notes'], activeAccountId: 'notes'
  }] }))
  await submitBrief(id, 'Have @Notes review the schedule')
  expect(calls.map((m) => m.accountId)).toEqual(['Muse', 'notes', 'Muse'])
  expect(calls[2]!.text).toContain('[Notes] [FINAL] dates verified')
  expect(roomMarkdown(useRooms.getState().rooms.find((r) => r.id === id)!)).toContain('schedule approved')
  expect(useRooms.getState().rooms[0]!.members).toHaveLength(2)
})

it('revoking one administrator interrupts delegation and preserves other administrators', async () => {
  let finish!: (text: string) => void
  const id = adminFixture(() => new Promise((resolve) => { finish = resolve }))
  const other = setRoomAdministrator('Dot', true)
  const run = submitBrief(id, 'Delegate the review')
  setRoomAdministrator('Muse', false)
  finish('@Dot review')
  await run
  expect(useRooms.getState().rooms.find((r) => r.id === id)).toMatchObject({
    coordinatorId: undefined, mode: 'manual', messages: [{ author: 'User' }]
  })
  expect(useRooms.getState().rooms.find((r) => r.id === other)?.coordinatorId).toBe('Dot')
})

it('does not transfer administrator authority to a newly selected account', () => {
  const id = adminFixture(async () => '')
  useBotStore.setState(({ bots }) => ({ bots: bots.map((b) => b.id === 'Muse'
    ? { ...b, accountIds: ['Muse', 'other'], activeAccountId: 'other' } : b) }))
  expect(useRooms.getState().rooms.find((r) => r.id === id)?.coordinatorId).toBeUndefined()
})

it('routes only the brief, while delivering approved reference text and preserving it in exports', async () => {
  const send = vi.fn(async () => 'reviewed')
  fixture('manual', send)
  const references = [{ label: '@file sample.txt:3-4', text: '@Dot was mentioned in this example' }]
  await submitBrief('room', '@Muse review the excerpt', { references })
  const room = useRooms.getState().rooms[0]!
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    accountId: 'Muse', text: expect.stringContaining(references[0]!.text)
  }))
  expect(room.messages[0]?.text).toBe('@Muse review the excerpt')
  expect(room.messages[0]?.references).toEqual(references)
  expect(roomMarkdown(room)).toContain(references[0]!.text)
})

it('continues queued participants after a failed turn without retrying the failed member', async () => {
  const calls: string[] = []
  fixture('auto', async (msg) => {
    calls.push(msg.accountId)
    if (msg.accountId === 'Muse') throw new Error('transport timeout')
    expect(msg.text).toContain('Muse 本轮未送达。')
    return '@Muse retry'
  })
  await submitBrief('room', '@Muse @Dot review')
  expect(calls).toEqual(['Muse', 'Dot'])
  expect(useRooms.getState().errors.room).toContain('transport timeout')
})

it('says a delivered turn without a reply was delivered instead of not sent', async () => {
  fixture('manual', async () => '')
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({ getStatus: () => 'online',
    onMessage: () => () => {},
    sendMessage: async (m: OutgoingMessage): Promise<SendReceipt> => {
      m.onAccepted?.()
      return { messageId: 'receipt', acceptedAt: 1 }
    }
  } as unknown as PlatformAdapter)
  await submitBrief('room', '@Muse review')
  const room = useRooms.getState().rooms[0]!
  expect(room.messages.at(-1)).toMatchObject({ notice: true, text: 'Muse 已收到消息，本轮还没有回复。' })
  expect(useRooms.getState().errors.room).toBe('@Muse：已送达，但没有收到回复')
})

it('treats an adapter no-reply error as delivered', async () => {
  fixture('manual', async () => '')
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({ getStatus: () => 'online',
    onMessage: () => () => {},
    sendMessage: async (): Promise<SendReceipt> => { throw new AdapterError('no-reply', 'Hark 回复失败') }
  } as unknown as PlatformAdapter)
  await submitBrief('room', '@Muse review')
  expect(useRooms.getState().rooms[0]!.messages.at(-1)?.text).toBe('Muse 已收到消息，本轮还没有回复。')
  expect(useRooms.getState().errors.room).toBe('@Muse：已送达，但没有回复（Hark 回复失败）')
})

it('returns a delegated failure to the administrator and records only its accepted final', async () => {
  const calls: OutgoingMessage[] = []
  const id = adminFixture(async (msg) => {
    calls.push(msg)
    if (msg.accountId === 'Dot') throw new Error('offline')
    return calls.length === 1 ? '@Dot review' : '[FINAL] partial result'
  })
  await submitBrief(id, 'Review')
  expect(calls.map((m) => m.accountId)).toEqual(['Muse', 'Dot', 'Muse'])
  expect(calls[2]?.text).toContain('Dot 本轮未送达。')
  const room = useRooms.getState().rooms.find((r) => r.id === id)!
  expect(room.messages.at(-1)?.final).toBe(true)
  expect(roomMarkdown(room)).toContain('partial result')
})

it('reports an unprocessed handoff or tool at the cap and stays quiet for a completed turn', async () => {
  const run = vi.fn()
  vi.stubGlobal('window', { electron: { workspace: { run, manage: async () => ({tools: []}) } } })
  const replies = ['@Dot review', '[TOOL] {"name":"read","args":{"path":"notes.txt"}}', 'Complete']
  fixture('auto', async () => replies.shift()!, 1)
  await submitBrief('room', '@Muse start')
  expect(useRooms.getState().errors.room).toContain('@Dot')
  await submitBrief('room', '@Muse read')
  expect(useRooms.getState().errors.room).toContain('read')
  expect(run).not.toHaveBeenCalled()
  await submitBrief('room', '@Muse finish')
  expect(useRooms.getState().errors.room).toBeUndefined()
})

it('keeps the key of an existing Hermes room until its transcript is cleared', async () => {
  const keys: (string | undefined)[] = []
  fixture('manual', async (msg) => { keys.push(msg.hermesSessionKey); return 'noted' })
  useRooms.setState(({ rooms }) => ({ rooms: rooms.map((r) => ({
    ...r, members: r.members.map((m) => ({ ...m, platform: 'hermes' }))
  })) }))
  await submitBrief('room', '@Muse first')
  await submitBrief('room', '@Muse second')
  clearRoomTranscript('room')
  await submitBrief('room', '@Muse new conversation')
  await submitBrief('room', '@Muse follow up')
  expect(keys.slice(0, 2)).toEqual(['room-Muse', 'room-Muse'])
  expect(keys[2]).toBeTruthy()
  expect(keys[2]).not.toBe(keys[0])
  expect(keys[3]).toBe(keys[2])
})

it('lets another account take over while an interrupted member is still preparing a session', async () => {
  let finish!: (session: { sessionId: string }) => void
  const startSession = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  vi.stubGlobal('window', { electron: { muse: { startSession } } })
  const respond = vi.fn(async () => '[FINAL] ready')
  fixture('manual', respond)
  useRooms.setState(({ rooms }) => ({ rooms: rooms.map((r) => ({
    ...r, members: r.members.map((m) => m.botId === 'Muse' ? { ...m, platform: 'meta-muse' } : m)
  })) }))
  const preparing = submitBrief('room', '@Muse first')
  const takeover = submitBrief('room', '@Dot take over')
  try {
    await vi.waitFor(() => expect(useRooms.getState().rooms[0]?.finalId).toBeTruthy(), { timeout: 300 })
  } finally {
    finish({ sessionId: 'stopped-session' })
    await Promise.all([preparing, takeover])
  }
  expect(respond).toHaveBeenCalledTimes(1)
  expect(useRooms.getState().rooms[0]?.members[0]?.sessionId).toBeUndefined()
})

it('leaves delegated [FINAL] messages as drafts and exports the selected historical final', async () => {
  const replies = ['@Dot review', '[FINAL] draft', '[FINAL] first', '[FINAL] second']
  const id = adminFixture(async () => replies.shift()!)
  await submitBrief(id, 'First review')
  const first = useRooms.getState().rooms.find((r) => r.id === id)!
  expect(first.messages.find((m) => m.author === 'Dot')?.final).toBeUndefined()
  await submitBrief(id, 'Update review')
  const updated = useRooms.getState().rooms.find((r) => r.id === id)!
  expect(updated.messages.find((m) => m.id === first.finalId)?.final).toBe(true)
  expect(roomMarkdown(updated, first.finalId)).toContain('first')
  expect(roomMarkdown(updated)).toContain('second')
})

it('includes the current brief’s excerpt for a late participant beyond the 20-message window', () => {
  const excerpt = 'selected line from notes.txt'
  const room: CollabRoom = { id: 'room', title: 'Review', members, mode: 'auto', limit: 24, brief: 'Review the excerpt',
    messages: [
      { id: 'brief', author: 'User', text: 'Review the excerpt', references: [{ label: 'notes.txt', text: excerpt }] },
      ...Array.from({ length: 20 }, (_, i) => ({ id: String(i), author: 'Muse', text: 'progress' }))
    ] }
  expect(turnPrompt(room, members[1]!)).toContain(excerpt)
  expect(turnPrompt(room, { ...members[1]!, cursor: 1 })).not.toContain(excerpt)
})

it.each([
  { mode: 'manual', coordinatorId: undefined },
  { mode: 'auto', coordinatorId: undefined },
  { mode: 'auto', coordinatorId: 'admin' }
] as const)('gives a Hark participant plain discussion context in a $mode room (coordinator $coordinatorId)', (config) => {
  const [admin, hark] = issueRoster
  const brief = '请核对日期。\n保留原文中的引号「9 月 20 日」。'
  const request = {
    id: 'brief', author: 'Slack Taylor', text: brief,
    references: [{ label: 'notes.txt:3-4', text: 'Event date: Sep 20\nSchedule confirmed' }]
  }
  const assignment = { id: 'assignment', author: admin!.name, authorBotId: admin!.botId, text: `@${hark!.name} check the date in the excerpt.` }
  const priorAnswer = { id: 'prior', author: admin!.name, authorBotId: admin!.botId, text: '[FINAL]\nThe earlier draft said Sep 21.', final: true }
  const room: CollabRoom = {
    id: 'room', title: 'Review', members: issueRoster, limit: 8, ...config, brief,
    messages: [request, priorAnswer, assignment]
  }

  const prompt = turnPrompt(room, hark!, assignment)
  expect(prompt).toContain(`User request:\n${brief}`)
  expect(prompt).toContain(`[Slack Taylor] ${brief}\n\n[Reference: notes.txt:3-4]\nEvent date: Sep 20\nSchedule confirmed`)
  expect(prompt).toContain(`Recent discussion:\n[Slack Taylor]`)
  expect(prompt).toContain(`[${admin!.name}] The earlier draft said Sep 21.\n[${admin!.name}] ${assignment.text}`)
  expect(prompt).not.toMatch(/Collaboration room:|Members:|\[FINAL\]|\[HANDOFF\]|Bot IDs:/)
})

it('includes the exact brief, references and assigning post for Hark after a long queue', () => {
  const [admin, hark, worker] = issueRoster
  const brief = 'Review the source excerpt'
  const excerpt = 'Exact source text\n  with indentation.'
  const request = { id: 'brief', author: 'User', text: brief, references: [{ label: 'source', text: excerpt }] }
  const assignment = { id: 'assignment', author: admin!.name, authorBotId: admin!.botId, text: 'Check the date in the source.' }
  const room: CollabRoom = {
    id: 'room', title: 'Review', members: issueRoster, mode: 'auto', limit: 24, brief,
    messages: [request, assignment, ...Array.from({ length: 21 }, (_, index) => ({
      id: `update-${index}`, author: worker!.name, authorBotId: worker!.botId, text: `Update ${index}.`
    }))]
  }

  const prompt = turnPrompt(room, hark!, assignment)
  expect(prompt).toContain(`User request:\n${brief}\n\n[Reference: source]\n${excerpt}`)
  expect(prompt).toContain(`Earlier message relevant to this request:\n[${admin!.name}] ${assignment.text}`)
  expect(prompt).toContain(`[${worker!.name}] Update 20.`)
  expect(prompt).not.toContain('Update 0.')
  expect(turnPrompt(room, { ...hark!, cursor: room.messages.length }, assignment)).not.toContain(excerpt)
})

it('keeps the exact user request and reference text when they mention protocol markers', () => {
  const hark = issueRoster[1]!
  const brief = '[FINAL] is a heading in my notes. Please review it.'
  const excerpt = '[HANDOFF]\nExample copied as written.'
  const room: CollabRoom = {
    id: 'room', title: 'Review', members: issueRoster, mode: 'manual', limit: 8, brief,
    messages: [{ id: 'brief', author: 'User', text: brief, references: [{ label: 'notes', text: excerpt }] }]
  }
  expect(turnPrompt(room, hark)).toContain(`[User] ${brief}\n\n[Reference: notes]\n${excerpt}`)
})

it.each([0, 1])('keeps coordinator dispatch and non-Hark participant prompts (coordinator index %i)', (index) => {
  const coordinator = issueRoster[index]!
  const worker = issueRoster[2]!
  const room: CollabRoom = {
    id: 'room', title: 'Review', members: issueRoster, mode: 'auto', limit: 8, brief: 'Review the schedule',
    coordinatorId: coordinator.botId, messages: [{ id: 'draft', author: worker.name, authorBotId: worker.botId, text: '[FINAL] Dates verified.' }]
  }
  const prompt = turnPrompt(room, coordinator)
  expect(prompt).toContain(`Collaboration room: Review. You are @${coordinator.name}.`)
  expect(prompt).toContain(`Members: ${issueRoster.map((member) => `@${member.name}`).join(', ')}.`)
  expect(prompt).toContain('Coordinate the human brief and assign work as needed.')
  expect(prompt).toContain('[HANDOFF] ["<botId>"]')
  expect(prompt).toContain('Use [FINAL] on its own first line')
  expect(prompt).toContain('Human brief: Review the schedule')
  expect(prompt).toContain(`[${worker.name}] [FINAL] Dates verified.`)
  expect(turnPrompt(room, worker)).toContain('Answer the administrator’s request.')
})

it('delivers the exact assigning post and brief after a long queue', async () => {
  const roster = Array.from({ length: 23 }, (_, i): RoomMember => ({
    platform: 'dot', botId: `bot-${i}`, accountId: `account-${i}`, name: `Bot${i}`, cursor: 0
  }))
  const brief = 'Review the source excerpt'
  const excerpt = 'Exact source excerpt that must survive the window.'
  const assignment = 'First assignment: Verify the date from the supplied excerpt.'
  const calls: OutgoingMessage[] = []
  fixture('auto', async (msg) => {
    calls.push(msg)
    const turn = Number(msg.accountId.slice('account-'.length))
    if (turn === 0) {
      const targets = roster.slice(1).map(({ botId }) => botId)
      return `[HANDOFF] ${JSON.stringify(targets)}\n${assignment}`
    }
    return turn === 22 ? '[FINAL]\nComplete' : 'Progress'
  }, 24, roster)
  await submitBrief('room', brief, { references: [{ label: 'source', text: excerpt }] })
  expect(calls).toHaveLength(23)
  expect(calls[22]?.text).toContain(`Human brief: ${brief}\n\n[Reference: source]\n${excerpt}`)
  expect(calls[22]?.text).toContain(`[Bot0] ${assignment}`)
  expect(calls[22]?.text).not.toContain('[Bot1] Progress')
})

it('keeps fallback bot IDs distinct even when a direct match appears later in the roster', () => {
  fixture('manual', async () => 'reply')
  const [muse, dot] = useRooms.getState().rooms[0]!.members
  useRooms.setState(({ rooms }) => ({ rooms: [{ ...rooms[0]!, members: [
    { ...muse!, botId: 'old-muse' }, muse!, { ...dot!, botId: 'old-dot' }, { ...dot!, botId: 'other-old-dot' }
  ] }] }))
  useBotStore.setState(({ bots }) => ({ bots: [...bots] }))
  expect(useRooms.getState().rooms[0]!.members.map(({ botId }) => botId)).toEqual([
    'old-muse', 'Muse', 'Dot', 'other-old-dot'
  ])
})

it('only advances the cursor with a platform session and replays context until then', async () => {
  const calls: OutgoingMessage[] = []
  fixture('manual', async (msg) => {
    calls.push(msg)
    if (calls.length === 1) return 'First reply'
    return { text: 'Next reply', sessionId: 'confirmed-session' }
  })
  await submitBrief('room', '@Muse first brief')
  expect(useRooms.getState().rooms[0]?.members[0]?.cursor).toBe(0)
  await submitBrief('room', '@Muse second brief')
  expect(calls[1]?.text).toContain('[User] @Muse first brief')
  expect(calls[1]?.text).toContain('[Muse] First reply')
  expect(useRooms.getState().rooms[0]?.members[0]).toMatchObject({ cursor: 4, sessionId: 'confirmed-session' })
  await submitBrief('room', '@Muse third brief')
  expect(calls[2]?.sessionId).toBe('confirmed-session')
  expect(calls[2]?.text).not.toContain('First reply')
})

it('skips serialization for transient updates and skips writes for an equivalent rooms payload', () => {
  const data = new Map<string, string>()
  const setItem = vi.fn((name: string, value: string) => { data.set(name, value) })
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => data.get(name) ?? null,
    setItem,
    removeItem: (name: string) => data.delete(name)
  })
  const toJSON = vi.fn(() => ({ id: 'storage-room' }))
  const room = { id: 'storage-room', title: 'Storage', toJSON } as unknown as CollabRoom
  useRooms.setState({ rooms: [room] })
  useRooms.setState({ speakers: { [room.id]: 'Muse' }, turnProgress: { [room.id]: { turn: 1, limit: 8 } } })
  useRooms.setState({ errors: { [room.id]: 'Transient error' } })
  expect(toJSON).toHaveBeenCalledOnce()
  expect(setItem).toHaveBeenCalledOnce()
  useRooms.setState({ rooms: [{ ...room }] })
  expect(toJSON).toHaveBeenCalledTimes(2)
  expect(setItem).toHaveBeenCalledOnce()
  useRooms.setState({ rooms: [] })
  expect(setItem).toHaveBeenCalledTimes(2)
})

it('recovers invalid tool JSON locally and continues queued peers', async () => {
  const run = vi.fn()
  vi.stubGlobal('window', { electron: { workspace: { run, manage: async () => ({ tools: [{ name: 'list' }] }) } } })
  const send = vi.fn(async (msg: OutgoingMessage) => {
    if (msg.accountId === 'Muse') {
      expect(msg.text).toContain('use "." for the workspace root')
      return '[TOOL] {"name":"list", "args": {"path":"@Dot"}'
    }
    expect(msg.text).toContain('[Tool] 工具请求失败：无效的工具请求：JSON 格式有误')
    return '[FINAL]\nPartial result'
  })
  fixture('auto', send)
  await submitBrief('room', '@Muse @Dot review')
  expect(send.mock.calls.map(([msg]) => msg.accountId)).toEqual(['Muse', 'Dot'])
  expect(run).not.toHaveBeenCalled()
  const room = useRooms.getState().rooms[0]!
  expect(room.messages[1]?.localOnly).toBe(true)
  expect(room.messages[1]?.handoffBotIds).toBeUndefined()
  expect(room.messages[2]).toMatchObject({ author: 'Tool', localOnly: true })
  expect(room.finalId).toBe(room.messages[3]?.id)
})

it('returns a denied delegated tool request to the coordinator', async () => {
  const run = vi.fn().mockRejectedValue(new Error('用户已取消本次操作'))
  vi.stubGlobal('window', { electron: { workspace: { run, manage: async () => ({ tools: [] }) } } })
  const send = vi.fn(async (msg: OutgoingMessage) => {
    if (msg.accountId === 'Dot') return '[TOOL] {"name":"read","args":{"path":"@Muse"}}'
    if (msg.text.includes('[Tool] 工具请求失败')) return '[FINAL]\nReviewed with existing evidence'
    return '@Dot check'
  })
  const id = adminFixture(send)
  await submitBrief(id, 'Review')
  expect(send.mock.calls.map(([msg]) => msg.accountId)).toEqual(['Muse', 'Dot', 'Muse'])
  expect(run).toHaveBeenCalledOnce()
  expect(useRooms.getState().errors[id]).toContain('用户已取消本次操作')
  expect(useRooms.getState().rooms.find((r) => r.id === id)?.messages.at(-1)?.final).toBe(true)
})

it('retains the confirmed v0.14 final when starting the next brief after hydration', async () => {
  fixture('manual', async () => '[FINAL] updated')
  const current = useRooms.getState()
  const stored = { ...current.rooms[0]!, finalId: 'old', messages: [
    { id: 'old', author: 'Muse', text: '[FINAL] earlier result' }
  ] }
  const hydrate = useRooms.persist.getOptions().merge!
  useRooms.setState(hydrate({ rooms: [stored] }, current))
  await submitBrief('room', '@Dot update')
  expect(useRooms.getState().rooms[0]?.messages[0]?.final).toBe(true)
})

it('gives Hark a plain assistant frame plus the hardened workspace portal instead of [TOOL] instructions', async () => {
  const manage = vi.fn().mockResolvedValue({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] })
  const portal = vi.fn().mockResolvedValue({
    running: true,
    publicUrl: 'https://portal.example.trycloudflare.com',
    entryUrl: 'https://portal.example.trycloudflare.com/?token=abc',
    tools: []
  })
  vi.stubGlobal('window', {
    electron: {
      workspace: { manage, run: vi.fn() },
      workspacePortal: { manage: portal },
      hark: { rpc: vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'hark-conv-1' } }) }
    }
  })
  const sentPrompts: string[] = []
  fixture(
    'manual',
    async (msg) => {
      sentPrompts.push(msg.text)
      return '收到，已通过工作区门户读取资料。'
    },
    4,
    [{ name: 'HarkBot', botId: 'hark-bot', platform: 'hark' as const, accountId: 'acc-hark', cursor: 0 }]
  )

  await submitBrief('room', '@HarkBot 帮忙总结一下当前工作区')
  expect(sentPrompts).toHaveLength(1)
  const prompt = sentPrompts[0]!
  expect(prompt).not.toContain('[TOOL]')
  expect(prompt).not.toContain('Collaboration room:')
  expect(prompt).not.toContain('Members:')
  expect(prompt).not.toContain('Human brief:')
  expect(prompt).toContain('Please help with the user’s request')
  expect(prompt).toContain('https://portal.example.trycloudflare.com/?token=abc')
  expect(portal).toHaveBeenCalledWith({ op: 'open', scope: 'room' })
  expect(manage).not.toHaveBeenCalled()
})
