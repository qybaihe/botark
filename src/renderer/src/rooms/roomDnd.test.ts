import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'
import { useBotStore } from '@/store/botStore'
import type { CollabRoom, RoomMember } from './model'
import {
  applyDropOnRoom,
  applyDropOutOfRoom,
  BOT_DRAG_MIME,
  decodeRoomMemberDrag,
  encodeRoomMemberDrag,
  isRoomDropDrag,
  isRoomMemberDrag,
  ROOM_MEMBER_DRAG_MIME
} from './roomDnd'
import { useRooms } from './roomStore'

const member = (name: string): RoomMember => ({ name, botId: name, platform: 'dot', accountId: name, cursor: 0 })

function room(id: string, names: string[]): CollabRoom {
  return { id, title: id.toUpperCase(), brief: '', members: names.map(member), mode: 'auto', limit: 8, messages: [] }
}

function setup(status: 'online' | 'offline' = 'online') {
  useRooms.setState({ rooms: [room('a', ['Muse', 'Dot']), room('b', ['Hark', 'Cue'])], speakers: {}, errors: {} })
  useBotStore.setState({
    bots: ['Muse', 'Dot', 'Hark', 'Cue', 'Grok'].map(
      (n) => ({ id: n, name: n, platformId: 'dot', activeAccountId: n, accountIds: [n] }) as unknown as Bot
    ),
    accounts: {}
  })
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({ getStatus: () => status } as unknown as PlatformAdapter)
}

const data = (entries: Record<string, string>) => ({ getData: (k: string) => entries[k] ?? '' })
const membersOf = (id: string) => useRooms.getState().rooms.find((r) => r.id === id)!.members.map((m) => m.botId)

afterEach(() => vi.restoreAllMocks())

describe('room drag and drop', () => {
  it('recognises drag payload types', () => {
    expect(isRoomDropDrag([BOT_DRAG_MIME])).toBe(true)
    expect(isRoomDropDrag([ROOM_MEMBER_DRAG_MIME])).toBe(true)
    expect(isRoomDropDrag(['Files'])).toBe(false)
    expect(isRoomMemberDrag([BOT_DRAG_MIME])).toBe(false)
    expect(decodeRoomMemberDrag(encodeRoomMemberDrag('a', 'Dot'))).toEqual({ roomId: 'a', botId: 'Dot' })
    expect(decodeRoomMemberDrag('not json')).toBeNull()
  })

  it('adds a sidebar bot dropped onto a group chat', () => {
    setup()
    const res = applyDropOnRoom('a', data({ [BOT_DRAG_MIME]: 'Grok' }))
    expect(res?.ok).toBe(true)
    expect(membersOf('a')).toEqual(['Muse', 'Dot', 'Grok'])
  })

  it('rejects duplicates and disconnected bots', () => {
    setup()
    expect(applyDropOnRoom('a', data({ [BOT_DRAG_MIME]: 'Dot' }))?.ok).toBe(false)
    setup('offline')
    expect(applyDropOnRoom('a', data({ [BOT_DRAG_MIME]: 'Grok' }))?.ok).toBe(false)
    expect(membersOf('a')).toEqual(['Muse', 'Dot'])
  })

  it('transfers a member dragged from one group chat to another', () => {
    setup()
    const res = applyDropOnRoom('b', data({ [ROOM_MEMBER_DRAG_MIME]: encodeRoomMemberDrag('a', 'Dot') }))
    expect(res?.ok).toBe(true)
    expect(membersOf('a')).toEqual(['Muse'])
    expect(membersOf('b')).toEqual(['Hark', 'Cue', 'Dot'])
  })

  it('ignores dropping a member back onto its own chat', () => {
    setup()
    expect(applyDropOnRoom('a', data({ [ROOM_MEMBER_DRAG_MIME]: encodeRoomMemberDrag('a', 'Dot') }))).toBeNull()
    expect(membersOf('a')).toEqual(['Muse', 'Dot'])
  })

  it('removes a member dragged out of a group chat, but keeps the last one', () => {
    setup()
    expect(applyDropOutOfRoom(data({ [ROOM_MEMBER_DRAG_MIME]: encodeRoomMemberDrag('a', 'Dot') }))?.ok).toBe(true)
    expect(membersOf('a')).toEqual(['Muse'])
    expect(applyDropOutOfRoom(data({ [ROOM_MEMBER_DRAG_MIME]: encodeRoomMemberDrag('a', 'Muse') }))?.ok).toBe(false)
    expect(membersOf('a')).toEqual(['Muse'])
  })
})
