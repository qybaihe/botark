import { GeminiAccountsSettingsPanel } from '@/components/gemini/GeminiAccountsSettingsPanel'
import { useMemo, useRef, useState } from 'react'
import { Activity, ArrowLeft, LayoutDashboard, Server, Settings, Smartphone, Sparkles, Users, type LucideIcon } from 'lucide-react'
import type { PlatformId } from '@adapters/types'
import { HermesAccountsSettingsPanel } from '@/components/hermes/HermesAccountsSettingsPanel'
import { DsBotAccountsSettingsPanel } from '@/components/dsbot/DsBotAccountsSettingsPanel'
import { PaneHeader } from '@/components/layout/PaneHeader'
import { MobileSyncSettingsPanel } from '@/components/mobile-sync/MobileSyncSettingsPanel'
import { ArkMobileLinkSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { platformIcon } from '@/lib/platformIcons'
import { useBotStore, type BotHubState } from '@/store/botStore'
import type { BotAccount } from '@/types'
import { GeneralSettingsSection } from './GeneralSettingsSection'
import { McpSettingsSection } from './McpSettingsSection'
import { OverviewSection } from './OverviewSection'
import { PlatformAccountsSection, indexBotsByAccount, useDotStoredMeta } from './PlatformAccountsSection'
import { ProxyPoolSection, useProxyPool } from './ProxyPoolSection'

export type SettingsTab = BotHubState['settingsTab']

export interface SettingsActivity {
  busy: boolean
  setBusy: (busy: boolean) => void
  setHint: (hint: string | undefined) => void
  setError: (error: string | undefined) => void
}

interface SettingsNavItem {
  id: SettingsTab
  label: string
  icon: LucideIcon
  platformId?: PlatformId
  count?: number
}

export function SettingsView() {
  const tr = useT()
  const settingsTab = useBotStore((s) => s.settingsTab)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const connectAccount = useBotStore((s) => s.connectAccount)

  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const [navigationRevision, setNavigationRevision] = useState(0)
  const [credentialRevision, setCredentialRevision] = useState(0)
  const cleaning = useRef(false)
  const activity = { busy, setBusy, setHint, setError }

  const allAccounts = useMemo(() => Object.values(accounts), [accounts])
  const accountsByPlatform = useMemo(() => {
    const indexed = new Map<PlatformId, BotAccount[]>()
    for (const account of allAccounts) {
      const platformAccounts = indexed.get(account.platformId)
      if (platformAccounts) platformAccounts.push(account)
      else indexed.set(account.platformId, [account])
    }
    return indexed
  }, [allAccounts])
  const botsByAccountId = useMemo(() => indexBotsByAccount(bots), [bots])
  const accountCount = (platform: PlatformId) => accountsByPlatform.get(platform)?.length ?? 0
  const museAccountCount = accountCount('meta-muse')
  const proxyPool = useProxyPool(settingsTab, museAccountCount, cleaning, activity)
  const dot = useDotStoredMeta(settingsTab, accountCount('dot'), cleaning)

  const openTab = (tab: SettingsTab) => {
    setSettingsOpen(true, tab)
    setHint(undefined)
    setError(undefined)
    setNavigationRevision((revision) => revision + 1)
  }

  const handleReconnectAll = async (onlyOffline = false) => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const targets = allAccounts.filter((a) => (onlyOffline ? a.status === 'offline' || a.status === 'error' : true))
      await Promise.all(targets.map((a) => connectAccount(a.id).catch(() => undefined)))
      await dot.refresh()
      setHint(`已完成 ${targets.length} 个账号的连接巡检与会话同步`)
    } finally {
      setBusy(false)
    }
  }

  const nav: SettingsNavItem[] = [
    { id: 'overview', label: tr('Overview'), icon: LayoutDashboard, count: bots.length },
    { id: 'muse-accounts', label: 'Meta Muse', icon: Users, platformId: 'meta-muse', count: museAccountCount },
    { id: 'dot-accounts', label: 'ChatGPT Dot', icon: Users, platformId: 'dot', count: accountCount('dot') },
    { id: 'grok-accounts', label: 'Grok Bot', icon: Users, platformId: 'grok', count: accountCount('grok') },
    { id: 'hark-accounts', label: 'Hark', icon: Users, platformId: 'hark', count: accountCount('hark') },
    { id: 'gemini-accounts', label: 'Google Gemini', icon: Sparkles, platformId: 'gemini', count: accountCount('gemini') },
    { id: 'hermes-accounts', label: 'Hermes', icon: Server, platformId: 'hermes', count: accountCount('hermes') },
    {
      id: 'antigravity-accounts',
      label: 'Antigravity',
      icon: Users,
      platformId: 'antigravity',
      count: accountCount('antigravity')
    },
    {
      id: 'cue-accounts',
      label: 'Cue (Manus)',
      icon: Sparkles,
      platformId: 'cue',
      count: accountCount('cue')
    },
    {
      id: 'ds-bot-accounts',
      label: 'DS Bot',
      icon: Server,
      platformId: 'ds-bot',
      count: accountCount('ds-bot')
    },
    { id: 'mcp-hub', label: tr('MCP & Workspace'), icon: Server },
    { id: 'mobile-sync', label: tr('Mobile Sync'), icon: Smartphone },
    { id: 'proxy-pool', label: tr('Proxy pool'), icon: Server, count: proxyPool.pool.length },
    { id: 'general', label: tr('General & Security'), icon: Settings }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-main">
      <PaneHeader className="justify-between px-4">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setSettingsOpen(false)}
            className="no-drag press inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] font-medium text-ink shadow-soft hover:bg-hover"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {tr('Back')}
          </button>
          <h1 className="text-[15px] font-semibold tracking-tight text-ink">{tr('Settings & Accounts')}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || allAccounts.length === 0}
            onClick={() => void handleReconnectAll(false)}
          >
            <Activity className={cn('size-3.5', busy && 'animate-spin')} /> {tr('Check account connections')}
          </Button>
        </div>
      </PaneHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Settings Sub-navigation */}
        <aside className="flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-3">
          {nav.map((item) => {
            const Icon = item.icon
            const pIcon = platformIcon(item.platformId)
            const active = settingsTab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => openTab(item.id)}
                className={cn(
                  'press flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13px] font-medium transition-colors',
                  active ? 'bg-active text-ink' : 'text-ink-secondary hover:bg-hover hover:text-ink'
                )}
              >
                {pIcon ? (
                  <img
                    src={pIcon}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="size-4 shrink-0 rounded-[4px] object-cover ring-1 ring-line"
                  />
                ) : item.id === 'mobile-sync' ? (
                  <ArkMobileLinkSvg className="size-4 shrink-0" />
                ) : (
                  <Icon className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count !== undefined && item.count > 0 && (
                  <span className="rounded-full bg-sunken px-1.5 py-0.2 text-[11px] text-ink-muted tabular-nums">
                    {item.count}
                  </span>
                )}
              </button>
            )
          })}
        </aside>

        {/* Right Content Area */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-[820px]">
            {error && (
              <div role="alert" className="mb-4 whitespace-pre-line rounded-xl border border-status-error/25 bg-status-error/8 px-3.5 py-2.5 text-[13px] text-status-error">
                {error}
              </div>
            )}
            {hint && (
              <div className="mb-4 rounded-xl border border-accent-600/20 bg-accent-50 px-3.5 py-2.5 text-[13px] text-ink">
                {hint}
              </div>
            )}

            <OverviewSection
              active={settingsTab === 'overview'}
              accountsByPlatform={accountsByPlatform}
              dotMetaMap={dot.dotMetaMap}
              poolCount={proxyPool.pool.length}
              busy={busy}
              onReconnectOffline={() => void handleReconnectAll(true)}
            />
            <PlatformAccountsSection
              tab={settingsTab}
              accountsByPlatform={accountsByPlatform}
              botsByAccountId={botsByAccountId}
              activity={activity}
              credentialRevision={credentialRevision}
              proxyPool={proxyPool}
              dot={dot}
            />
            {settingsTab === 'gemini-accounts' && <GeminiAccountsSettingsPanel />}
            {settingsTab === 'hermes-accounts' && <HermesAccountsSettingsPanel />}
            {settingsTab === 'ds-bot-accounts' && <DsBotAccountsSettingsPanel />}
            {settingsTab === 'mobile-sync' && <MobileSyncSettingsPanel />}
            <ProxyPoolSection
              active={settingsTab === 'proxy-pool'}
              credentialRevision={credentialRevision}
              museAccountCount={museAccountCount}
              botsByAccountId={botsByAccountId}
              activity={activity}
              proxyPool={proxyPool}
            />
            <GeneralSettingsSection
              active={settingsTab === 'general'}
              navigationRevision={navigationRevision}
              activity={activity}
              cleaning={cleaning}
              onCleanupStart={() => {
                proxyPool.invalidate()
                dot.invalidate()
              }}
              onCleanupSuccess={() => {
                proxyPool.clear()
                dot.clear()
                setCredentialRevision((revision) => revision + 1)
              }}
              onCleanupFinish={() => {
                void proxyPool.refresh()
                void dot.refresh()
              }}
            />
            {settingsTab === 'mcp-hub' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <McpSettingsSection />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
