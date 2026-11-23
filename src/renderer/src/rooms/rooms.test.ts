import { afterEach, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'
import { useBotStore } from '@/store/botStore'
import { mentions, roomMarkdown, stripFinalPrefix, turnPrompt, type CollabRoom } from './model'
import {
  clearRoomTranscript,
  deleteRoom,
  renameRoom,
  setRoomAdministrator,
  stopRoom,
  submitBrief,
  updateRoomConfig,
  useRooms
} from './roomStore'

const members = ['Muse', 'Dot'].map((name) => ({ name, botId: name, platform: 'dot' as const, accountId: name, cursor: 0 }))
function fixture(mode: CollabRoom['mode'], respond: (m: OutgoingMessage) => Promise<string>, limit = 8) {
  const room: CollabRoom = { id: 'room', title: 'Review', brief: '', members, mode, limit, messages: [] }
  useRooms.setState({ rooms: [room], speakers: {}, errors: {} })
  useBotStore.setState({ bots: members.map((m) => ({ id: m.botId, accountIds: [m.accountId] } as Bot)) })
  let emit!: (msg: IncomingMessage) => void
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({ getStatus: () => 'online',
    onMessage: (listener: typeof emit) => { emit = listener; return () => {} },
    sendMessage: async (m: OutgoingMessage) => {
      const text = await respond(m)
      const message = { ...m, text, createdAt: 1, id: 'fixture' }
      emit({ ...message, conversationId: 'private-chat', text: '@Dot wrong transcript' })
      emit(message)
      return { messageId: 'receipt', acceptedAt: 1 }
    }
  } as unknown as PlatformAdapter)
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('routes complete names once and ignores email addresses', () => {
  expect(mentions('x@Muse.io @MuseExtra @Dot @Muse @Dot', members).map((m) => m.name)).toEqual(['Dot', 'Muse'])
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
    expect(msg.text).toContain('Muse 本轮未取得回复')
    return '@Muse retry'
  })
  await submitBrief('room', '@Muse @Dot review')
  expect(calls).toEqual(['Muse', 'Dot'])
  expect(useRooms.getState().errors.room).toContain('transport timeout')
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
  expect(calls[2]?.text).toContain('Dot 本轮未取得回复')
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
