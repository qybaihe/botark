import { usePromptSlashMenu } from '@/components/chat/PromptSlashMenu'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getPlatform } from '@adapters/platforms'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Pin,
  PinOff,
  Plus,
  Square,
  X
} from 'lucide-react'
import { TranscriptSearchBar, TranscriptSearchButton } from '@/components/chat/TranscriptSearchBar'
import { revealTranscriptRow } from '@/lib/transcriptFocus'
import { focusRoomMessage, ROOM_FOCUS_EVENT, takeRoomMessageFocus } from './roomFocus'
import { MarkdownText } from '@/components/chat/MarkdownText'
import { MediaPreview } from '@/components/chat/MediaPreview'
import { NativeDocumentDialog, type NativeDocumentTarget } from '@/components/chat/NativeDocumentDialog'
import { PaneHeader } from '@/components/layout/PaneHeader'
import {
  ArkComposeNewSvg,
  ArkConsensusSealSvg,
  ArkDrawerToggleSvg,
  ArkExportDocSvg,
  ArkHandoffCurveSvg,
  ArkMcpNodeSvg,
  ArkMentionLoopSvg,
  ArkPromptSparkSvg,
  ArkRelayOrbSvg,
  ArkSlackWeaveSvg
} from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { NumberStepper } from '@/components/ui/Controls'
import { TextInput } from '@/components/ui/Field'
import { GrokBotMark } from '@/components/ui/GrokBotMark'
import { IconButton } from '@/components/ui/IconButton'
import { Menu, MenuContent, MenuItem, MenuTrigger, MENU_SURFACE } from '@/components/ui/Menu'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import {
  isHumanRoomMessage,
  mentionStartPattern,
  normalizeMentionName,
  roomRecipient,
  splitMentionSegments,
  stripFinalPrefix,
  type CollabRoom,
  type RoomMember,
  type RoomMessage,
  type RoomReference
} from './model'
import { RoomAvatarCluster } from './RoomAvatarCluster'
import { exportRoomJsonFile, exportRoomMarkdownFile, NEW_ROOM_ID } from './roomExport'
import {
  addRoom,
  roomSlackDestination,
  stopRoom,
  submitBrief,
  togglePinRoom,
  useRooms
} from './roomStore'
import { WorkspaceTools } from './WorkspaceTools'

export { NEW_ROOM_ID, PinnedRoomsList, RoomList } from './RoomSidebarList'

const ROOM_SCENARIOS = [
  {
    id: 'review',
    label: '方案评审',
    prompt: '请相互审阅方案，指出潜在边界问题与分歧，并推选一位成员综合输出最终定稿。'
  },
  {
    id: 'research',
    label: '联合调研',
    prompt: '请自主分工调研关键维度，交叉核实各自结论与依据，最后整合成结构化调研报告。'
  },
  {
    id: 'code-audit',
    label: '代码审查',
    prompt: '请先给出清晰技术方案，再由同伴从安全、边界条件和可维护性挑刺修订，最后输出定稿。'
  },
  {
    id: 'coauthor',
    label: '共同起草',
    prompt: '请协商分工、相互评审修订各自的草稿，达成一致后由执笔者输出最终交付版本。'
  }
] as const

/* -------------------------------------------------------------------------- */
/* Create Room Studio (Minimalist Grok Sand Stage)                            */
/* -------------------------------------------------------------------------- */

function CreateRoom() {
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const selectBot = useBotStore((s) => s.selectBot)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const setAddBotOpen = useBotStore((s) => s.setAddBotOpen)

  const isReadyStatus = (status?: string) =>
    status === 'online' || status === 'attention' || status === 'busy'
  const onlineBots = useMemo(
    () => bots.filter((b) => isReadyStatus(accounts[b.activeAccountId]?.status)),
    [bots, accounts]
  )
  const [ids, setIds] = useState<string[]>(() => onlineBots.slice(0, 3).map((b) => b.id))
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<CollabRoom['mode']>('auto')
  const [limit, setLimit] = useState(8)
  const [error, setError] = useState('')
  const [pokeMap, setPokeMap] = useState<Record<string, number>>({})

  const selectedBots = useMemo(
    () =>
      ids
        .map((id) => bots.find((b) => b.id === id))
        .filter((b): b is NonNullable<typeof b> => Boolean(b)),
    [ids, bots]
  )
  const hasDuplicateNames = useMemo(
    () =>
      new Set(selectedBots.map((b) => b.name.trim().toLowerCase())).size !== selectedBots.length,
    [selectedBots]
  )

  const toggleBot = (botId: string) => {
    setError('')
    setPokeMap((prev) => ({ ...prev, [botId]: (prev[botId] ?? 0) + 1 }))
    setIds((prev) => {
      if (prev.includes(botId)) return prev.filter((id) => id !== botId)
      if (prev.length >= 6) return prev
      return [...prev, botId]
    })
  }

  const placeholderTitle =
    selectedBots.length >= 2
      ? `群聊名称（默认：${selectedBots.map((b) => b.name).join(' · ')}）`
      : '群聊名称（选填）'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader>
        <span />
      </PaneHeader>

      <div className="flex min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <form
          className="m-auto flex w-full max-w-[560px] animate-veil-in flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            try {
              const created = addRoom(title, ids, mode, limit)
              selectBot(created.id)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          {/* Living 3D Character Chorus */}
          <div className="flex flex-col items-center gap-3 pt-1 text-center">
            <div className="flex min-h-[52px] items-center justify-center gap-2">
              {selectedBots.length > 0 ? (
                selectedBots.map((b) => (
                  <span
                    key={b.id}
                    className="inline-flex animate-mark-pop rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-line"
                  >
                    <GrokBotMark
                      seed={b.id}
                      shape={b.avatarShape}
                      color={b.avatarColor}
                      followPointer
                      sizePx={38}
                    />
                  </span>
                ))
              ) : (
                <span className="grid size-12 place-items-center rounded-2xl bg-hover text-ink-muted">
                  <ArkRelayOrbSvg className="size-6" />
                </span>
              )}
            </div>
            <h1 className="text-[18px] leading-6 font-semibold tracking-tight text-ink">
              新建协作群聊
            </h1>
          </div>

          {/* Clean Single Input */}
          <TextInput
            aria-label="群聊名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={placeholderTitle}
            className="h-10 rounded-xl px-3.5"
          />

          {/* Sculpted 2-Column Bot Cards */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-0.5 text-[12px] text-ink-muted">
              <span>选择 2–6 位成员</span>
              <span className="tabular-nums">{ids.length} / 6</span>
            </div>

            {bots.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong py-8 text-center">
                <Button size="sm" variant="primary" onClick={() => setAddBotOpen(true)}>
                  <Plus /> 添加 Bot
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {bots.map((b) => {
                  const acc = accounts[b.activeAccountId]
                  const isOnline = isReadyStatus(acc?.status)
                  const orderIndex = ids.indexOf(b.id)
                  const checked = orderIndex >= 0
                  const maxReached = !checked && ids.length >= 6
                  const platform = getPlatform(b.platformId)
                  const connectAndSelect = async () => {
                    if (!b.activeAccountId || acc?.pending) return
                    await connectAccount(b.activeAccountId)
                    const nextStatus = useBotStore.getState().accounts[b.activeAccountId]?.status
                    if (isReadyStatus(nextStatus)) {
                      setIds((prev) =>
                        prev.includes(b.id) || prev.length >= 6 ? prev : [...prev, b.id]
                      )
                    }
                  }

                  return (
                    <div
                      key={b.id}
                      role={isOnline ? 'checkbox' : undefined}
                      aria-checked={isOnline ? checked : undefined}
                      tabIndex={isOnline && !maxReached ? 0 : -1}
                      onClick={() => {
                        if (isOnline && !maxReached) {
                          toggleBot(b.id)
                        } else if (!isOnline && !maxReached) {
                          void connectAndSelect()
                        }
                      }}
                      onKeyDown={(e) => {
                        if ((e.key === ' ' || e.key === 'Enter') && isOnline && !maxReached) {
                          e.preventDefault()
                          toggleBot(b.id)
                        }
                      }}
                      className={cn(
                        'press flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-all outline-none select-none',
                        checked
                          ? 'border-ink/25 bg-active/70 shadow-hairline'
                          : isOnline && !maxReached
                            ? 'cursor-pointer border-line bg-surface hover:border-line-strong hover:bg-hover/45'
                            : !maxReached
                              ? 'cursor-pointer border-line/60 bg-sunken/35 opacity-75 hover:opacity-95'
                              : 'border-line/60 bg-sunken/35 opacity-55'
                      )}
                    >
                      <BotAvatar
                        emoji={b.emoji}
                        seed={b.id}
                        avatar={b.avatar}
                        avatarShape={b.avatarShape}
                        avatarColor={b.avatarColor}
                        platformId={b.platformId}
                        status={acc?.status ?? 'offline'}
                        pokeSignal={pokeMap[b.id] ?? 0}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium tracking-tight text-ink">
                          {b.name}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                          <PlatformGlyph platform={platform} size="sm" className="size-3" />
                          <span className="truncate">
                            {platform.name}
                            {acc?.handle && acc.handle !== b.name ? ` · ${acc.handle}` : ''}
                          </span>
                        </span>
                      </div>

                      {isOnline ? (
                        checked ? (
                          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[10.5px] font-semibold text-canvas tabular-nums animate-mark-pop">
                            {orderIndex + 1}
                          </span>
                        ) : (
                          <span className="size-4.5 shrink-0 rounded-full border border-line-strong" />
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={Boolean(acc?.pending)}
                          onClick={(e) => {
                            e.stopPropagation()
                            void connectAndSelect()
                          }}
                          className="h-6.5 px-2.5 text-[11px]"
                        >
                          {acc?.pending ? '连接中…' : '连接'}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {hasDuplicateNames && (
              <p className="px-0.5 text-[11.5px] text-ink-muted">
                同名成员将在创建时自动编号或按账号区分
              </p>
            )}
          </div>

          {/* Single-Line Mode & Turn Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-3.5 py-2.5">
            <SegmentedControl<CollabRoom['mode']>
              value={mode}
              onValueChange={setMode}
              size="sm"
              aria-label="发言模式"
              options={[
                { value: 'auto', label: '自主接力', icon: <ArkPromptSparkSvg /> },
                { value: 'manual', label: '手动 @' }
              ]}
            />
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-muted">上限</span>
              <NumberStepper
                value={limit}
                onChange={setLimit}
                min={1}
                max={24}
                suffix="轮"
                aria-label="轮数上限"
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-center text-[12.5px] text-status-error">
              {error}
            </p>
          )}

          <div className="flex justify-center pt-1">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={ids.length < 2}
              className="min-w-44"
            >
              创建群聊
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Quiet Grok-Style Timeline Messages                                         */
/* -------------------------------------------------------------------------- */

function HighlightMentions({
  text,
  members,
  invert = false
}: {
  text: string
  members: ReadonlyArray<RoomMember>
  invert?: boolean
}) {
  const segments = splitMentionSegments(text, members)
  return (
    <>
      {segments.map((seg, i) =>
        seg.member ? (
          <span
            key={i}
            className={cn(
              'inline-flex items-center rounded-md px-1.5 py-0.2 text-[12.5px] font-semibold',
              invert ? 'bg-canvas/18 text-main' : 'bg-hover text-ink'
            )}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}

function ToolExecutionCard({ message }: { message: RoomMessage }) {
  const [expanded, setExpanded] = useState(false)
  const lines = message.text.split('\n')
  const summary = lines[0]?.trim().slice(0, 72) || 'workspace'

  return (
    <div className="mx-auto w-full max-w-[780px] pl-11 animate-veil-in">
      <div className="inline-flex max-w-full flex-col overflow-hidden rounded-xl border border-line bg-sunken/45">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-hover/60"
        >
          <ArkMcpNodeSvg className="size-3.5 text-accent-600" />
          <span className="truncate font-mono text-[11.5px]">{summary}</span>
          <ChevronDown
            className={cn(
              'ml-1 size-3.5 shrink-0 text-ink-muted transition-transform duration-150',
              expanded && 'rotate-180'
            )}
          />
        </button>
        {expanded && (
          <pre className="max-h-56 overflow-auto border-t border-line bg-surface/60 px-3.5 py-2.5 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-ink-secondary">
            {message.text}
          </pre>
        )}
      </div>
    </div>
  )
}

function ReferenceList({ references, onRemove }: {
  references: RoomReference[]
  onRemove?: (index: number) => void
}) {
  return (
    <ul aria-label="随附资料" className="grid gap-1">
      {references.map((ref, index) => (
        <li key={index} className="flex items-start gap-2 rounded-md bg-sunken px-2 py-1 text-xs text-ink-secondary">
          <details className="min-w-0 flex-1">
            <summary className="cursor-pointer break-words">{ref.label}</summary>
            <pre className="my-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{ref.text}</pre>
          </details>
          {onRemove && (
            <button type="button" aria-label={`移除 ${ref.label}`} onClick={() => onRemove(index)}>
              <X className="size-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

const RoomMessageRow = memo(function RoomMessageRow({
  members,
  message,
  finalDeliverable,
  onMentionReply,
  onExport
}: {
  members: RoomMember[]
  message: RoomMessage
  finalDeliverable: boolean
  onMentionReply: (memberName: string) => void
  onExport: (messageId: string) => void
}) {
  const member = members.find((m) => message.authorBotId ? m.botId === message.authorBotId : m.name === message.author)
  const authorBotId = message.authorBotId ?? member?.botId
  const bot = useBotStore((s) => authorBotId ? s.bots.find((b) => b.id === authorBotId) : undefined)
  const [copied, setCopied] = useState(false)
  const [document, setDocument] = useState<NativeDocumentTarget | null>(null)

  if (message.notice) {
    return <p className="mx-auto text-xs text-ink-muted">{message.text}</p>
  }
  if (!message.authorBotId && message.author === 'Tool') {
    return <ToolExecutionCard message={message} />
  }

  if (isHumanRoomMessage(message)) {
    const fromSlack = message.author.startsWith('Slack ')
    return (
      <div className="mx-auto flex w-full max-w-[780px] flex-col items-end gap-1 animate-veil-in">
        {fromSlack && (
          <span className="inline-flex items-center gap-1 px-1 text-[11px] text-ink-muted">
            <ArkSlackWeaveSvg className="size-3" /> {message.author.replace(/^Slack\s+/, '')}
          </span>
        )}
        <div className="max-w-[76%] rounded-[20px] bg-bubble-user px-4 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap break-words text-main">
          <HighlightMentions text={message.text} members={members} invert />
        </div>
        {message.references && message.references.length > 0 && (
          <div className="max-w-[76%]">
            <ReferenceList references={message.references} />
          </div>
        )}
      </div>
    )
  }

  const cleanText = finalDeliverable ? stripFinalPrefix(message.text) : message.text
  const source = message.mediaSource
  const onFileLinkClick = source ? (path: string, title: string) => setDocument({
    accountId: source.accountId,
    platformId: source.platform,
    agentId: source.agentId,
    sessionId: source.sessionId,
    path,
    title
  }) : undefined
  const preview = <NativeDocumentDialog target={document} onClose={() => setDocument(null)} />
  const media = source && message.media?.length ? (
    <div className="mt-2">
      <MediaPreview
        parts={message.media}
        accountId={source.accountId}
        scope={source}
        onOpenDoc={(target) => setDocument({ ...target, platformId: source.platform })}
      />
    </div>
  ) : null
  const handoffs = message.handoffBotIds?.flatMap((id) => {
    const target = members.find((m) => m.botId === id)
    return target ? [target.name] : []
  })

  const copyBody = () => {
    void navigator.clipboard.writeText(cleanText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  if (finalDeliverable) {
    return (
      <article className="mx-auto w-full max-w-[780px] animate-step-in">
        <div className="overflow-hidden rounded-2xl border border-status-online/30 bg-status-online/[0.035] shadow-soft">
          <div className="flex items-center justify-between gap-2 border-b border-status-online/15 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
              <ArkConsensusSealSvg className="size-4 text-status-online" />
              <span className="font-semibold text-status-online-ink">共识定稿</span>
              <span className="truncate text-ink-muted">· {message.author}</span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={copyBody}
                title="复制定稿"
                className="press-icon grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
              >
                {copied ? (
                  <Check className="size-3.5 text-status-online" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onExport(message.id)}
                title="导出 Markdown"
                className="press-icon grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
              >
                <ArkExportDocSvg className="size-3.5" />
              </button>
            </div>
          </div>
          <div className="px-5 py-4 text-[14px] leading-[23px] text-ink">
            {cleanText && <MarkdownText text={cleanText} onFileLinkClick={onFileLinkClick} />}
            {media}
            {preview}
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className="group mx-auto flex w-full max-w-[780px] items-start gap-3 animate-veil-in">
      <div className="pt-0.5">
        <BotAvatar
          emoji={bot?.emoji ?? '🤖'}
          seed={bot?.id ?? member?.botId ?? message.author}
          avatar={bot?.avatar}
          avatarShape={bot?.avatarShape}
          avatarColor={bot?.avatarColor}
          platformId={member?.platform}
          size="sm"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[12.5px]">
          <span className="font-semibold tracking-tight text-ink">{message.author}</span>
          {Boolean(handoffs?.length) && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-muted">
              <ArkHandoffCurveSvg className="size-3 text-accent-600" />
              {handoffs?.join(' · ')}
            </span>
          )}
        </div>

        {cleanText && (
          <div className="rounded-2xl bg-bubble px-4 py-3 text-[14px] leading-[22px] text-ink">
            <MarkdownText text={cleanText} onFileLinkClick={onFileLinkClick} />
          </div>
        )}
        {media}
        {preview}

        <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {cleanText && (
            <button
              type="button"
              onClick={copyBody}
              className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-muted hover:bg-hover hover:text-ink"
            >
              {copied ? <Check className="size-3 text-status-online" /> : <Copy className="size-3" />}
              {copied ? '已复制' : '复制'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onMentionReply(member?.name ?? message.author)}
            className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-muted hover:bg-hover hover:text-ink"
          >
            <ArkMentionLoopSvg className="size-3" />
            追问
          </button>
        </div>
      </div>
    </article>
  )
})

const RoomTranscript = memo(function RoomTranscript({
  members, messages, finalId, onMentionReply, onExport
}: {
  members: RoomMember[]
  messages: RoomMessage[]
  finalId?: string
  onMentionReply: (name: string) => void
  onExport: (messageId: string) => void
}) {
  return messages.map((message) => (
    <div key={message.id} data-room-message-id={message.id} tabIndex={-1}
      className="flex flex-col rounded-lg focus-visible:outline-2 focus-visible:outline-accent-600">
      <RoomMessageRow
        members={members}
        message={message}
        finalDeliverable={message.final === true || message.id === finalId}
        onMentionReply={onMentionReply}
        onExport={onExport}
      />
    </div>
  ))
})

/* -------------------------------------------------------------------------- */
/* Active Collaboration Room View                                             */
/* -------------------------------------------------------------------------- */

const MAX_COMPOSER_HEIGHT = 200
const trailingMention = new RegExp(`${mentionStartPattern}([^@＠\\r\\n]*)$`, 'u')

export function RoomView({ id }: { id: string }) {
  const t = useT()
  const room = useRooms((s) => s.rooms.find((r) => r.id === id))
  const speaker = useRooms((s) => s.speakers[id])
  const liveReply = useRooms((s) => s.liveReplies[id])
  const progress = useRooms((s) => s.turnProgress[id])
  const error = useRooms((s) => s.errors[id])
  const audience = useRooms((s) => s.externalAudiences[id])

  const bots = useBotStore((s) => s.bots)
  const infoOpen = useBotStore((s) => s.infoPanelOpen)
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const selectBot = useBotStore((s) => s.selectBot)

  const [text, setText] = useState('')
  const [references, setReferences] = useState<RoomReference[]>([])
  const [multiline, setMultiline] = useState(false)
  const [mentionCursor, setMentionCursor] = useState(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`
    setMultiline(el.scrollHeight > 40)
  }, [])

  useLayoutEffect(() => {
    resize()
  }, [id, text, resize])

  useLayoutEffect(() => {
    followLatest.current = true
    const receiveFocus = () => {
      const messageId = takeRoomMessageFocus(id)
      if (!messageId) return
      const row = transcriptRef.current?.querySelector<HTMLElement>(`[data-room-message-id="${CSS.escape(messageId)}"]`)
      if (row) {
        followLatest.current = false
        revealTranscriptRow(row)
      }
    }
    receiveFocus()
    window.addEventListener(ROOM_FOCUS_EVENT, receiveFocus)
    return () => window.removeEventListener(ROOM_FOCUS_EVENT, receiveFocus)
  }, [id])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current
      if (transcript && followLatest.current) transcript.scrollTop = transcript.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [id, room?.messages.length, speaker, liveReply])

  useEffect(() => {
    const onAppend = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId: string; reference: RoomReference }>).detail
      if (!detail || detail.roomId !== id) return
      setReferences((prev) => [...prev, detail.reference])
      requestAnimationFrame(() => {
        resize()
        textareaRef.current?.focus()
      })
    }
    window.addEventListener('botark:room-append-draft', onAppend)
    return () => window.removeEventListener('botark:room-append-draft', onAppend)
  }, [id, resize])

  const insertMention = useCallback((memberName: string) => {
    setText((previous) => {
      const start = trailingMention.exec(previous)?.index
      return start !== undefined
        ? `${previous.slice(0, start)}@${memberName} `
        : `${previous}${previous && !/\s$/.test(previous) ? ' ' : ''}@${memberName} `
    })
    setMentionCursor(0)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [])

  const exportMessage = useCallback((messageId: string) => {
    const current = useRooms.getState().rooms.find((r) => r.id === id)
    if (current) exportRoomMarkdownFile(current, messageId)
  }, [id])

  const mentionMatch = trailingMention.exec(text)
  const rawQuery = mentionMatch?.[1] ?? ''
  const query = normalizeMentionName(rawQuery)
  const closeAfterExact =
    Boolean(mentionMatch) &&
    /\s$/.test(rawQuery) &&
    room?.members.some((m) => normalizeMentionName(m.name) === query) &&
    !room.members.some((m) => {
      const name = normalizeMentionName(m.name)
      return name.startsWith(`${query} `) || name.startsWith(`${query}·`)
    })
  const mentionCandidates =
    room && mentionMatch && !closeAfterExact
      ? room.members.filter((m) =>
          normalizeMentionName(m.name).includes(query)
        )
      : []

  const recipient = room?.members.find((m) => m.botId === room.coordinatorId)?.name ?? room?.title ?? ''
  const prompts = usePromptSlashMenu(textareaRef, text, setText, resize, recipient, mentionCandidates.length > 0)
  if (!room) return <CreateRoom />

  const canSend = Boolean(text.trim() || references.length)
  const submit = () => {
    if (!canSend) return
    void submitBrief(id, text, { references })
    setText('')
    setReferences([])
    setMentionCursor(0)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (prompts.handleKey(e)) return
    if (mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionCursor((c) => (c + 1) % mentionCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionCursor((c) => (c - 1 + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        e.preventDefault()
        const picked = mentionCandidates[mentionCursor] ?? mentionCandidates[0]
        if (picked) insertMention(picked.name)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const speakingMember = speaker ? room.members.find((m) => m.name === speaker) : undefined
  const speakingBot = speakingMember
    ? bots.find((b) => b.id === speakingMember.botId)
    : undefined
  const hermesAccount = room.members.find((m) => m.platform === 'hermes')?.accountId
  const slackDestination = roomSlackDestination(room)
  const slackLabel = (slackDestination?.channel ?? room.slackChannel ?? audience?.replace(/^Slack\s+/, ''))?.trim()

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {/* Quiet Grok Bot 3-Zone Header */}
      <PaneHeader className="gap-3 pr-3">
        <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
          {speaker ? (
            <span
              role="status"
              className="hidden min-w-0 truncate text-[12px] shimmer-text sm:inline"
            >
              {progress ? `${progress.turn}/${progress.limit} · ` : ''}@{speaker} 思考中…
            </span>
          ) : slackLabel ? (
            <span
              title={`已映射 Slack ${slackLabel}`}
              className="hidden max-w-36 items-center gap-1 truncate rounded-full bg-hover px-2.5 py-1 text-[11.5px] text-ink-secondary lg:inline-flex"
            >
              <ArkSlackWeaveSvg className="size-3 text-accent-600" />
              <span className="truncate">{slackLabel}</span>
            </span>
          ) : null}
        </div>

        {/* Center Grok Floating Capsule (Clean Title Only) */}
        <button
          type="button"
          data-capsule
          onClick={toggleInfoPanel}
          aria-expanded={infoOpen}
          title={`${room.title} · ${room.members.map((m) => m.name).join(' · ')}`}
          className={cn(
            'no-drag group press flex h-10 max-w-[min(420px,50%)] min-w-0 items-center gap-2 rounded-full pr-3.5 pl-2',
            'border-[0.5px] border-line-strong bg-main shadow-float hover:bg-surface'
          )}
        >
          <RoomAvatarCluster
            members={room.members}
            speakingName={speaker}
            size="xs"
            ringClassName="ring-main"
          />
          <h1 className="min-w-0 truncate text-[14px] leading-[18px] font-medium text-ink">
            {room.title}
          </h1>
          <ChevronRight
            aria-hidden
            className={cn(
              '-ml-2 size-4 w-0 shrink-0 -translate-x-1.5 text-ink-muted opacity-0 blur-[3px]',
              'transition-[width,margin,opacity,filter,translate] duration-[290ms] ease-spring-tap',
              'group-hover:ml-0 group-hover:w-4 group-hover:translate-x-0 group-hover:opacity-100 group-hover:blur-none'
            )}
          />
        </button>

        {/* Quiet Icon-Only Right Actions */}
        <div className="no-drag flex min-w-0 flex-1 items-center justify-end gap-1">
          <TranscriptSearchButton />
          {room.messages.length > 0 && (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label={t('Export conversation')}><ArkExportDocSvg /></IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem onSelect={() => exportRoomMarkdownFile(room)}>{t('Download Markdown (.md)')}</MenuItem>
                <MenuItem onSelect={() => exportRoomJsonFile(room)}>{t('Download JSON (.json)')}</MenuItem>
              </MenuContent>
            </Menu>
          )}
          <IconButton
            label={t(room.pinned ? 'Unpin from sidebar' : 'Pin to sidebar')}
            active={room.pinned === true}
            onClick={() => togglePinRoom(room.id)}
          >
            {room.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          </IconButton>
          <IconButton label="新建群聊" onClick={() => selectBot(NEW_ROOM_ID)}>
            <ArkComposeNewSvg />
          </IconButton>
          <IconButton
            label={infoOpen ? '收起详情' : '打开详情'}
            shortcut={shortcutLabel('I')}
            active={infoOpen}
            onClick={toggleInfoPanel}
          >
            <ArkDrawerToggleSvg active={infoOpen} />
          </IconButton>
        </div>
      </PaneHeader>

      <TranscriptSearchBar conversationId={id} messages={room.messages} focusMessage={focusRoomMessage} />
      {error && (
        <div className="mx-auto mt-2 flex max-w-[780px] flex-wrap items-center gap-2 px-4">
          <p role="alert" className="text-[12.5px] text-status-error">
            {error}
          </p>
          {!room.coordinatorId && room.mode === 'manual' &&
            room.members.map((m) => (
              <button
                key={m.botId}
                type="button"
                onClick={() => insertMention(m.name)}
                className="press rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11.5px] font-medium text-ink-secondary hover:bg-hover hover:text-ink"
              >
                @{m.name}
              </button>
            ))}
        </div>
      )}

      {/* Main Timeline or Quiet Empty Stage */}
      {room.messages.length === 0 && !speaker ? (
        <div className="flex min-h-0 flex-1 animate-veil-in flex-col items-center justify-center gap-5 px-8 pb-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <RoomAvatarCluster members={room.members} size="lg" ringClassName="ring-main" />
            <h2 className="text-[17px] leading-6 font-medium tracking-tight text-ink">
              {room.title}
            </h2>
          </div>

          <div className="flex max-w-xl flex-wrap justify-center gap-2">
            {ROOM_SCENARIOS.map((sc) => (
              <Button
                key={sc.id}
                size="sm"
                onClick={() => {
                  const lead = room.members[0]?.name
                  setText(lead ? `@${lead} ${sc.prompt}` : sc.prompt)
                  requestAnimationFrame(() => {
                    textareaRef.current?.focus()
                  })
                }}
                className="h-8 text-[13px] font-normal"
              >
                {sc.label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div ref={transcriptRef} onScroll={(event) => {
          const view = event.currentTarget
          followLatest.current = view.scrollHeight - view.scrollTop - view.clientHeight < 120
        }} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-5">
            <RoomTranscript
              members={room.members}
              messages={liveReply ? [...room.messages, liveReply] : room.messages}
              finalId={room.finalId}
              onMentionReply={insertMention}
              onExport={exportMessage}
            />

            {speaker && (
              <div className="mx-auto flex w-full max-w-[780px] items-center gap-3 animate-veil-in">
                <BotAvatar
                  emoji={speakingBot?.emoji ?? '🤖'}
                  seed={speakingBot?.id ?? speakingMember?.botId ?? speaker}
                  avatar={speakingBot?.avatar}
                  avatarShape={speakingBot?.avatarShape}
                  avatarColor={speakingBot?.avatarColor}
                  platformId={speakingMember?.platform}
                  isWorking
                  size="sm"
                />
                <div className="inline-flex items-center gap-2.5 rounded-2xl bg-bubble px-4 py-2.5">
                  <span className="text-[13px] shimmer-text">@{speaker} 正在回复…</span>
                  <button
                    type="button"
                    onClick={() => stopRoom(id)}
                    className="press rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-secondary shadow-hairline hover:text-ink"
                  >
                    停止
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Clean Grok Pill Composer */}
      <div className="shrink-0 px-6 pt-2 pb-5">
        <div className="relative mx-auto max-w-[820px] px-2">
          {prompts.menu}
          {mentionCandidates.length > 0 && (
            <div
              role="listbox"
              aria-label="提及成员"
              className={cn(
                'absolute bottom-full left-2 z-30 mb-2 flex w-64 flex-col gap-0.5 p-1.5',
                MENU_SURFACE,
                'animate-pop-lift'
              )}
            >
              {mentionCandidates.map((m, idx) => {
                const bot = bots.find((b) => b.id === m.botId)
                const active = idx === mentionCursor
                return (
                  <button
                    key={m.botId}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setMentionCursor(idx)}
                    onClick={() => insertMention(m.name)}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors',
                      active ? 'bg-hover text-ink' : 'text-ink-secondary hover:bg-hover'
                    )}
                  >
                    <BotAvatar
                      emoji={bot?.emoji ?? '🤖'}
                      seed={bot?.id ?? m.botId}
                      avatar={bot?.avatar}
                      avatarShape={bot?.avatarShape}
                      avatarColor={bot?.avatarColor}
                      platformId={m.platform}
                      size="xs"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">
                      {m.name}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <div
            className={cn(
              'border border-line-strong bg-surface p-[7px] shadow-card transition-[border-color,box-shadow,border-radius] duration-200',
              multiline ? 'rounded-[18px]' : 'rounded-[22px]',
              'focus-within:border-ink/20'
            )}
          >
            {references.length > 0 && (
              <ReferenceList references={references} onRemove={(index) =>
                setReferences((prev) => prev.filter((_, i) => i !== index))
              } />
            )}
            <div className="flex items-end gap-0.5">
              <IconButton
                label="提及成员 (@)"
                onClick={() => {
                  setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@`)
                  requestAnimationFrame(() => textareaRef.current?.focus())
                }}
              >
                <ArkMentionLoopSvg />
              </IconButton>

              {prompts.button}
              <WorkspaceTools
                scope={id}
                recipient={roomRecipient(room, slackDestination ? `Slack ${slackDestination.channel}` : audience)}
                hermesAccount={hermesAccount}
                variant="popover"
                append={(reference) => {
                  setReferences((prev) => [...prev, reference])
                  requestAnimationFrame(() => {
                    resize()
                    textareaRef.current?.focus()
                  })
                }}
              />

              <textarea
                {...prompts.textareaProps}
                ref={textareaRef}
                value={text}
                rows={1}
                onChange={(e) => {
                  prompts.sync(e.currentTarget)
                  setText(e.target.value)
                  setMentionCursor(0)
                }}
                onKeyDown={onKeyDown}
                placeholder={
                  !room.coordinatorId && room.mode === 'manual'
                    ? '当前为手动 @ 模式，输入 @ 成员名点名回复…'
                    : '发消息，或输入 @ 点名接力…'
                }
                aria-label={`发消息到 ${room.title}`}
                className="block max-h-[200px] min-h-8 flex-1 resize-none bg-transparent px-1.5 py-[5px] text-[14px] leading-[22px] text-ink outline-none placeholder:text-ink-muted"
              />

              {speaker && !canSend ? (
                <button
                  type="button"
                  onClick={() => stopRoom(id)}
                  aria-label="停止"
                  title="停止"
                  className="press-icon grid size-8 shrink-0 place-items-center rounded-full bg-ink text-canvas hover:bg-ink/85"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  aria-label="发送"
                  title="发送（Enter）"
                  className={cn(
                    'press-icon grid size-8 shrink-0 place-items-center rounded-full transition-colors',
                    canSend
                      ? 'bg-accent-600 text-white hover:bg-accent-700'
                      : 'bg-hover text-ink-faint'
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.25} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
