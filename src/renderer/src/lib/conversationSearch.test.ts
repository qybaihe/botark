import { describe, expect, it } from 'vitest'
import type { CollabRoom, RoomMessage } from '@/rooms/model'
import { buildSearchSnippet, findMessageMatchIds, searchRoomMessages } from './conversationSearch'

function room(id: string, messages: RoomMessage[]): CollabRoom {
  return { id, title: id, mode: 'manual', brief: '', limit: 5, messages,
    members: [{ botId: 'researcher', accountId: 'account', platform: 'hermes', name: 'Researcher', cursor: 0 }] }
}

describe('findMessageMatchIds', () => {
  it('finds one hit per message, oldest first, including messages outside the visible window', () => {
    const history = Array.from({ length: 100 }, (_, i) => ({ id: String(i), createdAt: i, text: i % 30 ? '' : 'Alpha ALPHA' })).reverse()
    expect(findMessageMatchIds(history, ' alPHA ')).toEqual(['0', '30', '60', '90'])
    expect(history[0]?.id).toBe('99')
    expect(findMessageMatchIds(history, ' ')).toEqual([])
    expect(findMessageMatchIds(history, 'missing')).toEqual([])
  })

  it('preserves transcript order for legacy room posts and tied timestamps', () => {
    const posts = [{ id: 'a', text: '✓' }, { id: 'b', text: '✓', createdAt: 20 }, { id: 'c', text: '✓' }, { id: 'd', text: '✓', createdAt: 20 }]
    expect(findMessageMatchIds(posts, '✓')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('buildSearchSnippet', () => {
  it('normalizes whitespace and gives matches priority within a bounded excerpt', () => {
    expect(buildSearchSnippet('  First\nsecond\tword  ', 'SECOND')).toBe('First second word')
    const long = 'prefix '.repeat(20) + 'NeEdLe' + ' suffix'.repeat(20)
    const excerpt = buildSearchSnippet(long, 'needle', 30)
    expect(excerpt).toMatch(/^….*NeEdLe.*…$/)
    expect(excerpt.length).toBeLessThanOrEqual(30)
    expect(buildSearchSnippet('abcdefghi', 'abc', 6)).toBe('abcde…')
    expect(buildSearchSnippet('abcdefghi', 'ghi', 6)).toBe('…efghi')
    expect(buildSearchSnippet('abcdefghi', 'absent', 6)).toBe('abcde…')
    expect(buildSearchSnippet('test', 't', 0)).toBe('')
  })
})

describe('searchRoomMessages', () => {
  const rooms = [
    room('one', [
      { id: 'old', author: 'User', text: 'A needle here', createdAt: 2 },
      { id: 'renamed', author: 'Former Name', authorBotId: 'researcher', text: '  context\nonly ', createdAt: 8 }
    ]),
    room('two', [
      { id: 'author', author: 'Slack Needle', text: 'sender only', createdAt: 5 },
      { id: 'new', author: 'Tool', text: 'NEEDLE found', createdAt: 10 }
    ])
  ]

  it('ranks text and author hits across rooms by time before applying the limit', () => {
    expect(searchRoomMessages(rooms, ' nEeDlE ', 2).map(({ room, message }) => [room.id, message.id]))
      .toEqual([['two', 'new'], ['two', 'author']])
    expect(searchRoomMessages(rooms, 'needle', 0)).toEqual([])
    expect(searchRoomMessages(rooms, '  ', 20)).toEqual([])
  })

  it('finds recorded senders and current member names only on their own posts', () => {
    for (const name of ['researcher', 'former']) {
      const hits = searchRoomMessages(rooms, name, 10)
      expect(hits.map((hit) => hit.message.id)).toEqual(['renamed'])
      expect(hits[0]).toMatchObject({ sender: 'Former Name · Researcher', snippet: 'context only' })
    }
  })

  it('orders undated posts in reverse transcript order without changing the room', () => {
    const legacy = room('legacy', ['first', 'last'].map((id) => ({ id, author: 'User', text: 'result' })))
    expect(searchRoomMessages([legacy], 'result').map((hit) => hit.message.id)).toEqual(['last', 'first'])
    expect(legacy.messages[0]?.id).toBe('first')
  })
})
