import { memo, useCallback, useMemo, useState } from 'react'
import { AlertCircle, Check, Clock3, Copy, CornerDownRight, ExternalLink, FileText, Globe, KeyRound, Loader2, Maximize2, RotateCw, Wrench } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import { useBotStore } from '@/store/botStore'
import { SEND_STILL_PENDING_TEXT } from '@/store/delivery'
import type { ChatMessage, ChatOptionWidget, ChatRichWidget, ChatToolCall } from '@/types'
import { getBridge } from '@/lib/bridge'
import { ArkExportDocSvg, ArkHandoffCurveSvg, ArkShieldVaultSvg } from '@/components/ui/ArkGlyphs'
import { ConnectorIcon } from '@/components/ui/ConnectorIcon'
import { SwitchPill } from '@/components/ui/Controls'
import { Select } from '@/components/ui/Select'
import { MarkdownText } from './MarkdownText'
import { getMessageMedia, MediaPreview, UserAttachmentItem, WorkspaceImage } from './MediaPreview'
import type { NativeDocumentTarget } from './NativeDocumentDialog'
import { SessionInteractiveCard } from './SessionInteractiveCard'
import { triggerShareConversation } from './ShareConversationDialog'
import { t } from '@/lib/i18n'

interface MessageBubbleProps {
  message: ChatMessage
  /** First bubble of a run from the same sender (gets the tail corner). */
  isFirstInRun: boolean
  /** Last bubble of a run (shows the meta line). */
  isLastInRun: boolean
  /** Shown in the meta line when a bot has several accounts. */
  accountLabel?: string
  onRetry?: (messageId: string) => void
}

function DeliveryState({ message, onRetry }: Pick<MessageBubbleProps, 'message' | 'onRetry'>) {
  switch (message.delivery) {
    case 'sending':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          <Clock3 className="size-3 shrink-0" aria-hidden /> {t('Sending…')}
        </span>
      )
    case 'accepted':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden /> {t('Delivered · replying')}
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right text-status-error-ink">
          <span className="inline-flex min-w-0 max-w-full items-start gap-1">
            <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{message.error ?? t('Not sent')}</span>
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 font-medium underline-offset-2 hover:underline"
            >
              <RotateCw className="size-3 shrink-0" aria-hidden /> {t('Retry')}
            </button>
          )}
        </span>
      )
    case 'no-reply':
      // Delivered: resending would post the message a second time, so say so.
      return (
        <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right text-status-attention-ink">
          <span className="inline-flex min-w-0 max-w-full items-start gap-1">
            <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{message.error ?? t('Delivered, but no reply')}</span>
          </span>
          {onRetry && message.error !== SEND_STILL_PENDING_TEXT && (
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              title={t('Sends the same message again')}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 font-medium underline-offset-2 hover:underline"
            >
              <RotateCw className="size-3 shrink-0" aria-hidden /> {t('Send again')}
            </button>
          )}
        </span>
      )
    case 'sent':
      return <Check className="size-3 shrink-0" aria-label={t('Sent')} />
    default:
      return null
  }
}

function ToolChips({ tools }: { tools: ChatToolCall[] }) {
  if (!tools.length) return null
  return (
    <ul className="mb-1.5 flex max-w-[78%] flex-col gap-1" aria-label={t('Tools')}>
      {tools.map((tool) => (
        <li
          key={tool.id}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-secondary shadow-soft"
        >
          {tool.status === 'running' ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-600" aria-hidden />
          ) : (
            <Wrench className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{tool.name}</span>
          {tool.toolType && tool.toolType !== tool.name && (
            <span className="shrink-0 text-ink-muted">{tool.toolType}</span>
          )}
          <span className="shrink-0 tabular-nums text-ink-muted">
            {tool.status === 'running'
              ? t('Running')
              : tool.status === 'errored'
                ? t('Failed')
                : t('Done')}
          </span>
        </li>
      ))}
      {tools.some((t) => t.summary) && (
        <li className="px-1 text-[11px] text-ink-muted">
          {tools
            .filter((t) => t.summary)
            .map((tool) => tool.summary)
            .join(' · ')}
        </li>
      )}
    </ul>
  )
}

function RichWidgets({
  widgets,
  botId,
  accountId,
  messageId,
  onOpenDoc
}: {
  widgets: ChatRichWidget[]
  botId: string
  accountId: string
  messageId: string
  onOpenDoc: (target: NativeDocumentTarget) => void
}) {
  const sendMessage = useBotStore((s) => s.sendMessage)
  if (!widgets.length) return null
  return (
    <ul className="mb-1.5 flex max-w-[85%] flex-col gap-2" aria-label={t('Widgets')}>
      {widgets.map((w) => {
        if (w.kind === 'shopping_results' || w.kind === 'shopping_results_v2') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{t('Shopping results')}</p>
              <ul className="flex flex-col gap-1.5">
                {w.products.slice(0, 8).map((p, i) => (
                  <li key={`${p.name}-${i}`} className="flex gap-2 text-[12px]">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" className="size-10 rounded-md object-cover" />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{p.name}</span>
                      <span className="block text-ink-muted">
                        {[p.price, p.retailer].filter(Boolean).join(' · ')}
                      </span>
                      {p.url ? (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-600 underline-offset-2 hover:underline"
                        >
                          {t('Open link')}
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-ink-muted">{t('Read-only — checkout not available in BotArk')}</p>
            </li>
          )
        }
        if (w.kind === 'shopping_cart') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1 text-[12px] font-medium text-ink-secondary">
                {t('Shopping cart')}
                {w.retailerName ? ` · ${w.retailerName}` : ''}
              </p>
              <ul className="flex flex-col gap-1 text-[12px]">
                {w.items.slice(0, 12).map((it) => (
                  <li key={it.id} className="flex justify-between gap-2">
                    <span className="truncate text-ink">
                      {it.name} × {it.quantity}
                    </span>
                    {it.linePrice ? <span className="shrink-0 text-ink-muted">{it.linePrice}</span> : null}
                  </li>
                ))}
              </ul>
              {w.subtotal ? (
                <p className="mt-1 text-[12px] font-medium text-ink">
                  {t('Subtotal')}: {w.subtotal}
                </p>
              ) : null}
              <p className="mt-1 text-[11px] text-ink-muted">{t('Read-only — checkout not available in BotArk')}</p>
            </li>
          )
        }
        if (w.kind === 'local_map') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1 text-[12px] font-medium text-ink-secondary">{t('Map')}</p>
              {w.places.length ? (
                <ul className="mb-1.5 flex flex-col gap-1 text-[12px]">
                  {w.places.slice(0, 12).map((pl) => (
                    <li key={pl.id}>
                      <span className="font-medium text-ink">{pl.name}</span>
                      <span className="text-ink-muted">
                        {' '}
                        ({pl.latitude.toFixed(4)}, {pl.longitude.toFixed(4)})
                        {pl.category ? ` · ${pl.category}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {w.html ? (
                <iframe
                  title={t('Map')}
                  sandbox=""
                  srcDoc={w.html}
                  className="h-40 w-full rounded-lg border border-line bg-white"
                />
              ) : null}
            </li>
          )
        }
        if (w.kind === 'marketplace_map') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{t('Marketplace map')}</p>
              <ul className="flex flex-col gap-1.5 text-[12px]">
                {w.listings.slice(0, 12).map((l) => (
                  <li key={l.id} className="flex gap-2">
                    {l.imageUrl ? (
                      <img src={l.imageUrl} alt="" className="size-10 rounded-md object-cover" />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{l.name}</span>
                      <span className="block text-ink-muted">
                        {[l.price, l.latitude != null ? `${l.latitude.toFixed(3)}, ${l.longitude?.toFixed(3)}` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {l.url ? (
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-600 underline-offset-2 hover:underline"
                        >
                          {t('Open link')}
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-ink-muted">{t('Read-only — checkout not available in BotArk')}</p>
            </li>
          )
        }
        if (w.kind === 'google_search') {
          return <li key={w.widgetId}>
            <iframe title="Google Search" sandbox="allow-popups" srcDoc={w.html}
              referrerPolicy="no-referrer" className="h-24 w-full rounded-lg border border-line" />
          </li>
        }
        if (w.kind === 'html') {
          return (
            <li key={w.widgetId} className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
              <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 text-[12px]">
                <span className="font-medium text-ink-secondary">
                  {t('HTML widget')}
                  {w.downloadable ? ` · ${t('Downloadable')}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: t('HTML widget'),
                      html: w.html,
                      mimeType: 'text/html'
                    })
                  }
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-hover"
                >
                  <Maximize2 className="size-3" /> 原生打开
                </button>
              </div>
              <iframe
                title={t('HTML widget')}
                sandbox=""
                srcDoc={w.html}
                className="h-48 w-full bg-white"
              />
            </li>
          )
        }
        if (w.kind === 'slides') {
          return (
            <li key={w.widgetId} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 shadow-soft">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">{w.label}</p>
                <p className="truncate text-[12px] text-ink-muted">
                  {t('Slides')} · {w.slug}
                  {w.path ? ` · ${w.path}` : ''}
                </p>
              </div>
              {w.path && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: w.label,
                      path: w.path
                    })
                  }
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hover px-2.5 py-1 text-[11px] font-medium text-accent-600 hover:bg-active"
                >
                  <Maximize2 className="size-3" /> 原生打开
                </button>
              )}
            </li>
          )
        }
        if (w.kind === 'image_options') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">
                {t('Image options')}
                {w.multiSelect ? ` · ${t('Multi-select')}` : ''}
              </p>
              <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {w.images.slice(0, 12).map((img, i) => {
                  const picked =
                    (w.selectedPath && w.selectedPath === img.path) ||
                    (w.selectedIndices && w.selectedIndices.includes(i))
                  return (
                    <li
                      key={`${img.path}-${i}`}
                      className={
                        picked
                          ? 'overflow-hidden rounded-lg border-2 border-accent-600 bg-accent-50'
                          : 'overflow-hidden rounded-lg border border-line bg-surface-muted'
                      }
                      title={img.path}
                    >
                      <WorkspaceImage
                        part={{
                          kind: 'image',
                          path: img.path,
                          name: img.path.split('/').pop() || img.path,
                          imageId: img.imageId
                        }}
                        accountId={accountId}
                      />
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        }
        if (w.kind === 'text_with_button') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-3 shadow-soft">
              {w.text ? (
                <div className="mb-2 text-[13px] leading-5 text-ink">
                  <MarkdownText text={w.text} />
                </div>
              ) : null}
              {w.buttons.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {w.buttons.map((b, i) => {
                    const harkProvider = b.command?.startsWith('hark:connect:')
                      ? b.command.slice('hark:connect:'.length).trim()
                      : undefined
                    if (b.url) {
                      return (
                        <a
                          key={`${b.label}-${i}`}
                          href={b.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-full bg-accent-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-accent-700"
                        >
                          <ConnectorIcon id={harkProvider} name={b.label} className="size-4 border-0 bg-transparent shadow-none" />
                          {b.label}
                        </a>
                      )
                    }
                    return (
                      <button
                        key={`${b.label}-${i}`}
                        type="button"
                        onClick={async () => {
                          if (harkProvider && getBridge()?.hark?.rpc) {
                            try {
                              const res = await getBridge()!.hark!.rpc({
                                accountId,
                                op: 'call',
                                method: 'POST',
                                path: '/connectors/link-sessions',
                                body: {
                                  provider: harkProvider,
                                  returnUrl: 'https://app.hark.com/settings/connected-accounts',
                                  origin: 'chat'
                                }
                              })
                              if (res.ok && res.data && typeof res.data === 'object') {
                                const d = res.data as Record<string, unknown>
                                const startUrl = String(d['startUrl'] ?? d['url'] ?? d['authUrl'] ?? '')
                                if (startUrl.startsWith('http')) {
                                  await getBridge()?.muse?.openHttps?.(startUrl)
                                  return
                                }
                              }
                              console.warn('[hark] link-sessions returned no start URL', res)
                            } catch (err) {
                              console.warn('[hark] link-sessions failed', err)
                            }
                          }
                          // A connect button never posts "Connect <provider>" into the chat; without a
                          // start link, open Hark's connected-accounts page instead.
                          if (harkProvider) {
                            await getBridge()?.muse?.openHttps?.('https://app.hark.com/settings/connected-accounts')
                            return
                          }
                          void sendMessage(botId, b.actionText || b.label)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1 text-[12px] font-medium text-ink hover:bg-hover"
                      >
                        <ConnectorIcon id={harkProvider ?? b.label} name={b.label} className="size-4 border-0 bg-transparent shadow-none" />
                        {b.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </li>
          )
        }
        if (w.kind === 'generic_list') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              {w.title && <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{w.title}</p>}
              <ul className="divide-y divide-line text-[12px]">
                {w.items.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{it.title}</span>
                      {it.subtitle && <span className="block truncate text-ink-muted">{it.subtitle}</span>}
                    </span>
                    {it.url ? (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[11px] text-accent-600 hover:bg-hover"
                      >
                        {t('Open link')}
                      </a>
                    ) : it.sendText ? (
                      <button
                        type="button"
                        onClick={() => void sendMessage(botId, it.sendText!)}
                        className="shrink-0 rounded-full border border-line-strong px-2.5 py-0.5 text-[11px] font-medium text-ink hover:bg-hover"
                      >
                        {t('Send')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          )
        }
        if (w.kind === 'voice_options') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{t('Voice options')}</p>
              <div className="flex flex-wrap gap-1.5">
                {w.voices.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => void sendMessage(botId, v.name)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-[12px] transition-colors',
                      v.selected
                        ? 'border-accent-600 bg-accent-50 font-medium text-accent-600'
                        : 'border-line-strong bg-surface text-ink hover:bg-hover'
                    )}
                    title={v.description}
                  >
                    {v.selected ? `✓ ${v.name}` : v.name}
                  </button>
                ))}
              </div>
            </li>
          )
        }
        if (w.kind === 'markdown') {
          const docTitle = w.title || w.path?.split('/').pop() || 'Markdown 文档'
          const wordCount = (w.markdown || '').trim().length
          return (
            <li
              key={w.widgetId}
              className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft transition-shadow hover:shadow-md"
            >
              <div className="flex items-center justify-between gap-3 border-b border-line bg-sunken/40 px-3.5 py-2.5">
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: docTitle,
                      markdown: w.markdown || undefined,
                      path: w.path,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">{docTitle}</span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      文章 / 文档卡片{wordCount > 0 ? ` · ${wordCount} 字` : ''}
                      {w.path ? ` · ${w.path}` : ''}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: docTitle,
                      markdown: w.markdown || undefined,
                      path: w.path,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-600 px-3 py-1 text-[11.5px] font-medium text-white shadow-hairline hover:bg-accent-700"
                >
                  <Maximize2 className="size-3" /> 右侧画布阅读
                </button>
              </div>
              {w.markdown && (
                <div className="relative max-h-60 overflow-hidden px-4 py-3 text-[13.5px] leading-relaxed text-ink">
                  <MarkdownText
                    text={w.markdown}
                    onFileLinkClick={(path, label) => onOpenDoc({ accountId, title: label, path })}
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" />
                </div>
              )}
            </li>
          )
        }
        if (w.kind === 'hotel_results') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">酒店推荐</p>
              <ul className="flex flex-col gap-1.5 text-[12px]">
                {w.hotels.map((h, i) => (
                  <li key={`${h.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-hover/40 px-2.5 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{h.name}</span>
                      <span className="block truncate text-[11px] text-ink-muted">
                        {[h.rating && `★ ${h.rating}`, h.price, h.location].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {h.url && (
                      <a
                        href={h.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-accent-600 hover:underline"
                      >
                        查看 <ExternalLink className="size-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          )
        }
        if (w.kind === 'idea_cards') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">灵感卡片</p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {w.cards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void sendMessage(botId, c.prompt || c.title)}
                    className="flex flex-col items-start rounded-lg border border-line bg-hover/30 p-2 text-left transition-colors hover:bg-hover"
                  >
                    <span className="text-[12.5px] font-medium text-ink">{c.title}</span>
                    {c.subtitle && <span className="mt-0.5 line-clamp-2 text-[11px] text-ink-muted">{c.subtitle}</span>}
                  </button>
                ))}
              </div>
            </li>
          )
        }
        if (w.kind === 'grok_form') {
          return (
            <GrokFormCard
              key={w.widgetId}
              widget={w}
              botId={botId}
              accountId={accountId}
            />
          )
        }
        if (w.kind === 'session_card') {
          return (
            <SessionInteractiveCard
              key={JSON.stringify([accountId, messageId, w.widgetId])}
              widget={w}
              accountId={accountId}
              botId={botId}
              messageId={messageId}
            />
          )
        }
        return null
      })}
    </ul>
  )
}

function GrokFormCard({
  widget,
  botId,
  accountId
}: {
  widget: Extract<ChatRichWidget, { kind: 'grok_form' }>
  botId: string
  accountId: string
}) {
  const botMeta = useBotStore((s) => s.bots.find((b) => b.id === botId))
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of widget.fields) {
      init[f.id] = f.options?.[0]?.id ?? ''
    }
    return init
  })
  const [saveToVault, setSaveToVault] = useState(widget.formKind === 'secret-request')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(Boolean(widget.submitted))
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting || submitted) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) {
      setErrMsg('Grok IPC 不可用')
      return
    }
    const agentId = botMeta?.selectedAgentId ?? ''
    const sessionId = botMeta?.activeSessionId ?? ''

    for (const f of widget.fields) {
      if (f.required && !values[f.id]?.trim()) {
        setErrMsg(`请填写必填项：${f.label}`)
        return
      }
    }

    setSubmitting(true)
    setErrMsg(null)
    try {
      let res: { ok: boolean; message?: string }
      if (widget.formKind === 'messaging-card') {
        res = await grok.rpc({
          accountId,
          op: 'answerMessagingCard',
          cardId: widget.entryId,
          version: widget.cardVersion ?? 1,
          answer: 'SUBMIT',
          values
        })
      } else if (widget.formKind === 'secret-request') {
        const firstField = widget.fields[0]
        const secretValue = (firstField ? values[firstField.id] : '') ?? ''
        res = await grok.rpc({
          accountId,
          op: 'submitSecret',
          agentId,
          entryId: widget.entryId,
          value: secretValue,
          sessionId
        })
      } else {
        res = await grok.rpc({
          accountId,
          op: 'submitUserForm',
          agentId,
          entryId: widget.entryId,
          values,
          saveToVault,
          sessionId
        })
      }
      if (!res.ok) {
        setErrMsg(res.message || '提交失败')
        return
      }
      setSubmitted(true)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : '提交出错')
    } finally {
      setSubmitting(false)
    }
  }

  const hasSecretField = widget.formKind === 'secret-request' || widget.fields.some((f) => f.secret)

  return (
    <li className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
      <div className="mb-2.5 flex items-start gap-2">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
          <KeyRound className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">
            {widget.title || (widget.formKind === 'secret-request' ? '提供密钥凭据' : '填写表单信息')}
          </p>
          {widget.subtitle && (
            <p className="mt-0.5 text-[11.5px] text-ink-muted">{widget.subtitle}</p>
          )}
        </div>
        {submitted && (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-online/10 px-2 py-0.5 text-[11px] font-medium text-status-online">
            <Check className="size-3" /> 已提交
          </span>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
        {widget.fields.map((field) => (
          <label key={field.id} className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium text-ink-secondary">
              {field.label}
              {field.required && <span className="ml-0.5 text-status-error">*</span>}
            </span>
            {field.options && field.options.length > 0 ? (
              <Select
                size="sm"
                disabled={submitted || submitting}
                value={values[field.id] ?? field.options[0]?.id ?? ''}
                onValueChange={(next) => setValues((prev) => ({ ...prev, [field.id]: next }))}
                options={field.options.map((opt) => ({ value: opt.id, label: opt.label }))}
              />
            ) : field.type === 'textarea' ? (
              <textarea
                rows={3}
                disabled={submitted || submitting}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600 disabled:opacity-60"
              />
            ) : (
              <input
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                disabled={submitted || submitting}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600 disabled:opacity-60"
              />
            )}
          </label>
        ))}

        {hasSecretField && widget.formKind === 'user-form' && !submitted && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-sunken/45 px-2.5 py-1.5 text-[11.5px] text-ink-secondary">
            <span>存入安全凭据库（Secret Vault）</span>
            <SwitchPill checked={saveToVault} onCheckedChange={setSaveToVault} />
          </div>
        )}

        {errMsg && <p className="text-[11.5px] text-status-error">{errMsg}</p>}

        {!submitted && (
          <div className="mt-0.5 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent-600 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-hairline hover:bg-accent-700 disabled:opacity-50"
            >
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              {submitting ? '提交中…' : '提交'}
            </button>
          </div>
        )}
      </form>
    </li>
  )
}

function OptionChips({ message, widget }: { message: ChatMessage; widget: ChatOptionWidget }) {
  const selectChatOption = useBotStore((s) => s.selectChatOption)
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const selected = widget.selectedText
  const filled = widget.buttonStyle === 'center_aligned_filled'
  const disabled = Boolean(selected)

  const pick = (text: string, index: number) => {
    if (disabled) return
    void selectChatOption(message.botId, message.id, widget.widgetId, text, index)
  }

  return (
    <div className="mt-2 flex max-w-[78%] flex-col gap-2" data-muse-option-widget={widget.widgetId}>
      <div className="flex flex-wrap gap-1.5">
        {widget.options.map((opt, index) => {
          const isSel = selected === opt
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled && !isSel}
              onClick={() => pick(opt, index)}
              className={cn(
                'rounded-full px-3 py-1.5 text-[13px] transition-colors',
                filled
                  ? 'bg-accent-600 text-white hover:bg-accent-600/90'
                  : 'border border-dashed border-line-strong bg-surface text-ink hover:bg-hover',
                isSel && 'ring-2 ring-accent-600',
                disabled && !isSel && 'opacity-50'
              )}
            >
              {isSel ? `✓ ${opt}` : opt}
            </button>
          )
        })}
        {widget.customInputPlaceholder && !selected && (
          <button
            type="button"
            onClick={() => setCustomOpen((v) => !v)}
            className="rounded-full border border-dashed border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-hover"
          >
            自定义…
          </button>
        )}
      </div>
      {customOpen && !selected && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const text = customText.trim()
            if (!text) return
            pick(text, -1)
          }}
        >
          <input
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={widget.customInputPlaceholder || '输入名字'}
            className="min-w-0 flex-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-accent"
            autoFocus
          />
          <button
            type="submit"
            className="rounded-full bg-accent-600 px-3 py-1.5 text-[13px] text-white"
          >
            发送
          </button>
        </form>
      )}
    </div>
  )
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isFirstInRun: _isFirstInRun,
  isLastInRun,
  accountLabel,
  onRetry
}: MessageBubbleProps) {
  const mine = message.role === 'user'
  const optionWidgets = (!mine && message.widgets?.filter((w) => w.kind === 'option')) || []
  const tools = (!mine && message.tools) || []
  const media = useMemo(() => getMessageMedia(message), [message])
  const rich = (!mine && message.richWidgets) || []
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)
  const setReplyTarget = useBotStore((s) => s.setReplyTarget)
  const openWebSessionAt = useBotStore((s) => s.openWebSessionAt)
  const botMeta = useBotStore((s) => s.bots.find((b) => b.id === message.botId))
  const [articleExpanded, setArticleExpanded] = useState(false)
  const [copiedMsg, setCopiedMsg] = useState(false)
  const [reactedEmoji, setReactedEmoji] = useState<string | null>(null)

  const supportsInAppWeb =
    botMeta?.platformId === 'meta-muse' ||
    botMeta?.platformId === 'hark' ||
    botMeta?.platformId === 'dot' ||
    botMeta?.platformId === 'antigravity'

  /**
   * Keep cloud browser, cloud computer, and credential vault links inside BotArk's
   * isolated account partition (#34) instead of bouncing out to external Chrome.
   */
  const handleMarkdownLinkClick = (href: string, label: string): boolean => {
    if (!supportsInAppWeb) return false
    const isPlatformDomain = /^https?:\/\/([^/]+\.)?(muse\.ai|hark\.com|chatgpt\.com|antigravity\.google\.com)(\/|$)/i.test(href)
    const isRelativeAction = !/^https?:\/\//i.test(href)
    const isSessionActionLabel =
      /登录|安全存储|安全卡片|密码|浏览器|云电脑|验证码|授权|sign\s*in|log\s*in|vault|browser/i.test(label) ||
      /安全卡片|密码只进安全存储|打开浏览器|云浏览器|云电脑/i.test(message.text || '')

    if (isPlatformDomain || isRelativeAction) {
      openWebSessionAt(/^https?:\/\//i.test(href) ? href : null)
      return true
    }
    if (isSessionActionLabel && /^https?:\/\//i.test(href)) {
      if (getBridge()?.webViews?.openInPartition) {
        void getBridge()!.webViews!.openInPartition({
          accountId: message.accountId,
          url: href,
          title: label
        })
      } else {
        openWebSessionAt(href)
      }
      return true
    }
    return false
  }

  const needsInlineSessionShortcut =
    !mine &&
    supportsInAppWeb &&
    !rich.some((w) => w.kind === 'session_card') &&
    /安全卡片|密码只进安全存储|安全存储|浏览器正在|打开浏览器|云端?浏览器|云电脑|需要你输入验证码/i.test(message.text || '')

  const openDocument = useCallback((target: NativeDocumentTarget) => {
    setActiveDocument({
      ...target,
      platformId: target.platformId ?? botMeta?.platformId,
      agentId: target.agentId ?? botMeta?.selectedAgentId
    })
  }, [setActiveDocument, botMeta?.platformId, botMeta?.selectedAgentId])

  const reactGrokMessage = (emoji: string) => {
    if (botMeta?.platformId !== 'grok' || !botMeta.selectedAgentId) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    const entryId = message.id.replace(/^grok_(u_)?/, '')
    setReactedEmoji(emoji)
    void grok
      .rpc({
        accountId: message.accountId,
        op: 'reactMessage',
        agentId: botMeta.selectedAgentId,
        entryId,
        emoji,
        sessionId: botMeta.activeSessionId ?? ''
      })
      .catch(() => setReactedEmoji(null))
  }

  const isLongMarkdownReport =
    !mine &&
    message.text.length > 360 &&
    (/(^|\n)#{1,4}\s+|\n\|.+\|\n|```/.test(message.text) || message.text.length > 800)
  const reportTitleMatch = !mine ? /^(?:---[\s\S]*?---\s*)?#+\s+(.+)$/m.exec(message.text) : null
  const reportTitle = reportTitleMatch?.[1]?.replace(/[*`]/g, '').trim() || '文章 / 报告文档'

  const copyMessageText = () => {
    if (!message.text) return
    void navigator.clipboard.writeText(message.text).then(
      () => {
        setCopiedMsg(true)
        setTimeout(() => setCopiedMsg(false), 1600)
      },
      () => {}
    )
  }

  const quoteReplyMessage = () => {
    const entryId = message.id.replace(/^grok_(u_)?/, '')
    const rawSnippet = (message.text || '').replace(/\s+/g, ' ').trim()
    const quote = rawSnippet.length > 140 ? `${rawSnippet.slice(0, 140)}…` : rawSnippet || '引用消息'
    setReplyTarget(message.botId, {
      messageId: message.id,
      entryId,
      quote,
      role: message.role
    })
    window.dispatchEvent(new CustomEvent('bothub:focus-composer'))
  }

  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      {/* 0. Quoted message snippet when user replied to a bubble */}
      {message.replyQuote && (
        <div
          className={cn(
            'mb-1 flex max-w-[72%] items-center gap-1.5 rounded-xl border border-line bg-sunken/45 px-2.5 py-1 text-[11.5px] text-ink-secondary',
            mine && 'self-end'
          )}
        >
          <CornerDownRight className="size-3 shrink-0 text-accent-600" aria-hidden />
          <span className="truncate">{message.replyQuote}</span>
        </div>
      )}

      {/* 1. Tool execution trace / thinking status above the assistant reply */}
      {!mine && tools.length > 0 && <ToolChips tools={tools} />}

      {/* 2. User uploaded attachment chips / image & video previews */}
      {message.attachments && message.attachments.length > 0 && (
        <ul className={cn('mb-1.5 flex max-w-[78%] flex-wrap gap-1.5', mine && 'justify-end')}>
          {message.attachments.map((file) => (
            <UserAttachmentItem key={file.id} file={file} />
          ))}
        </ul>
      )}

      {/* 3. Message text or structured inline Article / Document Card */}
      {message.text &&
        (isLongMarkdownReport ? (
          <div className="w-full max-w-[82%] overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
            {/* Article Card Header */}
            <div className="flex items-center justify-between gap-3 border-b border-line bg-sunken/40 px-4 py-2.5">
              <button
                type="button"
                onClick={() =>
                  openDocument({
                    accountId: message.accountId,
                    title: reportTitle,
                    markdown: message.text,
                    mimeType: 'text/markdown'
                  })
                }
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                  <FileText className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">{reportTitle}</span>
                  <span className="block truncate text-[11px] text-ink-muted">
                    Markdown 文章卡片 · {message.text.length} 字 · 支持右侧画布沉浸阅读
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {message.text.length > 720 && (
                  <button
                    type="button"
                    onClick={() => setArticleExpanded((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-hover hover:text-ink"
                  >
                    {articleExpanded ? '收起预览' : '展开全文'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    openDocument({
                      accountId: message.accountId,
                      title: reportTitle,
                      markdown: message.text,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-full bg-accent-600 px-3 py-1 text-[11.5px] font-medium text-white shadow-hairline hover:bg-accent-700"
                >
                  <Maximize2 className="size-3" /> 右侧画布阅读
                </button>
              </div>
            </div>

            {/* Article Card Body */}
            <div
              className={cn(
                'relative px-5 py-4 text-[14px] leading-[1.68] text-ink',
                !articleExpanded && message.text.length > 720 && 'max-h-[340px] overflow-hidden'
              )}
            >
              <MarkdownText
                text={message.text}
                suppressWorkspaceImages={media.length > 0}
                onLinkClick={handleMarkdownLinkClick}
                onFileLinkClick={(path, label) =>
                  openDocument({
                    accountId: message.accountId,
                    title: label || path.split('/').pop() || 'Document',
                    path
                  })
                }
              />
              {!articleExpanded && message.text.length > 720 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface via-surface/85 to-transparent" />
              )}
            </div>

            {!articleExpanded && message.text.length > 720 && (
              <div className="flex items-center justify-between border-t border-line/70 bg-sunken/25 px-4 py-1.5 text-[11.5px] text-ink-secondary">
                <button
                  type="button"
                  onClick={() => setArticleExpanded(true)}
                  className="font-medium text-ink-secondary hover:text-ink"
                >
                  点击展开完整长文（共 {message.text.length} 字）
                </button>
                <button
                  type="button"
                  onClick={() =>
                    openDocument({
                      accountId: message.accountId,
                      title: reportTitle,
                      markdown: message.text,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="font-medium text-accent-600 hover:underline"
                >
                  在右侧分栏打开 →
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'max-w-[78%] rounded-[18px] px-3.5 py-2 text-[14px] leading-6',
              mine ? 'bg-bubble-user text-canvas whitespace-pre-wrap break-words' : 'bg-bubble text-ink',
              message.delivery === 'sending' && 'opacity-70',
              message.delivery === 'failed' && 'bg-status-error/10 text-ink ring-1 ring-status-error/30'
            )}
          >
            {mine ? (
              message.text
            ) : (
              <MarkdownText
                text={message.text}
                suppressWorkspaceImages={media.length > 0}
                onLinkClick={handleMarkdownLinkClick}
                onFileLinkClick={(path, label) =>
                  openDocument({
                    accountId: message.accountId,
                    title: label || path.split('/').pop() || 'Document',
                    path
                  })
                }
              />
            )}
          </div>
        ))}

      {/* 3b. Inline shortcut pill when assistant mentions in-page Secure Vault / Cloud Browser (#34) */}
      {needsInlineSessionShortcut && (
        <button
          type="button"
          onClick={() => openWebSessionAt(null)}
          className="press mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1 text-[12px] font-medium text-ink shadow-soft hover:bg-hover"
        >
          {/安全卡片|安全存储|密码/.test(message.text || '') ? (
            <>
              <ArkShieldVaultSvg className="size-3.5 text-accent-600" />
              <span>在应用内打开安全卡片 / 原生页</span>
            </>
          ) : (
            <>
              <Globe className="size-3.5 text-accent-600" />
              <span>在应用内查看实时云浏览器</span>
            </>
          )}
        </button>
      )}

      {/* 4. Media / File / Artifact cards below message text */}
      {!mine && media.length > 0 && (
        <div className={cn('w-full', message.text && 'mt-2')}>
          <MediaPreview parts={media} accountId={message.accountId} onOpenDoc={openDocument} />
        </div>
      )}

      {/* 5. Rich widgets / interactive cards / CTA buttons below message text */}
      {!mine && rich.length > 0 && (
        <div className={cn('w-full', (message.text || media.length > 0) && 'mt-2')}>
          <RichWidgets
            widgets={rich}
            botId={message.botId}
            accountId={message.accountId}
            messageId={message.id}
            onOpenDoc={openDocument}
          />
        </div>
      )}

      {/* 6. Interactive option chips */}
      {optionWidgets.map((w) => (
        <OptionChips key={w.widgetId || w.options.join('|')} message={message} widget={w} />
      ))}

      {(isLastInRun || message.delivery === 'failed' || message.delivery === 'no-reply' || !mine) && (
        <div
          className={cn(
            'mt-1 flex min-h-5 max-w-full flex-wrap items-center gap-x-2 gap-y-1 px-1.5 text-[11px] leading-4 text-ink-muted transition-opacity duration-150',
            mine && 'max-w-[85%] justify-end',
            message.delivery === 'failed' || message.delivery === 'sending' || message.delivery === 'accepted' || message.delivery === 'no-reply'
              ? 'opacity-100'
              : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100'
          )}
        >
          {accountLabel && <span className="shrink-0 whitespace-nowrap text-ink-secondary">{accountLabel}</span>}
          {accountLabel && <span className="shrink-0" aria-hidden>·</span>}
          <time dateTime={new Date(message.createdAt).toISOString()} className="shrink-0 whitespace-nowrap tabular-nums">
            {formatClock(message.createdAt)}
          </time>
          {mine ? (
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
              {message.text && (
                <button
                  type="button"
                  onClick={quoteReplyMessage}
                  title="引用回复"
                  className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <ArkHandoffCurveSvg className="size-3 shrink-0" />
                  <span>引用</span>
                </button>
              )}
              <DeliveryState message={message} onRetry={onRetry} />
            </div>
          ) : (
            message.text && (
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={quoteReplyMessage}
                  title="引用此消息回复"
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <ArkHandoffCurveSvg className="size-3 shrink-0" />
                  <span>引用</span>
                </button>
                <button
                  type="button"
                  onClick={copyMessageText}
                  title={t('Copy')}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  {copiedMsg ? <Check className="size-3 shrink-0 text-status-online" /> : <Copy className="size-3 shrink-0" />}
                  <span>{copiedMsg ? '已复制' : t('Copy')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => triggerShareConversation({ botId: message.botId, messageId: message.id })}
                  title="生成共享页面"
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <ArkExportDocSvg className="size-3 shrink-0" />
                  <span>分享</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    openDocument({
                      accountId: message.accountId,
                      title: reportTitle,
                      markdown: message.text,
                      mimeType: 'text/markdown'
                    })
                  }
                  title="在右侧画布展开阅读"
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <Maximize2 className="size-3 shrink-0" />
                  <span>右侧阅读</span>
                </button>
                {botMeta?.platformId === 'grok' && botMeta.selectedAgentId && (
                  <div className="ml-0.5 inline-flex items-center gap-0.5">
                    {(['👍', '❤️', '🔥'] as const).map((emo) => (
                      <button
                        key={emo}
                        type="button"
                        onClick={() => reactGrokMessage(emo)}
                        title={`回应 ${emo}`}
                        className={cn(
                          'rounded px-1 py-0.5 text-[11px] hover:bg-hover',
                          reactedEmoji === emo && 'bg-accent-50 ring-1 ring-accent-500/40'
                        )}
                      >
                        {emo}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
})
