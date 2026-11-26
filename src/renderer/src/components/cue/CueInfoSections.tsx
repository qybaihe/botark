import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Cpu, ExternalLink, FileText, Globe, Link2, RefreshCw, Sparkles } from 'lucide-react'
import type { CueAuthStatus, CueRpcRequest } from '@shared/ipc'
import { asObj } from '@shared/parse'
import { EmptyLine, Section } from '@/components/info/Section'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { cleanSidebarError, isOnlineAccountStatus } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'

const EMPTY_LIST: unknown[] = []
const cueReads = new Map<string, Promise<unknown>>()

function readOnce<T>(key: readonly unknown[], load: () => Promise<T>): Promise<T> {
  const serialized = JSON.stringify(key)
  const existing = cueReads.get(serialized)
  if (existing) return existing as Promise<T>
  const request = Promise.resolve().then(load).finally(() => cueReads.delete(serialized))
  cueReads.set(serialized, request)
  return request
}

function readCueRpc(request: CueRpcRequest) {
  const cue = getBridge()?.cue
  if (!cue?.rpc) return Promise.reject(new Error('Cue IPC unavailable'))
  return readOnce(['rpc', request], () => cue.rpc(request))
}

interface CueQuotaSnapshot {
  limitCredits: number | null
  weeklyRemainingCredits: number | null
  purchasedRemainingCredits: number | null
  remainingPercent: number | null
  quotaUnavailable?: boolean
}

interface CueAgentMeta {
  id: string
  name: string
  isManus?: boolean
  email?: string
  phoneNumber?: string
  pcId?: string
  sessionId?: string
  lastDisplayMessage?: string
}

function readOptionalStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

async function callCueEndpoint(
  accountId: string,
  path: string,
  body: unknown = {},
  method: 'GET' | 'POST' = 'POST'
): Promise<unknown> {
  const res = await readCueRpc({ accountId, op: 'call', path, method, body })
  if (!res.ok) throw new Error(res.message || `HTTP ${res.status}`)
  return res.data
}

function readCueQuota(raw: unknown): CueQuotaSnapshot | null {
  const r = asObj(raw)
  if (!r) return null
  return {
    limitCredits: typeof r['limitCredits'] === 'number' ? r['limitCredits'] : null,
    weeklyRemainingCredits:
      typeof r['weeklyRemainingCredits'] === 'number' ? r['weeklyRemainingCredits'] : null,
    purchasedRemainingCredits:
      typeof r['purchasedRemainingCredits'] === 'number' ? r['purchasedRemainingCredits'] : null,
    remainingPercent: typeof r['remainingPercent'] === 'number' ? r['remainingPercent'] : null,
    quotaUnavailable: r['quotaUnavailable'] === true
  }
}

function parseCueAgentList(raw: unknown): CueAgentMeta[] {
  const list = Array.isArray(raw)
    ? raw
    : asObj(raw) && Array.isArray(asObj(raw)!['agents'])
      ? (asObj(raw)!['agents'] as unknown[])
      : []
  const items: CueAgentMeta[] = []
  for (const entry of list) {
    const r = asObj(entry)
    if (!r) continue
    const id = readOptionalStr(r['id'] ?? r['agentId'])
    const name = readOptionalStr(r['name'] ?? r['title'])
    if (!id || !name || id === 'agent-default' || id.startsWith('cue_default_')) continue
    const email = readOptionalStr(r['email'])
    const phoneNumber = readOptionalStr(r['phoneNumber'] ?? r['phone_number'])
    const pcId = readOptionalStr(r['pcId'] ?? r['pc_id'])
    const sessionId = readOptionalStr(r['sessionId'] ?? r['sessionUid'] ?? r['session_uid'])
    const lastDisplayMessage = readOptionalStr(
      r['lastDisplayMessage'] ?? r['last_display_message']
    )
    items.push({
      id,
      name,
      ...(typeof r['isManus'] === 'boolean' ? { isManus: r['isManus'] } : {}),
      ...(email ? { email } : {}),
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(pcId ? { pcId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(lastDisplayMessage ? { lastDisplayMessage } : {})
    })
  }
  return items
}

function pickCueAgentMeta(raw: unknown, selectedAgentId?: string): CueAgentMeta | null {
  const items = parseCueAgentList(raw)
  if (items.length === 0) return null
  if (selectedAgentId) {
    return items.find((item) => item.id === selectedAgentId) ?? null
  }
  return items[0] ?? null
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Shared loader hook for secondary Cue right-sidebar inspector sections.
 * Silently swallows unavailable/retired upstream RPCs via `cleanSidebarError`.
 */
function useCueSectionLoader<T>(
  accountId: string | undefined,
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  fallback: T,
  loadOffline = false
) {
  const isOnline = useBotStore((s) => isOnlineAccountStatus(accountId ? s.accounts[accountId]?.status : undefined))
  const key = JSON.stringify([accountId, ...deps, isOnline])
  const scope = useMemo(() => ({ key }), [key])
  const current = useRef(scope)
  current.current = scope
  const inFlight = useRef<{ scope: typeof scope; promise: Promise<void> } | undefined>(undefined)
  const [result, setResult] = useState<{ scope: typeof scope; data?: T; loading: boolean; error?: string }>()

  const refresh = useCallback(() => {
    if (current.current !== scope) return Promise.resolve()
    if (inFlight.current?.scope === scope) return inFlight.current.promise
    setResult((previous) => ({ scope, data: previous?.scope === scope ? previous.data : undefined, loading: true }))
    const promise = Promise.resolve().then(loader).then((data) => {
      if (current.current === scope) setResult({ scope, data, loading: false })
    }, (error: unknown) => {
      if (current.current === scope) {
        setResult((previous) => ({ scope, data: previous?.data, error: cleanSidebarError(error), loading: false }))
      }
    }).finally(() => {
      if (inFlight.current?.scope === scope) inFlight.current = undefined
    })
    inFlight.current = { scope, promise }
    return promise
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  useEffect(() => {
    if (isOnline || loadOffline) void refresh()
  }, [refresh, isOnline, loadOffline])

  const visible = result?.scope === scope ? result : undefined
  return { data: visible?.data ?? fallback, loading: visible?.loading ?? false, error: visible?.error, refresh, isOnline }
}

function useCueAuthKind(accountId: string | undefined): CueAuthStatus['authKind'] | undefined {
  const { data } = useCueSectionLoader<CueAuthStatus['authKind'] | undefined>(
    accountId,
    async () => {
      const cue = getBridge()?.cue
      if (!cue?.authStatus || !accountId) return undefined
      const st = await readOnce(['authStatus', accountId], () => cue.authStatus(accountId)).catch(() => null)
      return st?.authKind
    },
    [],
    undefined,
    true
  )
  return data
}

/**
 * 1. Cue Account Auth & Credential Import Card (parity with `GrokAccountAuthSection`).
 */
export function CueAccountAuthSection({ accountId }: { accountId: string }) {
  const account = useBotStore((s) => s.accounts[accountId])
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const importCueCredentials = useBotStore((s) => s.importCueCredentials)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const botCount = useBotStore(
    (s) => s.bots.filter((b) => b.platformId === 'cue' && b.accountIds.includes(accountId)).length
  )

  const [showPaste, setShowPaste] = useState(false)
  const [rawCred, setRawCred] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [hint, setHint] = useState<string>()

  const isOnline = isOnlineAccountStatus(account?.status)

  const handleImport = async () => {
    if (!rawCred.trim()) return
    setBusy(true)
    setErr(undefined)
    setHint(undefined)
    try {
      await importCueCredentials(accountId, rawCred.trim())
      const latest = useBotStore.getState().accounts[accountId]
      if (latest?.status === 'error') {
        setErr(latest.statusDetail || '凭据验证失败')
        return
      }
      setRawCred('')
      setShowPaste(false)
      setHint('凭据已生效，已自动同步 Cue Agent')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSyncAll = async () => {
    setBusy(true)
    setErr(undefined)
    setHint(undefined)
    try {
      const total = await syncCueAccountBots(accountId)
      setHint(`已同步 ${total} 个 Agent 到左侧列表`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (isOnline && !showPaste && !hint && !err) {
    return (
      <Section
        title="Cue 账号"
        action={
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleSyncAll()}>
            同步全部 Agent ({botCount})
          </Button>
        }
      >
        <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-secondary">
          <span className="truncate font-mono text-[11.5px] text-ink">
            {account?.handle || account?.displayName || '已连接'}
          </span>
          <button
            type="button"
            onClick={() => setShowPaste(true)}
            className="shrink-0 text-[11.5px] text-ink-muted hover:text-ink"
          >
            更换凭据
          </button>
        </div>
      </Section>
    )
  }

  return (
    <Section title="Cue 账号登录与导入">
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || account?.pending}
            onClick={() => void openCueLogin(accountId, false)}
          >
            登录窗口
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || account?.pending}
            onClick={() => void openCueLogin(accountId, true)}
          >
            默认浏览器授权
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setShowPaste((v) => !v)}
          >
            {showPaste ? '收起' : '粘贴凭据'}
          </Button>
        </div>

        {(showPaste || !isOnline) && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <textarea
              value={rawCred}
              onChange={(e) => setRawCred(e.target.value)}
              placeholder="粘贴 Bearer JWT、Cookie (cue_session_id=...)、JSON 或 API Key…"
              rows={2}
              spellCheck={false}
              className="block w-full resize-none rounded-lg border border-line bg-surface p-2 font-mono text-[11.5px] text-ink outline-none focus:border-accent-600"
            />
            {rawCred.trim() && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !rawCred.trim()}
                  onClick={() => void handleImport()}
                >
                  {busy ? '导入中…' : '导入并同步'}
                </Button>
              </div>
            )}
          </div>
        )}

        {account?.status === 'error' && account.statusDetail && !err && (
          <p className="text-[12px] text-status-error">{account.statusDetail}</p>
        )}
        {err && <p className="text-[12px] text-status-error">{err}</p>}
        {hint && <p className="text-[12px] text-status-online-ink">{hint}</p>}
      </div>
    </Section>
  )
}

/**
 * 2. Overview Card: Server-side Cue Agent identity, quota & sync.
 */
export function CueOverviewSection({ bot, account }: { bot: Bot; account?: BotAccount }) {
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const openWebSessionAt = useBotStore((s) => s.openWebSessionAt)

  const [syncing, setSyncing] = useState(false)

  const accountId = account?.id
  const connected = isOnlineAccountStatus(account?.status)
  const selectedAgentId = bot.selectedAgentId

  const { data: { authStatus, quota, agentMeta }, refresh: refreshCueInfo } = useCueSectionLoader<{
    authStatus?: CueAuthStatus | null; quota?: CueQuotaSnapshot | null; agentMeta?: CueAgentMeta | null
  }>(
    accountId,
    async () => {
      const cue = getBridge()?.cue
      if (!cue || !accountId) return {}
      const [st, qRes, aRes] = await Promise.all([
        readOnce(['authStatus', accountId], () => cue.authStatus(accountId)).catch(() => null),
        connected ? readCueRpc({ accountId, op: 'quota' }).catch(() => null) : null,
        connected ? readCueRpc({ accountId, op: 'listAgents' }).catch(() => null) : null
      ])
      return {
        authStatus: st,
        quota: qRes?.ok ? readCueQuota(qRes.data) : null,
        agentMeta: aRes?.ok ? pickCueAgentMeta(aRes.data, selectedAgentId) : null
      }
    },
    [bot.activeSessionId, selectedAgentId, connected],
    {},
    true
  )

  if (!account) return null

  const isApiKey = authStatus?.authKind === 'api-key'
  const hasCreditNumbers =
    quota &&
    (quota.limitCredits !== null ||
      quota.weeklyRemainingCredits !== null ||
      quota.purchasedRemainingCredits !== null)
  const displaySessionId = agentMeta?.sessionId || bot.activeSessionId

  return (
    <div className="mx-4 mt-3 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-hairline">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent-600" />
          <span className="text-[13px] font-semibold text-ink">
            {agentMeta ? agentMeta.name : 'Cue Agent 概览'}
          </span>
        </div>
        <StatusBadge status={account.status} />
      </div>
      <div className="flex flex-col gap-1 text-[12px] text-ink-secondary">
        {agentMeta && (
          <p>
            Cue 服务端 Agent：<span className="font-medium text-ink">{agentMeta.name}</span>
            {agentMeta.isManus === true
              ? '（Cue 内置默认 Agent）'
              : agentMeta.isManus === false
                ? '（Cue 自定义 Agent）'
                : ''}
          </p>
        )}
        {bot.selectedAgentId && (
          <p className="break-all">
            Agent ID：<span className="font-mono text-[11px] text-ink">{bot.selectedAgentId}</span>
          </p>
        )}
        {(agentMeta?.email || agentMeta?.phoneNumber) && (
          <p className="break-all">
            专属联络：
            <span className="font-medium text-ink">
              {[agentMeta.email, agentMeta.phoneNumber].filter(Boolean).join(' · ')}
            </span>
          </p>
        )}
        {displaySessionId && (
          <p className="break-all">
            会话 ID：<span className="font-mono text-[11px] text-ink">{displaySessionId}</span>
          </p>
        )}
        {agentMeta?.lastDisplayMessage && (
          <p className="line-clamp-1" title={agentMeta.lastDisplayMessage}>
            最近摘要：<span className="text-ink">{agentMeta.lastDisplayMessage}</span>
          </p>
        )}
        {isApiKey && (
          <p className="text-[11.5px] text-ink-muted">当前凭据为 Manus API Key（消耗 API 积分）</p>
        )}
        {!isApiKey && hasCreditNumbers && quota && (
          <p>
            Cue 周期剩余额度：
            <span className="font-medium text-ink">
              {quota.weeklyRemainingCredits ?? '—'}
              {quota.limitCredits !== null ? ` / ${quota.limitCredits}` : ''}
              {quota.remainingPercent !== null ? ` (${quota.remainingPercent}%)` : ''}
            </span>
            {quota.purchasedRemainingCredits !== null
              ? ` · 已购余额 ${quota.purchasedRemainingCredits}`
              : ''}
          </p>
        )}
      </div>
      {account.statusDetail && (
        <p className="text-[11.5px] text-status-error">{account.statusDetail}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={syncing}
          onClick={() => {
            setSyncing(true)
            void Promise.all([syncCueAccountBots(account.id), refreshCueInfo()]).finally(() =>
              setSyncing(false)
            )
          }}
        >
          <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />
          同步 Agent
        </Button>
        {!isApiKey && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openWebSessionAt(null)}
          >
            <Globe className="size-3.5" />
            内置网页视图
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 3. Sessions & Full History Control (parity with `GrokSessionsSection`).
 */
export function CueSessionsSection({ accountId, bot }: { accountId: string; bot: Bot }) {
  const hydrateCueBotHistory = useBotStore((s) => s.hydrateCueBotHistory)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const messageCount = useBotStore((s) => s.messages[bot.id]?.length ?? 0)
  const lastMessage = useBotStore((s) => {
    const list = s.messages[bot.id] ?? EMPTY_LIST
    return list.length > 0 ? (list[list.length - 1] as { text?: string }) : undefined
  })

  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()

  const pullAllHistory = async () => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      await syncCueAccountBots(accountId)
      const fetched = await hydrateCueBotHistory(bot.id)
      const total = useBotStore.getState().messages[bot.id]?.length ?? messageCount
      setHint(fetched > 0 ? `已拉取并合并 ${fetched} 条历史记录（当前共 ${total} 条）` : `已同步（当前共 ${total} 条记录）`)
    } catch (err) {
      setError(cleanSidebarError(err) || '拉取历史消息失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="会话与控制"
      count={messageCount || undefined}
      action={<RefreshButton loading={busy} onClick={() => void pullAllHistory()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-ink-secondary">{hint}</p>}
        <div className="flex items-center justify-between gap-2 text-ink-secondary">
          <span className="truncate font-mono text-[11px]">
            {bot.activeSessionId || '待同步会话 UID'}
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void pullAllHistory()}>
            拉取全部历史
          </Button>
        </div>
        {lastMessage?.text && (
          <p className="line-clamp-2 rounded-md bg-muted/40 px-2 py-1 text-[11.5px] text-ink-muted">
            {lastMessage.text}
          </p>
        )}
      </div>
    </Section>
  )
}

/**
 * 4. Scheduled Tasks / Automations (parity with `GrokAutomationsSection`).
 */
export function CueAutomationsSection({ accountId }: { accountId: string }) {
  const authKind = useCueAuthKind(accountId)
  const isApiKey = authKind === 'api-key'
  const { data: tasks, loading, error, refresh } = useCueSectionLoader<
    Array<{ id: string; name: string; schedule: string; enabled: boolean }>
  >(
    accountId,
    async () => {
      if (isApiKey) return []
      const raw = await callCueEndpoint(accountId, '/session.v1.SessionService/ListScheduledTasks', {
        page: 1,
        pageSize: 50
      })
      const obj = asObj(raw)
      const list = Array.isArray(obj?.['tasks']) ? (obj!['tasks'] as unknown[]) : []
      return list
        .map((entry, idx) => {
          const r = asObj(entry)
          if (!r) return null
          const id = readOptionalStr(r['id'] ?? r['taskId'] ?? r['task_id']) ?? `task_${idx}`
          const name = readOptionalStr(r['title'] ?? r['name'] ?? r['prompt']) ?? id
          const schedule =
            readOptionalStr(r['cron'] ?? r['scheduleText'] ?? r['schedule_text']) ?? '定时触发'
          const enabled = r['enabled'] !== false && r['isEnabled'] !== false
          return { id, name, schedule, enabled }
        })
        .filter((x): x is { id: string; name: string; schedule: string; enabled: boolean } =>
          Boolean(x)
        )
    },
    [isApiKey],
    []
  )

  return (
    <Section
      title="定时任务"
      count={tasks.length || undefined}
      action={!isApiKey ? <RefreshButton loading={loading} onClick={() => void refresh()} /> : undefined}
    >
      {error && <p className="mb-2 text-[12px] text-status-error">{error}</p>}
      {isApiKey ? (
        <EmptyLine>Manus API Key 模式暂不支持定时任务列表，使用 Cue 账号网页登录后可查看</EmptyLine>
      ) : tasks.length === 0 ? (
        <EmptyLine>暂无定时任务</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line/60 px-2.5 py-1.5 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{task.name}</span>
              <span className="shrink-0 text-[11px] text-ink-muted">
                {task.enabled ? task.schedule : '已暂停'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/**
 * 5. Agent Skills (parity with `GrokMemoriesAndSkillsSection`).
 */
export function CueSkillsSection({ accountId }: { accountId: string }) {
  const authKind = useCueAuthKind(accountId)
  const isApiKey = authKind === 'api-key'
  const { data: skills, loading, error, refresh } = useCueSectionLoader<
    Array<{ id: string; name: string; scope: string; description?: string }>
  >(
    accountId,
    async () => {
      if (isApiKey) return []
      const raw = await callCueEndpoint(accountId, '/skill.v1.SkillService/ListSkills', {})
      const obj = asObj(raw)
      const userList = Array.isArray(obj?.['userAddedSkills'] ?? obj?.['user_added_skills'])
        ? ((obj?.['userAddedSkills'] ?? obj?.['user_added_skills']) as unknown[])
        : []
      const officialList = Array.isArray(obj?.['officialSkills'] ?? obj?.['official_skills'])
        ? ((obj?.['officialSkills'] ?? obj?.['official_skills']) as unknown[])
        : []
      const fallbackList = Array.isArray(obj?.['skills']) ? (obj!['skills'] as unknown[]) : []
      const mapItems = (arr: unknown[], scope: string) =>
        arr
          .map((entry, idx) => {
            const r = asObj(entry)
            if (!r) return null
            const id = readOptionalStr(r['id'] ?? r['skillId'] ?? r['name']) ?? `${scope}_${idx}`
            const name = readOptionalStr(r['name'] ?? r['title'] ?? id) ?? id
            const description = readOptionalStr(r['description'])
            return { id, name, scope, ...(description ? { description } : {}) }
          })
          .filter(
            (x): x is { id: string; name: string; scope: string; description?: string } =>
              Boolean(x)
          )
      const merged = [
        ...mapItems(userList, '自定义'),
        ...mapItems(officialList, '官方'),
        ...mapItems(fallbackList, '技能')
      ]
      const seen = new Set<string>()
      return merged.filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
    },
    [isApiKey],
    []
  )

  return (
    <Section
      title="记忆与技能"
      count={skills.length || undefined}
      action={!isApiKey ? <RefreshButton loading={loading} onClick={() => void refresh()} /> : undefined}
    >
      {error && <p className="mb-2 text-[12px] text-status-error">{error}</p>}
      {isApiKey ? (
        <EmptyLine>Manus API Key 模式暂不支持技能列表，使用 Cue 账号网页登录后可查看</EmptyLine>
      ) : skills.length === 0 ? (
        <EmptyLine>暂无已配置技能</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1">
          {skills.slice(0, 12).map((sk) => (
            <li
              key={sk.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-hover/60"
            >
              <span className="min-w-0 flex-1 truncate text-ink" title={sk.description}>
                {sk.name}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-ink-muted">
                {sk.scope}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/**
 * 6. Session Files & Library Tab (parity with `GrokFilesSection`).
 */
export function CueFilesSection({
  accountId,
  sessionId
}: {
  accountId: string
  sessionId?: string
}) {
  const authKind = useCueAuthKind(accountId)
  const isApiKey = authKind === 'api-key'
  const { data: files, loading, error, refresh } = useCueSectionLoader<
    Array<{ id: string; name: string; sizeBytes: number; url?: string }>
  >(
    accountId,
    async () => {
      if (isApiKey) return []
      const payload = sessionId
        ? { sessionUid: sessionId, limit: 50, offset: 0 }
        : { shared: false, limit: 50, offset: 0 }
      let raw: unknown
      try {
        raw = await callCueEndpoint(accountId, '/session.v1.SessionService/ListSessionFiles', payload)
      } catch {
        raw = await callCueEndpoint(accountId, '/session.v1.SessionService/ListSessionFiles', {
          shared: false,
          limit: 50,
          offset: 0
        })
      }
      const obj = asObj(raw)
      const list = Array.isArray(obj?.['files'] ?? obj?.['items'])
        ? ((obj?.['files'] ?? obj?.['items']) as unknown[])
        : []
      return list
        .map((entry, idx) => {
          const r = asObj(entry)
          if (!r) return null
          const name = readOptionalStr(r['filename'] ?? r['name'] ?? r['path'])
          if (!name) return null
          const id = readOptionalStr(r['id'] ?? r['fileId'] ?? name) ?? `file_${idx}`
          const sizeBytes = Number(r['size'] ?? r['sizeBytes'] ?? r['size_bytes'] ?? 0) || 0
          const url = readOptionalStr(r['url'] ?? r['downloadUrl'] ?? r['download_url'])
          return { id, name, sizeBytes, ...(url ? { url } : {}) }
        })
        .filter(
          (x): x is { id: string; name: string; sizeBytes: number; url?: string } => Boolean(x)
        )
    },
    [sessionId, isApiKey],
    []
  )

  return (
    <Section
      title="会话文件与资料库"
      count={files.length || undefined}
      action={!isApiKey ? <RefreshButton loading={loading} onClick={() => void refresh()} /> : undefined}
    >
      {error && <p className="mb-2 text-[12px] text-status-error">{error}</p>}
      {isApiKey ? (
        <EmptyLine>Manus API Key 模式暂不支持会话资料库，使用 Cue 账号网页登录后可浏览</EmptyLine>
      ) : files.length === 0 ? (
        <EmptyLine>暂无会话文件</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-hover/60"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ink">
                <FileText className="size-3.5 shrink-0 text-ink-muted" />
                <span className="truncate">{f.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-muted">
                {f.sizeBytes > 0 && <span>{formatBytes(f.sizeBytes)}</span>}
                {f.url && (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-muted hover:text-ink"
                    title="打开文件"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/**
 * 7. Cloud PC / Sandbox Runtime Info (parity with `GrokComputerSection`).
 */
export function CueComputerSection({
  accountId,
  agentId,
  sessionId
}: {
  accountId: string
  agentId?: string
  sessionId?: string
}) {
  const authKind = useCueAuthKind(accountId)
  const isApiKey = authKind === 'api-key'
  const { data: runtime, loading, error, refresh } = useCueSectionLoader<{
    pcId?: string
    sessionUid?: string
    sandboxStatus?: string
    sandboxId?: string
  }>(
    accountId,
    async () => {
      const cue = getBridge()?.cue
      if (!cue?.rpc) return {}
      if (isApiKey) {
        return { sessionUid: sessionId, sandboxStatus: 'API KEY' }
      }
      const [agentsRes, sessRaw] = await Promise.all([
        readCueRpc({ accountId, op: 'listAgents' }).catch(() => null),
        sessionId
          ? callCueEndpoint(accountId, '/session.v1.SessionService/GetSession', {
              sessionUid: sessionId,
              includeEmptyTasks: true
            }).catch(() => null)
          : Promise.resolve(null)
      ])
      const meta = agentsRes?.ok ? pickCueAgentMeta(agentsRes.data, agentId) : null
      const sessObj = asObj(sessRaw)
      const sessionRec = asObj(sessObj?.['session']) ?? sessObj
      const sandboxId = readOptionalStr(
        sessionRec?.['sandboxId'] ?? sessionRec?.['sandbox_id'] ?? meta?.pcId
      )
      const sandboxStatus = readOptionalStr(
        sessionRec?.['status'] ?? sessionRec?.['state'] ?? (meta?.pcId ? 'BOUND' : 'STANDBY')
      )
      return {
        pcId: meta?.pcId,
        sessionUid: meta?.sessionId || sessionId,
        sandboxStatus,
        sandboxId
      }
    },
    [agentId, sessionId, isApiKey],
    {}
  )

  return (
    <Section
      title="云电脑与沙盒"
      action={!isApiKey ? <RefreshButton loading={loading} onClick={() => void refresh()} /> : undefined}
    >
      {error && <p className="mb-2 text-[12px] text-status-error">{error}</p>}
      {isApiKey ? (
        <EmptyLine>Manus API Key 模式暂不支持云电脑状态查询，使用 Cue 账号网页登录后可查看</EmptyLine>
      ) : (
        <div className="flex flex-col gap-1.5 text-[12px] text-ink-secondary">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Cpu className="size-3.5 text-ink-muted" />
              运行环境状态
            </span>
            <span className="font-mono text-[11.5px] text-ink">
              {runtime.sandboxStatus || 'STANDBY'}
            </span>
          </div>
          {runtime.pcId && (
            <p className="break-all">
              绑定云电脑：<span className="font-mono text-[11px] text-ink">{runtime.pcId}</span>
            </p>
          )}
          {runtime.sandboxId && runtime.sandboxId !== runtime.pcId && (
            <p className="break-all">
              沙盒实例：<span className="font-mono text-[11px] text-ink">{runtime.sandboxId}</span>
            </p>
          )}
          {runtime.sessionUid && (
            <p className="break-all">
              关联会话：<span className="font-mono text-[11px] text-ink">{runtime.sessionUid}</span>
            </p>
          )}
        </div>
      )}
    </Section>
  )
}

/**
 * 8. Cue Connectors & Integrations (parity with `GrokConnectorsAndMcpSection`).
 */
export function CueConnectorsSection({ accountId }: { accountId: string }) {
  const authKind = useCueAuthKind(accountId)
  const isApiKey = authKind === 'api-key'
  const { data: connectors, loading, error, refresh } = useCueSectionLoader<
    Array<{ id: string; name: string; connected: boolean }>
  >(
    accountId,
    async () => {
      if (isApiKey) return []
      const raw = await callCueEndpoint(accountId, '/connectors.v1.ConnectorService/ListConnectors', {})
      const obj = asObj(raw)
      const list = Array.isArray(obj?.['connectors'] ?? obj?.['items'])
        ? ((obj?.['connectors'] ?? obj?.['items']) as unknown[])
        : []
      return list
        .map((entry, idx) => {
          const r = asObj(entry)
          if (!r) return null
          const id = readOptionalStr(r['id'] ?? r['connectorId'] ?? r['name']) ?? `conn_${idx}`
          const name = readOptionalStr(r['name'] ?? r['displayName'] ?? id) ?? id
          const connected = r['connected'] !== false && r['isEnabled'] !== false
          return { id, name, connected }
        })
        .filter((x): x is { id: string; name: string; connected: boolean } => Boolean(x))
    },
    [isApiKey],
    []
  )

  return (
    <Section
      title="连接器与集成"
      count={connectors.length || undefined}
      action={!isApiKey ? <RefreshButton loading={loading} onClick={() => void refresh()} /> : undefined}
    >
      {error && <p className="mb-2 text-[12px] text-status-error">{error}</p>}
      {isApiKey ? (
        <EmptyLine>Manus API Key 模式暂不支持连接器列表，使用 Cue 账号网页登录后可查看</EmptyLine>
      ) : connectors.length === 0 ? (
        <EmptyLine>暂无已配置连接器</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1">
          {connectors.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-hover/60"
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ink">
                <Link2 className="size-3.5 shrink-0 text-ink-muted" />
                <span className="truncate">{c.name}</span>
              </span>
              <span className="shrink-0 text-[11px] text-ink-muted">
                {c.connected ? '已连接' : '未启用'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/**
 * 9. Cue Agents Directory & Switcher (parity with `GrokAgentsAndRoomsSection`).
 */
export function CueAgentsSection({
  accountId,
  agentId,
  botId
}: {
  accountId: string
  agentId?: string
  botId: string
}) {
  const bots = useBotStore((s) => s.bots)
  const selectBot = useBotStore((s) => s.selectBot)
  const setSelectedAgent = useBotStore((s) => s.setSelectedAgent)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)

  const [query, setQuery] = useState('')
  const [syncing, setSyncing] = useState(false)

  const { data: agents, loading, error, refresh } = useCueSectionLoader<CueAgentMeta[]>(
    accountId,
    async () => {
      const cue = getBridge()?.cue
      if (!cue?.rpc) return []
      const res = await readCueRpc({ accountId, op: 'listAgents' })
      if (!res.ok) throw new Error(res.message || '加载 Cue Agent 列表失败')
      return parseCueAgentList(res.data)
    },
    [],
    []
  )

  const filtered = query.trim()
    ? agents.filter((a) =>
        `${a.name} ${a.email ?? ''} ${a.phoneNumber ?? ''} ${a.id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
    : agents

  const handleSelectAgent = (item: CueAgentMeta) => {
    const owner = bots.find(
      (b) => b.platformId === 'cue' && b.accountIds.includes(accountId) && b.selectedAgentId === item.id
    )
    if (owner && owner.id !== botId) {
      selectBot(owner.id)
      return
    }
    setSelectedAgent(botId, item.id)
  }

  return (
    <Section
      title="Agent 列表与切换"
      count={agents.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 Cue Agent 名称或邮箱…"
            className="flex-1 text-[12px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={syncing}
            onClick={() => {
              setSyncing(true)
              void Promise.all([syncCueAccountBots(accountId), refresh()]).finally(() =>
                setSyncing(false)
              )
            }}
          >
            同步全部
          </Button>
        </div>
        {error && <p className="text-[12px] text-status-error">{error}</p>}
        {filtered.length === 0 ? (
          <EmptyLine>暂无匹配的 Cue Agent</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((item) => {
              const active = item.id === agentId
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectAgent(item)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                      active
                        ? 'border-accent-500/60 bg-accent-500/10 text-ink'
                        : 'border-line/60 bg-surface text-ink-secondary hover:bg-hover/60'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">
                      {item.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-muted">
                      {item.isManus ? '内置' : '自定义'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 10. Dedicated Agent Contact Info & Session Collaborators (parity with `GrokMembersSection`).
 */
export function CueAgentContactsSection({
  accountId,
  agentId,
  sessionId
}: {
  accountId: string
  agentId?: string
  sessionId?: string
}) {
  const [copiedKey, setCopiedKey] = useState<string>()
  const authKind = useCueAuthKind(accountId)
  const isApiKey = authKind === 'api-key'

  const { data: detail, loading, refresh } = useCueSectionLoader<{
    agent?: CueAgentMeta | null
    collaborators: Array<{ id: string; label: string }>
  }>(
    accountId,
    async () => {
      const cue = getBridge()?.cue
      if (!cue?.rpc) return { collaborators: [] }
      const [agentsRes, sessRaw] = await Promise.all([
        readCueRpc({ accountId, op: 'listAgents' }).catch(() => null),
        sessionId && !isApiKey
          ? callCueEndpoint(accountId, '/session.v1.SessionService/GetSession', {
              sessionUid: sessionId,
              includeEmptyTasks: true
            }).catch(() => null)
          : Promise.resolve(null)
      ])
      const meta = agentsRes?.ok ? pickCueAgentMeta(agentsRes.data, agentId) : null
      const sessObj = asObj(sessRaw)
      const sessionRec = asObj(sessObj?.['session']) ?? sessObj
      const rawCollabs = Array.isArray(sessionRec?.['collaborators'])
        ? (sessionRec!['collaborators'] as unknown[])
        : []
      const collaborators = rawCollabs
        .map((c, idx) => {
          const r = asObj(c)
          if (!r) return null
          const id = readOptionalStr(r['userId'] ?? r['id'] ?? r['email']) ?? `collab_${idx}`
          const label = readOptionalStr(r['email'] ?? r['name'] ?? id) ?? id
          return { id, label }
        })
        .filter((x): x is { id: string; label: string } => Boolean(x))
      return { agent: meta, collaborators }
    },
    [agentId, sessionId, isApiKey],
    { collaborators: [] }
  )

  const copyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((prev) => (prev === key ? undefined : prev)), 1500)
    } catch {
      /* ignore */
    }
  }

  const rows = [
    detail.agent?.email ? { key: 'email', label: '专属邮箱', value: detail.agent.email } : null,
    detail.agent?.phoneNumber
      ? { key: 'phone', label: '专属手机', value: detail.agent.phoneNumber }
      : null,
    agentId ? { key: 'agent', label: 'Agent ID', value: agentId } : null,
    detail.agent?.sessionId || sessionId
      ? { key: 'session', label: '会话 ID', value: detail.agent?.sessionId || sessionId! }
      : null
  ].filter((x): x is { key: string; label: string; value: string } => Boolean(x))

  return (
    <Section
      title="联络与协作"
      count={detail.collaborators.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {rows.length === 0 ? (
          <EmptyLine>暂无专属联络信息</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex items-center justify-between gap-2 rounded-md border border-line/60 px-2 py-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[10.5px] text-ink-muted">{row.label}</div>
                  <div className="truncate font-mono text-[11.5px] text-ink">{row.value}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void copyValue(row.key, row.value)}
                  className="shrink-0 rounded p-1 text-ink-muted hover:bg-hover/60 hover:text-ink"
                  title="复制"
                >
                  {copiedKey === row.key ? (
                    <Check className="size-3.5 text-status-online-ink" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {detail.collaborators.length > 0 && (
          <div className="pt-1">
            <div className="mb-1 text-[11px] text-ink-muted">协作者</div>
            <ul className="flex flex-col gap-1">
              {detail.collaborators.map((c) => (
                <li key={c.id} className="truncate text-[11.5px] text-ink-secondary">
                  {c.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  )
}
