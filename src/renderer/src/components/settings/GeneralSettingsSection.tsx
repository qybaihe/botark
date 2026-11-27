import { usePromptStore } from '@/store/promptStore'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Download, FolderPlus, RefreshCw, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'
import { listGrokAuthAccountIds } from '@adapters/grokbot/tokenStore'
import { adapterRegistry } from '@adapters/registry'
import { SecurityVaultCenter } from '@/components/info/SecurityVaultCard'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useT, t } from '@/lib/i18n'
import { clearVaultCredentials } from '@/lib/vaultClient'
import { stopRoom, useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import { usePrefsStore, type Locale, type ThemePref } from '@/store/prefsStore'
import { errorMessage, PLATFORM_LABELS } from './PlatformAccountsSection'
import type { SettingsActivity } from './SettingsView'

const PURGED_VAULT_STORES = new Set([
  'proxy', 'proxy-pool', 'grok-tokens', 'dot-tokens', 'cue-tokens', 'hermes-accounts', 'dsbot-accounts', 'secrets-vault'
])

async function purgeCredentials() {
  const state = useBotStore.getState()
  const bridge = getBridge()
  const accounts = Object.values(state.accounts)
  const failures: string[] = []
  const attempt = async (step: string, action: () => unknown | Promise<unknown>) => {
    try {
      await action()
      return true
    } catch (error) {
      failures.push(`${step} — ${errorMessage(error)}`)
      return false
    }
  }

  // Stop room turns before clearing their accounts and persisted transcript.
  const rooms = useRooms.getState().rooms
  await Promise.all(rooms.map((room) => attempt(room.title, () => stopRoom(room.id))))
  await attempt(t('Collaboration rooms'), () => {
    useRooms.setState({ rooms: [], speakers: {}, turnProgress: {}, errors: {}, externalAudiences: {} })
    localStorage.removeItem('botark-collaboration-rooms')
    if (localStorage.getItem('botark-collaboration-rooms') !== null) {
      throw new Error(t('Could not remove the saved collaboration rooms'))
    }
  })
  useBotStore.setState((current) => ({
    activeDocument: null,
    webSessionOpen: false,
    webSessionByBot: {},
    webSessionTargetUrl: null,
    ...(rooms.some((room) => room.id === current.selectedBotId) ? { selectedBotId: null } : {})
  }))

  const partitionIds = new Set(accounts.map((account) => account.id))
  const proxyIds = new Set(partitionIds)
  const muse = bridge?.muse
  if (muse?.listProxyPool) {
    await attempt(t('Proxy pool'), async () => {
      for (const item of await muse.listProxyPool()) {
        if (item.assignedAccountId) {
          proxyIds.add(item.assignedAccountId)
          partitionIds.add(item.assignedAccountId)
        }
      }
    })
  }

  const authBridges = {
    grok: bridge?.grok,
    dot: bridge?.dot,
    hark: bridge?.hark,
    hermes: bridge?.hermes,
    antigravity: bridge?.antigravity,
    cue: bridge?.cue,
    'ds-bot': bridge?.dsBot
  }
  const grokSessionIds = listGrokAuthAccountIds()
  for (const id of grokSessionIds) {
    partitionIds.add(id)
    proxyIds.add(id)
  }

  // The store drains account connections and invalidates their pending work.
  // Verify the cleanup through the bridge because the store only reports
  // per-account failures via UI state.
  await Promise.all(accounts.map(({ id, platformId }) =>
    attempt(`${PLATFORM_LABELS[platformId]} (${id})`, () => state.signOutAccount(id))
  ))
  const grokAdapter = adapterRegistry.get('grok') as { clearAuth?: (accountId: string) => void } | undefined
  await Promise.all(grokSessionIds.map((id) =>
    attempt(`Grok Bot (${id})`, () => grokAdapter?.clearAuth?.(id))
  ))

  const signedOutIds = new Set<string>()
  await Promise.all(accounts.map(async (account) => {
    const { id, platformId } = account
    const label = `${PLATFORM_LABELS[platformId]} (${id})`
    const cleared = await attempt(label, async () => {
      if (!bridge) return
      if (platformId === 'meta-muse' && muse?.signOut) {
        await muse.signOut(id)
        partitionIds.delete(id)
        return
      }
      const auth = platformId === 'meta-muse' ? undefined : authBridges[platformId]
      if (!auth?.clearAuth) throw new Error(t('Desktop credential cleanup is unavailable'))
      const status = await auth.clearAuth(id)
      if (status?.signedIn) throw new Error(t('The account is still signed in'))
    })
    if (platformId === 'hermes' || platformId === 'ds-bot') partitionIds.delete(id)
    if (cleared) signedOutIds.add(id)
  }))

  if (bridge) {
    await Promise.all([...partitionIds].map((id) => attempt(t('Browser session for {account}', { account: id }), async () => {
      if (!bridge.webViews?.clearPartition) throw new Error(t('Desktop credential cleanup is unavailable'))
      await bridge.webViews.clearPartition(id)
    })))
    // Include retained pool assignments and platform records outside the current Bot list.
    await Promise.all((['dot', 'grok', 'cue', 'hermes', 'ds-bot'] as const).map(async (platform) => {
      const auth = authBridges[platform]
      if (!auth?.clearAuth) return
      await attempt(PLATFORM_LABELS[platform], async () => {
        if ((await auth.clearAuth('*')).signedIn) throw new Error(t('The account is still signed in'))
      })
    }))
    if (muse?.setProxy) {
      await Promise.all([...proxyIds].map((id) => attempt(t('Proxy for {account}', { account: id }), async () => {
        const proxy = await muse.setProxy(id, { mode: 'direct' })
        if (proxy.mode !== 'direct' || proxy.hasPassword) throw new Error(t('Proxy credentials are still present'))
      })))
    }
    await attempt(t('Proxy pool'), async () => {
      if (!muse?.clearProxyPool) throw new Error(t('Desktop credential cleanup is unavailable'))
      if ((await muse.clearProxyPool()).length) throw new Error(t('Proxy credentials are still present'))
    })
  }

  await attempt(t('Security vault'), clearVaultCredentials)
  const vault = bridge?.vault
  if (vault?.status) {
    await attempt(t('Security vault'), async () => {
      const { stores } = await vault.status()
      for (const store of stores) {
        if (PURGED_VAULT_STORES.has(store.id) && (store.entryCount > 0 || (store.exists && store.modeOctal === null))) {
          failures.push(t('Could not verify that {file} is empty', { file: store.fileName }))
        }
      }
    })
  }
  if (signedOutIds.size) {
    useBotStore.setState((current) => {
      const accounts = { ...current.accounts }
      for (const id of signedOutIds) {
        const account = accounts[id]
        if (account) accounts[id] = { ...account, status: 'offline', statusDetail: 'Signed out', unread: 0 }
      }
      return { accounts }
    })
  }
  if (failures.length) throw new Error(t('Cleanup completed with errors') + '\n' + failures.join('\n'))
}

interface GeneralSettingsSectionProps {
  active: boolean
  navigationRevision: number
  activity: SettingsActivity
  cleaning: RefObject<boolean>
  onCleanupStart: () => void
  onCleanupSuccess: () => void
  onCleanupFinish: () => void
}

export function GeneralSettingsSection({
  active, navigationRevision, activity, cleaning, onCleanupStart, onCleanupSuccess, onCleanupFinish
}: GeneralSettingsSectionProps) {
  const tr = useT()
  const { busy, setBusy, setError, setHint } = activity
  const setOnboardingOpen = useBotStore((s) => s.setOnboardingOpen)
  const groups = useBotStore((s) => s.groups)
  const bots = useBotStore((s) => s.bots)
  const addGroup = useBotStore((s) => s.addGroup)
  const renameGroup = useBotStore((s) => s.renameGroup)
  const removeGroup = useBotStore((s) => s.removeGroup)

  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const locale = usePrefsStore((s) => s.locale)
  const setLocale = usePrefsStore((s) => s.setLocale)

  const [newGroupName, setNewGroupName] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')

  const [confirmWipeCreds, setConfirmWipeCreds] = useState(false)
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  const [version, setVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const checking = useRef(false)

  useLayoutEffect(() => {
    setConfirmWipeCreds(false)
    setConfirmResetAll(false)
  }, [navigationRevision])

  useEffect(() => {
    const updates = getBridge()?.updates
    if (updates?.version) void updates.version().then(setVersion, () => {})
  }, [])

  if (!active) return null

  const handleCheckForUpdates = async () => {
    if (checking.current) return
    const updates = getBridge()?.updates
    setHint(undefined)
    setError(undefined)
    if (!updates?.check) {
      setError(tr('Update checks require the desktop app'))
      return
    }
    checking.current = true
    setCheckingUpdate(true)
    try {
      if (!(await updates.check()).ok) throw new Error(tr('Something went wrong.'))
    } catch (err) {
      setError(tr('Could not check for updates: {reason}', { reason: errorMessage(err) }))
    } finally {
      checking.current = false
      setCheckingUpdate(false)
    }
  }

  const handleExportSanitizedConfig = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: version || '0.2.8',
      sanitized: true,
      groups,
      bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        platformId: b.platformId,
        emoji: b.emoji,
        groupId: b.groupId,
        pinned: Boolean(b.pinned)
      })),
      accounts: Object.values(useBotStore.getState().accounts).map((a) => ({
        id: a.id,
        platformId: a.platformId,
        displayName: a.displayName,
        status: a.status
      }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `botark-workspace-sanitized-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setHint('已导出不含任何 Token、Cookie 或密码的脱敏工作区结构文件')
  }

  const handleWipeAllCredentials = async () => {
    if (!confirmWipeCreds) {
      setConfirmWipeCreds(true)
      return
    }
    setConfirmWipeCreds(false)
    await handleCleanup(false)
  }

  const handleFactoryReset = async () => {
    if (!confirmResetAll) {
      setConfirmResetAll(true)
      return
    }
    setConfirmResetAll(false)
    await handleCleanup(true)
  }

  const handleCleanup = async (factoryReset: boolean) => {
    if (cleaning.current) return
    cleaning.current = true
    setBusy(true)
    setHint(undefined)
    setError(undefined)
    onCleanupStart()
    try {
      await purgeCredentials()
      if (factoryReset) {
        const workspace = useBotStore.getState()
        await workspace.resetWorkspace()
        localStorage.removeItem('bothub-workspace-v1')
        if (localStorage.getItem('bothub-workspace-v1') !== null) {
          throw new Error(tr('Could not remove the saved workspace'))
        }
      }
      onCleanupSuccess()
      setHint(factoryReset
        ? tr('Workspace, collaboration rooms, and saved credentials cleared')
        : tr('Saved account credentials, browser sessions, proxies, and collaboration rooms cleared'))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      cleaning.current = false
      onCleanupFinish()
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('General & Security')}</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          {tr('Adjust the appearance, manage sidebar groups, and clear local credentials.')}
        </p>
      </div>

      {/* Appearance & Version */}
      <div className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-soft">
        <div className="flex items-center justify-between px-4 py-3.5">
          <div>
            <p className="text-[14px] font-medium text-ink">{tr('Appearance')}</p>
            <p className="text-[12px] text-ink-muted">{tr('Grok Bot Sand Light and Sand Dark themes')}</p>
          </div>
          <SegmentedControl<ThemePref>
            size="sm"
            value={theme}
            onValueChange={(id) => setTheme(id)}
            options={[
              { value: 'system', label: tr('Match system') },
              { value: 'light', label: tr('Light') },
              { value: 'dark', label: tr('Dark') }
            ]}
          />
        </div>

        <div className="flex items-center justify-between px-4 py-3.5">
          <div>
            <p className="text-[14px] font-medium text-ink">{tr('Language')}</p>
            <p className="text-[12px] text-ink-muted">{tr('Choose the display language')}</p>
          </div>
          <SegmentedControl<Locale>
            size="sm"
            value={locale}
            onValueChange={(id) => {
              if (id === locale) return
              setLocale(id)
              window.location.reload()
            }}
            options={[
              { value: 'zh', label: '简体中文' },
              { value: 'en', label: 'English' }
            ]}
          />
        </div>

        <div className="flex items-center justify-between px-4 py-3.5">
          <div>
            <p className="text-[14px] font-medium text-ink">{tr('Current version')}</p>
            <p className="font-mono text-[12px] text-ink-muted">BotArk {version || '0.11.1'}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={checkingUpdate}
            onClick={() => void handleCheckForUpdates()}
          >
            <RefreshCw className={cn('size-3.5', checkingUpdate && 'animate-spin')} />
            {tr('Check for updates')}
          </Button>
        </div>

        <div className="flex items-center justify-between px-4 py-3.5">
          <p className="text-[14px] font-medium text-ink">{tr('Prompt library')}</p>
          <Button size="sm" variant="secondary" onClick={() => usePromptStore.getState().setLibraryOpen(true)}>
            {tr('Manage prompt templates…')}
          </Button>
        </div>

        <div className="flex items-center justify-between px-4 py-3.5">
          <div>
            <p className="text-[14px] font-medium text-ink">{tr('BotArk guide')}</p>
            <p className="text-[12px] text-ink-muted">
              {tr('Learn how BotArk connects accounts, runs collaboration rooms, and uses MCP tools.')}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOnboardingOpen(true)}
          >
            <Sparkles className="size-3.5 text-accent-600" />
            {tr('Open the onboarding guide')}
          </Button>
        </div>
      </div>

      {/* Sidebar Section / Group Management */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5">
          <span className="text-[13px] font-medium text-ink">侧边栏分组管理 ({groups.length})</span>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (!newGroupName.trim()) return
              addGroup(newGroupName.trim())
              setNewGroupName('')
            }}
          >
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="新建分组名称…"
              className="h-7 rounded-lg border border-line bg-canvas px-2.5 text-[12px] text-ink outline-none focus:border-accent-600"
            />
            <Button size="sm" variant="secondary" type="submit" disabled={!newGroupName.trim()}>
              <FolderPlus className="size-3.5" /> 新建分组
            </Button>
          </form>
        </div>
        <ul className="divide-y divide-line">
          {groups.map((g) => {
            const count = bots.filter((b) => b.groupId === g.id).length
            const isEditing = editingGroupId === g.id
            return (
              <li key={g.id} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingGroupName}
                      onChange={(e) => setEditingGroupName(e.target.value)}
                      onBlur={() => {
                        if (editingGroupName.trim()) renameGroup(g.id, editingGroupName.trim())
                        setEditingGroupId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          if (editingGroupName.trim()) renameGroup(g.id, editingGroupName.trim())
                          setEditingGroupId(null)
                        }
                      }}
                      className="h-7 rounded border border-accent-600 bg-canvas px-2 text-[13px] text-ink outline-none"
                    />
                  ) : (
                    <span className="font-medium text-ink">{g.name}</span>
                  )}
                  <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
                    {count} 个 Bot
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingGroupId(g.id)
                      setEditingGroupName(g.name)
                    }}
                  >
                    重命名
                  </Button>
                  {groups.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeGroup(g.id)}
                      title="删除分组（组内 Bot 自动移至默认分组）"
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

      {/* Live OS Keychain & Security Vault Audit */}
      <SecurityVaultCenter />

      {/* Security & Sanitization Center */}
      <div className="overflow-hidden rounded-2xl border border-status-error/25 bg-surface shadow-soft">
        <div className="border-b border-line bg-status-error/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-status-error" />
            <h3 className="text-[14px] font-semibold text-ink">{tr('Credential security')}</h3>
          </div>
          <p className="mt-1 text-[12px] text-ink-secondary">
            {tr('BotArk encrypts OAuth tokens, refresh tokens, and proxy passwords using system secure storage.')}
          </p>
        </div>
        <div className="divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <div>
              <p className="text-[13.5px] font-medium text-ink">{tr('Export sanitized workspace metadata')}</p>
              <p className="text-[12px] text-ink-muted">
                {tr('The export contains group, bot, and account metadata.')}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={handleExportSanitizedConfig}>
              <Download className="size-3.5" /> {tr('Export sanitized JSON')}
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <div>
              <p className="text-[13.5px] font-medium text-ink">{tr('Clear saved credentials')}</p>
              <p className="text-[12px] text-ink-muted">
                {tr('Sign out of all accounts and clear saved credentials, browser sessions, proxies, and collaboration rooms.')}
              </p>
            </div>
            <Button
              size="sm"
              variant={confirmWipeCreds ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => void handleWipeAllCredentials()}
              className={cn(confirmWipeCreds && 'bg-status-error text-white hover:bg-status-error/90')}
            >
              <Trash2 className="size-3.5" />
              {tr(confirmWipeCreds ? 'Confirm credential cleanup' : 'Clear saved credentials')}
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
            <div>
              <p className="text-[13.5px] font-medium text-ink">{tr('Factory reset')}</p>
              <p className="text-[12px] text-ink-muted">
                {tr('Delete local bots, accounts, chat history, collaboration rooms, and saved credentials.')}
              </p>
            </div>
            <Button
              size="sm"
              variant={confirmResetAll ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => void handleFactoryReset()}
              className={cn(confirmResetAll && 'bg-status-error text-white hover:bg-status-error/90')}
            >
              <Trash2 className="size-3.5" />
              {tr(confirmResetAll ? 'Confirm factory reset' : 'Factory reset')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
