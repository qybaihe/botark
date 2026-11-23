import type { PlatformId } from '@adapters/types'
import { createId } from '@shared/id'

export interface RoomMember {
  botId: string
  accountId: string
  platform: PlatformId
  name: string
  agentId?: string
  sessionId?: string
  hermesSessionKey?: string
  cursor: number
}

export function freshRoomSession(platform: PlatformId) {
  return {
    cursor: 0, sessionId: undefined,
    hermesSessionKey: platform === 'hermes' ? createId('hermes') : undefined
  }
}

export interface RoomReference {
  label: string
  text: string
}

export interface RoomMessage {
  id: string
  author: string
  text: string
  references?: RoomReference[]
  authorBotId?: string
  notice?: boolean
  final?: boolean
  createdAt?: number
}

export interface CollabRoom {
  id: string
  title: string
  members: RoomMember[]
  messages: RoomMessage[]
  mode: 'manual' | 'auto'
  limit: number
  brief: string
  /** Present on a native coordination room owned by this administrator. */
  coordinatorId?: string
  slackParent?: string
  slackChannel?: string
  slackThread?: string
  finalId?: string
  createdAt?: number
}

const escapedName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface MentionSegment {
  text: string
  member?: RoomMember
}

export function splitMentionSegments(
  text: string,
  members: ReadonlyArray<RoomMember>
): MentionSegment[] {
  if (!text || !members.length) return text ? [{ text }] : []
  const sorted = [...members]
    .filter((m) => m.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length)
  if (!sorted.length) return [{ text }]

  const hits: Array<{ start: number; end: number; member: RoomMember }> = []
  for (const member of sorted) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_.+-])@(${escapedName(member.name)})(?![A-Za-z0-9_]|\\.[A-Za-z0-9])`,
      'giu'
    )
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      if (hits.some((h) => start >= h.start && start < h.end)) continue
      hits.push({ start, end, member })
    }
  }
  if (!hits.length) return [{ text }]
  hits.sort((a, b) => a.start - b.start)

  const segments: MentionSegment[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start < cursor) continue
    if (hit.start > cursor) {
      segments.push({ text: text.slice(cursor, hit.start) })
    }
    segments.push({ text: text.slice(hit.start, hit.end), member: hit.member })
    cursor = hit.end
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) })
  }
  return segments
}

export function mentions(text: string, members: RoomMember[]): RoomMember[] {
  const seen = new Set<string>()
  const result: RoomMember[] = []
  for (const seg of splitMentionSegments(text, members)) {
    if (!seg.member) continue
    const key = seg.member.botId || seg.member.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(seg.member)
  }
  return result
}

function messageWithReferences(message: RoomMessage): string {
  return [message.text, ...(message.references ?? []).map((ref) =>
    `[Reference: ${ref.label}]\n${ref.text}`
  )].join('\n\n')
}

export function isHumanRoomMessage(message: RoomMessage): boolean {
  return !message.authorBotId && (message.author === 'User' || message.author.startsWith('Slack '))
}

export function roomRecipient(room: CollabRoom, externalAudience?: string): string {
  return [room.title, room.members.map((m) => m.name).join(', '), externalAudience].filter(Boolean).join(' · ')
}

export function turnPrompt(room: CollabRoom, member: RoomMember): string {
  const start = Math.max(member.cursor, room.messages.length - 20)
  const briefIndex = room.messages.findLastIndex(isHumanRoomMessage)
  const missedBrief = briefIndex >= member.cursor && briefIndex < start ? room.messages[briefIndex] : undefined
  const context = room.messages
    .slice(start)
    .map((m) => `[${m.author}] ${messageWithReferences(m)}`)
    .join('\n')
  return [
    `Collaboration room: ${room.title}. You are @${member.name}.`,
    `Members: ${room.members.map((m) => '@' + m.name).join(', ')}.`,
    room.coordinatorId
      ? member.botId === room.coordinatorId
        ? 'Coordinate the human brief. Mention a teammate to assign work or ask for progress. Their reply comes back to you. Use [FINAL] when ready.'
        : 'Answer the administrator’s request. Your reply returns to the administrator for review.'
      : 'Review, revise and choose a writer as needed. Mention a peer only to request their next turn. Start the final deliverable with [FINAL] on its own line.',
    `Human brief: ${missedBrief?.references?.length ? messageWithReferences(missedBrief) : room.brief}`,
    context
  ].join('\n\n')
}

export function isFinal(text: string): boolean {
  return /^\[FINAL\](?:\s|$)/i.test(text.trimStart())
}

export function stripFinalPrefix(text: string): string {
  return text.replace(/^\s*\[FINAL\]\s*/i, '')
}

export function roomMarkdown(room: CollabRoom, finalId = room.finalId): string {
  const final = room.messages.find((m) => m.id === finalId)
  return final
    ? `# ${room.title}\n\n${stripFinalPrefix(final.text)}\n`
    : `# ${room.title}\n\n${room.messages.map((m) => `## ${m.author}\n\n${messageWithReferences(m)}`).join('\n\n')}\n`
}
