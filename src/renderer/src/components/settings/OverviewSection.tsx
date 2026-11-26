import { useMemo, useState } from 'react'
import { LogOut, MoreHorizontal, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { PlatformId } from '@adapters/types'
import { ArkRelayOrbSvg } from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Status'
import { useT } from '@/lib/i18n'
import { platformIcon } from '@/lib/platformIcons'
import { NEW_ROOM_ID } from '@/rooms/roomExport'
import { useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import type { BotAccount } from '@/types'
import { isOnlineStatus, PLATFORM_LABELS, type DotStoredMeta } from './PlatformAccountsSection'

interface OverviewSectionProps {
  active: boolean
  accountsByPlatform: ReadonlyMap<PlatformId, BotAccount[]>
  dotMetaMap: Record<string, DotStoredMeta>
  poolCount: number
  busy: boolean
  onReconnectOffline: () => void
}

const PLATFORMS = [
  { id: 'meta-muse', tab: 'muse-accounts', desc: 'Noise WSS' },
  { id: 'dot', tab: 'dot-accounts', desc: 'Calpico Room' },
  { id: 'grok', tab: 'grok-accounts', desc: 'Sand PKCE' },
  { id: 'hark', tab: 'hark-accounts', desc: '项目空间' },
  { id: 'hermes', tab: 'hermes-accounts', desc: '本地网关' },
  { id: 'antigravity', tab: 'antigravity-accounts', desc: 'Google Cloud' },
  { id: 'cue', tab: 'cue-accounts', desc: 'Manus API' },
  { id: 'ds-bot', tab: 'ds-bot-accounts', desc: 'DSH 开源团队' }
] as const

export function OverviewSection({
  active, accountsByPlatform, dotMetaMap, poolCount, busy, onReconnectOffline
}: OverviewSectionProps) {
  const tr = useT()
  const groups = useBotStore((s) => s.groups)
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const roomCount = useRooms((s) => active ? s.rooms.length : 0)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const selectBot = useBotStore((s) => s.selectBot)
  const renameBot = useBotStore((s) => s.renameBot)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const moveBotToGroup = useBotStore((s) => s.moveBotToGroup)
  const togglePinBot = useBotStore((s) => s.togglePinBot)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)

  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<
    'all' | 'meta-muse' | 'dot' | 'grok' | 'hark' | 'hermes' | 'antigravity' | 'cue' | 'ds-bot'
  >('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [editingBotId, setEditingBotId] = useState<string | null>(null)
  const [editingBotName, setEditingBotName] = useState('')

  const filteredBots = useMemo(() => {
    if (!active) return []
    const q = searchQuery.trim().toLowerCase()
    return bots.filter((bot) => {
      if (platformFilter !== 'all' && bot.platformId !== platformFilter) return false
      const acc = accounts[bot.activeAccountId]
      const isOnline = isOnlineStatus(acc?.status)
      if (statusFilter === 'online' && !isOnline) return false
      if (statusFilter === 'offline' && isOnline) return false
      if (!q) return true
      const hay = `${bot.name} ${acc?.displayName ?? ''} ${acc?.handle ?? ''} ${bot.activeAccountId}`.toLowerCase()
      return hay.includes(q)
    })
  }, [active, bots, accounts, searchQuery, platformFilter, statusFilter])

  if (!active) return null

  const allAccounts = Object.values(accounts)
  const onlineAccountsCount = allAccounts.filter((account) => isOnlineStatus(account.status)).length
  const botCounts = new Map<PlatformId, number>()
  for (const bot of bots) botCounts.set(bot.platformId, (botCounts.get(bot.platformId) ?? 0) + 1)

  return (
    <div className="flex flex-col gap-4 animate-veil-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('Overview')}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || allAccounts.length === 0}
            onClick={onReconnectOffline}
          >
            <RefreshCw className="size-3.5" /> 重连离线
          </Button>
        </div>
      </div>

      {/* Clean Minimalist KPI Strip */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
          <p className="text-[11.5px] text-ink-muted">Bot 总数</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{bots.length}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
          <p className="text-[11.5px] text-ink-muted">在线账号</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
            {onlineAccountsCount} <span className="text-[13px] font-normal text-ink-muted">/ {allAccounts.length}</span>
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
          <p className="text-[11.5px] text-ink-muted">{tr('Collaboration rooms')}</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{roomCount}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
          <p className="text-[11.5px] text-ink-muted">加密代理池</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{poolCount}</p>
        </div>
      </div>

      {/* Platform Breakdown Cards */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
        {PLATFORMS.map((platform) => {
          const platformAccounts = accountsByPlatform.get(platform.id) ?? []
          const onlineCount = platformAccounts.filter((account) => isOnlineStatus(account.status)).length
          return (
            <button
              key={platform.id}
              type="button"
              onClick={() => setSettingsOpen(true, platform.tab)}
              className="press flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left shadow-hairline transition-colors hover:border-line-strong hover:bg-hover/50"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {platformIcon(platform.id) && (
                  <img
                    src={platformIcon(platform.id)}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="size-7 shrink-0 rounded-lg object-cover ring-1 ring-line"
                  />
                )}
                <div className="min-w-0">
                  <span className="block truncate text-[13.5px] font-semibold tracking-tight text-ink">
                    {PLATFORM_LABELS[platform.id]}
                  </span>
                  <span className="block truncate text-[11px] text-ink-muted">{platform.desc}</span>
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] font-medium text-ink-secondary tabular-nums">
                {onlineCount}/{platformAccounts.length}
              </span>
            </button>
          )
        })}
      </div>

      {/* Compact 1-Line Multi-Agent Collaboration Card */}
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-2.5 shadow-hairline">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
            <ArkRelayOrbSvg active className="size-4" />
          </span>
          <span className="truncate text-[13.5px] font-medium text-ink">
            {tr('Multi-agent collaboration')}{roomCount > 0 ? ` · ${tr('{count} rooms', { count: roomCount })}` : ''}
          </span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setSettingsOpen(false)
            selectBot(NEW_ROOM_ID)
          }}
        >
          <Plus className="size-3.5" />
          {tr('Create collaboration room')}
        </Button>
      </div>

      {/* Unified Bot & Account Management Table */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/40 px-4 py-2.5">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索 Bot 名称、邮箱 Handle 或账号 ID…"
              className="h-8 w-full rounded-xl border border-line bg-canvas pr-3 pl-8 text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              size="sm"
              variant="pill"
              value={platformFilter}
              onValueChange={(next) => setPlatformFilter(next)}
              className="min-w-36"
              options={[
                { value: 'all', label: `全部平台 (${bots.length})` },
                { value: 'meta-muse', label: `Meta Muse (${botCounts.get('meta-muse') ?? 0})` },
                { value: 'dot', label: `ChatGPT Dot (${botCounts.get('dot') ?? 0})` },
                { value: 'grok', label: `Grok Bot (${botCounts.get('grok') ?? 0})` },
                { value: 'hark', label: `Hark Pro (${botCounts.get('hark') ?? 0})` },
                { value: 'hermes', label: `Hermes (${botCounts.get('hermes') ?? 0})` },
                { value: 'antigravity', label: `Antigravity (${botCounts.get('antigravity') ?? 0})` },
                { value: 'cue', label: `Cue (${botCounts.get('cue') ?? 0})` },
                { value: 'ds-bot', label: `DS Bot (${botCounts.get('ds-bot') ?? 0})` }
              ]}
            />
            <Select
              size="sm"
              variant="pill"
              value={statusFilter}
              onValueChange={(next) => setStatusFilter(next)}
              className="min-w-28"
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'online', label: '仅在线' },
                { value: 'offline', label: '仅离线 / 异常' }
              ]}
            />
          </div>
        </div>

        {filteredBots.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-[13.5px] font-medium text-ink">
              {bots.length === 0 ? '当前工作区暂无任何 Bot 账号' : '没有符合筛选条件的 Bot'}
            </p>
            <p className="mt-1 text-[12px] text-ink-muted">
              {bots.length === 0
                ? '可从左侧平台标签页添加或批量导入账号，所有凭据均使用系统安全存储加密。'
                : '请尝试清空搜索词或切换平台筛选器。'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {filteredBots.map((bot) => {
              const acc = accounts[bot.activeAccountId]
              const dotMeta = bot.platformId === 'dot' ? dotMetaMap[bot.activeAccountId] : undefined
              const isEditing = editingBotId === bot.id
              return (
                <li
                  key={bot.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <BotAvatar
                      seed={bot.id}
                      avatar={bot.avatar}
                      avatarShape={bot.avatarShape}
                      avatarColor={bot.avatarColor}
                      emoji={bot.emoji}
                      platformId={bot.platformId}
                      status={acc?.status ?? 'offline'}
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {isEditing ? (
                          <form
                            className="inline-flex items-center gap-1"
                            onSubmit={(e) => {
                              e.preventDefault()
                              if (editingBotName.trim()) {
                                renameBot(bot.id, editingBotName.trim())
                                if (acc) renameAccount(acc.id, editingBotName.trim())
                              }
                              setEditingBotId(null)
                            }}
                          >
                            <input
                              autoFocus
                              value={editingBotName}
                              onChange={(e) => setEditingBotName(e.target.value)}
                              onBlur={() => {
                                if (editingBotName.trim()) {
                                  renameBot(bot.id, editingBotName.trim())
                                }
                                setEditingBotId(null)
                              }}
                              className="h-6 rounded border border-accent-600 bg-canvas px-2 text-[13px] font-medium text-ink outline-none"
                            />
                          </form>
                        ) : (
                          <span className="truncate text-[14px] font-medium text-ink">{bot.name}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingBotId(bot.id)
                            setEditingBotName(bot.name)
                          }}
                          className="rounded p-0.5 text-ink-muted hover:bg-hover hover:text-ink"
                          title="重命名 Bot"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
                          {platformIcon(bot.platformId) && (
                            <img
                              src={platformIcon(bot.platformId)}
                              alt=""
                              aria-hidden
                              draggable={false}
                              className="size-3 shrink-0 rounded-[3px] object-cover"
                            />
                          )}
                          {PLATFORM_LABELS[bot.platformId] ?? bot.platformId}
                        </span>
                        {acc && <StatusBadge status={acc.status} />}
                        {dotMeta?.hasRefreshToken && (
                          <span className="rounded-md bg-status-online/10 px-1.5 py-0.5 text-[10.5px] font-medium text-status-online-ink">
                            RT 自动续期
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-muted">
                        <span className="font-mono text-[11px]">
                          {acc?.handle || dotMeta?.handle || PLATFORM_LABELS[bot.platformId]}
                        </span>
                        {dotMeta?.planType && (
                          <>
                            <span>·</span>
                            <span className="uppercase">{dotMeta.planType}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Select
                      size="xs"
                      variant="pill"
                      value={bot.groupId}
                      onValueChange={(next) => moveBotToGroup(bot.id, next)}
                      title="调整所属分组"
                      className="max-w-32"
                      options={groups.map((g) => ({ value: g.id, label: g.name }))}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setSettingsOpen(false)
                        selectBot(bot.id)
                      }}
                    >
                      对话
                    </Button>
                    <Menu>
                      <MenuTrigger
                        aria-label={`${bot.name} 更多操作`}
                        className="press-icon grid size-7 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
                      >
                        <MoreHorizontal className="size-4" />
                      </MenuTrigger>
                      <MenuContent align="end" side="bottom" className="min-w-40">
                        <MenuItem onSelect={() => togglePinBot(bot.id)}>
                          {bot.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                          {bot.pinned ? '取消置顶' : '置顶侧边栏'}
                        </MenuItem>
                        {acc && (
                          <MenuItem
                            disabled={acc.pending}
                            onSelect={() => void connectAccount(acc.id)}
                          >
                            <RefreshCw aria-hidden /> 重新连接
                          </MenuItem>
                        )}
                        {acc && (
                          <MenuItem
                            disabled={acc.pending}
                            onSelect={() => void signOutAccount(acc.id)}
                          >
                            <LogOut aria-hidden /> 退出登录
                          </MenuItem>
                        )}
                        <MenuSeparator />
                        <MenuItem danger onSelect={() => void removeBot(bot.id)}>
                          <Trash2 aria-hidden /> 删除 Bot
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
