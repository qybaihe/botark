import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Download,
  FileUp,
  FolderPlus,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Shuffle,
  Smartphone,
  Sparkles,
  Trash2,
  Users
} from 'lucide-react'
import type { PlatformId } from '@adapters/types'
import type { MuseProxyMode, MuseProxyPoolItemView, MuseProxyView } from '@shared/ipc'
import { createId } from '@shared/id'
import { SecurityVaultCenter } from '@/components/info/SecurityVaultCard'
import { PaneHeader } from '@/components/layout/PaneHeader'
import { MuseBatchImport } from '@/components/add-bot/MuseBatchImport'
import { ArkMobileLinkSvg, ArkRelayOrbSvg } from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { Dialog } from '@/components/ui/Dialog'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useT, t } from '@/lib/i18n'
import { platformIcon } from '@/lib/platformIcons'
import { HermesAccountsSettingsPanel } from '@/components/hermes/HermesAccountsSettingsPanel'
import { MobileSyncSettingsPanel } from '@/components/mobile-sync/MobileSyncSettingsPanel'
import { McpSettingsSection } from '@/components/settings/McpSettingsSection'
import { NEW_ROOM_ID } from '@/rooms/RoomView'
import { useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import { usePrefsStore, type Locale, type ThemePref } from '@/store/prefsStore'

type SettingsTab =
  | 'overview'
  | 'muse-accounts'
  | 'dot-accounts'
  | 'grok-accounts'
  | 'hark-accounts'
  | 'hermes-accounts'
  | 'antigravity-accounts'
  | 'cue-accounts'
  | 'mcp-hub'
  | 'mobile-sync'
  | 'proxy-pool'
  | 'general'

interface DotStoredMeta {
  accountId: string
  handle?: string
  displayName?: string
  planType?: string
  activeDotId?: string
  roomId?: string
  mode?: 'dot' | 'native'
  model?: string
  effort?: string
  hasRefreshToken?: boolean
  expiresAtMs?: number
  updatedAt?: number
  hasProxy?: boolean
}

const PROXY_PLACEHOLDER = `# 支持每行一个代理（自动识别格式）：
https://user:pass@proxy.example.com:443
http://user:pass@127.0.0.1:7890
socks5://user:pass@127.0.0.1:1080
socks5h://127.0.0.1:1080
192.168.1.10:1080:username:password
127.0.0.1:7890`

const PLATFORM_LABELS: Record<PlatformId, string> = {
  'meta-muse': 'Meta Muse',
  dot: 'ChatGPT Dot',
  grok: 'Grok Bot',
  hark: 'Hark Pro',
  hermes: 'Hermes',
  antigravity: 'Antigravity',
  cue: 'Cue (Manus)'
}

export function SettingsView() {
  const tr = useT()
  const settingsTab = useBotStore((s) => s.settingsTab)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const setOnboardingOpen = useBotStore((s) => s.setOnboardingOpen)
  const groups = useBotStore((s) => s.groups)
  const bots = useBotStore((s) => s.bots)
  const collabRooms = useRooms((s) => s.rooms)
  const accounts = useBotStore((s) => s.accounts)
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const openMuseLogin = useBotStore((s) => s.openMuseLogin)
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const openHarkLogin = useBotStore((s) => s.openHarkLogin)
  const openDotLogin = useBotStore((s) => s.openDotLogin)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const renameBot = useBotStore((s) => s.renameBot)
  const addGroup = useBotStore((s) => s.addGroup)
  const renameGroup = useBotStore((s) => s.renameGroup)
  const removeGroup = useBotStore((s) => s.removeGroup)
  const moveBotToGroup = useBotStore((s) => s.moveBotToGroup)
  const togglePinBot = useBotStore((s) => s.togglePinBot)
  const setGrokAccessToken = useBotStore((s) => s.setGrokAccessToken)
  const syncGrokAccountBots = useBotStore((s) => s.syncGrokAccountBots)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)
  const clearAllCredentials = useBotStore((s) => s.clearAllCredentials)
  const resetWorkspace = useBotStore((s) => s.resetWorkspace)

  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const locale = usePrefsStore((s) => s.locale)
  const setLocale = usePrefsStore((s) => s.setLocale)

  const [pool, setPool] = useState<MuseProxyPoolItemView[]>([])
  const [accountProxies, setAccountProxies] = useState<Record<string, MuseProxyView>>({})
  const [dotMetaMap, setDotMetaMap] = useState<Record<string, DotStoredMeta>>({})
  const [rawProxyText, setRawProxyText] = useState('')
  const [defaultMode, setDefaultMode] = useState<Exclude<MuseProxyMode, 'direct'>>('socks5')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const [batchOpen, setBatchOpen] = useState(false)

  // Overview filters & inline editing
  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<
    'all' | 'meta-muse' | 'dot' | 'grok' | 'hark' | 'hermes' | 'antigravity'
  >('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [editingBotId, setEditingBotId] = useState<string | null>(null)
  const [editingBotName, setEditingBotName] = useState('')

  // Platform credential import states
  const [grokTokenInput, setGrokTokenInput] = useState('')
  const [grokRefreshInput, setGrokRefreshInput] = useState('')
  const [grokTargetAccountId, setGrokTargetAccountId] = useState<string>('__new__')

  const [dotRawInput, setDotRawInput] = useState('')
  const [dotRefreshInput, setDotRefreshInput] = useState('')
  const [dotTargetAccountId, setDotTargetAccountId] = useState<string>('__new__')
  const [dotMigrateMemory, setDotMigrateMemory] = useState(true)

  const [harkRawInput, setHarkRawInput] = useState('')
  const [harkTargetAccountId, setHarkTargetAccountId] = useState<string>('__new__')

  // Group management states
  const [newGroupName, setNewGroupName] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')

  // Security confirmation states
  const [confirmWipeCreds, setConfirmWipeCreds] = useState(false)
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  const [version, setVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dotInputRef = useRef<HTMLTextAreaElement>(null)

  const allAccounts = useMemo(() => Object.values(accounts), [accounts])
  const museBots = useMemo(() => bots.filter((b) => b.platformId === 'meta-muse'), [bots])
  const museAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'meta-muse'), [allAccounts])
  const dotBots = useMemo(() => bots.filter((b) => b.platformId === 'dot'), [bots])
  const dotAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'dot'), [allAccounts])
  const grokBots = useMemo(() => bots.filter((b) => b.platformId === 'grok'), [bots])
  const grokAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'grok'), [allAccounts])
  const harkBots = useMemo(() => bots.filter((b) => b.platformId === 'hark'), [bots])
  const harkAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'hark'), [allAccounts])
  const hermesBots = useMemo(() => bots.filter((b) => b.platformId === 'hermes'), [bots])
  const hermesAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'hermes'), [allAccounts])
  const antigravityBots = useMemo(() => bots.filter((b) => b.platformId === 'antigravity'), [bots])
  const antigravityAccounts = useMemo(
    () => allAccounts.filter((a) => a.platformId === 'antigravity'),
    [allAccounts]
  )
  const cueAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'cue'), [allAccounts])
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const importCueCredentials = useBotStore((s) => s.importCueCredentials)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const [cueCredentialInput, setCueCredentialInput] = useState('')
  const [cueTargetAccountId, setCueTargetAccountId] = useState('__new__')

  const onlineAccountsCount = useMemo(
    () => allAccounts.filter((a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention').length,
    [allAccounts]
  )

  const refreshProxiesAndPool = useCallback(async () => {
    const muse = getBridge()?.muse
    if (!muse) return
    try {
      if (muse.listProxyPool) {
        const items = await muse.listProxyPool()
        setPool(items)
      }
      if (muse.getProxy) {
        const nextMap: Record<string, MuseProxyView> = {}
        const allAccs = Object.values(useBotStore.getState().accounts)
        await Promise.all(
          allAccs.map(async (acc) => {
            try {
              nextMap[acc.id] = await muse.getProxy(acc.id)
            } catch {
              /* ignore */
            }
          })
        )
        setAccountProxies(nextMap)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshDotStoredMeta = useCallback(async () => {
    const dot = getBridge()?.dot
    if (!dot?.rpc) return
    try {
      const res = await dot.rpc({ accountId: '_', op: 'listStoredAccounts' })
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
  }, [])

  useEffect(() => {
    void refreshProxiesAndPool()
  }, [refreshProxiesAndPool, museAccounts.length])

  useEffect(() => {
    void refreshDotStoredMeta()
  }, [refreshDotStoredMeta, dotAccounts.length, settingsTab])

  useEffect(() => {
    const updates = getBridge()?.updates
    if (!updates) return
    void updates.version().then(setVersion)
    return updates.onEvent((ev) => setCheckingUpdate(ev.type === 'checking'))
  }, [])

  const filteredBots = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return bots.filter((bot) => {
      if (platformFilter !== 'all' && bot.platformId !== platformFilter) return false
      const acc = accounts[bot.activeAccountId]
      const isOnline = acc?.status === 'online' || acc?.status === 'busy' || acc?.status === 'attention'
      if (statusFilter === 'online' && !isOnline) return false
      if (statusFilter === 'offline' && isOnline) return false
      if (!q) return true
      const hay = `${bot.name} ${acc?.displayName ?? ''} ${acc?.handle ?? ''} ${bot.activeAccountId}`.toLowerCase()
      return hay.includes(q)
    })
  }, [bots, accounts, searchQuery, platformFilter, statusFilter])

  const handleReconnectAll = async (onlyOffline = false) => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const targets = allAccounts.filter((a) => (onlyOffline ? a.status === 'offline' || a.status === 'error' : true))
      await Promise.all(targets.map((a) => connectAccount(a.id).catch(() => undefined)))
      await refreshDotStoredMeta()
      setHint(`已完成 ${targets.length} 个账号的连接巡检与会话同步`)
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
      const ids = museAccounts.map((a) => a.id)
      const keepIds = [
        ...harkAccounts,
        ...grokAccounts,
        ...dotAccounts,
        ...antigravityAccounts,
        ...hermesAccounts
      ].map((a) => a.id)
      if (ids.length > 0 && muse.assignProxyPool) {
        const assigned = await muse.assignProxyPool(ids, keepIds)
        setPool(assigned.items)
        setHint(`已导入 ${res.added} 个代理（池共 ${res.total} 个），并已自动为 ${assigned.assignedCount} 个 Muse 账号一对一绑定代理`)
      } else {
        setHint(`已导入 ${res.added} 个代理（池共 ${res.total} 个）；新建或导入 Muse 账号时将自动一对一分配`)
      }
      await refreshProxiesAndPool()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleAutoAssignAll = async () => {
    const muse = getBridge()?.muse
    if (!muse?.assignProxyPool) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const ids = museAccounts.map((a) => a.id)
      const keepIds = [
        ...harkAccounts,
        ...grokAccounts,
        ...dotAccounts,
        ...antigravityAccounts,
        ...hermesAccounts
      ].map((a) => a.id)
      const res = await muse.assignProxyPool(ids, keepIds)
      setPool(res.items)
      setHint(`已为 ${res.assignedCount} / ${ids.length} 个 Muse 账号完成一对一代理匹配`)
      await refreshProxiesAndPool()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleRemovePoolItem = async (id: string) => {
    const muse = getBridge()?.muse
    if (!muse?.removeProxyPoolItem) return
    const next = await muse.removeProxyPoolItem(id)
    setPool(next)
  }

  const handleClearPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.clearProxyPool) return
    const next = await muse.clearProxyPool()
    setPool(next)
    setHint('已清空代理池')
  }

  const handleQuickAddMuseAccount = async () => {
    const accountId = createId('acc')
    const botId = createId('bot')
    const index = museBots.length + 1
    const muse = getBridge()?.muse
    if (muse?.assignProxyPool) {
      const ids = [...museAccounts.map((a) => a.id), accountId]
      const keepIds = [
        ...harkAccounts,
        ...grokAccounts,
        ...dotAccounts,
        ...antigravityAccounts,
        ...hermesAccounts
      ].map((a) => a.id)
      await muse.assignProxyPool(ids, keepIds).catch(() => undefined)
    }
    addBot({
      id: botId,
      platformId: 'meta-muse',
      name: `Muse ${index}`,
      accounts: [{ key: accountId, accountId, displayName: `Muse ${index}`, handle: '' }],
      background: true
    })
    await refreshProxiesAndPool()
    void openMuseLogin(accountId)
  }

  const handleQuickAddGrokAccount = (openInBrowser = false) => {
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleQuickAddHarkAccount = async () => {
    const accountId = createId('acc')
    const botId = createId('bot')
    const index = harkBots.length + 1
    const muse = getBridge()?.muse
    if (muse?.assignProxyPool) {
      const ids = [...museAccounts.map((a) => a.id), ...harkAccounts.map((a) => a.id), accountId]
      const keepIds = [...grokAccounts, ...dotAccounts, ...antigravityAccounts, ...hermesAccounts].map((a) => a.id)
      await muse.assignProxyPool(ids, keepIds).catch(() => undefined)
    }
    addBot({
      id: botId,
      platformId: 'hark',
      name: `Hark ${index}`,
      accounts: [{ key: accountId, accountId, displayName: `Hark ${index}`, handle: '' }],
      background: true
    })
    await refreshProxiesAndPool()
    void openHarkLogin(accountId)
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
      const st = await hark.importCredentials({
        accountId: targetId,
        rawInput: harkRawInput.trim()
      })
      if (!st.signedIn) {
        setError('未检测到有效 Hark 会话，请检查 Cookie（含 __Secure-hark.session_token）或 Token 是否有效')
        return
      }
      const label = st.displayName || st.handle || `Hark ${harkBots.length + 1}`
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleQuickAddDotAccount = () => {
    const accountId = createId('acc_dot')
    const botId = createId('bot')
    const index = dotBots.length + 1
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
        const ownerBot = bots.find((b) => b.accountIds.includes(accountId))
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
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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
      accounts: allAccounts.map((a) => ({
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
    setBusy(true)
    setError(undefined)
    try {
      await clearAllCredentials()
      setPool([])
      setAccountProxies({})
      setDotMetaMap({})
      setConfirmWipeCreds(false)
      setHint('已彻底清除所有平台的登录凭据、OAuth Token、会话 Cookie 与代理池密码')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleFactoryReset = async () => {
    if (!confirmResetAll) {
      setConfirmResetAll(true)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await resetWorkspace()
      setPool([])
      setAccountProxies({})
      setDotMetaMap({})
      setConfirmResetAll(false)
      setHint('已清空全部敏感凭据、测试账号与对话记录，应用已恢复至可发布的纯净初始状态')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const NAV: Array<{ id: SettingsTab; label: string; icon: typeof Users; platformId?: PlatformId; count?: number }> = [
    { id: 'overview', label: '总览', icon: LayoutDashboard, count: bots.length },
    { id: 'muse-accounts', label: 'Meta Muse', icon: Users, platformId: 'meta-muse', count: museAccounts.length },
    { id: 'dot-accounts', label: 'ChatGPT Dot', icon: Users, platformId: 'dot', count: dotAccounts.length },
    { id: 'grok-accounts', label: 'Grok Bot', icon: Users, platformId: 'grok', count: grokAccounts.length },
    { id: 'hark-accounts', label: 'Hark', icon: Users, platformId: 'hark', count: harkAccounts.length },
    { id: 'hermes-accounts', label: 'Hermes', icon: Server, platformId: 'hermes', count: hermesAccounts.length },
    {
      id: 'antigravity-accounts',
      label: 'Antigravity',
      icon: Users,
      platformId: 'antigravity',
      count: antigravityAccounts.length
    },
    {
      id: 'cue-accounts',
      label: 'Cue (Manus)',
      icon: Sparkles,
      platformId: 'cue',
      count: cueAccounts.length
    },
    { id: 'mcp-hub', label: 'MCP 与工作区', icon: Server },
    { id: 'mobile-sync', label: '手机同步', icon: Smartphone },
    { id: 'proxy-pool', label: '代理池', icon: Server, count: pool.length },
    { id: 'general', label: '常规与安全', icon: Settings }
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
            返回
          </button>
          <h1 className="text-[15px] font-semibold tracking-tight text-ink">设置与账号</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || allAccounts.length === 0}
            onClick={() => void handleReconnectAll(false)}
          >
            <Activity className={cn('size-3.5', busy && 'animate-spin')} /> 健康巡检
          </Button>
        </div>
      </PaneHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Settings Sub-navigation */}
        <aside className="flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-3">
          {NAV.map((item) => {
            const Icon = item.icon
            const pIcon = platformIcon(item.platformId)
            const active = settingsTab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSettingsOpen(true, item.id)
                  setHint(undefined)
                  setError(undefined)
                  setConfirmWipeCreds(false)
                  setConfirmResetAll(false)
                }}
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
              <div className="mb-4 rounded-xl border border-status-error/25 bg-status-error/8 px-3.5 py-2.5 text-[13px] text-status-error">
                {error}
              </div>
            )}
            {hint && (
              <div className="mb-4 rounded-xl border border-accent-600/20 bg-accent-50 px-3.5 py-2.5 text-[13px] text-ink">
                {hint}
              </div>
            )}

            {settingsTab === 'overview' && (
              <div className="flex flex-col gap-4 animate-veil-in">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[17px] font-semibold tracking-tight text-ink">总览</h2>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || allAccounts.length === 0}
                      onClick={() => void handleReconnectAll(true)}
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
                    <p className="text-[11.5px] text-ink-muted">协作群聊</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{collabRooms.length}</p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
                    <p className="text-[11.5px] text-ink-muted">加密代理池</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{pool.length}</p>
                  </div>
                </div>

                {/* Platform Breakdown Cards */}
                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
                  {(
                    [
                      { id: 'meta-muse', tab: 'muse-accounts', name: 'Meta Muse', list: museAccounts, desc: 'Noise WSS' },
                      { id: 'dot', tab: 'dot-accounts', name: 'ChatGPT Dot', list: dotAccounts, desc: 'Calpico Room' },
                      { id: 'grok', tab: 'grok-accounts', name: 'Grok Bot', list: grokAccounts, desc: 'Sand PKCE' },
                      { id: 'hark', tab: 'hark-accounts', name: 'Hark Pro', list: harkAccounts, desc: '项目空间' },
                      { id: 'hermes', tab: 'hermes-accounts', name: 'Hermes', list: hermesAccounts, desc: '本地网关' },
                      {
                        id: 'antigravity',
                        tab: 'antigravity-accounts',
                        name: 'Antigravity',
                        list: antigravityAccounts,
                        desc: 'Google Cloud'
                      }
                    ] as const
                  ).map((p) => {
                    const onCount = p.list.filter(
                      (a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention'
                    ).length
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSettingsOpen(true, p.tab)}
                        className="press flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left shadow-hairline transition-colors hover:border-line-strong hover:bg-hover/50"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {platformIcon(p.id) && (
                            <img
                              src={platformIcon(p.id)}
                              alt=""
                              aria-hidden
                              draggable={false}
                              className="size-7 shrink-0 rounded-lg object-cover ring-1 ring-line"
                            />
                          )}
                          <div className="min-w-0">
                            <span className="block truncate text-[13.5px] font-semibold tracking-tight text-ink">
                              {p.name}
                            </span>
                            <span className="block truncate text-[11px] text-ink-muted">{p.desc}</span>
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] font-medium text-ink-secondary tabular-nums">
                          {onCount}/{p.list.length}
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
                      多 Agent 协作群聊{collabRooms.length > 0 ? ` · ${collabRooms.length} 个房间` : ''}
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
                    新建群聊
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
                          { value: 'meta-muse', label: `Meta Muse (${museBots.length})` },
                          { value: 'dot', label: `ChatGPT Dot (${dotBots.length})` },
                          { value: 'grok', label: `Grok Bot (${grokBots.length})` },
                          { value: 'hark', label: `Hark Pro (${harkBots.length})` },
                          { value: 'hermes', label: `Hermes (${hermesBots.length})` },
                          { value: 'antigravity', label: `Antigravity (${antigravityBots.length})` }
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
            )}

            {settingsTab === 'muse-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Muse 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      独立隔离多账号会话，支持批量导入与自动分配代理。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setBatchOpen(true)}>
                      批量导入账号 (邮箱 | 收件箱)
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => void handleQuickAddMuseAccount()}>
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
                      {museAccounts.filter((a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention').length}
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
                        配置代理池 →
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
                      <Button variant="primary" size="sm" onClick={() => setBatchOpen(true)}>
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
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleAutoAssignAll()}>
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
                        const ownerBot = bots.find((b) => b.accountIds.includes(acc.id))
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

            {settingsTab === 'dot-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">ChatGPT Dot 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      支持网页登录或导入凭据，自动加密保存与续期。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="sm" onClick={handleQuickAddDotAccount}>
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
                      {dotAccounts.filter((a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention').length}
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
                            const ownerBot = bots.find((b) => b.accountIds.includes(acc.id))
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
                        const ownerBot = bots.find((b) => b.accountIds.includes(acc.id))
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
            )}

            {settingsTab === 'grok-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Grok Bot 账号管理</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      一个 Grok 账号下可包含多个 Bot，登录后会自动按 Bot 展开在左侧对话列表中。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" onClick={() => handleQuickAddGrokAccount(false)}>
                      <Plus className="size-3.5" /> 登录窗口添加账号
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => handleQuickAddGrokAccount(true)}>
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
                        const accountBots = bots.filter(
                          (b) => b.platformId === 'grok' && b.accountIds.includes(acc.id)
                        )
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
            )}

            {settingsTab === 'hark-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Hark 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      支持内置窗口登录或直接粘贴会话凭据接入。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" onClick={() => void handleQuickAddHarkAccount()}>
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
                          const ownerBot = bots.find((b) => b.accountIds.includes(acc.id))
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
                        const ownerBot = bots.find((b) => b.accountIds.includes(acc.id))
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
            )}

            {settingsTab === 'hermes-accounts' && <HermesAccountsSettingsPanel />}

            {settingsTab === 'antigravity-accounts' && (
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
                        const bot = antigravityBots.find((b) => b.accountIds.includes(acc.id))
                        const online =
                          acc.status === 'online' || acc.status === 'busy' || acc.status === 'attention'
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
            )}

            {settingsTab === 'mobile-sync' && <MobileSyncSettingsPanel />}

            {settingsTab === 'proxy-pool' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">代理池</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      批量导入代理并按「一号一代理」自动分配，本地钥匙串加密保存。
                    </p>
                  </div>
                  {pool.length > 0 && museAccounts.length > 0 && (
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleAutoAssignAll()}>
                      <Shuffle className="size-3.5" /> 一键匹配给全部 Muse 账号 ({museAccounts.length})
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
                  <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                    <span>代理池列表 ({pool.length})</span>
                    {pool.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => void handleClearPool()}>
                        清空代理池
                      </Button>
                    )}
                  </div>
                  {pool.length === 0 ? (
                    <p className="py-8 text-center text-[13px] text-ink-muted">代理池为空，请在上方粘贴导入代理</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {pool.map((item, idx) => {
                        const assignedAcc = item.assignedAccountId ? accounts[item.assignedAccountId] : undefined
                        const ownerBot = item.assignedAccountId
                          ? bots.find((b) => b.accountIds.includes(item.assignedAccountId!))
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
                              {assignedAcc || ownerBot ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-status-online/10 px-2.5 py-0.5 text-[11.5px] font-medium text-status-online-ink">
                                  已绑定 → {ownerBot?.name || assignedAcc?.displayName || item.assignedAccountId}
                                </span>
                              ) : (
                                <span className="rounded-full bg-sunken px-2.5 py-0.5 text-[11.5px] text-ink-muted">
                                  空闲待分配
                                </span>
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
            )}

            {settingsTab === 'general' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div>
                  <h2 className="text-[17px] font-semibold tracking-tight text-ink">常规、侧栏分组与凭据安全</h2>
                  <p className="mt-1 text-[13px] text-ink-secondary">
                    调整界面外观、管理侧边栏分组，以及在发布/交付前一键脱敏或清除所有本机敏感凭据。
                  </p>
                </div>

                {/* Appearance & Version */}
                <div className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-soft">
                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">{tr('Appearance')}</p>
                      <p className="text-[12px] text-ink-muted">Grok Bot Sand Light / Sand Dark 配色系统</p>
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
                      <p className="text-[12px] text-ink-muted">切换界面显示语言</p>
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
                      <p className="text-[14px] font-medium text-ink">当前版本</p>
                      <p className="font-mono text-[12px] text-ink-muted">BotArk {version || '0.11.1'}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={checkingUpdate}
                      onClick={() => {
                        setCheckingUpdate(true)
                        void getBridge()?.updates?.check()
                      }}
                    >
                      <RefreshCw className={cn('size-3.5', checkingUpdate && 'animate-spin')} />
                      {tr('Check for updates')}
                    </Button>
                  </div>

                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">新手引导与产品架构导览</p>
                      <p className="text-[12px] text-ink-muted">
                        查看六大原生协议、多 Agent 协作群聊、受控本地 MCP 与钥匙串加密沙盒架构指南
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOnboardingOpen(true)}
                    >
                      <Sparkles className="size-3.5 text-accent-600" />
                      打开新手引导
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
                      <h3 className="text-[14px] font-semibold text-ink">凭据安全与上线前一键脱敏</h3>
                    </div>
                    <p className="mt-1 text-[12px] text-ink-secondary">
                      所有 OAuth Token、Refresh Token 与代理密码均通过系统 Keychain (`safeStorage` + `0600` 权限) 加密保存。在打包分发或推送上线前，可在此一键抹除所有本机测试凭据。
                    </p>
                  </div>
                  <div className="divide-y divide-line">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div>
                        <p className="text-[13.5px] font-medium text-ink">导出脱敏工作区结构</p>
                        <p className="text-[12px] text-ink-muted">
                          仅导出分组与 Bot 列表元数据（自动剥离所有 Token、Cookie、聊天隐私与代理密码）
                        </p>
                      </div>
                      <Button size="sm" variant="secondary" onClick={handleExportSanitizedConfig}>
                        <Download className="size-3.5" /> 导出脱敏 JSON
                      </Button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div>
                        <p className="text-[13.5px] font-medium text-ink">移除所有敏感凭据（保留 Bot 列表）</p>
                        <p className="text-[12px] text-ink-muted">
                          一键退出全部平台账号并清空本机 `dot-accounts.json`、`grok-sand-tokens.json`、浏览器分区 Cookie 与代理池
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
                        {confirmWipeCreds ? '确认清除所有凭据' : '清除全部敏感凭据'}
                      </Button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div>
                        <p className="text-[13.5px] font-medium text-ink">恢复出厂纯净状态（清空工作区 + 全部凭据）</p>
                        <p className="text-[12px] text-ink-muted">
                          彻底删除本机所有测试 Bot、账号、聊天记录与加密凭据，恢复至首次安装时的空白工作区
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
                        {confirmResetAll ? '再次点击确认恢复出厂' : '恢复出厂设置'}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {settingsTab === 'cue-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Cue (Manus) 多账号管理</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      支持同时接入多个 Cue 账号（独立浏览器分区、独立设备指纹与代理隔离），并支持将两个或多个 Cue 账号同时编排进同一群聊协同工作。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        const accountId = createId('acc')
                        const botId = createId('bot')
                        addBot({
                          id: botId,
                          platformId: 'cue',
                          name: `Cue ${cueAccounts.length + 1}`,
                          accounts: [{ key: accountId, accountId, displayName: `Cue ${cueAccounts.length + 1}`, handle: '' }],
                          background: true
                        })
                        void openCueLogin(accountId, false)
                      }}
                    >
                      <Plus className="size-3.5" /> 登录窗口添加账号
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const accountId = createId('acc')
                        const botId = createId('bot')
                        addBot({
                          id: botId,
                          platformId: 'cue',
                          name: `Cue ${cueAccounts.length + 1}`,
                          accounts: [{ key: accountId, accountId, displayName: `Cue ${cueAccounts.length + 1}`, handle: '' }],
                          background: true
                        })
                        void openCueLogin(accountId, true)
                      }}
                    >
                      <Globe className="size-3.5" /> 默认浏览器授权
                    </Button>
                  </div>
                </div>

                <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">粘贴凭据导入（Manus API Key / Bearer Token / Cookie / JSON）</span>
                    <Select
                      size="xs"
                      variant="pill"
                      value={cueTargetAccountId}
                      onValueChange={(next) => setCueTargetAccountId(next)}
                      className="max-w-64"
                      options={[
                        { value: '__new__', label: '+ 接入新 Cue 账号（自动创建协同 Bot）' },
                        ...cueAccounts.map((acc) => ({
                          value: acc.id,
                          label: `更新凭据：${acc.handle || acc.displayName || acc.id}`
                        }))
                      ]}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={cueCredentialInput}
                      onChange={(e) => setCueCredentialInput(e.target.value)}
                      placeholder="粘贴 x-manus-api-key (sk-manus-...)、Bearer Token、Cookie (session_id=... / cue_session=...) 或 JSON…"
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
                            const targetId = isNew ? createId('acc') : cueTargetAccountId
                            await importCueCredentials(targetId, cueCredentialInput.trim())
                            setCueCredentialInput('')
                            setCueTargetAccountId('__new__')
                            setHint(isNew ? '已接入新 Cue 账号并同步 Bot 到左侧列表' : '已更新 Cue 账号凭据')
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err))
                          } finally {
                            setBusy(false)
                          }
                        }}
                      >
                        {busy ? '导入中…' : cueTargetAccountId === '__new__' ? '导入并同步 Bot' : '更新凭据'}
                      </Button>
                    </div>
                  </div>
                </div>

                {cueAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
                    <p className="text-[14px] font-medium text-ink">暂无 Cue 账号</p>
                    <p className="max-w-md text-[12.5px] text-ink-muted">
                      可添加两个或多个 Cue 账号，每个账号拥有独立凭据金库与名称，可直接拉入同一群聊协作。
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <ul className="divide-y divide-line">
                      {cueAccounts.map((acc) => {
                        const accountBots = bots.filter(
                          (b) => b.platformId === 'cue' && b.accountIds.includes(acc.id)
                        )
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
                                      {acc.handle || acc.displayName || 'Cue 账号'}
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
                                  onClick={() => void openCueLogin(acc.id, false)}
                                >
                                  登录窗口
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={acc.pending}
                                  onClick={() => void openCueLogin(acc.id, true)}
                                >
                                  浏览器授权
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
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'mcp-hub' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <McpSettingsSection />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Batch Import Dialog */}
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
    </div>
  )
}
