import type { CollabRoom, RoomMessage } from '@/rooms/model'

export interface SearchableMessage {
  id: string
  text: string
  createdAt?: number
}

export function findMessageMatchIds(messages: readonly SearchableMessage[], query: string): string[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return []
  // Older room transcripts lack timestamps. Keep those posts in transcript order.
  let timestamp = 0
  const hits = []
  for (const message of messages) {
    timestamp = message.createdAt ?? timestamp
    if (message.text.toLowerCase().includes(wanted)) hits.push({ id: message.id, timestamp })
  }
  return hits.sort((a, b) => a.timestamp - b.timestamp).map((hit) => hit.id)
}

export function buildSearchSnippet(text: string, query: string, maxLen = 88): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (maxLen < 1) return ''
  if (flat.length <= maxLen) return flat
  const wanted = query.trim().replace(/\s+/g, ' ').toLowerCase()
  const match = Math.max(0, flat.toLowerCase().indexOf(wanted))
  // Reserve space for ellipses and give the matched phrase priority over context.
  const context = Math.max(0, Math.floor((maxLen - wanted.length - 2) / 3))
  const start = Math.max(0, Math.min(match - context, flat.length - maxLen + 1))
  const prefix = start ? '…' : ''
  const width = maxLen - prefix.length
  const suffix = start + width < flat.length ? '…' : ''
  return prefix + flat.slice(start, start + width - suffix.length).trim() + suffix
}

export function searchRoomMessages(rooms: readonly CollabRoom[], query: string, limit = 20) {
  const wanted = query.trim().toLowerCase()
  const hits: { room: CollabRoom; message: RoomMessage; sender: string; timestamp: number; index: number }[] = []
  if (wanted && limit > 0) {
    for (const room of rooms) {
      const names = new Map(room.members.map((member) => [member.botId, member.name]))
      let timestamp = room.createdAt ?? 0
      for (const [index, message] of room.messages.entries()) {
        timestamp = message.createdAt ?? timestamp
        const member = message.authorBotId && names.get(message.authorBotId)
        const sender = member && member !== message.author ? `${message.author} · ${member}` : message.author
        if (sender.toLowerCase().includes(wanted) || message.text.toLowerCase().includes(wanted)) {
          hits.push({ room, message, sender, timestamp, index })
        }
      }
    }
  }
  return hits.sort((a, b) => b.timestamp - a.timestamp || b.index - a.index)
    .slice(0, limit)
    .map(({ room, message, sender }) => ({ room, message, sender, snippet: buildSearchSnippet(message.text, wanted) }))
}
