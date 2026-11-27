import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types'
import type { CollabRoom } from '@/rooms/model'
import { buildConversationJson, buildConversationMarkdown, buildRoomJson, sanitizeExportFilename } from './conversationExport'

const date = new Date('2026-11-27T08:35:00Z')
const bot = { id: 'b', name: 'Assistant', platformId: 'hermes' } as const
const base = { botId: 'b', accountId: 'account', createdAt: date.getTime() }
const messages: ChatMessage[] = [
  { ...base, id: '1', role: 'user', text: 'Explain **this**.', replyQuote: 'First line\nsecond line',
    attachments: [{ id: 'f', name: 'notes.pdf', size: 50, mimeType: 'application/pdf', dataBase64: 'VERY_LARGE_PAYLOAD' }] },
  { ...base, id: '2', role: 'bot', text: '', media: [{ kind: 'file', path: '/work/report.txt' }],
    tools: [{ id: 't', name: 'read_notes', status: 'completed', summary: 'Read 3 pages' }] }
]

describe('conversation exports', () => {
  it('formats the title, dates, speaker turns, multiline quotes, tool summaries and file references', () => {
    const md = buildConversationMarkdown(bot, 'Hermes', messages, 'en', date)
    const formatted = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    expect(md).toContain('# Assistant (Hermes)')
    expect(md).toContain(`Exported on ${formatted}`)
    expect(md).toContain(`### Me · ${formatted}`)
    expect(md).toContain(`### Assistant · ${formatted}`)
    expect(md).toContain('> Quote: First line\n> second line\n\nExplain **this**.')
    expect(md).toContain('- read_notes (completed) — Read 3 pages')
    expect(md).toContain('- notes.pdf')
    expect(md).toContain('- report.txt')
    expect(md).not.toContain('VERY_LARGE_PAYLOAD')
    expect(buildConversationMarkdown(bot, 'Hermes', messages.slice(1), 'en', date)).not.toContain('notes.pdf')
  })

  it('exports only supplied messages and public bot metadata without mutating attachments', () => {
    const output = buildConversationJson({ ...bot }, 'Hermes', messages.slice(0, 1), date)
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1, exportedAt: date.toISOString(), bot: { id: 'b', name: 'Assistant' },
      platform: { id: 'hermes', name: 'Hermes' }, messages: [{
        ...messages[0], attachments: [{ id: 'f', name: 'notes.pdf', size: 50, mimeType: 'application/pdf' }]
      }]
    })
    expect(messages[0]?.attachments?.[0]?.dataBase64).toBe('VERY_LARGE_PAYLOAD')
  })

  it('removes nested binary fields and inline data URLs while keeping ordinary widget text', () => {
    const msg = { ...messages[1]!, extra: { data_base64: 'huge', raw: new Uint8Array(250), blob: new Blob(['huge']), buf: Buffer.from('bytes') },
      richWidgets: [{ kind: 'html' as const, widgetId: 'html', html: '<p>Result</p><img src="data:image/png;base64,aW1hZ2U=">' }],
      media: [{ kind: 'image' as const, path: 'data:image/png;base64,aW1hZ2U=' }] }
    const exported = JSON.parse(buildConversationJson(bot, 'Hermes', [msg], date)).messages[0]
    expect(exported.extra).toEqual({})
    expect(exported.richWidgets[0].html).toBe('<p>Result</p><img src="[inline file]">')
    expect(exported.media[0].path).toBe('[inline file]')
    expect(buildConversationMarkdown(bot, 'Hermes', [msg], 'en', date)).not.toContain('aW1hZ2U=')
  })

  it('exports room members, final and legacy messages, and references without session identifiers', () => {
    const room: CollabRoom = {
      id: 'r', title: 'Team', mode: 'auto', limit: 3, brief: 'Review', finalId: 'final',
      members: [{ botId: 'b', name: 'Assistant', platform: 'hermes', accountId: 'account', cursor: 22, sessionId: 'private-session' }],
      messages: [{ id: 'final', author: 'Assistant', authorBotId: 'b', text: 'Done', final: true, references: [{ label: 'draft', text: 'text' }] }]
    }
    const output = buildRoomJson(room, date)
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, exportedAt: date.toISOString(), room: {
      id: 'r', title: 'Team', finalId: 'final', members: [{ botId: 'b', name: 'Assistant', platform: 'hermes' }]
    }, messages: room.messages })
    expect(output).not.toContain('private-session')
  })
})

describe('sanitizeExportFilename', () => {
  it('preserves readable Unicode names, strips path and control characters and normalizes extensions', () => {
    expect(sanitizeExportFilename('../报告 / Q4:\n?*', '.MD')).toBe('报告-Q4.md')
    expect(sanitizeExportFilename('\u0000<>', 'json')).toBe('conversation.json')
    expect(sanitizeExportFilename('con', '.json')).toBe('_con.json')
    expect(sanitizeExportFilename('a', '../json')).toBe('a.json')
    expect(Buffer.byteLength(sanitizeExportFilename('报'.repeat(300), 'json'))).toBeLessThan(256)
  })
})
