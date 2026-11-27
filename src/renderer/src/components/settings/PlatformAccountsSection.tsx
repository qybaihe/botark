import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Globe, KeyRound, LogOut, Plus, RefreshCw, Shuffle, Trash2 } from 'lucide-react'
import type { ConnectionStatus, PlatformId } from '@adapters/types'
import { createId } from '@shared/id'
import { keepMuseBatchProxyAssignments, MuseBatchImport } from '@/components/add-bot/MuseBatchImport'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { Dialog } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { importHarkCredentialsForAccount } from '@/lib/harkCredentialImport'
import { useT, t } from '@/lib/i18n'
import { proxyPoolArgsForAccounts, useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'
import type { useProxyPool } from './ProxyPoolSection'
import type { SettingsActivity, SettingsTab } from './SettingsView'

interface AccountListProps {
  accounts: readonly BotAccount[]
  botsByAccountId: ReadonlyMap<string, Bot[]>
}

interface AccountTabProps extends AccountListProps {
  active: boolean
  activity: SettingsActivity
}

interface AccountImportProps extends AccountTabProps {
  credentialRevision: number
}

export interface DotStoredMeta {
  accountId: string
  handle?: string
  planType?: string
  mode?: 'dot' | 'native'
  model?: string
  hasRefreshToken?: boolean
}

const EMPTY_ACCOUNTS: readonly BotAccount[] = []

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  'meta-muse': 'Meta Muse',
  dot: 'ChatGPT Dot',
  grok: 'Grok Bot',
  hark: 'Hark Pro',
  gemini: 'Google Gemini',
  hermes: 'Hermes',
  antigravity: 'Antigravity',
  cue: 'Cue (Manus)',
  'ds-bot': 'DS Bot'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isOnlineStatus(status: ConnectionStatus | undefined): boolean {
  return status === 'online' || status === 'busy' || status === 'attention'
}

export function indexBotsByAccount(bots: readonly Bot[]): Map<string, Bot[]> {
  const indexed = new Map<string, Bot[]>()
  for (const bot of bots) {
    for (const id of bot.accountIds) {
      const owners = indexed.get(id)
      if (owners) owners.push(bot)
      else indexed.set(id, [bot])
    }
  }
  return indexed
}

export function useDotStoredMeta(
  settingsTab: SettingsTab,
  accountCount: number,
  cleaning: RefObject<boolean>
) {
  const [dotMetaMap, setDotMetaMap] = useState<Record<string, DotStoredMeta>>({})
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const { settingsOpen, settingsTab } = useBotStore.getState()
    if (cleaning.current || !settingsOpen || (settingsTab !== 'overview' && settingsTab !== 'dot-accounts')) return
    const dot = getBridge()?.dot
    if (!dot?.rpc) return
    const request = ++requestId.current
    try {
      const res = await dot.rpc({ accountId: '_', op: 'listStoredAccounts' })
      const current = useBotStore.getState()
      if (!current.settingsOpen || current.settingsTab !== settingsTab || requestId.current !== request) return
      if (res.ok && Array.isArray(res.data)) {
        const map: Record<string, DotStoredMeta> = {}
        for (const item of res.data as DotStoredMeta[]) {
          if (item && typeof item.accountId === 'string') {
            map[item.accountId] = item
          }
        }
        setDotMetaMap(map)
      }
    } catch {
      /* ignore */
    }
  }, [cleaning])

  const invalidate = useCallback(() => {
    requestId.current++
  }, [])
  useLayoutEffect(() => invalidate, [invalidate, settingsTab])
  useEffect(() => {
    void refresh()
  }, [refresh, settingsTab, accountCount])

  return { dotMetaMap, refresh, invalidate, clear: () => setDotMetaMap({}) }
}

async function quickAddProxyAccount(
  platformId: 'meta-muse' | 'hark' | 'cue',
  baseName: string,
  { busy, setBusy }: SettingsActivity
) {
  if (busy) return
  setBusy(true)
  const { accounts, bots, addBot } = useBotStore.getState()
  const index = bots.filter((bot) => bot.platformId === platformId).length + 1
  const accountId = createId(platformId === 'cue' ? 'acc_cue' : 'acc')
  const name = platformId === 'cue' && index === 1 ? baseName : `${baseName} ${index}`
  try {
    const muse = getBridge()?.muse
    if (muse?.assignProxyPool) {
      const args = proxyPoolArgsForAccounts(accounts, [accountId])
      await muse.assignProxyPool(args.accountIds, keepMuseBatchProxyAssignments(args.keepIds)).catch(() => undefined)
    }
    addBot({
      id: createId('bot'),
      platformId,
      name,
      accounts: [{ key: accountId, accountId, displayName: name, handle: '' }],
      background: true
    })
    return accountId
  } finally {
    setBusy(false)
  }
}

type MuseProxyPool = Pick<ReturnType<typeof useProxyPool>, 'pool' | 'accountProxies' | 'refresh' | 'assignMuseProxies'>

function MuseAccountsSection({
  active, accounts: museAccounts, botsByAccountId, activity, proxyPool
}: AccountTabProps & { proxyPool: MuseProxyPool }) {
  const tr = useT()
  const { busy } = activity
  const { pool, accountProxies, refresh: refreshProxiesAndPool, assignMuseProxies } = proxyPool
  const [batchOpen, setBatchOpen] = useState(false)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const selectBot = useBotStore((s) => s.selectBot)
  const openMuseLogin = useBotStore((s) => s.openMuseLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)

  const handleQuickAddMuseAccount = async () => {
    const accountId = await quickAddProxyAccount('meta-muse', 'Muse', activity)
    if (!accountId) return
    void refreshProxiesAndPool()
    void openMuseLogin(accountId)
  }

  return (
    <>
      {active && (
        <div className="flex flex-col gap-5 animate-veil-in">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight text-ink">Muse 账号</h2>
              <p className="mt-1 text-[13px] text-ink-secondary">
                独立隔离多账号会话，支持批量导入与自动分配代理。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setBatchOpen(true)}>
                批量导入账号 (邮箱 | 收件箱)
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddMuseAccount()}>
                <Plus className="size-3.5" /> 新增 Muse 账号
              </Button>
            </div>
          </div>

          {/* Quick Summary Bar */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
              <p className="text-[12px] text-ink-muted">Muse 账号总数</p>
              <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{museAccounts.length}</p>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
              <p className="text-[12px] text-ink-muted">在线就绪</p>
              <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
                {museAccounts.filter((account) => isOnlineStatus(account.status)).length}
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
              <p className="text-[12px] text-ink-muted">已绑定独立代理</p>
              <p className="mt-1 flex items-baseline justify-between">
                <span className="text-[22px] font-semibold tabular-nums text-ink">
                  {Object.values(accountProxies).filter((p) => p && p.mode !== 'direct').length}
                </span>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true, 'proxy-pool')}
                  className="text-[12px] font-medium text-accent-600 hover:underline"
                >
                  {tr('Configure proxy pool')} →
                </button>
              </p>
            </div>
          </div>

          {/* Accounts List */}
          {museAccounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-12 text-center">
              <p className="text-[14px] font-medium text-ink">暂无 Muse 账号</p>
              <p className="max-w-md text-[12.5px] text-ink-muted">
                你可以先在「代理池与自动分配」导入一批代理，然后点击「批量导入账号」或「新增 Muse 账号」，系统会自动实现一号一代理。
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true, 'proxy-pool')}>
                  先导入代理池
                </Button>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => setBatchOpen(true)}>
                  批量导入 Muse 账号
                </Button>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
              <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                <span>账号与对应 Bot</span>
                <div className="flex items-center gap-2">
                  {pool.length > 0 && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void assignMuseProxies()}>
                      <Shuffle className="size-3.5" /> 一键按代理池重新一对一匹配
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void refreshProxiesAndPool()}>
                    <RefreshCw className="size-3.5" /> 刷新
                  </Button>
                </div>
              </div>
              <ul className="divide-y divide-line">
                {museAccounts.map((acc) => {
                  const ownerBot = botsByAccountId.get(acc.id)?.[0]
                  const px = accountProxies[acc.id]
                  const hasProxy = px && px.mode !== 'direct' && px.host && px.port
                  return (
                    <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                      <div className="flex min-w-0 items-center gap-3">
                        <BotAvatar
                          seed={ownerBot?.id ?? acc.id}
                          avatar={ownerBot?.avatar}
                          avatarShape={ownerBot?.avatarShape}
                          avatarColor={ownerBot?.avatarColor}
                          status={acc.status}
                          size="md"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-ink">
                              {ownerBot?.name || acc.displayName}
                            </span>
                            <StatusBadge status={acc.status} />
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                            <span className="font-mono text-[11px]">{acc.handle || acc.id}</span>
                            <span>·</span>
                            {hasProxy ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-accent-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent-600">
                                <Globe className="size-3" />
                                {px.mode}://{px.username ? `${px.username}@` : ''}
                                {px.host}:{px.port}
                              </span>
                            ) : (
                              <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-muted">
                                直连 (无代理)
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {ownerBot && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => selectBot(ownerBot.id)}
                          >
                            进入对话
                          </Button>
                        )}
                        {acc.status === 'offline' ? (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={acc.pending}
                            onClick={() => void openMuseLogin(acc.id)}
                          >
                            登录
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={acc.pending}
                            onClick={() => void connectAccount(acc.id)}
                          >
                            重连
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={acc.pending}
                          onClick={() => void signOutAccount(acc.id)}
                          title="退出登录"
                        >
                          <LogOut className="size-3.5" />
                        </Button>
                        {ownerBot && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeBot(ownerBot.id)}
                            title="删除该账号与 Bot"
                          >
                            <Trash2 className="size-3.5 text-status-error" />
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        title={t('Batch import Muse accounts')}
      >
        <MuseBatchImport
          onDone={() => {
            setBatchOpen(false)
            void refreshProxiesAndPool()
          }}
        />
      </Dialog>
    </>
  )
}

function DotAccountsSection({
  active, accounts: dotAccounts, botsByAccountId, activity, credentialRevision, dotMetaMap, refreshDotStoredMeta
}: AccountImportProps & { dotMetaMap: Record<string, DotStoredMeta>; refreshDotStoredMeta: () => Promise<void> }) {
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const openDotLogin = useBotStore((s) => s.openDotLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const renameBot = useBotStore((s) => s.renameBot)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const [dotRawInput, setDotRawInput] = useState('')
  const [dotRefreshInput, setDotRefreshInput] = useState('')
  const [dotTargetAccountId, setDotTargetAccountId] = useState<string>('__new__')
  const [dotMigrateMemory, setDotMigrateMemory] = useState(true)
  const dotInputRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    setDotRawInput('')
    setDotRefreshInput('')
    setDotTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddDotAccount = () => {
    const accountId = createId('acc_dot')
    const botId = createId('bot')
    const index = useBotStore.getState().bots.filter((bot) => bot.platformId === 'dot').length + 1
    addBot({
      id: botId,
      platformId: 'dot',
      name: `Dot ${index}`,
      emoji: '🪐',
      accounts: [{ key: accountId, accountId, displayName: `Dot ${index}`, handle: '' }],
      background: true
    })
    void openDotLogin(accountId)
  }

  const handleImportDotCredentials = async () => {
    const dot = getBridge()?.dot
    if (!dot?.importCredentials) return
    const raw = dotRawInput.trim()
    const rt = dotRefreshInput.trim()
    if (!raw && !rt) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = dotTargetAccountId === '__new__' || !accounts[dotTargetAccountId]

      // Support batch multi-line AT/RT or JSON array when creating new Dot Bots
      if (isNew && !rt) {
        let batchItems: string[] = []
        if (raw.startsWith('[')) {
          try {
            const arr = JSON.parse(raw) as unknown[]
            if (Array.isArray(arr) && arr.length > 1) {
              batchItems = arr.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
            }
          } catch {
            /* single payload */
          }
        } else if (!raw.startsWith('{')) {
          const lines = raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
          if (lines.length > 1) {
            batchItems = lines
          }
        }

        if (batchItems.length > 1) {
          let okCount = 0
          const importedNames: string[] = []
          for (const item of batchItems) {
            try {
              const accId = createId('acc_dot')
              const st = await dot.importCredentials({ accountId: accId, rawInput: item })
              const label = st.handle || st.displayName || accId
              addBot({
                id: `bot_${accId}`,
                platformId: 'dot',
                name: `Dot · ${label}`,
                emoji: '🪐',
                accounts: [{ key: accId, accountId: accId, displayName: label, handle: st.handle ?? label }],
                background: true
              })
              okCount++
              importedNames.push(label)
            } catch {
              /* continue remaining items */
            }
          }
          setDotRawInput('')
          await refreshDotStoredMeta()
          if (okCount === 0) {
            setError('批量导入未成功，请检查每行 AT / RT 或 JSON 格式是否正确')
          } else {
            setHint(`已批量导入 ${okCount} / ${batchItems.length} 个 Dot 账号：${importedNames.join('、')}`)
          }
          return
        }
      }

      const accountId = isNew ? createId('acc_dot') : dotTargetAccountId
      const st = await dot.importCredentials({
        accountId,
        rawInput: raw,
        refreshToken: rt || undefined,
        migrateDataFromAccountId: !isNew && dotMigrateMemory ? accountId : undefined
      })
      const label = st.handle || st.displayName || accountId
      if (isNew) {
        const botId = `bot_${accountId}`
        addBot({
          id: botId,
          platformId: 'dot',
          name: `Dot · ${label}`,
          emoji: '🪐',
          accounts: [
            {
              key: accountId,
              accountId,
              displayName: label,
              handle: st.handle ?? label
            }
          ],
          background: true
        })
      } else {
        renameAccount(accountId, label)
        const ownerBot = botsByAccountId.get(accountId)?.[0]
        if (ownerBot && ownerBot.name.startsWith('Dot')) {
          renameBot(ownerBot.id, `Dot · ${label}`)
        }
        await connectAccount(accountId)
      }
      setDotRawInput('')
      setDotRefreshInput('')
      setDotTargetAccountId('__new__')
      await refreshDotStoredMeta()
      const migratedMsg = st.migration
        ? `（已迁移目标 ${st.migration.goalCopied ? '✓' : '—'}、记忆 ${st.migration.memoriesCopied} 条）`
        : ''
      setHint(
        `已成功导入 Dot 账号：${label}${st.planType ? ` (${st.planType})` : ''} ${migratedMsg}`
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">ChatGPT Dot 账号</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            支持网页登录或导入凭据，自动加密保存与续期。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={handleQuickAddDotAccount}>
            <Plus className="size-3.5" /> 网页登录新增 Dot 账号
          </Button>
        </div>
      </div>

      {/* Quick Summary Bar */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
          <p className="text-[12px] text-ink-muted">Dot 账号总数</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{dotAccounts.length}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
          <p className="text-[12px] text-ink-muted">在线就绪</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
            {dotAccounts.filter((account) => isOnlineStatus(account.status)).length}
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
          <p className="text-[12px] text-ink-muted">RT 自动续期就绪</p>
          <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">
            {Object.values(dotMetaMap).filter((m) => m.hasRefreshToken).length}
            <span className="text-[13px] font-normal text-ink-muted"> / {dotAccounts.length}</span>
          </p>
        </div>
      </div>

      {/* AT / RT / JSON Single & Batch Import Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <KeyRound className="size-3.5 text-accent-600" />
            导入 ChatGPT AT / RT / JSON 凭据（支持多行批量导入）
          </span>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <span>导入目标：</span>
            <Select
              size="xs"
              variant="pill"
              value={dotTargetAccountId}
              onValueChange={(next) => setDotTargetAccountId(next)}
              className="max-w-64"
              options={[
                { value: '__new__', label: '+ 新建独立 Dot Bot（支持多行批量导入）' },
                ...dotAccounts.map((acc) => {
                  const ownerBot = botsByAccountId.get(acc.id)?.[0]
                  return {
                    value: acc.id,
                    label: `替换凭据：${ownerBot?.name || acc.displayName} (${acc.handle || acc.id})`
                  }
                })
              ]}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            ref={dotInputRef}
            value={dotRawInput}
            onChange={(e) => setDotRawInput(e.target.value)}
            placeholder="粘贴单条或多行（每行一个）ChatGPT access_token (eyJ...)、refresh_token (rt_...) 或 JSON (auth.json / JSON 数组)…"
            rows={3}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={dotRefreshInput}
              onChange={(e) => setDotRefreshInput(e.target.value)}
              placeholder="可选：单账号导入时单独填写 refresh_token (rt_...) 用于自动续期"
              className="h-8 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || (!dotRawInput.trim() && !dotRefreshInput.trim())}
              onClick={() => void handleImportDotCredentials()}
            >
              {busy
                ? '正在验证…'
                : dotTargetAccountId === '__new__'
                  ? '导入并创建 Dot Bot'
                  : '更新该 Bot 凭据'}
            </Button>
          </div>
          {dotTargetAccountId !== '__new__' && (
            <div className="mt-0.5 flex items-center justify-between gap-3 rounded-xl bg-main px-3 py-2 ring-1 ring-line/50 text-[12px] text-ink-secondary">
              <span>替换账号时自动迁移当前目标与记忆</span>
              <SwitchPill checked={dotMigrateMemory} onCheckedChange={setDotMigrateMemory} />
            </div>
          )}
        </div>
      </div>

      {/* Dot Accounts List */}
      {dotAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">暂无 Dot 账号</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">
            点击上方「网页登录新增 Dot 账号」或在上方卡片中粘贴 ChatGPT AT / RT 凭据即可创建 Dot Bot。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
            <span>Dot 账号与对应 Bot ({dotAccounts.length})</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                for (const acc of dotAccounts) {
                  void connectAccount(acc.id)
                }
                void refreshDotStoredMeta()
              }}
            >
              <RefreshCw className="size-3.5" /> 全部重连检验
            </Button>
          </div>
          <ul className="divide-y divide-line">
            {dotAccounts.map((acc) => {
              const ownerBot = botsByAccountId.get(acc.id)?.[0]
              const meta = dotMetaMap[acc.id]
              return (
                <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                  <div className="flex min-w-0 items-center gap-3">
                    <BotAvatar
                      seed={ownerBot?.id ?? acc.id}
                      avatar={ownerBot?.avatar}
                      avatarShape={ownerBot?.avatarShape}
                      avatarColor={ownerBot?.avatarColor}
                      emoji={ownerBot?.emoji ?? '🪐'}
                      platformId="dot"
                      status={acc.status}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">
                          {ownerBot?.name || acc.displayName}
                        </span>
                        <StatusBadge status={acc.status} />
                        {meta?.planType && (
                          <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[10.5px] uppercase text-ink-secondary">
                            {meta.planType}
                          </span>
                        )}
                        {meta?.hasRefreshToken ? (
                          <span className="rounded bg-status-online/10 px-1.5 py-0.5 text-[10.5px] font-medium text-status-online-ink">
                            RT 自动续期已开启
                          </span>
                        ) : (
                          <span className="rounded bg-sunken px-1.5 py-0.5 text-[10.5px] text-ink-muted">
                            仅 AT 会话
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                        <span className="font-mono text-[11px]">{acc.handle || meta?.handle || acc.id}</span>
                        {meta?.mode && (
                          <>
                            <span>·</span>
                            <span>{meta.mode === 'native' ? `Native (${meta.model || 'gpt-6-astra'})` : 'Calpico Room'}</span>
                          </>
                        )}
                        {acc.statusDetail && (
                          <>
                            <span>·</span>
                            <span className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                              {acc.statusDetail}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {ownerBot && (
                      <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>
                        进入对话
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={acc.pending}
                      onClick={() => void openDotLogin(acc.id)}
                    >
                      网页登录
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDotTargetAccountId(acc.id)
                        dotInputRef.current?.focus()
                      }}
                    >
                      替换 AT/RT
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void connectAccount(acc.id)}
                    >
                      重连
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void signOutAccount(acc.id)}
                      title="退出登录"
                    >
                      <LogOut className="size-3.5" />
                    </Button>
                    {ownerBot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeBot(ownerBot.id)}
                        title="删除该账号与 Bot"
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function GrokAccountsSection({
  active, accounts: grokAccounts, botsByAccountId, activity, credentialRevision
}: AccountImportProps) {
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const setGrokAccessToken = useBotStore((s) => s.setGrokAccessToken)
  const syncGrokAccountBots = useBotStore((s) => s.syncGrokAccountBots)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const [grokTokenInput, setGrokTokenInput] = useState('')
  const [grokRefreshInput, setGrokRefreshInput] = useState('')
  const [grokTargetAccountId, setGrokTargetAccountId] = useState<string>('__new__')

  useLayoutEffect(() => {
    setGrokTokenInput('')
    setGrokRefreshInput('')
    setGrokTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddGrokAccount = (openInBrowser = false) => {
    // Explicitly adding an account always starts a fresh login partition.
    const accountId = createId('acc')
    const botId = createId('bot')
    addBot({
      id: botId,
      platformId: 'grok',
      name: 'Grok Bot',
      accounts: [{ key: accountId, accountId, displayName: 'Grok Bot', handle: '' }],
      background: true
    })
    void openGrokLogin(accountId, openInBrowser)
  }

  const handleImportGrokToken = async () => {
    const token = grokTokenInput.trim()
    const rt = grokRefreshInput.trim() || undefined
    if (!token) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = grokTargetAccountId === '__new__' || !accounts[grokTargetAccountId]
      const accountId = isNew ? createId('acc') : grokTargetAccountId
      await setGrokAccessToken(accountId, token, undefined, undefined, rt)
      const latestAcc = useBotStore.getState().accounts[accountId]
      if (latestAcc?.status === 'error') {
        setError(latestAcc.statusDetail || '凭据无效或已过期，请检查后重试')
        return
      }
      const totalBots = await syncGrokAccountBots(accountId, {
        includeDismissed: true,
        selectFirst: isNew
      })
      setGrokTokenInput('')
      setGrokRefreshInput('')
      setGrokTargetAccountId('__new__')
      setHint(
        isNew
          ? `已接入 Grok 账号，自动同步 ${totalBots} 个 Bot 到左侧列表`
          : `已更新凭据并同步 ${totalBots} 个 Bot`
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Grok Bot 账号管理</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            一个 Grok 账号下可包含多个 Bot，登录后会自动按 Bot 展开在左侧对话列表中。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => handleQuickAddGrokAccount(false)}>
            <Plus className="size-3.5" /> 登录窗口添加账号
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleQuickAddGrokAccount(true)}>
            <Globe className="size-3.5" /> 默认浏览器授权
          </Button>
        </div>
      </div>

      {/* Credential Import Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">粘贴凭据导入（Token / Cookie / JSON / API Key）</span>
          <Select
            size="xs"
            variant="pill"
            value={grokTargetAccountId}
            onValueChange={(next) => setGrokTargetAccountId(next)}
            className="max-w-64"
            options={[
              { value: '__new__', label: '+ 接入新 Grok 账号（自动同步全部 Bot）' },
              ...grokAccounts.map((acc) => ({
                value: acc.id,
                label: `更新凭据：${acc.handle || acc.displayName || acc.id}`
              }))
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            value={grokTokenInput}
            onChange={(e) => setGrokTokenInput(e.target.value)}
            placeholder="粘贴 Access Token (eyJ...)、Cookie (WorkosCursorSessionToken=...)、JSON 或 API Key…"
            rows={2}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex gap-2">
            <input
              value={grokRefreshInput}
              onChange={(e) => setGrokRefreshInput(e.target.value)}
              placeholder="可选：填写 Refresh Token 用于自动续期"
              className="h-8 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none focus:border-accent-600"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !grokTokenInput.trim()}
              onClick={() => void handleImportGrokToken()}
            >
              {busy ? '验证中…' : grokTargetAccountId === '__new__' ? '导入并同步 Bot' : '更新凭据'}
            </Button>
          </div>
        </div>
      </div>

      {/* Grok Accounts List */}
      {grokAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">暂无 Grok Bot 账号</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">
            点击上方「登录窗口添加账号」或粘贴凭据，即可将账号下的全部 Bot 同步到左侧列表。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {grokAccounts.map((acc) => {
              const accountBots = (botsByAccountId.get(acc.id) ?? []).filter((b) => b.platformId === 'grok')
              const ownerBot = accountBots[0]
              return (
                <li key={acc.id} className="flex flex-col gap-2.5 px-4 py-3.5 hover:bg-hover/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <BotAvatar
                        seed={ownerBot?.id ?? acc.id}
                        avatar={ownerBot?.avatar}
                        avatarShape={ownerBot?.avatarShape}
                        avatarColor={ownerBot?.avatarColor}
                        platformId="grok"
                        status={acc.status}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {acc.handle || acc.displayName || 'Grok Bot 账号'}
                          </span>
                          <StatusBadge status={acc.status} />
                          <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary">
                            {accountBots.length} 个 Bot
                          </span>
                        </div>
                        {acc.statusDetail && (
                          <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                            {acc.statusDetail}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={acc.pending}
                        onClick={() => void openGrokLogin(acc.id, false)}
                      >
                        登录窗口
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={acc.pending}
                        onClick={() => void openGrokLogin(acc.id, true)}
                      >
                        浏览器授权
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending || busy}
                        onClick={() => {
                          void connectAccount(acc.id).then(() =>
                            syncGrokAccountBots(acc.id, { includeDismissed: true })
                          )
                        }}
                      >
                        同步全部 Bot
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending}
                        onClick={() => void signOutAccount(acc.id)}
                        title="退出登录"
                      >
                        <LogOut className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          for (const b of accountBots) {
                            await removeBot(b.id)
                          }
                        }}
                        title="移除该账号及名下全部 Bot"
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    </div>
                  </div>

                  {accountBots.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pl-12">
                      {accountBots.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => selectBot(b.id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1 text-[12px] text-ink transition-colors hover:border-line-strong hover:bg-hover"
                        >
                          <BotAvatar
                            seed={b.id}
                            avatar={b.avatar}
                            avatarShape={b.avatarShape}
                            avatarColor={b.avatarColor}
                            platformId="grok"
                            size="xs"
                          />
                          <span className="max-w-[160px] truncate">{b.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function HarkAccountsSection({
  active, accounts: harkAccounts, botsByAccountId, activity, credentialRevision
}: AccountImportProps) {
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const openHarkLogin = useBotStore((s) => s.openHarkLogin)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const [harkRawInput, setHarkRawInput] = useState('')
  const [harkTargetAccountId, setHarkTargetAccountId] = useState<string>('__new__')

  useLayoutEffect(() => {
    setHarkRawInput('')
    setHarkTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddHarkAccount = async () => {
    const accountId = await quickAddProxyAccount('hark', 'Hark', activity)
    if (accountId) void openHarkLogin(accountId)
  }

  const handleImportHarkCredentials = async () => {
    const hark = getBridge()?.hark
    if (!hark?.importCredentials || !harkRawInput.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = harkTargetAccountId === '__new__' || !accounts[harkTargetAccountId]
      const targetId = isNew ? createId('acc_hark') : harkTargetAccountId
      const st = await importHarkCredentialsForAccount(hark, targetId, harkRawInput)
      const botCount = useBotStore.getState().bots.filter((bot) => bot.platformId === 'hark').length
      const label = st.displayName || st.handle || `Hark ${botCount + 1}`
      if (isNew) {
        addBot({
          id: `bot_${targetId}`,
          platformId: 'hark',
          name: `Hark · ${label}`,
          emoji: '✨',
          accounts: [{ key: targetId, accountId: targetId, displayName: label, handle: st.handle ?? '' }],
          background: true
        })
      } else {
        renameAccount(targetId, label)
        await connectAccount(targetId)
      }
      setHarkRawInput('')
      setHarkTargetAccountId('__new__')
      setHint(`已成功导入 Hark 账号：${label} (${st.handle || targetId}) 并同步对话历史`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Hark 账号</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            支持内置窗口登录或直接粘贴会话凭据接入。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddHarkAccount()}>
            <Plus className="size-3.5" /> 网页登录新增 Hark 账号
          </Button>
        </div>
      </div>

      {/* Hark Cookie / Token Import Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">导入 Hark Session Cookie / Token</span>
          <Select
            size="xs"
            variant="pill"
            value={harkTargetAccountId}
            onValueChange={(next) => setHarkTargetAccountId(next)}
            className="max-w-64"
            options={[
              { value: '__new__', label: '+ 新建独立 Hark Bot' },
              ...harkAccounts.map((acc) => {
                const ownerBot = botsByAccountId.get(acc.id)?.[0]
                return {
                  value: acc.id,
                  label: `更新会话：${ownerBot?.name || acc.displayName} (${acc.handle || acc.id})`
                }
              })
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            value={harkRawInput}
            onChange={(e) => setHarkRawInput(e.target.value)}
            placeholder="粘贴 Hark Cookie 字符串（如 __Secure-hark.session_token=...）、JSON Cookie 数组或原始 Session Token…"
            rows={2}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !harkRawInput.trim()}
              onClick={() => void handleImportHarkCredentials()}
            >
              {busy
                ? '正在验证会话…'
                : harkTargetAccountId === '__new__'
                  ? '导入并新建 Hark Bot'
                  : '更新该账号会话'}
            </Button>
          </div>
        </div>
      </div>

      {harkAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">暂无 Hark 账号</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">
            点击上方「网页登录新增 Hark 账号」或在卡片中粘贴 Cookie / Session Token 即可接入。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {harkAccounts.map((acc) => {
              const ownerBot = botsByAccountId.get(acc.id)?.[0]
              return (
                <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                  <div className="flex min-w-0 items-center gap-3">
                    <BotAvatar
                      seed={ownerBot?.id ?? acc.id}
                      avatar={ownerBot?.avatar}
                      avatarShape={ownerBot?.avatarShape}
                      avatarColor={ownerBot?.avatarColor}
                      status={acc.status}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">
                          {ownerBot?.name || acc.displayName}
                        </span>
                        <StatusBadge status={acc.status} />
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                        {acc.handle || acc.id}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {ownerBot && (
                      <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>
                        进入对话
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={acc.pending}
                      onClick={() => void openHarkLogin(acc.id)}
                    >
                      登录窗口
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void connectAccount(acc.id)}
                    >
                      刷新会话
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={acc.pending}
                      onClick={() => void signOutAccount(acc.id)}
                      title="退出登录"
                    >
                      <LogOut className="size-3.5" />
                    </Button>
                    {ownerBot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeBot(ownerBot.id)}
                        title="删除"
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function AntigravityAccountsSection({ accounts: antigravityAccounts, botsByAccountId }: AccountListProps) {
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">
            Antigravity 账号
          </h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            独立隔离登录 Google Antigravity，支持多账号、模型切换与流式对话。
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => useBotStore.getState().setAddBotOpen(true, 'antigravity')}
        >
          添加 Antigravity 账号
        </Button>
      </div>

      {antigravityAccounts.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <p className="text-[13.5px] font-medium text-ink">尚未添加 Google Antigravity 账号</p>
          <p className="mt-1 text-[12px] text-ink-muted">
            点击右上角「添加 Antigravity 账号」，在弹出的安全登录窗口完成 Google 登录即可。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {antigravityAccounts.map((acc) => {
              const bot = botsByAccountId.get(acc.id)?.find((b) => b.platformId === 'antigravity')
              const online = isOnlineStatus(acc.status)
              return (
                <li
                  key={acc.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-ink">
                        {bot?.name || acc.displayName}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          online
                            ? 'bg-status-online/15 text-status-online-ink'
                            : 'bg-sunken text-ink-muted'
                        )}
                      >
                        {online ? '在线' : '离线'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-muted">
                      {acc.handle || acc.id}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void useBotStore.getState().openAntigravityLogin(acc.id)}
                    >
                      {online ? '重新登录' : '登录'}
                    </Button>
                    {bot && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          useBotStore.getState().selectBot(bot.id)
                          setSettingsOpen(false)
                        }}
                      >
                        打开对话
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function CueAccountsSection({
  active, accounts: cueAccounts, botsByAccountId, activity, credentialRevision
}: AccountImportProps) {
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const selectBot = useBotStore((s) => s.selectBot)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const importCueCredentials = useBotStore((s) => s.importCueCredentials)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const [cueCredentialInput, setCueCredentialInput] = useState('')
  const [cueTargetAccountId, setCueTargetAccountId] = useState('__new__')

  useLayoutEffect(() => {
    setCueCredentialInput('')
    setCueTargetAccountId('__new__')
  }, [credentialRevision])

  if (!active) return null

  const handleQuickAddCueAccount = async (openInBrowser = false) => {
    const accountId = await quickAddProxyAccount('cue', 'Cue', activity)
    if (accountId) void openCueLogin(accountId, openInBrowser)
  }


  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Cue 账号</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            独立隔离登录 Cue（cue.im），通过 Cue 桌面端原生协议同步各 Agent 与历史消息并直连流式对话；亦可选填 Manus API Key（sk-...）。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddCueAccount(false)}>
            <Plus className="size-3.5" /> 网页登录新增 Cue 账号
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleQuickAddCueAccount(true)}>
            <Globe className="size-3.5" /> 系统浏览器登录
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-ink">导入 Cue 会话 Cookie / Token / 凭据（可选）</span>
          <Select
            size="xs"
            variant="pill"
            value={cueTargetAccountId}
            onValueChange={(next) => setCueTargetAccountId(next)}
            className="max-w-64"
            options={[
              { value: '__new__', label: '+ 新建独立 Cue 账号' },
              ...cueAccounts.map((acc) => ({
                value: acc.id,
                label: `更新会话：${acc.handle || acc.displayName || acc.id}`
              }))
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Cue 会话凭据"
            value={cueCredentialInput}
            onChange={(e) => setCueCredentialInput(e.target.value)}
            placeholder="粘贴 Manus API Key（sk-...）、Cue Cookie（cue_session_id=...）或 Bearer Token (eyJ...)…"
            rows={2}
            spellCheck={false}
            className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !cueCredentialInput.trim()}
              onClick={async () => {
                setBusy(true)
                setError(undefined)
                setHint(undefined)
                try {
                  const isNew = cueTargetAccountId === '__new__' || !accounts[cueTargetAccountId]
                  const targetId = isNew ? createId('acc_cue') : cueTargetAccountId
                  await importCueCredentials(targetId, cueCredentialInput.trim())
                  setCueCredentialInput('')
                  setCueTargetAccountId('__new__')
                  setHint(isNew ? '已导入并新建 Cue 账号，可在侧栏进入会话' : '已更新 Cue 账号会话')
                } catch (err) {
                  setError(errorMessage(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? '正在验证会话…' : cueTargetAccountId === '__new__' ? '导入并新建 Cue Bot' : '更新该账号会话'}
            </Button>
          </div>
        </div>
      </div>

      {cueAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
          <p className="text-[14px] font-medium text-ink">暂无 Cue 账号</p>
          <p className="max-w-md text-[12.5px] text-ink-muted">
            点击上方「网页登录新增 Cue 账号」在内置隔离窗口登录，或在卡片中粘贴 Cookie / Token 即可接入。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
          <ul className="divide-y divide-line">
            {cueAccounts.map((acc) => {
              const accountBots = (botsByAccountId.get(acc.id) ?? []).filter((b) => b.platformId === 'cue')
              const ownerBot = accountBots[0]
              return (
                <li key={acc.id} className="flex flex-col gap-2.5 px-4 py-3.5 hover:bg-hover/30">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <BotAvatar
                        seed={ownerBot?.id ?? acc.id}
                        platformId="cue"
                        status={acc.status}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {ownerBot?.name || acc.handle || acc.displayName || 'Cue 账号'}
                          </span>
                          <StatusBadge status={acc.status} />
                          <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary">
                            {accountBots.length} 个 Bot
                          </span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                          {acc.handle || acc.id}
                        </p>
                        {acc.statusDetail && (
                          <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                            {acc.statusDetail}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {ownerBot && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            selectBot(ownerBot.id)
                            setSettingsOpen(false)
                          }}
                        >
                          进入对话
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={acc.pending || busy}
                        onClick={() => void openCueLogin(acc.id, false)}
                      >
                        登录窗口
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending || busy}
                        onClick={() => void connectAccount(acc.id)}
                      >
                        刷新会话
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending || busy}
                        onClick={() => void syncCueAccountBots(acc.id)}
                      >
                        同步 Bot
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={acc.pending}
                        onClick={() => void signOutAccount(acc.id)}
                        title="退出登录"
                      >
                        <LogOut className="size-3.5" />
                      </Button>
                      {ownerBot && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeBot(ownerBot.id)}
                          title="删除"
                        >
                          <Trash2 className="size-3.5 text-status-error" />
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

interface PlatformAccountsSectionProps {
  tab: SettingsTab
  accountsByPlatform: ReadonlyMap<PlatformId, BotAccount[]>
  botsByAccountId: ReadonlyMap<string, Bot[]>
  activity: SettingsActivity
  credentialRevision: number
  proxyPool: MuseProxyPool
  dot: Pick<ReturnType<typeof useDotStoredMeta>, 'dotMetaMap' | 'refresh'>
}

export function PlatformAccountsSection({
  tab, accountsByPlatform, botsByAccountId, activity, credentialRevision, proxyPool, dot
}: PlatformAccountsSectionProps) {
  const importProps = { botsByAccountId, activity, credentialRevision }

  // Keep import drafts across tab switches while only rendering the active account panel.
  return (
    <>
      <MuseAccountsSection
        active={tab === 'muse-accounts'}
        accounts={accountsByPlatform.get('meta-muse') ?? EMPTY_ACCOUNTS}
        botsByAccountId={botsByAccountId}
        activity={activity}
        proxyPool={proxyPool}
      />
      <DotAccountsSection
        {...importProps}
        active={tab === 'dot-accounts'}
        accounts={accountsByPlatform.get('dot') ?? EMPTY_ACCOUNTS}
        dotMetaMap={dot.dotMetaMap}
        refreshDotStoredMeta={dot.refresh}
      />
      <GrokAccountsSection
        {...importProps}
        active={tab === 'grok-accounts'}
        accounts={accountsByPlatform.get('grok') ?? EMPTY_ACCOUNTS}
      />
      <HarkAccountsSection
        {...importProps}
        active={tab === 'hark-accounts'}
        accounts={accountsByPlatform.get('hark') ?? EMPTY_ACCOUNTS}
      />
      {tab === 'antigravity-accounts' && (
        <AntigravityAccountsSection
          accounts={accountsByPlatform.get('antigravity') ?? EMPTY_ACCOUNTS}
          botsByAccountId={botsByAccountId}
        />
      )}
      <CueAccountsSection
        {...importProps}
        active={tab === 'cue-accounts'}
        accounts={accountsByPlatform.get('cue') ?? EMPTY_ACCOUNTS}
      />
    </>
  )
}
