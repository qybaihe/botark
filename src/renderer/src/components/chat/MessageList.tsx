import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronUp } from 'lucide-react'
import { BotAvatar } from '@/components/ui/Avatar'
import { revealTranscriptRow } from '@/lib/transcriptFocus'
import { cn } from '@/lib/cn'
import { formatDayLabel, isSameDay } from '@/lib/format'
import type { Bot, BotAccount, ChatMessage } from '@/types'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'
import { plural, useT } from '@/lib/i18n'

interface MessageListProps {
  bot: Bot
  messages: ChatMessage[]
  accounts: BotAccount[]
  typing: boolean
  onRetry: (messageId: string) => void
}

const WINDOW_SIZE = 80
/** Messages closer than this (same sender & account) render as one run. */
const RUN_GAP_MS = 5 * 60 * 1000
/** Auto-scroll only if the reader is already near the bottom. */
const STICKY_THRESHOLD_PX = 120

const FOCUS_MESSAGE_EVENT = 'bothub:focus-message'
interface MessageFocus {
  botId: string
  messageId: string
}
let pendingMessageFocus: MessageFocus | undefined

export function focusChatMessage(botId: string, messageId: string): void {
  // Selecting a different bot or closing its web session can mount the list after this event.
  pendingMessageFocus = { botId, messageId }
  window.dispatchEvent(new Event(FOCUS_MESSAGE_EVENT))
}

function sameRun(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.role === b.role &&
    a.accountId === b.accountId &&
    Math.abs(b.createdAt - a.createdAt) < RUN_GAP_MS &&
    isSameDay(a.createdAt, b.createdAt)
  )
}

export const MessageList = memo(function MessageList(props: MessageListProps) {
  const { bot } = props
  const sessionKey = JSON.stringify([bot.id, bot.activeAccountId, bot.selectedAgentId, bot.activeSessionId, bot.hermesSessionKey])
  return <Transcript key={sessionKey} {...props} />
})

function Transcript({ bot, messages, accounts, typing, onRetry }: MessageListProps) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLOListElement>(null)
  const scrollFrame = useRef<number | null>(null)
  const stickToBottom = useRef(true)
  const prependAnchor = useRef<{ message: HTMLElement; top: number } | null>(null)
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.displayName])), [accounts])
  const showAccount = bot.accountIds.length > 1
  const lastMessage = messages[messages.length - 1]

  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE)
  const [focusMessageId, setFocusMessageId] = useState<string>()
  const focusIndex = useMemo(
    () => focusMessageId ? messages.findIndex((message) => message.id === focusMessageId) : -1,
    [focusMessageId, messages]
  )
  const focusCount = focusIndex < 0 ? 0 : messages.length - focusIndex
  const hiddenCount = Math.max(0, messages.length - Math.max(visibleCount, focusCount))
  const visibleMessages = useMemo(() => messages.slice(hiddenCount), [messages, hiddenCount])
  const previous = useRef({ lastMessage, count: messages.length })
  const unseenLabel = plural(t, unseen, 'New message', '{n} new messages')

  const updateScrollState = useCallback((view: HTMLDivElement) => {
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < STICKY_THRESHOLD_PX
    stickToBottom.current = atBottom
    setAway(!atBottom)
    if (atBottom) setUnseen(0)
  }, [])

  const followBottom = useCallback(() => {
    if (!stickToBottom.current || scrollFrame.current !== null) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      const el = scrollRef.current
      if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
    })
  }, [])

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    const view = scrollRef.current
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(followBottom)
    if (transcript) observer?.observe(transcript)
    if (view) observer?.observe(view)
    return () => {
      observer?.disconnect()
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
    }
  }, [followBottom])

  useLayoutEffect(() => {
    const old = previous.current
    previous.current = { lastMessage, count: messages.length }
    const added = messages.length - old.count
    if (lastMessage?.role === 'user' && added > 0 && lastMessage.id !== old.lastMessage?.id) {
      stickToBottom.current = true
      setAway(false)
      setUnseen(0)
    } else if (added > 0 && !stickToBottom.current && lastMessage?.role === 'bot') {
      setUnseen((count) => count + added)
    }
    followBottom()
  }, [messages.length, lastMessage, typing, followBottom])

  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    const view = scrollRef.current
    if (!anchor || !view) return
    prependAnchor.current = null
    if (view.contains(anchor.message)) {
      const newTop = anchor.message.getBoundingClientRect().top - view.getBoundingClientRect().top
      view.scrollTop += newTop - anchor.top
    }
    updateScrollState(view)
  }, [hiddenCount, visibleCount, updateScrollState])

  useLayoutEffect(() => {
    const receiveFocus = () => {
      if (pendingMessageFocus?.botId === bot.id) {
        setFocusMessageId(pendingMessageFocus.messageId)
        pendingMessageFocus = undefined
      }
    }
    receiveFocus()
    window.addEventListener(FOCUS_MESSAGE_EVENT, receiveFocus)
    return () => window.removeEventListener(FOCUS_MESSAGE_EVENT, receiveFocus)
  }, [bot.id])

  useLayoutEffect(() => {
    if (!focusMessageId) return
    const view = scrollRef.current
    const row = transcriptRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
    if (row && view) {
      stickToBottom.current = false
      setVisibleCount((count) => Math.max(count, focusCount))
      revealTranscriptRow(row)
    }
    setFocusMessageId(undefined)
  }, [focusMessageId, focusCount])

  const loadEarlier = () => {
    const view = scrollRef.current
    const firstMessage = transcriptRef.current?.querySelector<HTMLElement>('[data-message-id]')
    if (view && firstMessage) {
      prependAnchor.current = {
        message: firstMessage,
        top: firstMessage.getBoundingClientRect().top - view.getBoundingClientRect().top
      }
    }
    setVisibleCount((count) => count + WINDOW_SIZE)
  }

  const jumpToLatest = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
    stickToBottom.current = false
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    setUnseen(0)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(event) => updateScrollState(event.currentTarget)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <ol ref={transcriptRef} className="mx-auto flex max-w-[860px] flex-col px-8 py-6" aria-label={t('Conversation with {name}', { name: bot.name })}>
          {hiddenCount > 0 && (
            <li className="flex justify-center pb-5 [overflow-anchor:none]">
              <button
                type="button"
                onClick={loadEarlier}
                title={t('Load earlier messages')}
                className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary hover:bg-hover hover:text-ink"
              >
                <ChevronUp className="size-3.5" aria-hidden />
                {plural(t, Math.min(hiddenCount, WINDOW_SIZE), 'Load {n} earlier message', 'Load {n} earlier messages')}
              </button>
            </li>
          )}
          {visibleMessages.map((message, index) => {
            const prev = visibleMessages[index - 1]
            const next = visibleMessages[index + 1]
            const newDay = !prev || !isSameDay(prev.createdAt, message.createdAt)
            const isFirstInRun = !sameRun(prev, message)
            const isLastInRun = !sameRun(message, next)
            const isBot = message.role === 'bot'

            return (
              <Fragment key={message.id}>
                {newDay && (
                  <li className="my-5 flex items-center justify-center gap-3 text-caption text-ink-muted first:mt-0" role="separator">
                    {formatDayLabel(message.createdAt)}
                  </li>
                )}
                <li
                  data-message-id={message.id}
                  tabIndex={-1}
                  className={cn('group/msg rounded-lg focus-visible:outline-2 focus-visible:outline-accent-600', isFirstInRun && !newDay ? 'mt-3' : 'mt-1')}
                >
                  <div className="flex items-start gap-2.5">
                    {isBot && (
                      <span className="mt-0.5 w-7 shrink-0">
                        {isFirstInRun && (
                          <BotAvatar
                            emoji={bot.emoji}
                            seed={bot.id}
                            avatar={bot.avatar}
                            avatarShape={bot.avatarShape}
                            avatarColor={bot.avatarColor}
                            platformId={bot.platformId}
                            size="sm"
                          />
                        )}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <MessageBubble
                        message={message}
                        isFirstInRun={isFirstInRun}
                        isLastInRun={isLastInRun}
                        accountLabel={showAccount ? accountNames.get(message.accountId) : undefined}
                        onRetry={onRetry}
                      />
                    </div>
                  </div>
                </li>
              </Fragment>
            )
          })}
          {typing && (
            <li className="mt-4">
              <TypingIndicator bot={bot} />
            </li>
          )}
        </ol>
      </div>
      {away && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={unseen > 0 ? unseenLabel : t('Jump to latest')}
          className={cn(
            'press absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 animate-pop-lift items-center gap-1.5 rounded-full shadow-float',
            unseen > 0
              ? 'bg-accent-600 px-3 text-[13px] text-white hover:bg-accent-700'
              : 'w-8 justify-center border-[0.5px] border-line-strong bg-main text-ink-secondary hover:text-ink'
          )}
        >
          <ArrowDown className="size-4" aria-hidden />
          {unseen > 0 && <span className="tabular-nums">{unseenLabel}</span>}
        </button>
      )}
    </div>
  )
}
