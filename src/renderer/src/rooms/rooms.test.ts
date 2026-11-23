import { afterEach, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'
import { useBotStore } from '@/store/botStore'
import { mentions, roomMarkdown, stripFinalPrefix, type CollabRoom } from './model'
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
