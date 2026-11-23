import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getPlatform } from '@adapters/platforms'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  Square,
  Trash2
} from 'lucide-react'
import { MarkdownText } from '@/components/chat/MarkdownText'
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
import { InlineEdit } from '@/components/ui/InlineEdit'
import {
  MENU_SURFACE,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger
} from '@/components/ui/Menu'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { cn } from '@/lib/cn'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import {
  isFinal,
  mentions,
  splitMentionSegments,
  stripFinalPrefix,
  type CollabRoom,
  type RoomMember,
  type RoomMessage
} from './model'
import { RoomAvatarCluster } from './RoomAvatarCluster'
import { exportRoomMarkdownFile } from './RoomInspectorPanel'
import { applyDropOnRoom, isRoomDropDrag, showRoomDndNotice, useRoomDndNotice } from './roomDnd'
import {
  addRoom,
  deleteRoom,
  renameRoom,
  stopRoom,
  submitBrief,
  useRooms
} from './roomStore'
import { WorkspaceTools } from './WorkspaceTools'

export const NEW_ROOM_ID = 'room-create'

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
/* Sidebar Room List                                                          */
/* -------------------------------------------------------------------------- */

/** Drop-target props so a bot / room member can be dragged onto a group chat. */
function useRoomDropTarget(roomId: string) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!isRoomDropDrag(e.dataTransfer.types)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        if (!over) setOver(true)
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        if (!isRoomDropDrag(e.dataTransfer.types)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        showRoomDndNotice(applyDropOnRoom(roomId, e.dataTransfer))
      }
    }
  }
}

function RoomDndNotice() {
  const notice = useRoomDndNotice((s) => s.notice)
  if (!notice) return null
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-none fixed bottom-4 left-4 z-50 max-w-72 rounded-xl px-3 py-2 text-[12px] font-medium shadow-lg',
        notice.ok ? 'bg-ink text-canvas' : 'bg-status-error text-white'
      )}
    >
      {notice.message}
    </div>
  )
}

function CompactRoomButton({
  room,
  active,
  speaking,
  onOpen
}: {
  room: CollabRoom
  active: boolean
  speaking: string | undefined
  onOpen: () => void
}) {
  const drop = useRoomDropTarget(room.id)
  return (
    <button
      type="button"
      title={`${room.title}（可拖入 Bot）`}
      aria-current={active}
      onClick={onOpen}
      {...drop.props}
      className={cn(
        'press-icon relative grid size-11 place-items-center rounded-2xl transition-colors',
        active ? 'bg-active ring-1 ring-line-strong' : 'hover:bg-hover',
        drop.over && 'bg-accent-50 ring-2 ring-accent-500'
      )}
    >
      <RoomAvatarCluster
        members={room.members.slice(0, 2)}
        speakingName={speaking}
        size="xs"
        ringClassName="ring-canvas"
      />
      {speaking && (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-2 rounded-full bg-accent-600 ring-2 ring-canvas animate-pulse"
        />
      )}
    </button>
  )
}

function RoomSidebarItem({
  room,
  selected,
  speaker,
  onSelect
}: {
  room: CollabRoom
  selected: boolean
  speaker: string | undefined
  onSelect: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const drop = useRoomDropTarget(room.id)
  const lastMsg = room.messages.at(-1)
  const subtitle = speaker
    ? `@${speaker}…`
    : room.finalId
      ? '已定稿'
      : lastMsg
        ? stripFinalPrefix(lastMsg.text).replace(/\s+/g, ' ').trim()
        : `${room.members.length} 位成员`

  return (
    <div
      className={cn(
        'group/room relative rounded-xl transition-shadow',
        drop.over && 'bg-accent-50/70 ring-2 ring-accent-500'
      )}
      {...drop.props}
    >
      {drop.over && (
        <span className="pointer-events-none absolute top-1/2 right-9 z-10 -translate-y-1/2 rounded-md bg-accent-600 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
          松开加入
        </span>
      )}
      {renaming ? (
        <div className="flex h-11 items-center px-2">
          <InlineEdit
            value={room.title}
            label="群聊名称"
            maxLength={50}
            className="h-8 w-full text-[13px] font-medium"
            onCommit={(name) => renameRoom(room.id, name)}
            onDone={() => setRenaming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          data-bot-row
          aria-current={selected}
          onClick={onSelect}
          title={room.title}
          className={cn(
            'no-drag press flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors outline-none',
            selected ? 'bg-active text-ink' : 'hover:bg-hover text-ink'
          )}
        >
          <RoomAvatarCluster
            members={room.members}
            speakingName={speaker}
            size="xs"
            ringClassName="ring-canvas"
          />
          <div className="min-w-0 flex-1 pr-4">
            <span className="block truncate text-[13px] leading-[18px] font-medium tracking-tight text-ink">
              {room.title}
            </span>
            <p
              className={cn(
                'truncate text-[11.5px] leading-4',
                speaker
                  ? 'shimmer-text font-medium'
                  : room.finalId
                    ? 'text-status-online-ink'
                    : 'text-ink-muted'
              )}
            >
              {subtitle}
            </p>
          </div>
        </button>
      )}

      {!renaming && (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            aria-label={`${room.title} 菜单`}
            className={cn(
              'press-icon absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-muted',
              'opacity-0 group-hover/room:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
              'hover:bg-active hover:text-ink data-[state=open]:bg-active'
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </MenuTrigger>
          <MenuContent align="start" side="bottom" className="min-w-40">
            <MenuItem onSelect={() => setRenaming(true)}>
              <Pencil aria-hidden /> 重命名
            </MenuItem>
            <MenuItem
              disabled={room.messages.length === 0}
              onSelect={() => exportRoomMarkdownFile(room)}
            >
              <ArkExportDocSvg /> 导出 Markdown
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => deleteRoom(room.id)}>
              <Trash2 aria-hidden /> 删除
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}

export function RoomList({ compact = false }: { compact?: boolean }) {
  const rooms = useRooms((s) => s.rooms)
  const speakers = useRooms((s) => s.speakers)
  const select = useBotStore((s) => s.selectBot)
  const selected = useBotStore((s) => s.selectedBotId)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const settingsOpen = useBotStore((s) => s.settingsOpen)
  const [collapsed, setCollapsed] = useState(false)

  const openRoom = (id: string) => {
    if (settingsOpen) setSettingsOpen(false)
    select(id)
  }

  if (compact) {
    return (
      <section
        aria-label="群聊"
        className="no-drag mt-1 flex w-full shrink-0 flex-col items-center gap-1.5 border-t border-ink/[0.06] pt-2"
      >
        <button
          type="button"
          title="新建群聊"
          aria-label="新建群聊"
          aria-current={selected === NEW_ROOM_ID && !settingsOpen}
          onClick={() => openRoom(NEW_ROOM_ID)}
          className={cn(
            'press-icon grid size-10 place-items-center rounded-2xl transition-colors',
            selected === NEW_ROOM_ID && !settingsOpen
              ? 'bg-active text-accent-600'
              : 'text-ink-secondary hover:bg-hover hover:text-ink'
          )}
        >
          <ArkRelayOrbSvg active={selected === NEW_ROOM_ID && !settingsOpen} className="size-4.5" />
        </button>
        {rooms.map((r) => (
          <CompactRoomButton
            key={r.id}
            room={r}
            active={r.id === selected && !settingsOpen}
            speaking={speakers[r.id]}
            onOpen={() => openRoom(r.id)}
          />
        ))}
        <RoomDndNotice />
      </section>
    )
  }

  return (
    <section aria-label="群聊" className="no-drag mt-1 shrink-0 border-t border-ink/[0.06] pt-1.5">
      <div className="group/rsec flex h-7 items-center gap-0.5 px-0.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-ink-muted transition-colors hover:bg-hover hover:text-ink-secondary"
        >
          <ArkRelayOrbSvg className="size-3.5 text-ink-secondary" />
          <span className="truncate text-[12px] font-medium tracking-tight">群聊</span>
          {collapsed && rooms.length > 0 && (
            <span className="ml-auto text-[11px] tabular-nums opacity-70">{rooms.length}</span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              'ml-auto size-3.5 shrink-0 transition-transform duration-150',
              !collapsed ? 'rotate-90 opacity-0 group-hover/rsec:opacity-80' : 'opacity-70'
            )}
          />
        </button>
        <button
          type="button"
          title="新建群聊"
          aria-label="新建群聊"
          onClick={() => openRoom(NEW_ROOM_ID)}
          className={cn(
            'press-icon grid size-6 shrink-0 place-items-center rounded-full transition-colors',
            selected === NEW_ROOM_ID && !settingsOpen
              ? 'bg-ink text-canvas'
              : 'text-ink-muted hover:bg-hover hover:text-ink'
          )}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {!collapsed && (
        <div className="mt-0.5 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {rooms.map((r) => (
            <RoomSidebarItem
              key={r.id}
              room={r}
              selected={r.id === selected && !settingsOpen}
              speaker={speakers[r.id]}
              onSelect={() => openRoom(r.id)}
            />
          ))}
        </div>
      )}
      <RoomDndNotice />
    </section>
  )
}

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

function RoomMessageRow({
  room,
  message,
  onMentionReply
}: {
  room: CollabRoom
  message: RoomMessage
  onMentionReply: (memberName: string) => void
}) {
  const bots = useBotStore((s) => s.bots)
  const [copied, setCopied] = useState(false)

  if (message.author === 'Tool') {
    return <ToolExecutionCard message={message} />
  }

  const isUser = message.author === 'User' || message.author.startsWith('Slack ')
  if (isUser) {
    const fromSlack = message.author.startsWith('Slack ')
    return (
      <div className="mx-auto flex w-full max-w-[780px] flex-col items-end gap-1 animate-veil-in">
        {fromSlack && (
          <span className="inline-flex items-center gap-1 px-1 text-[11px] text-ink-muted">
            <ArkSlackWeaveSvg className="size-3" /> {message.author.replace(/^Slack\s+/, '')}
          </span>
        )}
        <div className="max-w-[76%] rounded-[20px] bg-bubble-user px-4 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap break-words text-main">
          <HighlightMentions text={message.text} members={room.members} invert />
        </div>
      </div>
    )
  }

  const member = room.members.find((m) => m.name === message.author)
  const bot = member ? bots.find((b) => b.id === member.botId) : undefined
  const finalDeliverable = message.id === room.finalId || isFinal(message.text)
  const cleanText = finalDeliverable ? stripFinalPrefix(message.text) : message.text
  const handoffs = mentions(cleanText, room.members).filter((t) => t.name !== message.author)

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
                onClick={() => exportRoomMarkdownFile(room)}
                title="导出 Markdown"
                className="press-icon grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
              >
                <ArkExportDocSvg className="size-3.5" />
              </button>
            </div>
          </div>
          <div className="px-5 py-4 text-[14px] leading-[23px] text-ink">
            <MarkdownText text={cleanText} />
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
          {handoffs.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-muted">
              <ArkHandoffCurveSvg className="size-3 text-accent-600" />
              {handoffs.map((h) => h.name).join(' · ')}
            </span>
          )}
        </div>

        <div className="rounded-2xl bg-bubble px-4 py-3 text-[14px] leading-[22px] text-ink">
          <MarkdownText text={cleanText} />
        </div>

        <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={copyBody}
            className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-muted hover:bg-hover hover:text-ink"
          >
            {copied ? <Check className="size-3 text-status-online" /> : <Copy className="size-3" />}
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            onClick={() => onMentionReply(message.author)}
            className="press inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-muted hover:bg-hover hover:text-ink"
          >
            <ArkMentionLoopSvg className="size-3" />
            追问
          </button>
        </div>
      </div>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/* Active Collaboration Room View                                             */
/* -------------------------------------------------------------------------- */

const MAX_COMPOSER_HEIGHT = 200

export function RoomView({ id }: { id: string }) {
  const room = useRooms((s) => s.rooms.find((r) => r.id === id))
  const speaker = useRooms((s) => s.speakers[id])
  const progress = useRooms((s) => s.turnProgress[id])
  const error = useRooms((s) => s.errors[id])
  const audience = useRooms((s) => s.externalAudiences[id])

  const bots = useBotStore((s) => s.bots)
  const infoOpen = useBotStore((s) => s.infoPanelOpen)
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const selectBot = useBotStore((s) => s.selectBot)

  const [text, setText] = useState('')
  const [multiline, setMultiline] = useState(false)
  const [mentionCursor, setMentionCursor] = useState(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`
    setMultiline(el.scrollHeight > 40)
  }

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth'
    })
  }, [room?.messages.length, speaker])

  useEffect(() => {
    const onAppend = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId: string; text: string }>).detail
      if (!detail || detail.roomId !== id) return
      setText((prev) => [prev, detail.text].filter(Boolean).join('\n\n'))
      requestAnimationFrame(() => {
        resize()
        textareaRef.current?.focus()
      })
    }
    window.addEventListener('botark:room-append-draft', onAppend)
    return () => window.removeEventListener('botark:room-append-draft', onAppend)
  }, [id])

  if (!room) return <CreateRoom />

  const mentionMatch = /(?:^|.*[^A-Za-z0-9_.+-])(@([^\n]*))$/u.exec(text)
  const atIdx = mentionMatch
    ? mentionMatch.index + mentionMatch[0].length - mentionMatch[1]!.length
    : -1
  const rawQuery = mentionMatch?.[2] ?? ''
  const closeAfterExact =
    Boolean(mentionMatch) &&
    /\s$/.test(rawQuery) &&
    room.members.some((m) => m.name.toLowerCase() === rawQuery.trimEnd().toLowerCase()) &&
    !room.members.some((m) => m.name.toLowerCase().startsWith(rawQuery.toLowerCase()))
  const mentionCandidates =
    mentionMatch && !closeAfterExact
      ? room.members.filter((m) =>
          m.name.toLowerCase().includes(rawQuery.trim().toLowerCase())
        )
      : []

  const insertMention = (memberName: string) => {
    const next =
      mentionMatch && atIdx >= 0
        ? `${text.slice(0, atIdx)}@${memberName} `
        : `${text}${text && !text.endsWith(' ') ? ' ' : ''}@${memberName} `
    setText(next)
    setMentionCursor(0)
    requestAnimationFrame(() => {
      resize()
      textareaRef.current?.focus()
    })
  }

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    void submitBrief(id, trimmed)
    setText('')
    setMentionCursor(0)
    requestAnimationFrame(resize)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
  const slackLabel = (room.slackChannel ?? audience?.replace(/^Slack\s+/, ''))?.trim()

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
          {room.messages.length > 0 && (
            <IconButton
              label={room.finalId ? '导出共识 Markdown' : '导出讨论记录'}
              onClick={() => exportRoomMarkdownFile(room)}
            >
              <ArkExportDocSvg />
            </IconButton>
          )}
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

      {error && (
        <div className="mx-auto mt-2 flex max-w-[780px] flex-wrap items-center gap-2 px-4">
          <p role="alert" className="text-[12.5px] text-status-error">
            {error}
          </p>
          {room.mode === 'manual' &&
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
                    resize()
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
        <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-5">
            {room.messages.map((m) => (
              <RoomMessageRow
                key={m.id}
                room={room}
                message={m}
                onMentionReply={(name) => insertMention(name)}
              />
            ))}

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

              <WorkspaceTools
                scope={id}
                recipient={room.title}
                hermesAccount={hermesAccount}
                variant="popover"
                append={(value) => {
                  setText((prev) => [prev, value].filter(Boolean).join('\n\n'))
                  requestAnimationFrame(() => {
                    resize()
                    textareaRef.current?.focus()
                  })
                }}
              />

              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                onChange={(e) => {
                  setText(e.target.value)
                  setMentionCursor(0)
                  resize()
                }}
                onKeyDown={onKeyDown}
                placeholder={
                  room.mode === 'manual'
                    ? '当前为手动 @ 模式，输入 @ 成员名点名回复…'
                    : '发消息，或输入 @ 点名接力…'
                }
                aria-label={`发消息到 ${room.title}`}
                className="block max-h-[200px] min-h-8 flex-1 resize-none bg-transparent px-1.5 py-[5px] text-[14px] leading-[22px] text-ink outline-none placeholder:text-ink-muted"
              />

              {speaker && !text.trim() ? (
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
                  disabled={!text.trim()}
                  aria-label="发送"
                  title="发送（Enter）"
                  className={cn(
                    'press-icon grid size-8 shrink-0 place-items-center rounded-full transition-colors',
                    text.trim()
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
