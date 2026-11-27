import { translate } from '@/lib/i18n'
import type { CollabRoom } from '@/rooms/model'
import type { Locale } from '@/store/prefsStore'
import type { Bot, ChatMessage } from '@/types'

// Rich widgets and media paths can also contain inline images (including in HTML or Markdown).
function withoutInlineData(text: string): string {
  return text.replace(/data:[\w.+/-]*(?:;[\w.+-]+=[\w.+-]+)*;base64,[a-z\d+/=_-]+/gi, '[inline file]')
}

export function buildConversationMarkdown(
  bot: Pick<Bot, 'name'>, platformName: string, messages: readonly ChatMessage[], locale: Locale = 'zh',
  exportedAt = new Date()
): string {
  const date = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' })
  const title = translate(locale, '{name} ({platform})', { name: bot.name, platform: platformName })
  const header = `# ${title}\n\n${translate(locale, 'Exported on {date}', { date: date.format(exportedAt) })}`
  const turns = messages.map((message) => {
    const speaker = message.role === 'user' ? translate(locale, 'Me') : bot.name
    const lines = [`### ${speaker} · ${date.format(message.createdAt)}`]
    if (message.replyQuote) {
      lines.push(translate(locale, 'Quote: {text}', { text: message.replyQuote }).split(/\r?\n/).map((line) => `> ${line}`).join('\n'))
    }
    if (message.text) lines.push(message.text)
    if (message.tools?.length) {
      lines.push(`**${translate(locale, 'Tools')}**\n` + message.tools.map((tool) =>
        `- ${tool.name} (${tool.status})${tool.summary ? ` — ${tool.summary}` : ''}`).join('\n'))
    }
    const files = [
      ...(message.attachments ?? []).map((file) => file.name),
      ...(message.media ?? []).map((file) => file.name || (file.path.startsWith('data:') ? file.kind : file.path.split(/[\\/]/).pop()) || file.kind)
    ]
    if (files.length) lines.push(`**${translate(locale, 'Attachments')}**\n` + files.map((name) => `- ${name}`).join('\n'))
    return lines.join('\n\n')
  })
  return withoutInlineData([header, ...turns].join('\n\n---\n\n') + '\n')
}

function exportJson(metadata: object, messages: readonly unknown[], exportedAt: Date): string {
  return JSON.stringify({ schemaVersion: 1, exportedAt: exportedAt.toISOString(), ...metadata, messages }, (key, value: unknown) => {
    if (/^(?:data_?base64|base64)$/i.test(key) || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined
    // Buffers invoke toJSON before the replacer sees them.
    if (value && typeof value === 'object' && 'type' in value && value.type === 'Buffer' && 'data' in value && Array.isArray(value.data)) return undefined
    return typeof value === 'string' ? withoutInlineData(value) : value
  }, 2)
}

export function buildConversationJson(
  bot: Pick<Bot, 'id' | 'name' | 'platformId'>, platformName: string, messages: readonly ChatMessage[], exportedAt = new Date()
): string {
  return exportJson({
    bot: { id: bot.id, name: bot.name }, platform: { id: bot.platformId, name: platformName }
  }, messages, exportedAt)
}

export function buildRoomJson(room: CollabRoom, exportedAt = new Date()): string {
  const { id, title, mode, brief, createdAt, finalId, members } = room
  return exportJson({
    room: { id, title, mode, brief, createdAt, finalId, members: members.map(({ botId, name, platform }) => ({ botId, name, platform })) }
  }, room.messages.map(({ mediaSource: _source, ...message }) => message), exportedAt)
}

export function sanitizeExportFilename(name: string, ext: string): string {
  const suffix = ext.replace(/[^a-z0-9]/gi, '').toLowerCase()
  let stem = name.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'conversation'
  // Leave room for the extension on filesystems with a 255-byte component limit.
  stem = [...stem].slice(0, 60).join('').replace(/-+$/, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem
  return suffix ? `${stem}.${suffix.slice(0, 12)}` : stem
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  try {
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }
}
