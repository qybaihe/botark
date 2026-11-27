export const ROOM_FOCUS_EVENT = 'botark:focus-room-message'
let pending: { roomId: string; messageId: string } | undefined

export function focusRoomMessage(roomId: string, messageId: string): void {
  pending = { roomId, messageId }
  window.dispatchEvent(new Event(ROOM_FOCUS_EVENT))
}

// A palette selection can arrive before the lazy-loaded RoomView mounts.
export function takeRoomMessageFocus(roomId: string): string | undefined {
  if (pending?.roomId !== roomId) return
  const { messageId } = pending
  pending = undefined
  return messageId
}
