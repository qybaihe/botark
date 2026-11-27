import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getPlatform } from '@adapters/platforms'
import { Check, Copy, Globe } from 'lucide-react'
import { getPlatformInspector } from '@/components/info/platformInspector'
import { ArkExportDocSvg } from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { MarkdownText } from '@/components/chat/MarkdownText'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { buildConversationMarkdown, buildConversationJson, sanitizeExportFilename, downloadTextFile } from '@/lib/conversationExport'
import { translate, useT } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'
import { usePrefsStore, type Locale } from '@/store/prefsStore'
import type { Bot, ChatMessage } from '@/types'

export interface OpenShareEventDetail {
  botId: string
  messageId?: string
  conversationKey?: string
}

export function triggerShareConversation(detail: OpenShareEventDetail): void {
  const bot = useBotStore.getState().bots.find((item) => item.id === detail.botId)
  window.dispatchEvent(new CustomEvent<OpenShareEventDetail>('bothub:open-share', {
    detail: { ...detail, conversationKey: bot ? shareConversationKey(bot) : undefined }
  }))
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatMessageHtml(text: string): string {
  const escaped = escapeHtml(text)
  // Render fenced code blocks & inline formatting cleanly in standalone HTML
  return escaped
    .replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const tag = lang ? `<div class="code-lang">${lang}</div>` : ''
      return `<div class="code-wrap">${tag}<pre><code>${code}</code></pre></div>`
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\n/g, '<br />')
}

export function buildStandaloneShareHtml(
  bot: Bot,
  platformName: string,
  items: ChatMessage[],
  locale: Locale = 'zh'
): string {
  const language = locale === 'zh' ? 'zh-CN' : 'en'
  const dateLabel = new Date().toLocaleString(language)
  const turnsHtml = items
    .map((m) => {
      const isUser = m.role === 'user'
      const time = new Date(m.createdAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
      const quote = m.replyQuote
        ? `<div class="quote">↳ ${escapeHtml(m.replyQuote)}</div>`
        : ''
      return `<article class="turn ${isUser ? 'turn-user' : 'turn-bot'}">
  <div class="meta">${escapeHtml(isUser ? translate(locale, 'You') : bot.name)} · ${time}</div>
  ${quote}
  <div class="bubble">${formatMessageHtml(messageSummary(m))}</div>
</article>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(bot.name)} · ${escapeHtml(translate(locale, 'Share conversation'))}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f5f2;
    --card: #ffffff;
    --ink: #171717;
    --muted: #6e6d6a;
    --line: rgba(23,23,23,0.09);
    --bubble-bot: #efeeea;
    --bubble-user: #18181b;
    --bubble-user-ink: #fafafa;
    --code-bg: #e7e5e0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121212;
      --card: #1b1b1c;
      --ink: #f3f3f3;
      --muted: #9a9a9e;
      --line: rgba(255,255,255,0.1);
      --bubble-bot: #242426;
      --bubble-user: #f4f4f5;
      --bubble-user-ink: #141415;
      --code-bg: #161618;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 20px 64px;
    background: var(--bg);
    color: var(--ink);
    font: 14.5px/1.65 -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", system-ui, sans-serif;
  }
  .sheet {
    max-width: 780px;
    margin: 0 auto;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 24px;
    overflow: hidden;
    box-shadow: 0 18px 48px -16px rgba(0,0,0,0.12);
  }
  header {
    padding: 22px 28px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .badge {
    font-size: 11.5px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  main { padding: 24px 28px; display: flex; flex-direction: column; gap: 18px; }
  .turn { display: flex; flex-direction: column; gap: 5px; align-items: flex-start; }
  .turn-user { align-items: flex-end; }
  .meta { font-size: 11.5px; color: var(--muted); padding: 0 4px; }
  .quote {
    font-size: 12px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 4px 10px;
    max-width: 76%;
  }
  .bubble {
    max-width: 82%;
    padding: 11px 16px;
    border-radius: 18px;
    background: var(--bubble-bot);
    word-break: break-word;
  }
  .turn-user .bubble {
    background: var(--bubble-user);
    color: var(--bubble-user-ink);
  }
  .code-wrap {
    margin: 10px 0;
    border-radius: 12px;
    overflow: hidden;
    background: var(--code-bg);
    border: 1px solid var(--line);
  }
  .code-lang {
    font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 5px 12px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
  }
  pre {
    margin: 0;
    padding: 12px;
    overflow-x: auto;
    font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .inline-code {
    font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--code-bg);
  }
  footer {
    padding: 14px 28px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
  }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div>
        <div class="title">${escapeHtml(bot.name)}</div>
        <div class="sub">${escapeHtml(platformName)} · ${escapeHtml(translate(locale, 'Messages: {count}', { count: items.length }))}</div>
      </div>
      <span class="badge">${escapeHtml(translate(locale, 'Shared via BotArk'))}</span>
    </header>
    <main>
${turnsHtml}
    </main>
    <footer>
      <span>${escapeHtml(translate(locale, 'Exported on {date}', { date: dateLabel }))}</span>
      <span>BotArk Desktop</span>
    </footer>
  </div>
</body>
</html>`
}

export { buildConversationMarkdown as buildShareMarkdown } from '@/lib/conversationExport'

type ShareScope = 'all' | 'focus' | 'single' | 'range'
type ShareSelection = {
  conversationKey: string
  messageId?: string
  firstId?: string
  lastId?: string
  scope: ShareScope
  id: symbol
}

function messageSummary(message: ChatMessage): string {
  return message.text || [
    ...(message.attachments ?? []).map((file) => file.name),
    ...(message.media ?? []).map((file) => file.name || file.kind),
    ...(message.tools ?? []).map((tool) => tool.name),
    ...(message.widgets ?? []).map((widget) => widget.kind),
    ...(message.richWidgets ?? []).map((widget) => widget.kind)
  ].join(' · ')
}

function shareConversationKey(bot: Bot): string {
  return JSON.stringify([bot.id, bot.activeSessionId ?? bot.hermesSessionKey, bot.activeAccountId, bot.selectedAgentId])
}

export function ShareConversationDialog({
  bot,
  messages
}: {
  bot: Bot
  messages: ChatMessage[]
}) {
  const t = useT()
  const openWebSessionAt = useBotStore((s) => s.openWebSessionAt)
  const [selection, setSelection] = useState<ShareSelection>()
  const [copiedId, setCopiedId] = useState<symbol>()
  const currentShare = useRef<symbol>(undefined)
  const copyTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  const conversationKey = shareConversationKey(bot)
  const activeSelection = selection?.conversationKey === conversationKey ? selection : undefined
  const focusMessageId = activeSelection?.messageId
  const scope = activeSelection?.scope ?? 'all'
  const open = activeSelection !== undefined
  const copiedMd = open && copiedId === activeSelection.id

  useLayoutEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenShareEventDetail>).detail
      if (!detail || detail.botId !== bot.id) return
      if (detail.conversationKey !== undefined && detail.conversationKey !== conversationKey) return
      const id = Symbol()
      currentShare.current = id
      setSelection({ conversationKey, messageId: detail.messageId, scope: detail.messageId ? 'focus' : 'all', id })
    }
    window.addEventListener('bothub:open-share', onOpen)
    return () => {
      currentShare.current = undefined
      window.removeEventListener('bothub:open-share', onOpen)
    }
  }, [bot.id, conversationKey])

  useEffect(() => {
    setSelection((previous) => previous?.conversationKey === conversationKey ? previous : undefined)
  }, [conversationKey])

  useEffect(() => () => clearTimeout(copyTimeout.current), [activeSelection?.id])

  const close = () => {
    currentShare.current = undefined
    setSelection(undefined)
  }

  const platform = getPlatform(bot.platformId)
  const supportsWebShare = getPlatformInspector(bot.platformId).supportsWebSession
  const locale = usePrefsStore((s) => s.locale)
  const isCurrentShare = () => {
    if (!activeSelection || currentShare.current !== activeSelection.id) return false
    const state = useBotStore.getState()
    const currentBot = state.bots.find((item) => item.id === state.selectedBotId)
    return currentBot !== undefined && shareConversationKey(currentBot) === conversationKey
  }

  const available = useMemo(() => open ? messages.filter((m) =>
    m.text.trim() || m.replyQuote || m.tools?.length || m.attachments?.length || m.media?.length || m.widgets?.length || m.richWidgets?.length
  ) : [], [open, messages])
  const firstId = activeSelection?.firstId ?? focusMessageId ?? available[0]?.id
  const lastId = activeSelection?.lastId ?? available.at(-1)?.id
  const firstIndex = available.findIndex((message) => message.id === firstId)
  const selectedMessages = useMemo(() => {
    if (scope === 'all') return available
    const index = available.findIndex((m) => m.id === (scope === 'focus' ? focusMessageId : firstId))
    if (index < 0) return []
    if (scope === 'range') {
      const end = available.findIndex((m) => m.id === lastId)
      return end < index ? [] : available.slice(index, end + 1)
    }
    const includePrompt = scope === 'focus' && available[index]?.role === 'bot' && available[index - 1]?.role === 'user'
    return available.slice(includePrompt ? index - 1 : index, index + 1)
  }, [available, firstId, lastId, focusMessageId, scope])
  const canExport = open && selectedMessages.length > 0

  const handleDownload = (format: 'html' | 'md' | 'json') => {
    if (!canExport || !isCurrentShare()) return
    if (format === 'html') {
      downloadTextFile(sanitizeExportFilename(bot.name + '-share', format),
        buildStandaloneShareHtml(bot, platform.name, selectedMessages, locale), 'text/html;charset=utf-8')
    } else if (format === 'md') {
      downloadTextFile(sanitizeExportFilename(bot.name, format),
        buildConversationMarkdown(bot, platform.name, selectedMessages, locale), 'text/markdown;charset=utf-8')
    } else {
      downloadTextFile(sanitizeExportFilename(bot.name, format),
        buildConversationJson(bot, platform.name, selectedMessages), 'application/json')
    }
  }

  const updateSelection = (patch: Partial<Pick<ShareSelection, 'firstId' | 'lastId' | 'scope'>>) => {
    setCopiedId(undefined)
    setSelection((previous) => previous && previous.id === activeSelection?.id ? { ...previous, ...patch } : previous)
  }

  const handleCopyMarkdown = () => {
    if (!canExport || !isCurrentShare()) return
    const { id } = activeSelection
    const md = buildConversationMarkdown(bot, platform.name, selectedMessages, locale)
    void navigator.clipboard.writeText(md).then(() => {
      if (currentShare.current !== id) return
      setCopiedId(id)
      clearTimeout(copyTimeout.current)
      copyTimeout.current = setTimeout(() => setCopiedId(undefined), 1600)
    }, () => {})
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) close() }}
      title={t('Share conversation')}
      className="w-[min(92vw,580px)]"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <BotAvatar
              emoji={bot.emoji}
              seed={bot.id}
              avatar={bot.avatar}
              avatarShape={bot.avatarShape}
              avatarColor={bot.avatarColor}
              platformId={bot.platformId}
              size="sm"
            />
            <div>
              <p className="text-[13.5px] font-semibold text-ink">{bot.name}</p>
              <p className="text-[11.5px] text-ink-muted">
                {platform.name} · {t('Selected messages: {count}', { count: selectedMessages.length })}
              </p>
            </div>
          </div>

          {available.length > 0 && (
            <SegmentedControl<ShareScope>
              size="xs"
              value={scope}
              aria-label={t('Export scope')}
              onValueChange={(scope) => updateSelection({ scope })}
              options={[
                ...(focusMessageId ? [{ value: 'focus' as const, label: t('Current exchange') }] : []),
                { value: 'all', label: t('Entire conversation ({count})', { count: available.length }) },
                { value: 'range', label: t('Message range') },
                { value: 'single', label: t('Single message') }
              ]}
            />
          )}
        </div>

        {(scope === 'range' || scope === 'single') && (
          <div className="flex gap-2">
            {(scope === 'range' ? ['first', 'last'] as const : ['first'] as const).map((bound) => (
              <label key={bound} className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-secondary">
                {t(scope === 'single' ? 'Message' : bound === 'first' ? 'From message' : 'Through message')}
                <select className="min-w-0 rounded-md border border-line bg-main px-2 py-1.5 text-ink"
                  value={(bound === 'first' ? firstId : lastId) ?? ''}
                  onChange={(event) => {
                    const id = event.target.value
                    if (bound === 'last') updateSelection({ lastId: id })
                    else {
                      const pastEnd = available.findIndex((m) => m.id === id) > available.findIndex((m) => m.id === lastId)
                      updateSelection(pastEnd ? { firstId: id, lastId: id } : { firstId: id })
                    }
                  }}>
                  {available.map((m, index) => (
                    <option key={m.id} value={m.id} disabled={bound === 'last' && index < firstIndex}>
                      {index + 1}. {m.role === 'user' ? t('Me') : bot.name} · {messageSummary(m).slice(0, 55)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        {/* Live Share Page Preview */}
        <div className="max-h-[340px] overflow-y-auto rounded-2xl border border-line/80 bg-sunken/35 p-4">
          {selectedMessages.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-muted">
              {t(scope === 'focus' ? 'This message has no shareable text or is unavailable' : 'This conversation has no shareable messages')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {selectedMessages.slice(0, 12).map((m) => {
                const mine = m.role === 'user'
                return (
                  <div key={m.id} className={mine ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
                    {m.replyQuote && (
                      <div className="mb-1 max-w-[80%] truncate rounded-lg border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-muted">
                        ↳ {m.replyQuote}
                      </div>
                    )}
                    <div
                      className={
                        mine
                          ? 'max-w-[82%] rounded-2xl bg-bubble-user px-3.5 py-2 text-[13px] leading-5 text-main'
                          : 'max-w-[86%] rounded-2xl bg-surface px-3.5 py-2.5 text-[13px] leading-5 text-ink ring-1 ring-line/60'
                      }
                    >
                      {mine ? messageSummary(m) : <MarkdownText text={messageSummary(m)} />}
                    </div>
                  </div>
                )
              })}
              {selectedMessages.length > 12 && (
                <p className="text-center text-[11.5px] text-ink-muted">
                  {t('The export will include the remaining {count} messages', { count: selectedMessages.length - 12 })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {supportsWebShare ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!open || (scope === 'focus' && !canExport)}
              onClick={() => {
                if (!isCurrentShare()) return
                close()
                openWebSessionAt(null)
              }}
            >
              <Globe className="size-3.5" />
              {t('Create a share link on the platform')}
            </Button>
          ) : (
            <span />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!canExport}
              onClick={handleCopyMarkdown}
            >
              {copiedMd ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
              {t(copiedMd ? 'Copied Markdown' : 'Copy Markdown')}
            </Button>
            <Button size="sm" variant="secondary" disabled={!canExport} onClick={() => handleDownload('md')}>
              {t('Download Markdown (.md)')}
            </Button>
            <Button size="sm" variant="secondary" disabled={!canExport} onClick={() => handleDownload('json')}>
              {t('Download JSON (.json)')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canExport}
              onClick={() => handleDownload('html')}
            >
              <ArkExportDocSvg className="size-3.5" />
              {t('Download share page (.html)')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
