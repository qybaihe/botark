import { buildRoomJson, downloadTextFile, sanitizeExportFilename } from '@/lib/conversationExport'
import { roomMarkdown, type CollabRoom } from './model'

export const NEW_ROOM_ID = 'room-create'

export function exportRoomMarkdownFile(room: CollabRoom, finalId?: string) {
  downloadTextFile(sanitizeExportFilename(room.title, 'md'), roomMarkdown(room, finalId), 'text/markdown;charset=utf-8')
}

export function exportRoomJsonFile(room: CollabRoom) {
  downloadTextFile(sanitizeExportFilename(room.title, 'json'), buildRoomJson(room), 'application/json')
}
