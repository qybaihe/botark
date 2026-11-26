import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Activity, FileUp, Loader2, Shuffle, Trash2 } from 'lucide-react'
import type { MuseProxyMode, MuseProxyPoolItemView, MuseProxyTestResult, MuseProxyView } from '@shared/ipc'
import { keepMuseBatchProxyAssignments } from '@/components/add-bot/MuseBatchImport'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { useT } from '@/lib/i18n'
import { proxyPoolArgsForAccounts, useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'
import { errorMessage } from './PlatformAccountsSection'
import type { SettingsActivity, SettingsTab } from './SettingsView'

const PROXY_PLACEHOLDER = `# 支持每行一个代理（自动识别格式）：
https://user:pass@proxy.example.com:443
http://user:pass@127.0.0.1:7890
socks5://user:pass@127.0.0.1:1080
socks5h://127.0.0.1:1080
192.168.1.10:1080:username:password
127.0.0.1:7890`

function musePoolArgs() {
  const { accounts } = useBotStore.getState()
  const museIds = Object.values(accounts)
    .filter((account) => account.platformId === 'meta-muse')
    .map((account) => account.id)
  return proxyPoolArgsForAccounts(accounts, museIds)
}

export function useProxyPool(
  settingsTab: SettingsTab,
  museAccountCount: number,
  cleaning: RefObject<boolean>,
  { setBusy, setError, setHint }: SettingsActivity
) {
  const tr = useT()
  const [pool, setPool] = useState<MuseProxyPoolItemView[]>([])
  const [accountProxies, setAccountProxies] = useState<Record<string, MuseProxyView>>({})
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const { settingsOpen, settingsTab, accounts } = useBotStore.getState()
    if (cleaning.current || !settingsOpen || !['overview', 'muse-accounts', 'proxy-pool'].includes(settingsTab)) return
    const muse = getBridge()?.muse
    if (!muse) return
    const request = ++requestId.current
    const isCurrent = () => {
      const state = useBotStore.getState()
      return state.settingsOpen && state.settingsTab === settingsTab && requestId.current === request
    }
    try {
      if (muse.listProxyPool) {
        const items = await muse.listProxyPool()
        if (!isCurrent()) return
        setPool(items)
      }
      if (settingsTab === 'muse-accounts' && muse.getProxy) {
        const ids = Object.values(accounts)
          .filter((account) => account.platformId === 'meta-muse')
          .map((account) => account.id)
        const results = await Promise.allSettled(ids.map(async (id) => [id, await muse.getProxy(id)] as const))
        if (!isCurrent()) return
        setAccountProxies(Object.fromEntries(
          results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
        ))
      }
    } catch (err) {
      if (isCurrent()) setError(errorMessage(err))
    }
  }, [cleaning, setError])

  const invalidate = useCallback(() => {
    requestId.current++
  }, [])
  useLayoutEffect(() => invalidate, [invalidate, settingsTab])
  useEffect(() => {
    void refresh()
  }, [refresh, settingsTab, museAccountCount])

  const clear = () => {
    setPool([])
    setAccountProxies({})
  }

  const assignMuseProxies = async () => {
    const muse = getBridge()?.muse
    if (!muse?.assignProxyPool) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const { accountIds, keepIds } = musePoolArgs()
      const res = await muse.assignProxyPool(accountIds, keepMuseBatchProxyAssignments(keepIds))
      setPool(res.items)
      setHint(tr('Assigned proxies to {assigned} of {total} Muse accounts', {
        assigned: res.assignedCount, total: accountIds.length
      }))
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return { pool, accountProxies, setPool, refresh, invalidate, clear, assignMuseProxies }
}

interface ProxyPoolSectionProps {
  active: boolean
  credentialRevision: number
  museAccountCount: number
  botsByAccountId: ReadonlyMap<string, Bot[]>
  activity: SettingsActivity
  proxyPool: ReturnType<typeof useProxyPool>
}

export function ProxyPoolSection({
  active, credentialRevision, museAccountCount, botsByAccountId, activity, proxyPool
}: ProxyPoolSectionProps) {
  const tr = useT()
  const accounts = useBotStore((s) => s.accounts)
  const { busy, setBusy, setError, setHint } = activity
  const { pool, setPool, refresh, assignMuseProxies } = proxyPool
  const [rawProxyText, setRawProxyText] = useState('')
  const [defaultMode, setDefaultMode] = useState<Exclude<MuseProxyMode, 'direct'>>('socks5')
  const [testResults, setTestResults] = useState<Record<string, MuseProxyTestResult>>({})
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set())
  const [testingAll, setTestingAll] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    setRawProxyText('')
    setTestResults({})
    setTestingIds(new Set())
    setTestingAll(false)
  }, [credentialRevision])

  if (!active) return null

  const latencyBadgeClass = (ms: number | undefined): string => {
    if (typeof ms !== 'number') return 'bg-status-online/10 text-status-online-ink'
    if (ms < 300) return 'bg-status-online/10 text-status-online-ink'
    if (ms < 800) return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    return 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
  }

  const handleTestPool = async (ids?: string[]) => {
    const muse = getBridge()?.muse
    if (!muse?.testProxyPool || pool.length === 0) return
    const targetIds = ids && ids.length > 0 ? ids : pool.map((item) => item.id)
    const isAll = !ids || ids.length === 0
    if (isAll) setTestingAll(true)
    setTestingIds((prev) => {
      const next = new Set(prev)
      for (const id of targetIds) next.add(id)
      return next
    })
    setError(undefined)
    if (isAll) setHint(undefined)
    try {
      const res = await muse.testProxyPool(isAll ? undefined : targetIds)
      setTestResults((prev) => ({ ...prev, ...res }))
      if (isAll) {
        const values = Object.values(res)
        const okValues = values.filter((r) => r.ok)
        const avgMs =
          okValues.length > 0
            ? Math.round(
                okValues.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / okValues.length
              )
            : null
        setHint(
          avgMs !== null
            ? `代理检测完成：${okValues.length} / ${values.length} 可用（平均延迟 ${avgMs} ms）`
            : `代理检测完成：0 / ${values.length} 可用`
        )
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      if (isAll) setTestingAll(false)
      setTestingIds((prev) => {
        const next = new Set(prev)
        for (const id of targetIds) next.delete(id)
        return next
      })
    }
  }

  const failedIds = pool.filter((item) => testResults[item.id]?.ok === false).map((item) => item.id)

  const handleRemoveFailed = async () => {
    const muse = getBridge()?.muse
    if (!muse?.removeProxyPoolItem || failedIds.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      let next = pool
      for (const id of failedIds) {
        next = await muse.removeProxyPoolItem(id)
      }
      setPool(next)
      setTestResults((prev) => {
        const copy = { ...prev }
        for (const id of failedIds) delete copy[id]
        return copy
      })
      setHint(`已移除 ${failedIds.length} 个失效代理`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleImportPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.importProxyPool || !rawProxyText.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await muse.importProxyPool(rawProxyText, defaultMode)
      setRawProxyText('')
      setPool(res.items)
      const { accountIds, keepIds } = musePoolArgs()
      if (accountIds.length > 0 && muse.assignProxyPool) {
        const assigned = await muse.assignProxyPool(accountIds, keepMuseBatchProxyAssignments(keepIds))
        setPool(assigned.items)
        setHint(tr('Imported {added} proxies ({total} in pool) and assigned {assigned} to Muse accounts', {
          added: res.added, total: res.total, assigned: assigned.assignedCount
        }))
      } else {
        setHint(tr('Imported {added} proxies ({total} in pool)', { added: res.added, total: res.total }))
      }
      await refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRemovePoolItem = async (id: string) => {
    const muse = getBridge()?.muse
    if (!muse?.removeProxyPoolItem) return
    const next = await muse.removeProxyPoolItem(id)
    setPool(next)
    setTestResults((prev) => {
      if (!(id in prev)) return prev
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
  }

  const handleClearPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.clearProxyPool) return
    const next = await muse.clearProxyPool()
    setPool(next)
    setTestResults({})
    setHint('已清空代理池')
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('Proxy pool')}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            批量导入代理并按「一号一代理」自动分配，本地钥匙串加密保存。
          </p>
        </div>
        {pool.length > 0 && museAccountCount > 0 && (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void assignMuseProxies()}>
            <Shuffle className="size-3.5" /> {tr('Assign proxies to Muse accounts ({count})', { count: museAccountCount })}
          </Button>
        )}
      </div>

      {/* Proxy Pool Importer Card */}
      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-ink">批量粘贴或导入代理</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
              <span>无协议前缀时默认：</span>
              <Select
                size="xs"
                variant="pill"
                value={defaultMode}
                onValueChange={(next) => setDefaultMode(next)}
                className="w-40"
                options={[
                  { value: 'socks5', label: 'SOCKS5' },
                  { value: 'socks5h', label: 'SOCKS5H (远程 DNS)' },
                  { value: 'http', label: 'HTTP' },
                  { value: 'https', label: 'HTTPS (TLS)' }
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] text-ink-secondary hover:bg-hover hover:text-ink"
            >
              <FileUp className="size-3.5" /> 从 .txt 导入
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              hidden
              onChange={(ev) => {
                const file = ev.target.files?.[0]
                ev.target.value = ''
                if (file) {
                  void file.text().then((txt) =>
                    setRawProxyText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${txt}` : txt))
                  )
                }
              }}
            />
          </div>
        </div>
        <textarea
          value={rawProxyText}
          onChange={(e) => setRawProxyText(e.target.value)}
          placeholder={PROXY_PLACEHOLDER}
          rows={5}
          spellCheck={false}
          className="block w-full resize-none rounded-xl border border-line bg-canvas p-3 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[12px] text-ink-muted">
            导入后会自动为尚未绑定代理的账号一对一分配
          </span>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !rawProxyText.trim()}
            onClick={() => void handleImportPool()}
          >
            导入代理池并自动匹配
          </Button>
        </div>
      </div>

      {/* Current Pool List */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
          <span>代理池列表 ({pool.length})</span>
          {pool.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {getBridge()?.muse?.testProxyPool && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || testingAll}
                  onClick={() => void handleTestPool()}
                >
                  {testingAll ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Activity className="size-3.5" aria-hidden />
                  )}
                  {testingAll ? '测速中…' : '全部测速'}
                </Button>
              )}
              {failedIds.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || testingAll}
                  onClick={() => void handleRemoveFailed()}
                >
                  移除失效 ({failedIds.length})
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy || testingAll} onClick={() => void handleClearPool()}>
                清空代理池
              </Button>
            </div>
          )}
        </div>
        {pool.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-muted">代理池为空，请在上方粘贴导入代理</p>
        ) : (
          <ul className="divide-y divide-line">
            {pool.map((item, idx) => {
              const assignedAcc = item.assignedAccountId ? accounts[item.assignedAccountId] : undefined
              const ownerBot = item.assignedAccountId
                ? botsByAccountId.get(item.assignedAccountId)?.[0]
                : undefined
              const probe = testResults[item.id]
              const isTestingItem = testingIds.has(item.id)
              const probeTooltip = probe
                ? probe.ok
                  ? [
                      typeof probe.latencyMs === 'number' ? `延迟 ${probe.latencyMs} ms` : null,
                      probe.country ? `地区 ${probe.country}` : null,
                      probe.exitIp ? `出口 IP ${probe.exitIp}` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : probe.error || '代理不可用'
                : undefined
              return (
                <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="w-6 font-mono text-[11px] text-ink-muted">#{idx + 1}</span>
                    <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] uppercase text-ink-secondary">
                      {item.mode}
                    </span>
                    <span className="truncate font-mono text-[13px] text-ink">
                      {item.username ? `${item.username}${item.hasPassword ? ':***' : ''}@` : ''}
                      {item.host}:{item.port}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isTestingItem ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                        检测中…
                      </span>
                    ) : probe ? (
                      probe.ok ? (
                        <span
                          title={probeTooltip}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${latencyBadgeClass(probe.latencyMs)}`}
                        >
                          {typeof probe.latencyMs === 'number' ? `${probe.latencyMs} ms` : '可用'}
                          {probe.country ? ` · ${probe.country}` : ''}
                        </span>
                      ) : (
                        <span
                          title={probeTooltip}
                          className="inline-flex items-center rounded-full bg-status-error/10 px-2 py-0.5 text-[11px] font-medium text-status-error"
                        >
                          不可用
                        </span>
                      )
                    ) : null}
                    {assignedAcc || ownerBot ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-status-online/10 px-2.5 py-0.5 text-[11.5px] font-medium text-status-online-ink">
                        已绑定 → {ownerBot?.name || assignedAcc?.displayName || item.assignedAccountId}
                      </span>
                    ) : (
                      <span className="rounded-full bg-sunken px-2.5 py-0.5 text-[11.5px] text-ink-muted">
                        空闲待分配
                      </span>
                    )}
                    {getBridge()?.muse?.testProxyPool && (
                      <button
                        type="button"
                        disabled={isTestingItem || testingAll}
                        onClick={() => void handleTestPool([item.id])}
                        className="rounded p-1 text-ink-muted hover:bg-hover hover:text-ink disabled:opacity-40"
                        title="测试可用性与延迟"
                      >
                        <Activity className="size-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleRemovePoolItem(item.id)}
                      className="rounded p-1 text-ink-muted hover:bg-hover hover:text-status-error"
                      title="移除代理"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
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
