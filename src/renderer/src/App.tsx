import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { adapterRegistry } from '@adapters/registry'
import { ChatArea } from '@/components/chat/ChatArea'
import { AppShell } from '@/components/layout/AppShell'
import { InfoPanel } from '@/components/info/InfoPanel'
import { hasSeenOnboarding } from '@/components/onboarding/onboardingState'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { UpdateBanner } from '@/components/update/UpdateBanner'
import { useGlobalShortcuts } from '@/lib/shortcuts'
import { useRooms } from '@/rooms/roomStore'
import { applySlackConnection } from '@/rooms/slackRooms'
import { startAdapterBridge } from '@/services/adapterBridge'
import { startMobileSyncBridge } from '@/services/mobileSyncBridge'
import { useBotStore } from '@/store/botStore'
import { startPrefsSync, usePrefsStore } from '@/store/prefsStore'

const SettingsView = lazy(() => import('@/components/settings/SettingsView').then(({ SettingsView }) => ({ default: SettingsView })))
const RoomView = lazy(() => import('@/rooms/RoomView').then(({ RoomView }) => ({ default: RoomView })))
const RoomInspectorPanel = lazy(() =>
  import('@/rooms/RoomInspectorPanel').then(({ RoomInspectorPanel }) => ({ default: RoomInspectorPanel }))
)
const AddBotDialog = lazy(() => import('@/components/add-bot/AddBotDialog').then(({ AddBotDialog }) => ({ default: AddBotDialog })))
const OnboardingDialog = lazy(() =>
  import('@/components/onboarding/OnboardingGuide').then(({ OnboardingDialog }) => ({ default: OnboardingDialog }))
)
const CommandPalette = lazy(() =>
  import('@/components/palette/CommandPalette').then(({ CommandPalette }) => ({ default: CommandPalette }))
)

function OnDemandDialog({ open, children }: { open: boolean; children: ReactNode }) {
  const [hasOpened, setHasOpened] = useState(open)
  useEffect(() => {
    if (open) setHasOpened(true)
  }, [open])

  // Keep Radix mounted after the first open so it can animate out and restore focus.
  return open || hasOpened ? <Suspense fallback={null}>{children}</Suspense> : null
}

export default function App() {
  const settingsOpen = useBotStore((s) => s.settingsOpen)
  const addBotOpen = useBotStore((s) => s.addBotOpen)
  const onboardingOpen = useBotStore((s) => s.onboardingOpen)
  const paletteOpen = useBotStore((s) => s.paletteOpen)
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const activeRoom = useRooms((s) => s.rooms.find((r) => r.id === selectedBotId))
  const roomSelected = selectedBotId === 'room-create' || Boolean(activeRoom)
  // Details slide open next to a selected bot or active collaboration room (and not while in Settings).
  const infoOpen = useBotStore(
    (s) =>
      !s.settingsOpen &&
      s.infoPanelOpen &&
      (s.bots.some((b) => b.id === s.selectedBotId) || Boolean(activeRoom))
  )
  const setAddBotOpen = useBotStore((s) => s.setAddBotOpen)

  useEffect(() => {
    const stop = startAdapterBridge()
    const stopMobileSync = startMobileSyncBridge()
    // After reload the zustand status may still say online, but adapters have
    // no live session — reconnect Muse/Grok/Hark so send does not fail.
    const { accounts, connectAccount, addBot, removeAccountFromBot } = useBotStore.getState()
    for (const account of Object.values(accounts)) {
      if (
        account.platformId === 'meta-muse' ||
        account.platformId === 'grok' ||
        account.platformId === 'hark' ||
        account.platformId === 'dot' ||
        account.platformId === 'gemini' ||
        account.platformId === 'hermes' ||
        account.platformId === 'antigravity' ||
        account.platformId === 'cue' ||
        account.platformId === 'ds-bot'
      ) {
        void connectAccount(account.id)
      }
    }
    // Enforce 1-account-per-bot across all bots (remove any extra attached accounts)
    for (const b of useBotStore.getState().bots) {
      if (b.accountIds.length > 1) {
        const keepId = b.activeAccountId && b.accountIds.includes(b.activeAccountId) ? b.activeAccountId : b.accountIds[0]!
        for (const id of b.accountIds) {
          if (id !== keepId) {
            removeAccountFromBot(b.id, id)
          }
        }
      }
    }
    // Auto-hydrate all pre-provisioned Dot accounts from dot-accounts.json (strictly 1 account = 1 bot)
    const dotBridge = typeof window !== 'undefined' ? window.electron?.dot : undefined
    if (dotBridge?.rpc) {
      void dotBridge
        .rpc({ accountId: 'acc_dot_default', op: 'listStoredAccounts' })
        .then((res) => {
          if (!res?.ok || !Array.isArray(res.data)) return
          const storedList = res.data as Array<{
            accountId: string
            handle?: string
            displayName?: string
            planType?: string
          }>
          const validIds = new Set(storedList.map((x) => x.accountId).filter(Boolean))
          // Remove any stale Dot bots/accounts whose account is no longer in dot-accounts.json
          if (validIds.size > 0) {
            useBotStore.setState((s) => {
              const nextAccounts = { ...s.accounts }
              for (const [id, acc] of Object.entries(nextAccounts)) {
                if (acc.platformId === 'dot' && !validIds.has(id)) {
                  delete nextAccounts[id]
                }
              }
              return {
                accounts: nextAccounts,
                bots: s.bots.filter((b) => {
                  if (b.platformId !== 'dot') return true
                  const accId = b.activeAccountId || b.accountIds[0]
                  return Boolean(accId && validIds.has(accId))
                })
              }
            })
          }
          for (const item of storedList) {
            const accId = item.accountId
            if (!accId) continue
            const label = item.handle || item.displayName || accId
            const curState = useBotStore.getState()
            const existingBotForAcc = curState.bots.find(
              (b) =>
                b.platformId === 'dot' &&
                (b.activeAccountId === accId || b.accountIds.includes(accId))
            )
            if (!existingBotForAcc) {
              const botId =
                accId === 'acc_dot_default'
                  ? 'bot_dot_default'
                  : `bot_${accId}`
              addBot({
                id: botId,
                platformId: 'dot',
                name: `Dot · ${label}`,
                emoji: '🪐',
                accounts: [
                  {
                    key: accId,
                    accountId: accId,
                    displayName: label,
                    handle: item.handle ?? label
                  }
                ],
                background: Boolean(curState.selectedBotId)
              })
            } else {
              void curState.connectAccount(accId)
            }
          }
        })
        .catch(() => undefined)
    }
    return () => {
      stopMobileSync()
      stop()
    }
  }, [])

  // Handle `--open-grok-login` startup trigger or first-visit full-screen guide
  useEffect(() => {
    const triggerGrokLoginFlow = () => {
      const state = useBotStore.getState()
      const offlineGrok = Object.values(state.accounts).find(
        (a) => a.platformId === 'grok' && (a.status === 'offline' || a.status === 'error')
      )
      if (offlineGrok) {
        const owner = state.bots.find((b) => b.accountIds.includes(offlineGrok.id))
        if (owner) state.selectBot(owner.id)
        void state.openGrokLogin(offlineGrok.id, false)
        return
      }
      state.setAddBotOpen(true, 'grok')
    }

    const params =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    if (params?.get('openGrokLogin') === '1') {
      const timer = setTimeout(triggerGrokLoginFlow, 220)
      return () => clearTimeout(timer)
    }

    if (!hasSeenOnboarding() && useBotStore.getState().bots.length > 0) {
      useBotStore.getState().setOnboardingOpen(true)
    }

    const onTrigger = () => triggerGrokLoginFlow()
    window.addEventListener('bothub:open-grok-login', onTrigger)
    return () => window.removeEventListener('bothub:open-grok-login', onTrigger)
  }, [])

  useEffect(() => startPrefsSync(), [])
  useEffect(() => {
    // Only resume an explicitly connected bridge after a renderer reload.
    if (sessionStorage.getItem('botark.slack.connected') !== '1') return
    const bridge = window.electron?.slack
    if (!bridge) return
    let live = true
    void bridge.request({ op: 'status' })
      .then((state) => { if (live) applySlackConnection(bridge, state) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  useGlobalShortcuts()

  // Test harness for CDP/E2E scripts (dev, or ?e2e=1 / localStorage BOTHUB_E2E).
  useEffect(() => {
    const e2e =
      import.meta.env.DEV ||
      (typeof window !== 'undefined' &&
        (new URLSearchParams(window.location.search).get('e2e') === '1' ||
          window.localStorage.getItem('BOTHUB_E2E') === '1'))
    if (!e2e) return
    Object.assign(window, {
      __bothub: {
        store: useBotStore,
        rooms: useRooms,
        prefs: usePrefsStore,
        adapterRegistry
      }
    })
  }, [])

  return (
    <>
      <div className="relative isolate h-full">
        <UpdateBanner />
        <AppShell
          asideOpen={infoOpen}
          sidebar={<Sidebar onAddBot={() => setAddBotOpen(true)} />}
          main={
            <ErrorBoundary surface={settingsOpen ? '管理控制台' : '对话区'} resetKey={settingsOpen ? 'settings' : selectedBotId}>
              <Suspense fallback={null}>
                {settingsOpen ? <SettingsView /> : roomSelected && selectedBotId ? <RoomView key={selectedBotId} id={selectedBotId} /> : <ChatArea />}
              </Suspense>
            </ErrorBoundary>
          }
          aside={
            <ErrorBoundary surface="右侧面板" resetKey={selectedBotId}>
              <Suspense fallback={null}>
                {activeRoom ? <RoomInspectorPanel room={activeRoom} /> : <InfoPanel />}
              </Suspense>
            </ErrorBoundary>
          }
        />
      </div>
      <OnDemandDialog open={addBotOpen}>
        <AddBotDialog />
      </OnDemandDialog>
      <OnDemandDialog open={onboardingOpen}>
        <OnboardingDialog />
      </OnDemandDialog>
      <OnDemandDialog open={paletteOpen}>
        <CommandPalette />
      </OnDemandDialog>
    </>
  )
}
