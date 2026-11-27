import type { PlatformId } from '@adapters/types'
import { createId } from '@shared/id'
import { isToolRequest } from './toolRequests'
import type { ChatMediaPart } from '@/types'

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
  media?: ChatMediaPart[]
  mediaSource?: Pick<RoomMember, 'accountId' | 'platform' | 'agentId' | 'sessionId'>
  references?: RoomReference[]
  authorBotId?: string
  notice?: boolean
  final?: boolean
  handoffBotIds?: string[]
  localOnly?: boolean
  createdAt?: number
}

export interface CollabRoom {
  id: string
  title: string
  pinned?: boolean
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

export function normalizeMentionName(name: string): string {
  return name.normalize('NFC').replace(/[\p{Zs}\t]+/gu, ' ').replace(/ *[·•・] */g, '·').trim().toLowerCase()
}

const horizontalSpace = '[\\p{Zs}\\t]'
export const mentionStartPattern = String.raw`(?:(?<![\p{Script=Latin}\p{M}\p{N}_.+@＠-])|(?<=(?<![\p{Script=Latin}\p{N}_])__))[@＠]`
const ignoredMentionText = new RegExp([
  // Fenced blocks (including unclosed blocks), blockquotes, and inline backtick spans.
  /^[\p{Zs}\t]*(?<fence>(?<fenceChar>`|~)\k<fenceChar>{2,})[^\r\n]*\r?\n[\s\S]*?(?:^[\p{Zs}\t]*\k<fence>\k<fenceChar>*[\p{Zs}\t]*\r?$|(?![\s\S]))/u.source,
  String.raw`^[\p{Zs}\t]*>[^\n]*`,
  /(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/u.source,
  // Markdown link destinations, absolute URLs, and slash-prefixed paths.
  String.raw`(?<=\]\()[^)\r\n]+`,
  /(?:\b(?:[a-z][a-z\d+.-]*:\/\/|www\.|(?:[a-z\d-]+\.)+[a-z]{2,}(?=[/#?]))|\/)[^\s<>"'`()\[\]，。！？；、：]+/u.source
].join('|'), 'gimu')

function mentionNamePattern(name: string): string {
  return name.split(/([ ·])/).map((part) => {
    if (part === ' ') return `${horizontalSpace}+`
    if (part === '·') return `${horizontalSpace}*[·•・]${horizontalSpace}*`
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
}

export interface MentionSegment {
  text: string
  member?: RoomMember
}

export function splitMentionSegments(
  text: string,
  members: ReadonlyArray<RoomMember>
): MentionSegment[] {
  if (!text || !members.length || !/[@＠]/u.test(text)) return text ? [{ text }] : []
  const byName = new Map<string, RoomMember>()
  for (const member of members) {
    const name = normalizeMentionName(member.name)
    if (name && !byName.has(name)) byName.set(name, member)
  }
  if (!byName.size) return [{ text }]
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(mentionNamePattern)
  // Allow Markdown's double underscores at either boundary while excluding word and domain suffixes.
  const after = String.raw`(?![\p{Script=Latin}\p{M}\p{N}]|_(?!_(?![\p{Script=Latin}\p{N}_]))|[.-][\p{L}\p{N}_]|${horizontalSpace}*[·•・]${horizontalSpace}*[\p{L}\p{N}])`
  const matcher = new RegExp(`${mentionStartPattern}(${names.join('|')})${after}`, 'giu')

  const normalized = text.normalize('NFC')
  // Only decomposed text needs an offset map to preserve the original spelling in the segments.
  const offsets = normalized === text ? undefined : new Map<number, number>()
  if (offsets) {
    let offset = 0
    for (const { index, segment } of new Intl.Segmenter().segment(text)) {
      offsets.set(offset, index)
      offset += segment.normalize('NFC').length
    }
    offsets.set(offset, text.length)
  }
  const ignored = normalized.matchAll(ignoredMentionText)
  let excluded = ignored.next().value

  const segments: MentionSegment[] = []
  let cursor = 0
  for (const match of normalized.matchAll(matcher)) {
    const end = match.index + match[0].length
    while (excluded && excluded.index + excluded[0].length <= match.index) excluded = ignored.next().value
    if (excluded && end > excluded.index) continue
    const member = byName.get(normalizeMentionName(match[1]!))
    if (!member) continue
    const startOriginal = offsets?.get(match.index) ?? match.index
    const endOriginal = offsets?.get(end) ?? end
    if (startOriginal > cursor) segments.push({ text: text.slice(cursor, startOriginal) })
    segments.push({ text: text.slice(startOriginal, endOriginal), member })
    cursor = endOriginal
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) })
  }
  return segments
}

export function mentions(text: string, members: ReadonlyArray<RoomMember>): RoomMember[] {
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

function explicitHandoff(text: string): { botIds: string[]; text: string } | undefined {
  const reply = text.trimStart()
  const header = /^\[HANDOFF\][\p{Zs}\t]*(\[[^\r\n]*\])[\p{Zs}\t]*(?:\r?\n|$)/iu.exec(reply)
  if (!header) return
  try {
    const botIds: unknown = JSON.parse(header[1]!)
    if (Array.isArray(botIds) && botIds.every((id): id is string => typeof id === 'string' && Boolean(id))) {
      return { botIds: [...new Set(botIds)], text: reply.slice(header[0].length).trimStart() }
    }
  } catch {
    // An invalid header is ordinary message text.
  }
}

const handoffRequest = /^(?:在吗|在不在|回一声|回一下|说话|回复|回答|测试|看看|请|帮忙|处理|核实|检查|确认|审阅|评估|麻烦|能否|可否|能不能|(?:你|您)(?:在吗|在不在|能否|能不能|可以|方便)|\b(?:please|reply|review|check|could you|can you|would you)\b)/iu
const relayedHandoffRequest = /^用户(?:在问|叫|让|请|想让|想知道)(?:你|您).*?(?:在不在|在吗|回一声|回一下|说话|回复|回答)/u
const thanksOrCourtesy = /^(?:感谢|多谢|谢谢|thanks\b|thank you\b|请(?:查收|知悉|参考)|please\s+(?:see|find|note)\s+(?!if\b|whether\b))/iu
const completedWork = /^(?:[^，,？?]*(?:已完成|已通过|已确认|完毕|(?:结果|结论|报告)(?:如下|显示|表明)|\b(?:is|are|was|were)\s+(?:now\s+)?(?:complete|finished|attached)\b)|(?:确认|核实|审阅|检查|评估|测试)(?:了|完了|(?:结果|结论|报告)?\s*[:：]))/iu

function directHandoff(text: string, members: ReadonlyArray<RoomMember>): RoomMember | undefined {
  const paragraph = text
    .replace(/^(?:[\p{Zs}\t]*>[^\n]*(?:\n|$)|[\p{Zs}\t]*\r?\n)+/u, '')
    .split(/\r?\n(?=[\p{Zs}\t]*(?:\r?\n|>))/u, 1)[0]!.trimStart()
  const segments = splitMentionSegments(paragraph, members)
  const opening = segments[0]?.text
  const formatted = opening === '**' || opening === '__'
  const address = segments[formatted ? 1 : 0]
  if (!address?.member) return
  const remainder = paragraph.slice(address.text.length + (formatted ? 2 : 0))
  if (formatted && !remainder.startsWith(opening)) return
  const callout = (formatted ? remainder.slice(2) : remainder).replace(/^[\s,:，：、]+/u, '')
  const firstSentence = callout.split(/[。！!；;]|\.(?:\s|$)/u, 1)[0]!

  // Match the request at the start of the address. Words about work completed later in
  // the paragraph should not turn a deliverable (or a thank-you) into another turn.
  if (thanksOrCourtesy.test(firstSentence) || completedWork.test(firstSentence)) return
  if (handoffRequest.test(firstSentence) || relayedHandoffRequest.test(firstSentence) ||
    /[?？](?:\s|$)/u.test(firstSentence)) {
    return address.member
  }
}

type RoomReply =
  | { kind: 'tool'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'post'; text: string; botIds: string[] }

export function classifyRoomReply(reply: string, speakerId: string, roster: RoomMember[], room: CollabRoom, hasMedia = false): RoomReply {
  if (isToolRequest(reply)) return { kind: 'tool', text: reply }
  const isCoordinator = speakerId === room.coordinatorId
  const canDelegate = isCoordinator || (!room.coordinatorId && room.mode === 'auto')
  const handoff = explicitHandoff(reply)
  let text = handoff?.text ?? reply

  if ((!room.coordinatorId || isCoordinator) && isFinal(reply)) {
    const body = stripFinalPrefix(reply)
    if (!body.trim() && !hasMedia) return { kind: 'post', text: body, botIds: [] }
    const target = canDelegate ? directHandoff(body, roster) : undefined
    if (!target || target.botId === speakerId || !room.members.some((m) => m.botId === target.botId)) {
      return { kind: 'final', text: reply }
    }
    text = body
  }

  if (room.coordinatorId && !isCoordinator) return { kind: 'post', text, botIds: [room.coordinatorId] }
  if (!canDelegate) return { kind: 'post', text, botIds: [] }
  const botIds = handoff
    ? handoff.botIds.filter((id) => roster.some((m) => m.botId === id))
    : mentions(text, roster).map((m) => m.botId)
  return { kind: 'post', text, botIds }
}

function messageWithReferences(message: RoomMessage, text = message.text): string {
  return [text, ...(message.references ?? []).map((ref) =>
    `[Reference: ${ref.label}]\n${ref.text}`
  )].join('\n\n')
}

export function isHumanRoomMessage(message: RoomMessage): boolean {
  return !message.authorBotId && (message.author === 'User' || message.author.startsWith('Slack '))
}

export function roomRecipient(room: CollabRoom, externalAudience?: string): string {
  return [room.title, room.members.map((m) => m.name).join(', '), externalAudience].filter(Boolean).join(' · ')
}

/**
 * Members whose platform refuses to run behind another application's tool
 * protocol. Hark's policy rejects a multi-agent room frame outright, so it
 * gets a plain assistant frame and accesses local workspaces via the hardened
 * workspace portal instead of `[TOOL]` instructions.
 */
export function refusesRoomFrame(platform: PlatformId): boolean {
  return platform === 'hark'
}

export function turnPrompt(room: CollabRoom, member: RoomMember, trigger?: RoomMessage): string {
  const isCoordinator = member.botId === room.coordinatorId
  const plainAssistant = refusesRoomFrame(member.platform) && !isCoordinator
  const formatPost = (message: RoomMessage) => {
    const text = plainAssistant && (message.authorBotId || message.final) && isFinal(message.text)
      ? stripFinalPrefix(message.text) : message.text
    return `[${message.author}] ${messageWithReferences(message, text)}`
  }
  const start = Math.max(member.cursor, room.messages.length - 20)
  const briefIndex = room.messages.findLastIndex(isHumanRoomMessage)
  const missedBrief = briefIndex >= member.cursor && briefIndex < start ? room.messages[briefIndex] : undefined
  const brief = missedBrief ? messageWithReferences(missedBrief) : room.brief
  const recent = room.messages.slice(start)
  const context = recent
    .filter((m) => !m.authorBotId || !isToolRequest(m.text))
    .map(formatPost)
    .join('\n')
  const missedTrigger = trigger && trigger.id !== missedBrief?.id && !recent.some((m) => m.id === trigger.id) ? trigger : undefined
  if (plainAssistant) {
    return [
      'Please help with the user’s request using the discussion and references below.',
      `User request:\n${brief}`,
      missedTrigger && `Earlier message relevant to this request:\n${formatPost(missedTrigger)}`,
      context && `Recent discussion:\n${context}`
    ].filter(Boolean).join('\n\n')
  }

  const canDelegate = isCoordinator || (!room.coordinatorId && room.mode === 'auto')
  return [
    `Collaboration room: ${room.title}. You are @${member.name}.`,
    `Members: ${room.members.map((m) => '@' + m.name).join(', ')}.`,
    room.coordinatorId
      ? isCoordinator
        ? 'Coordinate the human brief and assign work as needed. Teammates’ replies come back to you.'
        : 'Answer the administrator’s request. Your reply returns to the administrator for review.'
      : canDelegate ? 'Review, revise and choose a writer as needed.' : 'Reply to the human brief.',
    canDelegate && (
      'To ask a teammate to speak next, use @ExactName in your request or put [HANDOFF] ["<botId>"] on the first line. ' +
      'Do not start with [FINAL] when handing off. [FINAL] immediately ends the round and prevents @mentions from being delivered. ' +
      `Bot IDs: ${room.members.map((m) => `@${m.name} = ${JSON.stringify(m.botId)}`).join(', ')}.`
    ),
    (!room.coordinatorId || isCoordinator) &&
      'Use [FINAL] on its own first line only when no teammate needs to speak anymore and you are giving the final answer to the user.',
    `Human brief: ${brief}`,
    missedTrigger && `Message that assigned this turn: ${formatPost(missedTrigger)}`,
    context
  ].filter(Boolean).join('\n\n')
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
