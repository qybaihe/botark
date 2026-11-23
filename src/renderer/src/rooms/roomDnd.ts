import { create } from 'zustand'
import { useBotStore } from '@/store/botStore'
import { addMemberToRoom, moveMemberToRoom, removeMember, useRooms } from './roomStore'

/** Drag payload: a sidebar bot (value = botId). */
export const BOT_DRAG_MIME = 'application/x-botark-bot'
/** Drag payload: a member of a group chat (value = JSON `{ roomId, botId }`). */
export const ROOM_MEMBER_DRAG_MIME = 'application/x-botark-room-member'

export interface RoomDropResult {
  ok: boolean
  message: string
}

type DragTypes = ArrayLike<string> | undefined | null

function hasType(types: DragTypes, mime: string): boolean {
  if (!types) return false
  for (let i = 0; i < types.length; i++) {
    if (types[i] === mime) return true
  }
  return false
}

/** True while dragging something that can be dropped onto a group chat. */
export function isRoomDropDrag(types: DragTypes): boolean {
  return hasType(types, BOT_DRAG_MIME) || hasType(types, ROOM_MEMBER_DRAG_MIME)
}

/** True while dragging a group-chat member (can be dropped out of the room). */
export function isRoomMemberDrag(types: DragTypes): boolean {
  return hasType(types, ROOM_MEMBER_DRAG_MIME)
}

export function encodeRoomMemberDrag(roomId: string, botId: string): string {
  return JSON.stringify({ roomId, botId })
}

export function decodeRoomMemberDrag(raw: string): { roomId: string; botId: string } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { roomId?: unknown; botId?: unknown }
    if (typeof parsed.roomId === 'string' && typeof parsed.botId === 'string' && parsed.roomId && parsed.botId) {
      return { roomId: parsed.roomId, botId: parsed.botId }
    }
  } catch {
    /* malformed payload */
  }
  return null
}

function botName(botId: string): string {
  return useBotStore.getState().bots.find((b) => b.id === botId)?.name?.trim() || 'Bot'
}

function roomTitle(roomId: string): string {
  return useRooms.getState().rooms.find((r) => r.id === roomId)?.title || '群聊'
}

type DragData = Pick<DataTransfer, 'getData'>

/** Drop onto a group chat: add a sidebar bot, or transfer a member from another chat. */
export function applyDropOnRoom(roomId: string, data: DragData): RoomDropResult | null {
  const member = decodeRoomMemberDrag(data.getData(ROOM_MEMBER_DRAG_MIME))
  if (member) {
    if (member.roomId === roomId) return null
    const res = moveMemberToRoom(member.roomId, member.botId, roomId)
    return res.ok
      ? { ok: true, message: `已将 ${botName(member.botId)} 转入「${roomTitle(roomId)}」` }
      : { ok: false, message: res.error ?? '转移成员失败' }
  }
  const botId = data.getData(BOT_DRAG_MIME)
  if (botId) {
    const res = addMemberToRoom(roomId, botId)
    return res.ok
      ? { ok: true, message: `已将 ${botName(botId)} 加入「${roomTitle(roomId)}」` }
      : { ok: false, message: res.error ?? '加入群聊失败' }
  }
  return null
}

interface RoomDndNoticeState {
  notice: (RoomDropResult & { id: number }) | null
}

/** Transient feedback for drag-and-drop membership changes. */
export const useRoomDndNotice = create<RoomDndNoticeState>(() => ({ notice: null }))

let noticeSeq = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined

export function showRoomDndNotice(result: RoomDropResult | null): void {
  if (!result) return
  const id = ++noticeSeq
  useRoomDndNotice.setState({ notice: { ...result, id } })
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    if (useRoomDndNotice.getState().notice?.id === id) useRoomDndNotice.setState({ notice: null })
  }, 2600)
}

/** Drop a group-chat member outside of any chat (e.g. back onto the bot list): remove it. */
export function applyDropOutOfRoom(data: DragData): RoomDropResult | null {
  const member = decodeRoomMemberDrag(data.getData(ROOM_MEMBER_DRAG_MIME))
  if (!member) return null
  const title = roomTitle(member.roomId)
  const res = removeMember(member.roomId, member.botId)
  return res.ok
    ? { ok: true, message: `已将 ${botName(member.botId)} 移出「${title}」` }
    : { ok: false, message: res.error ?? '移出成员失败' }
}
