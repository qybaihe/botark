import { BrowserWindow, Notification, session as electronSession, shell, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { MuseMainEvent, MuseSessionStatus, WebViewBounds } from '@shared/ipc'
import {
  MuseApprovalSnapshots, extractRawApprovalItems, mapMuseApproval,
  type MuseApprovalStreamMetadata
} from '@shared/museApprovals'
import { getAppWindowIcon } from '../appIcon'
import {
  attachGoogleOAuthWebContentsGuard,
  buildGoogleFallbackBannerScript,
  buildGoogleFirefoxCompatUa,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText,
  setGoogleFirefoxCompatMode
} from '../googleOAuthUaGuard'
import { partitionForAccount, webViewId, WebContentsViewManager } from '../webContentsViewManager'
import { MUSE_HOOK_SCRIPT, museDomSendScript, museRpcScript } from './hookScript'
import {
  MuseGatewayError,
  MuseNativeRegistry,
  museTransportMode,
  streamChat,
  createMuseTurnDeadline,
  isMuseStop,
  museEventSessionId,
  MUSE_STREAM_STOPPED,
  MUSE_STREAM_SUPERSEDED,
  selectOptionWidget,
  parseAgentStatus,
  parseOptionWidgets,
  parseRichWidgets,
  parseMediaParts,
  parseHistoryTranscript,
  transcriptText,
  unwrapMuseResult,
  type MuseChatEvent,
  type MuseNativeClient,
  type MuseOptionWidget
} from '../muse-native'
import {
  fetchFsRawPreview,
  downloadFsRawFile,
  fetchHttpWorkspaceFile,
  MUSE_WORKSPACE_DOWNLOAD,
  type MuseWorkspaceFile,
  uploadWorkspaceFile,
  buildWorkspaceUploadPath
} from '../muse-native/fs'
import { applyProxyToPartition, releaseProxyPoolAccount } from './accountProxy'
import { abortable } from '../muse-native/lifecycle'
import type { SubscriptionHandle } from '../muse-native/gateway'
import { historyAssistantsAfterTurn } from '../muse-native/chat'
import {
  cleanMuseChromeUserAgent,
  hasNonEmptyHatchSession,
  isAllowedMuseUrl,
  isMuseCheckpointUrl
} from './museLoginHelpers'
import { fetchInviteSummary, fetchSubscription } from '../muse-native/quota'
import {
  fetchInvite,
  redeemInviteCode,
  type MuseInviteSnapshot as NativeInvite
} from '../muse-native/invite'
import {
  runsFromResult,
  schedulesFromListResult,
  type MuseSchedule as NativeSchedule,
  type MuseTaskRun as NativeRun
} from '../muse-native/schedules'
import { extractStartedSessionId, sessionsFromListResult, sessionIdParams } from '../muse-native/sessions'
import { artifactsFromListResult, libraryFromResult } from '../muse-native/files'
import { fetchMuseIdentitySnapshot } from '../muse-native/identity'
import type {
  MuseChatSessionView,
  MuseConnectorConnectResult,
  MuseConnectorView,
  MuseFileEntryView,
  MuseHistoryMessageView,
  MuseIdentityView,
  MuseInviteSnapshot,
  MuseQuotaSnapshot,
  MuseSchedule,
  MuseSessionMutation,
  MuseTaskRun
} from '@shared/ipc'
import { driveEmailOtpLogin } from './museAutoLogin'
import type { MuseAutoLoginRequest, MuseAutoLoginResult } from '@shared/museBatch'
import { applyMuseKeepAlive, MUSE_HEALTH_SCRIPT, museWakeScript } from './museKeepAlive'

const MUSE_ORIGIN = 'https://muse.ai'
const QUOTA_POLL_MS = 60_000

function sameHatchCookie(left: Electron.Cookie, right: Electron.Cookie): boolean {
  return left.value === right.value && left.domain === right.domain && left.path === right.path && left.secure === right.secure
}

function sameHatchCookies(left: Electron.Cookie[], right: Electron.Cookie[]): boolean {
  return left.length === right.length && left.every((cookie) => right.some((other) => sameHatchCookie(cookie, other)))
}

interface AccountGeneration {
  controller: AbortController
  initializing?: Promise<AccountSession>
  refreshing?: Promise<MuseSessionStatus | undefined>
  openingLogin?: Promise<MuseSessionStatus>
  rebinding?: Promise<void>
  latestTurn?: ChatTurn
}

interface ChatTurn {
  id?: string
  conversationId?: string
  sessionId?: string
  controller: AbortController
  generation: AccountGeneration
  room: boolean
}

interface InspectorWatch {
  cancel?: (reason?: string) => void
  disposed?: boolean
}

type MuseClientEvent = MuseMainEvent & MuseApprovalStreamMetadata & { sendId?: string; sessionId?: string }
type InspectorSubscription = 'tasks.subscribe' | 'fs.subscribe' | 'artifacts.subscribe'

interface AccountSession {
  accountId: string
  botId: string
  viewId: string
  status: MuseSessionStatus
  /** Watchdog: when the gateway was last seen not ready (ms). */
  notReadySince?: number
  wakeRetry?: number
  nextWakeAt?: number
  reloadAfterMs?: number
  lastReloadAt?: number
  pollTimer?: ReturnType<typeof setInterval>
  /** Usage / quota snapshot (HTTPS Server Action). */
  quota?: MuseQuotaSnapshot
  quotaTimer?: ReturnType<typeof setInterval>
  quotaRead?: Promise<MuseQuotaSnapshot>
  subscriptions: Map<InspectorSubscription, InspectorWatch>
  approvalSnapshots: MuseApprovalSnapshots
  approvalVersion: number
  approvalRead?: Promise<{ pending: Record<string, unknown>[] } & MuseApprovalStreamMetadata>
  hookInstall?: Promise<void>
  chatWatch?: { client: MuseNativeClient; dispose: () => void }
  watchTexts: Map<string, string>
  /** Currently selected/active chat session_id for spontaneous watch filtering. */
  activeSessionId?: string
  roomSessions: Set<string>
  schedules?: MuseSchedule[]
  invite?: MuseInviteSnapshot
  chatSessions?: MuseChatSessionView[]
  files?: MuseFileEntryView[]
  connectors?: MuseConnectorView[]
  identitySynced?: boolean
  identity?: MuseIdentityView
}

/**
 * Owns muse.ai WebContentsViews and page-side RPC (sendRequest or DOM fallback).
 */
export class MuseSessionManager {
  private readonly sessions = new Map<string, AccountSession>()
  private readonly generations = new Map<string, AccountGeneration>()
  private disposed = false
  private nextApprovalVersion = 0
  private readonly listeners = new Set<(event: MuseClientEvent) => void>()
  /** Running batch auto-logins keyed by accountId. */
  private readonly autoLogins = new Map<string, AbortController>()
  /** Interactive login windows keyed by accountId (same persist partition). */
  private readonly loginWindows = new Map<string, BrowserWindow>()
  /** Native Noise gateway clients (default transport; hook is the fallback). */
  private readonly native = new MuseNativeRegistry(partitionForAccount, (accountId, phase, error) =>
    this.onNativePhase(accountId, phase, error)
  )
  /** Accounts currently inside an active streamChat turn (watch listener defers to streamChat). */
  private readonly activeStreams = new Map<string, ChatTurn>()

  constructor(
    private readonly window: BrowserWindow,
    private readonly views: WebContentsViewManager
  ) {}

  onEvent(listener: (event: MuseClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: MuseClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[muse] event listener failed', error)
      }
    }
  }

  private emitStatus(accountId: string): void {
    const session = this.sessions.get(accountId)
    if (!session) return
    this.emit({ type: 'status', status: session.status })
  }

  private generationFor(accountId: string): AccountGeneration {
    if (this.disposed) throw new MuseGatewayError('Muse session manager disposed', 'closed')
    let generation = this.generations.get(accountId)
    if (!generation) {
      generation = { controller: new AbortController() }
      this.generations.set(accountId, generation)
    }
    return generation
  }

  private materializeDomView(session: AccountSession, pinned = false): void {
    if (this.views.getView(session.viewId)) {
      if (pinned) this.views.setPinned(session.viewId, true)
      return
    }
    const info = this.views.create({
      botId: session.botId,
      accountId: session.accountId,
      url: MUSE_ORIGIN,
      label: `Meta Muse · ${session.accountId}`
    })
    session.viewId = info.viewId
    if (pinned) this.views.setPinned(session.viewId, true)
    this.configureView(info.viewId, session.accountId)
  }

  async ensure(botId: string, accountId: string, opts?: { show?: boolean; bounds?: WebViewBounds }): Promise<MuseSessionStatus> {
    const { signal } = this.generationFor(accountId).controller
    const activeLogin = this.loginWindows.get(accountId)
    if (!opts?.show && activeLogin && !activeLogin.isDestroyed() && !(await this.hasSessionCookie(accountId, signal))) {
      if (this.loginWindows.get(accountId) === activeLogin && !activeLogin.isDestroyed()) {
        return this.sessions.get(accountId)?.status ?? {
          accountId, signedIn: false, ready: false, hook: 'none',
          url: activeLogin.webContents.getURL() || MUSE_ORIGIN, pendingApprovals: 0, phase: 'signed-out'
        }
      }
    }
    const session = await this.prepareSession(botId, accountId, signal, opts)
    await this.refreshSession(accountId)
    signal.throwIfAborted()
    return session.status
  }

  private async prepareSession(
    botId: string,
    accountId: string,
    signal: AbortSignal,
    opts?: { show?: boolean; bounds?: WebViewBounds }
  ): Promise<AccountSession> {
    signal.throwIfAborted()
    const generation = this.generationFor(accountId)
    const lifetime = generation.controller.signal
    if (generation.rebinding) await abortable(signal, () => generation.rebinding!)
    let session = this.sessions.get(accountId)
    if (!session) {
      generation.initializing ??= abortable(lifetime, async () => {
        await applyProxyToPartition(accountId)
        lifetime.throwIfAborted()
        installGoogleOAuthHeaderGuard(electronSession.fromPartition(partitionForAccount(accountId)))
        const next: AccountSession = {
          accountId, botId, viewId: webViewId(botId, accountId),
          status: {
            accountId, signedIn: false, ready: false, hook: 'none', url: MUSE_ORIGIN,
            pendingApprovals: 0, phase: 'connecting'
          },
          subscriptions: new Map(),
          approvalSnapshots: new MuseApprovalSnapshots(),
          approvalVersion: 0,
          roomSessions: new Set(),
          watchTexts: new Map()
        }
        this.sessions.set(accountId, next)
        this.startPolling(accountId)
        return next
      }).finally(() => { generation.initializing = undefined })
      session = await abortable(signal, () => generation.initializing!)
    }
    signal.throwIfAborted()
    lifetime.throwIfAborted()
    if (botId !== 'muse') session.botId = botId

    const hookMode = museTransportMode() !== 'native'
    if (opts?.show || hookMode) this.materializeDomView(session, hookMode)
    if (opts?.show && opts.bounds) this.views.attach(session.viewId, opts.bounds)
    return session
  }

  private configureView(viewId: string, accountId: string): void {
    const view = this.views.getView(viewId)
    if (!view) return

    const isCurrentView = () => this.views.getView(viewId) === view && this.sessions.get(accountId)?.viewId === viewId
    const partition = partitionForAccount(accountId)
    installGoogleOAuthHeaderGuard(electronSession.fromPartition(partition))

    const attachViewPopupGuards = (wc: WebContents) => {
      const viewSes = electronSession.fromPartition(partition)
      const windowIcon = getAppWindowIcon()
      attachGoogleOAuthWebContentsGuard(wc, viewSes)
      wc.setWindowOpenHandler(({ url }) => {
        if (isAllowedMuseUrl(url)) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 540,
              height: 700,
              title: 'Muse 安全登录',
              autoHideMenuBar: true,
              ...(windowIcon ? { icon: windowIcon } : {}),
              parent: this.window.isDestroyed() ? undefined : this.window,
              webPreferences: {
                partition,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false
              }
            }
          }
        }
        return { action: 'deny' }
      })
      wc.on('did-create-window', (childWin) => {
        attachViewPopupGuards(childWin.webContents)
      })
    }
    attachViewPopupGuards(view.webContents)

    void applyMuseKeepAlive(view.webContents)
    view.webContents.on('dom-ready', () => {
      void applyMuseKeepAlive(view.webContents)
    })

    view.webContents.on('did-finish-load', () => {
      if (isCurrentView()) void this.refreshSession(accountId).catch(() => undefined)
    })

    view.webContents.on('did-navigate', (_e, url) => {
      const session = this.sessions.get(accountId)
      if (session && isCurrentView()) {
        session.status.url = url
        this.emitStatus(accountId)
      }
    })
  }

  private async installHook(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    const view = session && this.views.getView(session.viewId)
    const signal = this.generations.get(accountId)?.controller.signal
    if (!session || !view || !signal || signal.aborted || view.webContents.isDestroyed()) return
    if (session.hookInstall) return session.hookInstall
    const install = this.installHookInView(session, view, signal).finally(() => {
      if (session.hookInstall === install) session.hookInstall = undefined
    })
    session.hookInstall = install
    return install
  }

  private async installHookInView(session: AccountSession, view: Electron.WebContentsView, signal: AbortSignal): Promise<void> {
    const { accountId } = session
    try {
      const result = (await view.webContents.executeJavaScript(MUSE_HOOK_SCRIPT, true)) as {
        ready?: boolean
        hook?: MuseSessionStatus['hook']
      }
      if (signal.aborted || this.views.getView(session.viewId) !== view) return
      session.status.ready = this.nativeReady(accountId) || Boolean(result?.ready)
      session.status.hook = result?.hook ?? 'none'
      this.emitStatus(accountId)
    } catch (error) {
      if (signal.aborted || this.views.getView(session.viewId) !== view) return
      console.error('[muse] hook install failed', error)
      session.status.ready = this.nativeReady(accountId)
      session.status.hook = 'none'
      this.emitStatus(accountId)
    }
  }

  private startPolling(accountId: string): void {
    const session = this.sessions.get(accountId)
    if (!session || session.pollTimer) return
    // Lightweight cookie + Noise gateway heartbeat (12s) keeps sessions alive without hidden BrowserWindows.
    session.pollTimer = setInterval(() => {
      void this.refreshSession(accountId).catch(() => undefined)
    }, 12_000)
  }

  async refreshSession(accountId: string): Promise<MuseSessionStatus | undefined> {
    const session = this.sessions.get(accountId)
    const generation = this.generations.get(accountId)
    if (!session || !generation) return undefined
    const { signal } = generation.controller
    generation.refreshing ??= abortable(signal, async () => {
      if (generation.rebinding) await generation.rebinding
      signal.throwIfAborted()
      return this.refreshSessionState(session, signal)
    }).finally(() => {
      generation.refreshing = undefined
    })
    return generation.refreshing
  }

  private async refreshSessionState(session: AccountSession, signal: AbortSignal): Promise<MuseSessionStatus> {
    const { accountId } = session
    const signedIn = await this.hasSessionCookie(accountId, signal)
    const signInChanged = signedIn !== session.status.signedIn
    if (signInChanged) {
      session.status.signedIn = signedIn
      this.emit({ type: 'login', accountId, signedIn })
    }
    if (signedIn && !session.quotaTimer) {
      void this.refreshQuota(accountId).catch(() => undefined)
      this.ensureQuotaPolling(accountId)
    }
    if (!signedIn) {
      clearInterval(session.quotaTimer)
      session.quotaTimer = undefined
      if (signInChanged) {
        session.approvalRead = undefined
        session.approvalVersion = ++this.nextApprovalVersion
        session.status.pendingApprovals = 0
        session.approvalSnapshots.apply([])
      }
      this.disposeNative(session)
    }

    const view = this.views.getView(session.viewId)
    if (view && !view.webContents.isDestroyed()) session.status.url = view.webContents.getURL()
    if (signedIn && museTransportMode() === 'native' && !this.nativeReady(accountId)) {
      try {
        await this.native.get(accountId).gateway.connect()
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof MuseGatewayError && error.code === 'cvm_required') {
          session.status.phaseDetail = 'Muse needs Owner verification (CVM) — finish it in the web session'
          this.materializeDomView(session, true)
        }
      }
      signal.throwIfAborted()
    }

    if (signedIn) {
      if (view && !view.webContents.isDestroyed()) await this.installHook(accountId)
      signal.throwIfAborted()
      if (this.nativeReady(accountId)) {
        session.status.ready = true
        session.status.phase = 'ready'
        session.status.phaseDetail = undefined
        this.ensureChatWatch(accountId)
        if (view) this.views.setPinned(session.viewId, false)
      }
      void this.refreshApprovals(accountId)
    } else {
      session.status.ready = false
      session.status.phase = 'signed-out'
      session.status.phaseDetail = 'Sign in to muse.ai in the web session'
    }

    if (view && !view.webContents.isDestroyed()) await this.watchdog(accountId, signal)
    signal.throwIfAborted()
    this.emitStatus(accountId)
    return session.status
  }

  /**
   * Health watchdog. Mirrors the official client's recovery path:
   *  1. keep page visible/active (rAF-driven SSR reveal + hydration),
   *  2. POST /api/hatch/vm/wake {vm_id, retry_count} with backoff,
   *  3. full reload with growing backoff if still not hydrated.
   */
  private async watchdog(accountId: string, signal: AbortSignal): Promise<void> {
    const session = this.sessions.get(accountId)
    const view = session && this.views.getView(session.viewId)
    if (!session || !view || view.webContents.isDestroyed()) return
    const st = session.status
    if (!st.signedIn) {
      st.phase = 'signed-out'
      st.phaseDetail = 'Sign in to muse.ai in the web session'
      session.notReadySince = undefined
      return
    }
    if (st.hook === 'sendRequest' || this.nativeReady(accountId)) {
      st.phase = 'ready'
      st.phaseDetail = undefined
      session.notReadySince = undefined
      session.wakeRetry = 0
      session.nextWakeAt = undefined
      session.reloadAfterMs = undefined
      return
    }

    const now = Date.now()
    session.notReadySince ??= now
    const elapsed = now - session.notReadySince

    let health: { visibility?: string; bodyLen?: number; store?: boolean; loginUi?: boolean; vmId?: string | null } = {}
    try {
      health = (await view.webContents.executeJavaScript(MUSE_HEALTH_SCRIPT, true)) ?? {}
    } catch {
      /* page mid-navigation */
    }
    signal.throwIfAborted()
    if (health.visibility === 'hidden') await applyMuseKeepAlive(view.webContents)
    signal.throwIfAborted()
    if (health.loginUi) {
      st.phase = 'signed-out'
      st.phaseDetail = 'muse.ai shows the login page'
      return
    }
    st.phase = health.bodyLen ? 'connecting' : 'hydrating'
    st.phaseDetail = health.bodyLen ? 'Connecting to Muse gateway…' : 'Loading muse.ai…'

    if (elapsed > 20_000 && health.vmId && now >= (session.nextWakeAt ?? 0)) {
      const retry = session.wakeRetry ?? 0
      try {
        const res = (await view.webContents.executeJavaScript(museWakeScript(health.vmId, retry), true)) as {
          status: number
          body: string
        }
        console.info('[muse] vm wake', accountId, res?.status, res?.body)
      } catch {
        /* ignore */
      }
      signal.throwIfAborted()
      session.wakeRetry = retry + 1
      session.nextWakeAt = now + Math.min(5_000 * 2 ** retry, 60_000)
      st.phase = 'waking-vm'
      st.phaseDetail = `Waking Muse VM (attempt ${retry + 1})…`
    }

    const reloadAfter = session.reloadAfterMs ?? 45_000
    if (now - (session.lastReloadAt ?? session.notReadySince) > reloadAfter) {
      session.lastReloadAt = now
      session.reloadAfterMs = Math.min(reloadAfter * 2, 300_000)
      st.phase = 'reloading'
      st.phaseDetail = 'Reloading muse.ai to rehydrate…'
      await applyMuseKeepAlive(view.webContents)
      signal.throwIfAborted()
      if (!view.webContents.isDestroyed()) view.webContents.reloadIgnoringCache()
    }
  }

  getStatus(accountId: string): MuseSessionStatus | undefined {
    return this.sessions.get(accountId)?.status
  }

  private onNativePhase(accountId: string, phase: string, error: string | null): void {
    const session = this.sessions.get(accountId)
    if (!session) return
    if (phase === 'ready') {
      session.status.ready = true
      session.status.phase = 'ready'
      session.status.phaseDetail = undefined
      this.ensureChatWatch(accountId)
    } else if (phase === 'reconnecting' || phase === 'error') {
      session.status.ready = session.status.hook === 'sendRequest'
      if (!session.status.ready) session.status.phase = 'connecting'
      if (error && /cvm|owner/i.test(error)) session.status.phaseDetail = 'Muse needs Owner verification (CVM) — finish it in the web session'
    }
    this.emitStatus(accountId)
  }


  /** Desktop toast when the main window is blurred (approvals / new reply). Never auto-approves. */
  private maybeNotify(title: string, body: string): void {
    try {
      if (this.window.isDestroyed() || this.window.isFocused()) return
      if (!Notification.isSupported()) return
      const n = new Notification({ title, body: body.slice(0, 180), silent: false })
      n.on('click', () => {
        if (!this.window.isDestroyed()) {
          this.window.show()
          this.window.focus()
        }
      })
      n.show()
    } catch (error) {
      console.warn('[muse] notify', error instanceof Error ? error.message : error)
    }
  }

  /** Pull Sentinel approvals and share one versioned snapshot with the renderer. */
  async refreshApprovals(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session || (!this.nativeReady(accountId) && session.status.hook !== 'sendRequest')) return
    const prevCount = session.status.pendingApprovals
    try {
      const { pending, approvalVersion } = await this.loadApprovals(session)
      if (pending.length > prevCount && this.sessions.get(accountId) === session && session.approvalVersion === approvalVersion) {
        const first = pending[0]
        this.maybeNotify('Muse 需要确认', String(first?.['detail'] || first?.['host'] || first?.['title'] || '权限请求'))
      }
    } catch (error) {
      console.warn('[muse] refreshApprovals', error instanceof Error ? error.message : error)
    }
  }

  private publishApprovals(session: AccountSession, raw: unknown) {
    const { accountId } = session
    const pending = normalizeApprovals(session.approvalSnapshots.apply(raw))
    const snapshot = {
      pending, approvalVersion: session.approvalVersion, terminalApprovalIds: session.approvalSnapshots.terminalIds
    }
    session.status.pendingApprovals = pending.length
    this.emit({ type: 'approvals', accountId, ...snapshot })
    this.emitStatus(accountId)
    return snapshot
  }

  private loadApprovals(session: AccountSession): Promise<{ pending: Record<string, unknown>[] } & MuseApprovalStreamMetadata> {
    if (session.approvalRead) return session.approvalRead
    const { accountId } = session
    const { signal } = this.generationFor(accountId).controller
    const version = ++this.nextApprovalVersion
    session.approvalVersion = version
    const request = abortable(signal, async () => {
      const client = this.native.peek(accountId)
      const raw = client?.gateway.isReady()
        ? await client.gateway.request('egress.approvals', {}, undefined, signal)
        : await this.rpcRaw(accountId, 'egress.approvals', {}, signal)
      signal.throwIfAborted()
      if (version !== session.approvalVersion) throw new Error('Muse approval snapshot superseded')
      if (!raw || typeof raw !== 'object') throw new Error('Invalid Muse approval snapshot')
      validateApprovalResponse(raw)
      return this.publishApprovals(session, raw)
    }).finally(() => {
      if (session.approvalRead === request) session.approvalRead = undefined
    })
    session.approvalRead = request
    return request
  }

  /** Keep chat.subscribe open for agent.status + spontaneous onboarding bubbles. */
  private ensureChatWatch(accountId: string): void {
    const session = this.sessions.get(accountId)
    const client = this.native.peek(accountId)
    const signal = this.generations.get(accountId)?.controller.signal
    if (!session || !client || !signal || signal.aborted || session.chatWatch?.client === client) return
    const listener = (event: MuseChatEvent) => {
      if (!signal.aborted && this.native.peek(accountId) === client) this.onChatWatchEvent(accountId, event)
    }
    const onResumed = () => {
      if (signal.aborted || session.identitySynced) return
      session.identitySynced = true
      void this.syncIdentity(accountId).catch(() => {
        if (!signal.aborted) session.identitySynced = false
      })
    }
    session.chatWatch = { client, dispose: () => {
      client.chat.off('event', listener)
      client.chat.off('resumed', onResumed)
    } }
    client.chat.on('event', listener)
    client.chat.on('resumed', onResumed)
    void client.chat.ensure().then(onResumed, () => undefined)
  }

  async syncIdentity(accountId: string): Promise<MuseIdentityView> {
    const { signal } = this.generationFor(accountId).controller
    await this.ensure('muse', accountId)
    signal.throwIfAborted()
    const client = this.native.peek(accountId)
    if (!client) throw new Error('Muse native client is unavailable')
    const identity = await abortable(signal, () => fetchMuseIdentitySnapshot(client.gateway, this.partitionFetch(accountId, signal)))
    const session = this.sessions.get(accountId)
    if (session) {
      session.identity = identity
      session.identitySynced = true
    }
    if (identity.displayName || identity.avatarDataUrl || identity.emoji) {
      this.emit({ type: 'identity', accountId, identity })
    }
    return identity
  }

  private onChatWatchEvent(accountId: string, e: MuseChatEvent): void {
    const session = this.sessions.get(accountId)
    if (!session) return
    const p = e.payload
    if (e.name === 'agent.status') {
      const act = parseAgentStatus(p)
      this.emit({
        type: 'activity',
        accountId,
        sessionId: museEventSessionId(p) || undefined,
        activityCode: act.code,
        activityText: act.text ?? undefined,
        activityEmoji: act.emoji ?? undefined,
        agentId: act.agentId ?? undefined,
        subagents: act.subagents,
        busy: act.busy,
        ctaLabel: act.cta?.label
      })
      // Official client has no approvals.subscribe — needs_approval triggers refetch.
      if (
        act.code === 'needs_approval' ||
        /approval|confirm|permission/i.test(act.code) ||
        /approval|批准|审批/i.test(act.text ?? '')
      ) {
        void this.refreshApprovals(accountId)
      }
      return
    }
    // Spontaneous assistant / presentation (e.g. onboarding) when not driven by streamChat UI:
    // only emit when we have a botId conversation and the event carries a message id.
    if (this.activeStreams.has(accountId)) return
    const conversationId = session.botId
    if (!conversationId || conversationId === 'muse' || conversationId.startsWith('room-turn-')) return
    const eventSessionId = museEventSessionId(p)
    if (!session.activeSessionId || eventSessionId !== session.activeSessionId || session.roomSessions.has(eventSessionId)) return
    const id = typeof p['message_id'] === 'string' ? (p['message_id'] as string) : ''
    if (!id) return
    const watched =
      e.name === 'message.assistant' ||
      e.name === 'delta.message_start' ||
      e.name === 'delta.text_append' ||
      e.name === 'delta.message_done' ||
      e.name === 'delta.presentation' ||
      e.name === 'delta.placeholder' ||
      e.name === 'delta.tool_done' ||
      e.name === 'tool_call.completed'
    if (!watched) return
    const widgets = parseOptionWidgets(p)
    const richWidgets = parseRichWidgets(p)
    const media = parseMediaParts(p)
    const display =
      transcriptText(p) ||
      (typeof p['display_text'] === 'string' && p['display_text']) ||
      (typeof p['content'] === 'string' && p['content']) ||
      ''
    if (e.name === 'delta.tool_done' || e.name === 'tool_call.completed') {
      if (!media.length && !widgets.length && !richWidgets.length) return
      const body = session.watchTexts.get(id) || ''
      this.emit({
        type: 'stream',
        accountId,
        conversationId,
        sessionId: eventSessionId,
        messageId: `muse_native_${id}`,
        text: body,
        done: false,
        widgets: widgets.length ? widgets : undefined,
        richWidgets: richWidgets.length ? richWidgets : undefined,
        media: media.length ? media : undefined
      })
      return
    }
    if (e.name === 'delta.message_start' || e.name === 'delta.placeholder') {
      const placeholder = e.name === 'delta.placeholder' ? String(p['text'] ?? p['placeholder'] ?? '') : ''
      session.watchTexts.set(id, placeholder)
      this.emit({
        type: 'stream',
        accountId,
        conversationId,
        sessionId: eventSessionId,
        messageId: `muse_native_${id}`,
        text: placeholder,
        done: false,
        widgets: widgets.length ? widgets : undefined,
        richWidgets: richWidgets.length ? richWidgets : undefined,
        media: media.length ? media : undefined
      })
      return
    }
    if (e.name === 'delta.text_append') {
      const chunk = typeof p['text'] === 'string' ? (p['text'] as string) : ''
      if (!chunk) return
      const next = (session.watchTexts.get(id) ?? '') + chunk
      session.watchTexts.set(id, next)
      this.emit({
        type: 'stream',
        accountId,
        conversationId,
        sessionId: eventSessionId,
        messageId: `muse_native_${id}`,
        text: next,
        done: false,
        widgets: widgets.length ? widgets : undefined,
        richWidgets: richWidgets.length ? richWidgets : undefined,
        media: media.length ? media : undefined
      })
      return
    }
    if (e.name === 'delta.presentation' || e.name === 'message.assistant' || e.name === 'delta.message_done') {
      const body = display || session.watchTexts.get(id) || ''
      const isDone = e.name === 'message.assistant' || e.name === 'delta.message_done'
      if (isDone) session.watchTexts.delete(id)
      if (!body && !widgets.length && !richWidgets.length && !media.length) return
      this.emit({
        type: 'stream',
        accountId,
        conversationId,
        sessionId: eventSessionId,
        messageId: `muse_native_${id}`,
        text: body,
        done: isDone,
        widgets: widgets.length ? widgets : undefined,
        richWidgets: richWidgets.length ? richWidgets : undefined,
        media: media.length ? media : undefined
      })
    }
  }

  private mapStreamWidgets(list: MuseOptionWidget[] | undefined): MuseOptionWidget[] | undefined {
    return list && list.length ? list : undefined
  }

  private nativeReady(accountId: string): boolean {
    return museTransportMode() === 'native' && Boolean(this.native.peek(accountId)?.gateway.isReady())
  }

  private async hasSessionCookie(accountId: string, signal?: AbortSignal): Promise<boolean> {
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    const read = () => ses.cookies.get({ name: 'hatch_sess' })
    return hasNonEmptyHatchSession(await (signal ? abortable(signal, read) : read()))
  }

  /**
   * Verify whether the partition's `hatch_sess` cookie is accepted by muse.ai.
   * Returns `'rejected'` ONLY on an explicit 401/403; transient network/5xx errors
   * return `'inconclusive'` so login isn't blocked by a momentary upstream hiccup.
   */
  private async verifyAuthCheck(ses: Electron.Session, cleanUa: string, signal: AbortSignal): Promise<'ok' | 'rejected' | 'inconclusive'> {
    try {
      const res = await ses.fetch(`${MUSE_ORIGIN}/api/auth/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: MUSE_ORIGIN,
          Referer: `${MUSE_ORIGIN}/`,
          'User-Agent': cleanUa
        },
        body: '{}',
        signal
      })
      if (res.status === 401 || res.status === 403) return 'rejected'
      if (res.ok) {
        try {
          const json = (await res.json()) as { ok?: boolean }
          if (json && json.ok === false) return 'rejected'
        } catch {
          /* ignore */
        }
        return 'ok'
      }
      return 'inconclusive'
    } catch {
      return 'inconclusive'
    }
  }

  /** Native path; returns undefined when the caller should fall back to the hook. */
  private async rpcNative(accountId: string, method: string, params: unknown): Promise<{ value: unknown } | undefined> {
    if (museTransportMode() !== 'native') return undefined
    const generation = this.generationFor(accountId)
    const { signal } = generation.controller
    if (generation.rebinding) await abortable(signal, () => generation.rebinding!)
    if (!(await this.hasSessionCookie(accountId, signal))) return undefined
    signal.throwIfAborted()
    const client = this.native.get(accountId)
    try {
      await abortable(signal, () => client.gateway.connect())
    } catch (error) {
      signal.throwIfAborted()
      const session = this.sessions.get(accountId)
      if (session && error instanceof MuseGatewayError && error.code === 'cvm_required') {
        session.status.phaseDetail = 'Muse needs Owner verification (CVM) — finish it in the web session'
        this.emitStatus(accountId)
      }
      return undefined
    }
    const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    return { value: unwrapMuseResult(await client.gateway.request(method, p, undefined, signal)) }
  }

  private async runTurn(
    accountId: string,
    conversationId: string | undefined,
    sessionId: string | undefined,
    id: string | undefined,
    run: (turn: ChatTurn, signal: AbortSignal) => Promise<unknown>
  ): Promise<unknown> {
    const generation = this.generationFor(accountId)
    this.activeStreams.get(accountId)?.controller.abort(MUSE_STREAM_SUPERSEDED)
    const room = Boolean(conversationId?.startsWith('room-turn-'))
    const turn: ChatTurn = { id, conversationId, sessionId, controller: new AbortController(), generation, room }
    this.activeStreams.set(accountId, turn)
    generation.latestTurn = turn
    const deadline = createMuseTurnDeadline({ signal: AbortSignal.any([turn.controller.signal, generation.controller.signal]) })
    try {
      return await abortable(deadline.signal, () => run(turn, deadline.signal))
    } catch (error) {
      if (isMuseStop(deadline.signal)) throw new DOMException('Muse turn stopped', 'AbortError')
      if (deadline.signal.reason === MUSE_STREAM_SUPERSEDED) throw new Error('Muse turn superseded')
      throw error
    } finally {
      deadline.dispose()
      if (this.activeStreams.get(accountId) === turn) this.activeStreams.delete(accountId)
    }
  }

  private acceptTurn(accountId: string, turn: ChatTurn, sessionId?: string): void {
    if (sessionId) this.bindTurnSession(accountId, turn, sessionId)
    if (this.activeStreams.get(accountId) !== turn) return
    this.emit({ type: 'sent', accountId, conversationId: turn.conversationId, sendId: turn.id, sessionId: turn.sessionId })
  }

  private bindTurnSession(accountId: string, turn: ChatTurn, sessionId: string): void {
    if (this.activeStreams.get(accountId) !== turn) return
    turn.sessionId = sessionId
    const session = this.sessions.get(accountId)
    if (!session) return
    if (turn.room) session.roomSessions.add(sessionId)
    else this.selectDirectSession(session, sessionId)
  }

  private selectDirectSession(session: AccountSession, id: string): void {
    if (session.activeSessionId !== id) session.watchTexts.clear()
    session.roomSessions.delete(id)
    session.activeSessionId = id
  }

  private async nativeChatStream(
    client: MuseNativeClient,
    turn: ChatTurn,
    signal: AbortSignal,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const { accountId } = client
    const { conversationId, sessionId } = turn
    let lastId: string | undefined
    const result = await streamChat(client.gateway, client.chat, {
      text: extractChatText(params),
      nodeId: client.nodeId,
      sessionId,
      messageOrigin: params['message_origin'] && typeof params['message_origin'] === 'object'
        ? (params['message_origin'] as Record<string, unknown>) : undefined,
      items: extractChatItems(params),
      onAck: (resolved) => this.acceptTurn(accountId, turn, resolved),
      onSessionId: (resolved) => this.bindTurnSession(accountId, turn, resolved),
      canCancel: () => turn.generation.latestTurn === turn && !turn.generation.controller.signal.aborted
    }, (update) => {
      const messageId = `muse_native_${update.messageId}`
      lastId = messageId
      if (!conversationId) return
      this.emit({
        type: 'stream', accountId, conversationId, sendId: turn.id, sessionId: turn.sessionId, messageId,
        text: update.text, done: update.done, widgets: this.mapStreamWidgets(update.widgets),
        richWidgets: update.richWidgets, tools: update.tools, media: update.media
      })
      if (update.done && update.text.trim()) this.maybeNotify('Muse', update.text.trim().slice(0, 120))
    }, { deadline: signal, settleMs: 1500 })
    return { ...result.ack, session_id: result.sessionId, text: result.text, assistant_message_id: lastId }
  }

  async selectOption(
    accountId: string,
    args: {
      conversationId: string
      hostMessageId: string
      widget: MuseOptionWidget
      selectedText: string
      optionIndex: number
      sessionId?: string
    }
  ): Promise<unknown> {
    const sessionId = args.sessionId ?? this.sessions.get(accountId)?.activeSessionId
    return this.runTurn(accountId, args.conversationId, sessionId, undefined, async (turn, signal) => {
      await this.prepareSession(args.conversationId, accountId, signal)
      if (!(await this.hasSessionCookie(accountId, signal))) throw new Error('Muse account is not signed in')
      signal.throwIfAborted()
      const client = this.native.get(accountId)
      let lastId: string | undefined
      const result = await selectOptionWidget(client.gateway, client.chat, {
        nodeId: client.nodeId, sessionId, hostMessageId: args.hostMessageId.replace(/^muse_native_/, ''),
        widget: args.widget, selectedText: args.selectedText, optionIndex: args.optionIndex,
        onAck: (resolved) => this.acceptTurn(accountId, turn, resolved),
        onSessionId: (resolved) => this.bindTurnSession(accountId, turn, resolved),
        canCancel: () => turn.generation.latestTurn === turn && !turn.generation.controller.signal.aborted
      }, (u) => {
        lastId = `muse_native_${u.messageId}`
        this.emit({
          type: 'stream', accountId, conversationId: args.conversationId, sessionId: turn.sessionId, messageId: lastId,
          text: u.text, done: u.done, widgets: this.mapStreamWidgets(u.widgets), richWidgets: u.richWidgets,
          tools: u.tools, media: u.media
        })
      }, { deadline: signal, settleMs: 1500 })
      return { ...result.ack, text: result.text, assistant_message_id: lastId }
    })
  }

  async previewWorkspaceFile(accountId: string, path: string): Promise<MuseWorkspaceFile> {
    return this.readWorkspaceFile(accountId, path, false)
  }

  private async readWorkspaceFile(accountId: string, path: string, download: boolean): Promise<MuseWorkspaceFile> {
    const generation = this.generationFor(accountId)
    const { signal } = generation.controller
    if (generation.rebinding) await abortable(signal, () => generation.rebinding!)
    const trimmed = path.trim()
    const isHttp = /^https?:\/\//i.test(trimmed)
    const isFsRaw = /^https?:\/\/[^/]+\/fs\/raw\//i.test(trimmed)
    const fetchViaSession = () => fetchHttpWorkspaceFile(this.partitionFetch(accountId, signal), trimmed, download)
    if (isHttp && !isFsRaw) return abortable(signal, fetchViaSession)
    if (!(await this.hasSessionCookie(accountId, signal))) {
      if (isHttp) return abortable(signal, fetchViaSession)
      throw new Error('Muse account is not signed in')
    }
    await this.prepareSession('muse', accountId, signal)
    const client = this.native.get(accountId)
    try {
      return await abortable(signal, () => download
        ? downloadFsRawFile(client.gateway, trimmed)
        : fetchFsRawPreview(client.gateway, trimmed))
    } catch (error) {
      signal.throwIfAborted()
      if (isHttp) return abortable(signal, fetchViaSession)
      throw error
    }
  }

  /**
   * Eager-upload bytes to workspace/user/files/… via chunked fs.write
   * (official HatchGatewayFs / HatchAttachments file_ref path).
   */
  async uploadWorkspaceFile(
    accountId: string,
    args: { filename: string; mimeType: string; dataBase64: string }
  ): Promise<{ path: string; filename: string; mimeType: string }> {
    const { signal } = this.generationFor(accountId).controller
    await this.prepareSession('muse', accountId, signal)
    if (!(await this.hasSessionCookie(accountId, signal))) throw new Error('Muse account is not signed in')
    signal.throwIfAborted()
    const client = this.native.get(accountId)
    const bytes = Buffer.from(args.dataBase64, 'base64')
    const path = buildWorkspaceUploadPath(args.filename || 'file')
    const uploaded = await uploadWorkspaceFile(client.gateway, path, new Uint8Array(bytes), {
      stageBeforePublish: true, signal
    })
    return { path: uploaded, filename: args.filename || 'file', mimeType: args.mimeType || 'application/octet-stream' }
  }

  /** Invalidate work using the old proxy and hold new connections until the new rules apply. */
  pauseAccountProxy(accountId: string): () => void {
    if (this.disposed) return () => undefined
    const previous = this.generations.get(accountId)?.rebinding
    this.invalidateGeneration(accountId, 'Muse account proxy updated')
    const generation = this.generationFor(accountId)
    let release!: () => void
    const own = new Promise<void>((resolve) => { release = resolve })
    const pending = previous ? Promise.allSettled([previous, own]).then(() => undefined) : own
    generation.rebinding = pending
    const session = this.sessions.get(accountId)
    if (session) {
      this.disposeNative(session)
      clearInterval(session.quotaTimer)
      session.quotaTimer = undefined
      session.hookInstall = undefined
      session.approvalRead = undefined
      session.quotaRead = undefined
      session.status.ready = false
      session.status.phase = 'connecting'
      session.status.phaseDetail = undefined
      this.emitStatus(accountId)
    } else {
      this.native.dispose(accountId)
    }
    return () => {
      release()
      void pending.then(() => {
        if (generation.rebinding === pending) generation.rebinding = undefined
        if (!generation.controller.signal.aborted) void this.refreshSession(accountId).catch(() => undefined)
      })
    }
  }

  async rpc(
    accountId: string,
    method: string,
    params?: unknown,
    conversationId?: string,
    sendId?: string
  ): Promise<unknown> {
    if (method === MUSE_WORKSPACE_DOWNLOAD) {
      const path = (params as { path?: unknown } | null)?.path
      if (typeof path !== 'string') throw new TypeError('Invalid workspace download path')
      return this.readWorkspaceFile(accountId, path, true)
    }
    if (method === 'chat.stream') {
      const body = params && typeof params === 'object' ? params as Record<string, unknown> : {}
      const sessionId = typeof body['session_id'] === 'string' ? body['session_id'] : undefined
      return this.runTurn(accountId, conversationId, sessionId, sendId, async (turn, signal) => {
        const directBot = !turn.room && conversationId ? conversationId : 'muse'
        const session = await this.prepareSession(directBot, accountId, signal)
        signal.throwIfAborted()
        if (turn.room && sessionId) session.roomSessions.add(sessionId)
        if (museTransportMode() === 'native' && await this.hasSessionCookie(accountId, signal)) {
          const client = this.native.get(accountId)
          let nativeReady = false
          try {
            await abortable(signal, () => client.gateway.connect())
            nativeReady = true
          } catch (error) {
            signal.throwIfAborted()
            console.warn('[muse] native connect failed; using hook', error instanceof Error ? error.message : error)
          }
          if (nativeReady) return this.nativeChatStream(client, turn, signal, body)
        }
        const legacy = { node_id: accountId, capabilities: {}, ...body }
        return this.chatStreamAndCollect(accountId, legacy, turn, signal)
      })
    }
    if (method === 'chat.stop_turn') {
      if (!sendId) throw new TypeError('Invalid Muse send ID')
      await this.cancelChat(accountId, undefined, sendId)
      return { ok: true }
    }
    const { signal } = this.generationFor(accountId).controller
    await this.ensure('muse', accountId)
    signal.throwIfAborted()
    const session = this.sessions.get(accountId)
    if (method === 'egress.approvals' && session && (!params || Object.keys(params).length === 0)) return this.loadApprovals(session)
    const viaNative = await this.rpcNative(accountId, method, params)
    signal.throwIfAborted()
    const result = viaNative ? viaNative.value : await abortable(signal, () => this.rpcRaw(accountId, method, params, signal))
    if (method === 'egress.approval.decide' && session && params && typeof params === 'object') {
      validateApprovalResponse(result)
      const id = (params as Record<string, unknown>)['approval_id']
      if (typeof id === 'string') {
        session.approvalVersion = ++this.nextApprovalVersion
        session.approvalRead = undefined
        session.approvalSnapshots.resolve(id)
        this.publishApprovals(session, session.approvalSnapshots.pending)
      }
    }
    return result
  }

  private async chatStreamAndCollect(
    accountId: string,
    params: Record<string, unknown>,
    turn: ChatTurn,
    signal: AbortSignal
  ): Promise<unknown> {
    const { conversationId } = turn
    const startedAt = Date.now()
    let dispatched = false
    const cancelUpstream = (sessionId: string) => {
      if (turn.generation.latestTurn !== turn || turn.generation.controller.signal.aborted) return
      void this.rpcRaw(accountId, 'chat.cancel', { session_id: sessionId }, turn.generation.controller.signal).catch(() => undefined)
    }
    const onAbort = () => {
      if (isMuseStop(signal) && dispatched && turn.sessionId) cancelUpstream(turn.sessionId)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const ack = await abortable(signal, async () => {
        const raw = await this.rpcRaw(accountId, 'chat.stream', params, signal, () => { dispatched = true }, turn.room)
        const value = unwrapMuseResult(raw) as Record<string, unknown> | null
        if (isMuseStop(signal) && !turn.sessionId && typeof value?.['session_id'] === 'string') cancelUpstream(value['session_id'])
        return value
      })
      const streamMessageId = `muse_stream_${randomUUID()}`
      const emitReply = (text: string, done: boolean) => {
        if (!signal.aborted && conversationId) this.emit({
          type: 'stream', accountId, conversationId, sendId: turn.id, sessionId: turn.sessionId,
          messageId: streamMessageId, text, done
        })
      }
      if (ack?.['ok'] === true && ack['mode'] === 'dom') {
        const reply = typeof ack['reply'] === 'string' ? ack['reply'] : ''
        this.acceptTurn(accountId, turn)
        emitReply(reply, true)
        return { ...ack, text: reply, assistant_message_id: streamMessageId }
      }
      const sessionId = typeof ack?.['session_id'] === 'string' ? ack['session_id'] : turn.sessionId
      const messageId = typeof ack?.['message_id'] === 'string' ? ack['message_id'] : undefined
      if (sessionId && turn.sessionId && sessionId !== turn.sessionId) throw new Error('Muse acknowledged a different chat session')
      if (messageId) this.acceptTurn(accountId, turn, sessionId)
      if (!sessionId || !messageId) return ack
      emitReply('', false)
      const reply = await this.waitForAssistantReply(accountId, sessionId, messageId, startedAt, signal, (text) => emitReply(text, false))
      emitReply(reply, true)
      return { ...ack, session_id: sessionId, text: reply, assistant_message_id: streamMessageId }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async waitForAssistantReply(
    accountId: string,
    sessionId: string,
    userMessageId: string,
    startedAt: number,
    signal: AbortSignal,
    onProgress: (text: string) => void
  ): Promise<string> {
    const deadline = startedAt + 180_000
    let best = ''
    let lastChangeAt = startedAt
    while (Date.now() < deadline) {
      try {
        const history = await abortable(signal, () => this.rpcRaw(accountId, 'chat.history', { session_id: sessionId, limit: 40 }, signal))
        const rows = historyAssistantsAfterTurn(history, { ackUserMessageId: userMessageId, turnStartedAtMs: startedAt })
        const top = rows.at(-1)
        if (top?.text && top.text !== best) {
          best = top.text
          lastChangeAt = Date.now()
          onProgress(best)
        }
        if (top?.completed && best) return best
      } catch {
        signal.throwIfAborted()
      }
      if (best && Date.now() - lastChangeAt >= 45_000) return best
      await delay(600, undefined, { signal })
    }
    return best
  }

  private async rpcRaw(
    accountId: string, method: string, params?: unknown, signal?: AbortSignal, onDispatch?: () => void, room = false
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const session = this.sessions.get(accountId)
    if (!session) throw new Error(`No muse session for ${accountId}`)
    const lifetime = this.generations.get(accountId)?.controller.signal
    if (!this.views.getView(session.viewId)) this.materializeDomView(session, true)
    const view = this.views.getView(session.viewId)
    if (!view) throw new Error(`No muse web view for ${accountId}`)
    await this.installHook(accountId)
    signal?.throwIfAborted()
    lifetime?.throwIfAborted()
    if (this.views.getView(session.viewId) !== view || view.webContents.isDestroyed()) throw new Error('Muse web view changed')

    const sendDom = () => {
      signal?.throwIfAborted()
      if (params && typeof params === 'object' && typeof (params as Record<string, unknown>)['session_id'] === 'string') {
        throw new Error('Muse DOM fallback cannot send to an explicit session')
      }
      if (room) throw new Error('Muse DOM fallback cannot open an isolated room session')
      onDispatch?.()
      return view.webContents.executeJavaScript(museDomSendScript(extractChatText(params)), true)
    }
    if (session.status.hook !== 'sendRequest') {
      if (method === 'chat.stream') return sendDom()
      throw new Error(`Muse sendRequest unavailable (hook=${session.status.hook}); method ${method} needs gateway`)
    }

    try {
      onDispatch?.()
      return await view.webContents.executeJavaScript(museRpcScript(method, JSON.stringify(params ?? {})), true)
    } catch (error) {
      if (method === 'chat.stream' && error instanceof Error && /sendRequest not found; use DOM fallback/.test(error.message)) return sendDom()
      throw error
    }
  }

  async sendChat(accountId: string, conversationId: string, text: string): Promise<{ messageId: string }> {
    try {
      const result = await this.rpc(
        accountId,
        'chat.stream',
        // node_id / capabilities are filled per transport (native: device id + delta_stream).
        { items: [{ type: 'text', text }] },
        conversationId
      )
      const reply = extractReplyText(result)
      const resultObj = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
      const fromResult =
        resultObj && typeof resultObj['assistant_message_id'] === 'string'
          ? (resultObj['assistant_message_id'] as string)
          : ''
      const messageId = fromResult || `muse_${Date.now().toString(36)}`
      if (!reply) {
        this.emit({
          type: 'stream',
          accountId,
          conversationId,
          messageId,
          text: '(Muse accepted the message; open the web session if the reply is only visible there.)',
          done: true
        })
      }
      return { messageId }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const messageId = `muse_${Date.now().toString(36)}`
      this.emit({
        type: 'stream',
        accountId,
        conversationId,
        messageId,
        text: `Muse send failed: ${msg}`,
        done: true
      })
      throw error
    }
  }

  private invalidateGeneration(accountId: string, reason: string): void {
    const generation = this.generations.get(accountId)
    this.generations.delete(accountId)
    this.activeStreams.delete(accountId)
    generation?.controller.abort(new MuseGatewayError(reason, 'closed'))
  }

  private disposeNative(session: AccountSession): void {
    session.chatWatch?.dispose()
    session.chatWatch = undefined
    session.watchTexts.clear()
    for (const subscription of session.subscriptions.values()) {
      subscription.disposed = true
      subscription.cancel?.('disposed')
    }
    session.subscriptions.clear()
    this.native.dispose(session.accountId)
  }

  private teardownSession(accountId: string): void {
    const session = this.sessions.get(accountId)
    this.sessions.delete(accountId)
    if (session) {
      clearInterval(session.pollTimer)
      clearInterval(session.quotaTimer)
      this.disposeNative(session)
      this.views.destroy(session.viewId)
    } else {
      this.native.dispose(accountId)
    }
  }

  destroyAccount(accountId: string): void {
    this.autoLogins.get(accountId)?.abort()
    this.autoLogins.delete(accountId)
    const win = this.loginWindows.get(accountId)
    this.loginWindows.delete(accountId)
    if (win && !win.isDestroyed()) win.destroy()
    this.invalidateGeneration(accountId, 'Muse account disposed')
    this.teardownSession(accountId)
  }

  destroyAll(): void {
    this.disposed = true
    const ids = new Set([...this.generations.keys(), ...this.sessions.keys(), ...this.autoLogins.keys(), ...this.loginWindows.keys()])
    for (const accountId of ids) this.destroyAccount(accountId)
    this.listeners.clear()
  }

  private partitionFetch(accountId: string, signal?: AbortSignal) {
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    return async (url: string, init?: RequestInit) => {
      const requestSignal = signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal
      requestSignal?.throwIfAborted()
      return ses.fetch(url, { ...init, signal: requestSignal })
    }
  }

  getQuota(accountId: string): MuseQuotaSnapshot | null {
    return this.sessions.get(accountId)?.quota ?? null
  }

  async refreshQuota(accountId: string): Promise<MuseQuotaSnapshot> {
    const session = this.sessions.get(accountId)
    if (session?.quotaRead) return session.quotaRead
    const { signal } = this.generationFor(accountId).controller
    const request = abortable(signal, () => this.loadQuota(accountId, session, signal)).finally(() => {
      if (session?.quotaRead === request) session.quotaRead = undefined
    })
    if (session) session.quotaRead = request
    return request
  }

  private async loadQuota(accountId: string, session: AccountSession | undefined, signal: AbortSignal): Promise<MuseQuotaSnapshot> {
    const prev = session?.quota
    const publish = (snapshot: MuseQuotaSnapshot) => {
      signal.throwIfAborted()
      if (session) session.quota = snapshot
      this.emit({ type: 'quota', accountId, snapshot })
      return snapshot
    }
    try {
      if (!(await this.hasSessionCookie(accountId, signal))) {
        return publish({
          fetchedAt: Date.now(), stale: Boolean(prev), success: false,
          subscription: prev?.subscription ?? null, error: 'Sign in to muse.ai first'
        })
      }
      const fetch = this.partitionFetch(accountId, signal)
      const native = await fetchSubscription(fetch, { includeAgreement: false, accountId, signal })
      const invite = await fetchInviteSummary(fetch)
      return publish({
        fetchedAt: native.fetchedAt, stale: false, success: native.success,
        subscription: native.subscription, inviteUsesRemaining: invite?.usesRemaining ?? null
      })
    } catch (error) {
      signal.throwIfAborted()
      return publish({
        fetchedAt: Date.now(), stale: true, success: false, subscription: prev?.subscription ?? null,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200)
      })
    }
  }

  private ensureQuotaPolling(accountId: string): void {
    const session = this.sessions.get(accountId)
    if (!session || session.quotaTimer) return
    session.quotaTimer = setInterval(() => {
      void this.refreshQuota(accountId).catch(() => undefined)
    }, QUOTA_POLL_MS)
  }

  async listSchedules(accountId: string): Promise<MuseSchedule[]> {
    const { signal } = this.generationFor(accountId).controller
    const native = await this.rpcNative(accountId, 'tasks.list', {})
    const raw = native ? native.value : await this.rpc(accountId, 'tasks.list', {})
    signal.throwIfAborted()
    const list = schedulesFromListResult(raw).map(toSharedSchedule)
    const session = this.sessions.get(accountId)
    if (session) session.schedules = list
    this.emit({ type: 'schedules', accountId, schedules: list })
    this.ensureSubscription(accountId, 'tasks.subscribe', () => this.listSchedules(accountId))
    return list
  }

  async listScheduleRuns(accountId: string, jobId?: string): Promise<MuseTaskRun[]> {
    const params: Record<string, unknown> = {}
    if (jobId) params['job_id'] = jobId
    const native = await this.rpcNative(accountId, 'tasks.runs', params)
    const raw = native ? native.value : await this.rpc(accountId, 'tasks.runs', params)
    return runsFromResult(raw).map(toSharedRun)
  }

  async runSchedule(accountId: string, jobId: string): Promise<unknown> {
    const params = { job_id: jobId }
    const native = await this.rpcNative(accountId, 'tasks.run', params)
    const raw = native ? native.value : await this.rpc(accountId, 'tasks.run', params)
    void this.listSchedules(accountId).catch(() => undefined)
    return raw
  }

  async deleteSchedule(accountId: string, jobId: string): Promise<unknown> {
    const params = { job_id: jobId }
    const native = await this.rpcNative(accountId, 'tasks.delete', params)
    const raw = native ? native.value : await this.rpc(accountId, 'tasks.delete', params)
    void this.listSchedules(accountId).catch(() => undefined)
    return raw
  }

  private ensureSubscription(accountId: string, method: InspectorSubscription, onEvent: () => Promise<unknown>): void {
    if (!this.nativeReady(accountId)) return
    const session = this.sessions.get(accountId)
    const client = this.native.peek(accountId)
    const signal = this.generations.get(accountId)?.controller.signal
    if (!session || !client || !signal || session.subscriptions.has(method)) return
    const subscription: InspectorWatch = {}
    session.subscriptions.set(method, subscription)
    void client.gateway.subscribe(method, {}, () => {
      if (!subscription.disposed && !signal.aborted && this.native.peek(accountId) === client) void onEvent().catch(() => undefined)
    }, signal).then(async (handle: SubscriptionHandle) => {
      if (subscription.disposed || signal.aborted || this.native.peek(accountId) !== client) handle.cancel('disposed')
      else subscription.cancel = handle.cancel
      await handle.done
    }).catch(() => undefined).finally(() => {
      if (session.subscriptions.get(method) === subscription) session.subscriptions.delete(method)
    })
  }

  getInvite(accountId: string): MuseInviteSnapshot | null {
    return this.sessions.get(accountId)?.invite ?? null
  }

  async refreshInvite(accountId: string): Promise<MuseInviteSnapshot> {
    const session = this.sessions.get(accountId)
    const { signal } = this.generationFor(accountId).controller
    try {
      if (!(await this.hasSessionCookie(accountId, signal))) {
        const snap: MuseInviteSnapshot = {
          fetchedAt: Date.now(),
          inviteState: 'SIGNED_OUT',
          title: null,
          subtitle: null,
          code: null,
          inviteLink: null,
          shareText: null,
          maxUses: null,
          useCount: null,
          usesRemaining: null,
          hasRedeemedInviteCode: false,
          inviteCodeEntryAvailable: false,
          reward: null,
          redeemSubtitle: null,
          redeemDisclaimer: null,
          error: 'Sign in to muse.ai first'
        }
        if (session) session.invite = snap
        this.emit({ type: 'invite', accountId, snapshot: snap })
        return snap
      }
      const native = await abortable(signal, () => fetchInvite(this.partitionFetch(accountId, signal)))
      const snap = toSharedInvite(native)
      if (session) session.invite = snap
      this.emit({ type: 'invite', accountId, snapshot: snap })
      return snap
    } catch (error) {
      signal.throwIfAborted()
      const msg = error instanceof Error ? error.message : String(error)
      const prev = session?.invite
      const snap: MuseInviteSnapshot = {
        fetchedAt: Date.now(),
        inviteState: prev?.inviteState ?? 'ERROR',
        title: prev?.title ?? null,
        subtitle: prev?.subtitle ?? null,
        code: prev?.code ?? null,
        inviteLink: prev?.inviteLink ?? null,
        shareText: prev?.shareText ?? null,
        maxUses: prev?.maxUses ?? null,
        useCount: prev?.useCount ?? null,
        usesRemaining: prev?.usesRemaining ?? null,
        hasRedeemedInviteCode: prev?.hasRedeemedInviteCode ?? false,
        inviteCodeEntryAvailable: prev?.inviteCodeEntryAvailable ?? false,
        reward: prev?.reward ?? null,
        redeemSubtitle: prev?.redeemSubtitle ?? null,
        redeemDisclaimer: prev?.redeemDisclaimer ?? null,
        error: msg.slice(0, 200)
      }
      if (session) session.invite = snap
      this.emit({ type: 'invite', accountId, snapshot: snap })
      return snap
    }
  }

  async redeemInvite(
    accountId: string,
    code: string
  ): Promise<{ ok: boolean; message: string; openSettings?: boolean }> {
    const { signal } = this.generationFor(accountId).controller
    if (!(await this.hasSessionCookie(accountId, signal))) {
      return { ok: false, message: 'Sign in to muse.ai first' }
    }
    const result = await abortable(signal, () => redeemInviteCode(this.partitionFetch(accountId, signal), code))
    if (result.ok) void this.refreshInvite(accountId).catch(() => undefined)
    return result
  }

  async listSessions(accountId: string): Promise<MuseChatSessionView[]> {
    const { signal } = this.generationFor(accountId).controller
    const raw = await this.rpc(accountId, 'sessions.list', {})
    signal.throwIfAborted()
    const list = sessionsFromListResult(raw)
    const session = this.sessions.get(accountId)
    if (session) session.chatSessions = list
    this.emit({ type: 'sessions', accountId, sessions: list })
    return list
  }

  async mutateSession(accountId: string, mutation: MuseSessionMutation): Promise<unknown> {
    const params = sessionIdParams(mutation.sessionId)
    let method = ''
    if (mutation.op === 'archive') method = 'session.archive'
    else if (mutation.op === 'unarchive') method = 'session.unarchive'
    else if (mutation.op === 'pin') method = 'session.pin'
    else if (mutation.op === 'unpin') method = 'session.unpin'
    else if (mutation.op === 'delete') method = 'session.delete'
    else if (mutation.op === 'rename') {
      method = 'session.rename'
      params['title'] = mutation.title
      params['name'] = mutation.title
    } else {
      throw new TypeError('Unknown session mutation')
    }
    const raw = await this.rpc(accountId, method, params)
    void this.listSessions(accountId).catch(() => undefined)
    return raw
  }

  async cancelChat(accountId: string, sessionId?: string, sendId?: string): Promise<{ ok: true }> {
    const turn = this.activeStreams.get(accountId)
    if (turn && (sendId ? turn.id === sendId :
      !turn.room && (!sessionId || turn.sessionId === sessionId))) {
      turn.controller.abort(MUSE_STREAM_STOPPED)
    }
    return { ok: true }
  }

  async startSession(accountId: string): Promise<{ sessionId: string | null }> {
    const { signal } = this.generationFor(accountId).controller
    const raw = await this.rpc(accountId, 'session.start', { method: '/api/session/start', params: {} })
    signal.throwIfAborted()
    const sessionId = extractStartedSessionId(raw)
    // Both room and direct callers allocate here. Selection happens on history load or send ACK.
    void this.listSessions(accountId).catch(() => undefined)
    return { sessionId }
  }

  async loadSessionHistory(accountId: string, sessionId: string): Promise<MuseHistoryMessageView[]> {
    const { signal } = this.generationFor(accountId).controller
    const session = this.sessions.get(accountId)
    if (session && sessionId) this.selectDirectSession(session, sessionId)
    const raw = await this.rpc(accountId, 'chat.history', { session_id: sessionId, limit: 100 })
    signal.throwIfAborted()
    if (!session && sessionId) {
      const current = this.sessions.get(accountId)
      if (current && !current.activeSessionId) this.selectDirectSession(current, sessionId)
    }
    void this.rpcNative(accountId, 'chat.mark_seen', { thread_id: sessionId, session_id: sessionId }).catch(() => undefined)
    return parseHistoryTranscript(raw)
  }

  async listFiles(accountId: string): Promise<MuseFileEntryView[]> {
    const { signal } = this.generationFor(accountId).controller
    const out: MuseFileEntryView[] = []
    signal.throwIfAborted()
    try {
      const native = await this.rpcNative(accountId, 'artifacts.list', {})
      const raw = native ? native.value : await this.rpc(accountId, 'artifacts.list', {})
      out.push(...artifactsFromListResult(raw))
    } catch (error) {
      signal.throwIfAborted()
      console.warn('[muse] artifacts.list', error instanceof Error ? error.message : error)
    }
    signal.throwIfAborted()
    try {
      const native = await this.rpcNative(accountId, 'fs.library', {})
      const raw = native ? native.value : await this.rpc(accountId, 'fs.library', {})
      out.push(...libraryFromResult(raw))
    } catch (error) {
      signal.throwIfAborted()
      console.warn('[muse] fs.library', error instanceof Error ? error.message : error)
    }
    signal.throwIfAborted()
    if (out.length === 0) {
      try {
        const native = await this.rpcNative(accountId, 'fs.list', { path: 'workspace' })
        const raw = native ? native.value : await this.rpc(accountId, 'fs.list', { path: 'workspace' })
        out.push(...libraryFromResult(raw))
      } catch {
        /* best effort fallback */
      }
    }
    signal.throwIfAborted()
    // Dedupe by id
    const seen = new Set<string>()
    const unique = out.filter((f) => {
      if (seen.has(f.id)) return false
      seen.add(f.id)
      return true
    })
    const session = this.sessions.get(accountId)
    if (session) session.files = unique
    this.emit({ type: 'files', accountId, files: unique })
    this.ensureSubscription(accountId, 'fs.subscribe', () => this.listFiles(accountId))
    this.ensureSubscription(accountId, 'artifacts.subscribe', () => this.listFiles(accountId))
    return unique
  }

  async listConnectors(accountId: string): Promise<MuseConnectorView[]> {
    let raw: unknown
    try {
      const native = await this.rpcNative(accountId, 'connectors.list', {})
      raw = native ? native.value : await this.rpc(accountId, 'connectors.list', {})
    } catch (err) {
      // Fallback to connectors.homepage if connectors.list was retired/renamed
      try {
        const native = await this.rpcNative(accountId, 'connectors.homepage', {})
        raw = native ? native.value : await this.rpc(accountId, 'connectors.homepage', {})
      } catch {
        throw err
      }
    }
    const list = mapConnectors(raw)
    const session = this.sessions.get(accountId)
    if (session) session.connectors = list
    this.emit({ type: 'connectors', accountId, connectors: list })
    return list
  }

  async connectConnector(accountId: string, connectorId: string): Promise<MuseConnectorConnectResult> {
    try {
      const infoNative = await this.rpcNative(accountId, 'connectors.connect_info', { id: connectorId })
      const infoRaw = infoNative ? infoNative.value : await this.rpc(accountId, 'connectors.connect_info', { id: connectorId })
      const oauthUrl = extractOauthUrl(infoRaw)
      if (oauthUrl) {
        return { ok: true, oauthUrl, message: 'Finish connecting in your browser' }
      }
      const native = await this.rpcNative(accountId, 'connectors.connect', { id: connectorId })
      if (!native) await this.rpc(accountId, 'connectors.connect', { id: connectorId })
      void this.listConnectors(accountId).catch(() => undefined)
      return { ok: true, message: 'Connected' }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, message: msg.slice(0, 200) }
    }
  }

  async disconnectConnector(
    accountId: string,
    connectorId: string
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      const native = await this.rpcNative(accountId, 'connectors.disconnect', { id: connectorId })
      if (!native) await this.rpc(accountId, 'connectors.disconnect', { id: connectorId })
      void this.listConnectors(accountId).catch(() => undefined)
      return { ok: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, message: msg.slice(0, 200) }
    }
  }

  /**
   * Open a dedicated BrowserWindow that shares the account's persist partition
   * and loads muse.ai. Meta/Facebook/Google/Apple OAuth & agent.meta.ai SSO
   * flows stay in-window or in same-partition child popups.
   *
   * IMPORTANT: Never create a background WebContentsView for this partition
   * until login finishes — otherwise both views run `/aymh` and
   * `POST /api/auth/native/restart` concurrently on the same cookie jar and
   * reset the user's active OTP/SSO flow.
   */
  async openLogin(botId: string, accountId: string, opts?: { hidden?: boolean }): Promise<MuseSessionStatus> {
    const generation = this.generationFor(accountId)
    if (generation.openingLogin) {
      const status = await generation.openingLogin
      if (!opts?.hidden) this.showLogin(accountId)
      return status
    }
    const opening = this.openLoginWindow(botId, accountId, generation, opts).finally(() => {
      if (generation.openingLogin === opening) generation.openingLogin = undefined
    })
    generation.openingLogin = opening
    return opening
  }

  private async openLoginWindow(
    botId: string, accountId: string, generation: AccountGeneration, opts?: { hidden?: boolean }
  ): Promise<MuseSessionStatus> {
    let { signal } = generation.controller
    if (generation.rebinding) await abortable(signal, () => generation.rebinding!)
    await abortable(signal, () => applyProxyToPartition(accountId))

    const partition = partitionForAccount(accountId)
    const ses = electronSession.fromPartition(partition)
    const cleanUa = cleanMuseChromeUserAgent(ses.getUserAgent())
    installGoogleOAuthHeaderGuard(ses)

    const pendingStatus: MuseSessionStatus = {
      accountId,
      signedIn: false,
      ready: false,
      hook: 'none',
      url: MUSE_ORIGIN,
      pendingApprovals: 0,
      phase: 'signed-out'
    }

    // If a non-empty hatch_sess cookie already exists, verify it isn't revoked
    // before skipping the login window. Clear explicitly rejected (401/403)
    // cookies so re-login always starts cleanly.
    if (await this.checkLoginCookie(ses, cleanUa, signal, true)) return this.ensure(botId, accountId)
    signal.throwIfAborted()

    const existing = this.loginWindows.get(accountId)
    if (existing && !existing.isDestroyed()) {
      if (!opts?.hidden) {
        existing.show()
        existing.focus()
      }
      return this.sessions.get(accountId)?.status ?? pendingStatus
    }

    // Tear down any logged-out background WebContentsView + watchdog on this
    // partition so nothing competes with the visible login flow.
    this.invalidateGeneration(accountId, 'Muse interactive login started')
    this.teardownSession(accountId)
    const loginGeneration = this.generationFor(accountId)
    signal = loginGeneration.controller.signal

    const windowIcon = getAppWindowIcon()
    const win = new BrowserWindow({
      width: 1040,
      height: 780,
      minWidth: 720,
      minHeight: 560,
      title: '使用 Muse 登录',
      show: !opts?.hidden,
      backgroundColor: '#f7f7f8',
      autoHideMenuBar: true,
      ...(windowIcon ? { icon: windowIcon } : {}),
      parent: this.window.isDestroyed() ? undefined : this.window,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.loginWindows.set(accountId, win)

    const childPopups = new Set<BrowserWindow>()
    const closeChildPopups = () => {
      for (const child of childPopups) {
        try {
          if (!child.isDestroyed()) child.close()
        } catch {
          /* ignore */
        }
      }
      childPopups.clear()
    }
    const anyOnCheckpoint = (): boolean => {
      if (!win.isDestroyed() && isMuseCheckpointUrl(win.webContents.getURL())) return true
      for (const child of childPopups) {
        if (!child.isDestroyed() && isMuseCheckpointUrl(child.webContents.getURL())) return true
      }
      return false
    }

    let lastBlockCheckAt = 0
    const maybeShowGoogleFallbackBanner = async (wc: WebContents): Promise<void> => {
      if (wc.isDestroyed()) return
      try {
        const currentUrl = wc.getURL()
        if (!/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(currentUrl)) return
        const now = Date.now()
        if (now - lastBlockCheckAt < 150) return
        lastBlockCheckAt = now
        const bodyText = (await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)) as string
        if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
        await wc.executeJavaScript(
          buildGoogleFallbackBannerScript({
            title: 'Google 登录受限或需要通行密钥',
            detail: '可尝试兼容模式重试，或在 Muse 登录页改用邮箱验证码（Email OTP）登录。',
            buttonLabel: '在系统浏览器打开',
            actionUrl: 'botark-external://open',
            secondaryActions: [
              { label: '尝试兼容模式重试', actionUrl: 'botark-action://retry-firefox-ua' },
              { label: '改用邮箱登录', actionUrl: 'botark-action://back-to-login' }
            ]
          }),
          true
        )
      } catch {
        /* ignore transient navigation states */
      }
    }

    const attachLoginNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
      attachGoogleOAuthWebContentsGuard(wc, ses)

      const retryWithFirefoxUa = () => {
        setGoogleFirefoxCompatMode(ses, true)
        if (!wc.isDestroyed()) {
          wc.setUserAgent(buildGoogleFirefoxCompatUa())
          if (/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(wc.getURL())) {
            void wc.loadURL(MUSE_ORIGIN).catch(() => undefined)
          } else {
            wc.reload()
          }
        }
      }

      const backToLogin = () => {
        setGoogleFirefoxCompatMode(ses, false)
        closeChildPopups()
        if (!win.isDestroyed()) {
          void win.loadURL(MUSE_ORIGIN).catch(() => undefined)
        }
      }

      wc.setWindowOpenHandler(({ url }) => {
        if (url === 'botark-external://open') {
          void shell.openExternal(MUSE_ORIGIN)
          return { action: 'deny' }
        }
        if (url === 'botark-action://retry-firefox-ua') {
          retryWithFirefoxUa()
          return { action: 'deny' }
        }
        if (url === 'botark-action://back-to-login') {
          backToLogin()
          return { action: 'deny' }
        }
        if (!isAllowedMuseUrl(url)) return { action: 'deny' }
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'Muse 安全登录',
            autoHideMenuBar: true,
            ...(windowIcon ? { icon: windowIcon } : {}),
            parent: parentForChild.isDestroyed() ? undefined : parentForChild,
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      })

      wc.on('will-navigate', (event, url) => {
        if (url === 'botark-external://open') {
          event.preventDefault()
          void shell.openExternal(MUSE_ORIGIN)
          return
        }
        if (url === 'botark-action://retry-firefox-ua') {
          event.preventDefault()
          retryWithFirefoxUa()
          return
        }
        if (url === 'botark-action://back-to-login') {
          event.preventDefault()
          backToLogin()
        }
      })
    }

    attachLoginNavigationGuards(win.webContents, win)

    let settling = false
    let checking = false

    const finalizeSignedIn = async (): Promise<void> => {
      if (signal.aborted) return
      this.emit({ type: 'login', accountId, signedIn: true })
      if (this.loginWindows.get(accountId) === win) {
        this.loginWindows.delete(accountId)
      }
      closeChildPopups()
      try {
        if (!win.isDestroyed()) win.close()
      } catch {
        /* ignore */
      }
      try {
        await this.ensure(botId, accountId)
      } catch (error) {
        console.error('[muse] ensure session after login failed', error)
      }
      // Keep the optimistic signed-in flag if muse briefly churns cookies mid-load.
      const still = this.sessions.get(accountId)
      if (!signal.aborted && still) {
        still.status.signedIn = true
        this.emitStatus(accountId)
      }
    }

    const finishIfSignedIn = async (): Promise<void> => {
      if (signal.aborted || settling || checking || win.isDestroyed()) return
      checking = true
      try {
        if (anyOnCheckpoint() || !(await this.checkLoginCookie(ses, cleanUa, signal))) return
        if (signal.aborted || settling || win.isDestroyed() || anyOnCheckpoint()) return

        // hatch_sess is present and accepted — emit signed-in and close the login
        // window BEFORE starting the embedded WebContentsView.
        settling = true
        await finalizeSignedIn()
      } catch (error) {
        if (!signal.aborted) console.warn('[muse] login verification failed', error instanceof Error ? error.name : 'error')
      } finally {
        checking = false
      }
    }

    const onNav = (wc?: WebContents) => {
      void finishIfSignedIn()
      if (wc) void maybeShowGoogleFallbackBanner(wc)
    }
    win.webContents.on('did-finish-load', () => onNav(win.webContents))
    win.webContents.on('did-navigate', () => onNav(win.webContents))
    win.webContents.on('did-navigate-in-page', () => onNav(win.webContents))
    win.webContents.on('did-redirect-navigation', () => onNav(win.webContents))

    const trackChildWindow = (childWin: BrowserWindow) => {
      childPopups.add(childWin)
      attachLoginNavigationGuards(childWin.webContents, childWin)
      childWin.webContents.on('did-finish-load', () => onNav(childWin.webContents))
      childWin.webContents.on('did-navigate', () => onNav(childWin.webContents))
      childWin.webContents.on('did-navigate-in-page', () => onNav(childWin.webContents))
      childWin.webContents.on('did-redirect-navigation', () => onNav(childWin.webContents))
      childWin.webContents.on('did-create-window', (nested) => trackChildWindow(nested))
      childWin.on('closed', () => {
        childPopups.delete(childWin)
        void finishIfSignedIn()
      })
    }
    win.webContents.on('did-create-window', trackChildWindow)

    const onCookie = (
      _event: unknown,
      cookie: { name: string },
      _cause: string,
      removed: boolean
    ) => {
      if (!removed && cookie.name === 'hatch_sess') void finishIfSignedIn()
    }
    ses.cookies.on('changed', onCookie)

    const poll = setInterval(() => {
      if (win.isDestroyed() || settling) {
        clearInterval(poll)
        return
      }
      void finishIfSignedIn()
    }, 1000)

    win.on('closed', () => {
      clearInterval(poll)
      ses.cookies.off('changed', onCookie)
      closeChildPopups()
      const wasTracked = this.loginWindows.get(accountId) === win
      if (wasTracked) this.loginWindows.delete(accountId)
      if (!wasTracked) return

      void (async () => {
        // finishIfSignedIn already advanced the add-bot flow and started ensure().
        if (settling || this.sessions.get(accountId)?.status.signedIn) {
          this.emit({ type: 'login', accountId, signedIn: true })
          return
        }
        if (await this.checkLoginCookie(ses, cleanUa, signal) && !this.loginWindows.has(accountId)) {
          settling = true
          await finalizeSignedIn()
          return
        }
        if (signal.aborted || this.loginWindows.has(accountId)) return
        // Window went away without a valid session — offer reopen in add-bot UI.
        this.emit({ type: 'login', accountId, signedIn: false, windowClosed: true })
      })().catch(() => undefined)
    })

    try {
      await win.loadURL(MUSE_ORIGIN)
    } catch (error) {
      // Normal `/aymh` login redirects abort the initial navigation (ERR_ABORTED, -3).
      const code = (error as { errno?: number })?.errno
      if (code !== -3) {
        console.error('[muse] openLogin load failed', error)
      }
    }
    signal.throwIfAborted()
    return this.sessions.get(accountId)?.status ?? pendingStatus
  }

  private async checkLoginCookie(ses: Electron.Session, userAgent: string, signal: AbortSignal, clearRejected = false): Promise<boolean> {
    // Observe replacements before reading either the cookie or the auth verdict.
    let cookieGeneration = 0
    let clearing = false
    const onCookie = (_event: unknown, cookie: { name: string }, cause: string, removed: boolean) => {
      if (cookie.name !== 'hatch_sess') return
      if (!removed || (cause !== 'explicit' || !clearing)) cookieGeneration++
    }
    ses.cookies.on('changed', onCookie)
    try {
      while (true) {
        const version = cookieGeneration
        const cookies = await abortable(signal, () => ses.cookies.get({ name: 'hatch_sess' }))
        if (version !== cookieGeneration) continue
        if (!hasNonEmptyHatchSession(cookies)) return false
        const verdict = await abortable(signal, () => this.verifyAuthCheck(ses, userAgent, signal))
        if (version !== cookieGeneration) continue
        const current = await abortable(signal, () => ses.cookies.get({ name: 'hatch_sess' }))
        if (version !== cookieGeneration || !sameHatchCookies(cookies, current)) continue
        if (verdict !== 'rejected') return true
        if (!clearRejected) return false
        clearing = true
        const cleared = await this.clearHatchCookies(ses, current, signal, () => version === cookieGeneration)
        clearing = false
        if (cleared) return false
      }
    } finally {
      ses.cookies.off('changed', onCookie)
    }
  }

  private async clearHatchCookies(
    ses: Electron.Session, checked: Electron.Cookie[], signal: AbortSignal, unchanged: () => boolean
  ): Promise<boolean> {
    for (const cookie of checked) {
      signal.throwIfAborted()
      if (!unchanged()) return false
      const host = (cookie.domain || 'muse.ai').replace(/^\./, '')
      await ses.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`, cookie.name).catch(() => undefined)
    }
    const current = await abortable(signal, () => ses.cookies.get({ name: 'hatch_sess' }))
    return unchanged() && current.every((cookie) => checked.some((old) => sameHatchCookie(cookie, old)))
  }

  /** Batch import: email one-time-code login driven inside a hidden login window. */
  async autoLogin(req: MuseAutoLoginRequest): Promise<MuseAutoLoginResult> {
    this.autoLogins.get(req.accountId)?.abort()
    const ctrl = new AbortController()
    this.autoLogins.set(req.accountId, ctrl)
    try {
      const status = await this.openLogin(req.botId, req.accountId, { hidden: true })
      ctrl.signal.throwIfAborted()
      if (status.signedIn) return { ok: true }
      const win = this.loginWindows.get(req.accountId)
      if (!win || win.isDestroyed()) {
        return (await this.hasSessionCookie(req.accountId)) ? { ok: true } : { ok: false, reason: 'timeout' }
      }
      const result = await driveEmailOtpLogin(win, req, {
        signal: ctrl.signal,
        isSignedIn: async () =>
          Boolean(this.sessions.get(req.accountId)?.status.signedIn) || (await this.hasSessionCookie(req.accountId))
      })
      if (!result.ok) console.warn('[muse] auto login did not finish:', result.reason)
      return result
    } catch (error) {
      if (ctrl.signal.aborted) return { ok: false, reason: 'cancelled' }
      console.warn('[muse] auto login failed:', error instanceof Error ? error.name : 'error')
      return { ok: false, reason: 'error' }
    } finally {
      if (this.autoLogins.get(req.accountId) === ctrl) this.autoLogins.delete(req.accountId)
    }
  }

  showLogin(accountId: string): boolean {
    const win = this.loginWindows.get(accountId)
    if (!win || win.isDestroyed()) return false
    win.show()
    win.focus()
    return true
  }

  /** A login window or batch auto-login is still running for this account. */
  isLoginInFlight(accountId: string): boolean {
    return this.autoLogins.has(accountId) || this.loginWindows.has(accountId) || Boolean(this.generations.get(accountId)?.openingLogin)
  }

  async cancelLogin(accountId: string): Promise<void> {
    const previous = this.generations.get(accountId)?.rebinding
    this.destroyAccount(accountId)
    const release = releaseProxyPoolAccount(accountId).catch((error) => console.warn('[muse] proxy pool release failed', error))
    const clear = this.views.clearPartition(accountId)
    await this.blockPartitionDuring(accountId, Promise.all([previous?.catch(() => undefined), release, clear]).then(() => undefined))
  }

  /** Tear down the view and wipe the persist partition (full sign-out). */
  async signOut(accountId: string): Promise<void> {
    const previous = this.generations.get(accountId)?.rebinding
    this.destroyAccount(accountId)
    const clear = this.views.clearPartition(accountId)
    const work = this.blockPartitionDuring(accountId, Promise.all([previous?.catch(() => undefined), clear]).then(() => undefined))
    this.emit({ type: 'login', accountId, signedIn: false })
    await work
  }

  private async blockPartitionDuring(accountId: string, work: Promise<void>): Promise<void> {
    if (this.disposed) return work
    const generation = this.generationFor(accountId)
    generation.rebinding = work
    try {
      await work
    } finally {
      if (generation.rebinding === work) generation.rebinding = undefined
    }
  }
}

function validateApprovalResponse(raw: unknown): void {
  unwrapMuseResult(raw)
  if (raw && typeof raw === 'object' && (raw as { success?: unknown }).success === false) {
    throw new Error('Muse rejected the approval request')
  }
}

function extractChatText(params: unknown): string {
  if (!params || typeof params !== 'object') return ''
  const items = (params as { items?: Array<{ type?: string; text?: string }> }).items
  if (!Array.isArray(items)) return ''
  const texts = items
    .filter((it) => it && (it.type === 'text' || typeof it.text === 'string'))
    .map((it) => it.text ?? '')
    .filter((t) => t.length > 0)
  return texts.join('\n') || ''
}

function extractChatItems(params: unknown): import('../muse-native/chat').MuseChatItem[] {
  if (!params || typeof params !== 'object') return []
  const items = (params as { items?: Array<Record<string, unknown>> }).items
  if (!Array.isArray(items)) return []
  const out: import('../muse-native/chat').MuseChatItem[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const typ = it['type']
    if (typ === 'image' || typ === 'file' || typ === 'file_ref') {
      out.push(it as unknown as import('../muse-native/chat').MuseChatItem)
    }
  }
  return out
}

function extractReplyText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result !== 'object') return String(result)
  const r = result as Record<string, unknown>
  for (const key of ['text', 'message', 'content', 'reply']) {
    const v = r[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  if (Array.isArray(r['items'])) {
    const texts = (r['items'] as Array<{ text?: string; type?: string }>)
      .map((i) => i.text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (texts.length) return texts.join('\n')
  }
  try {
    return JSON.stringify(result)
  } catch {
    return ''
  }
}


export function normalizeApprovals(raw: unknown): Array<Record<string, unknown>> {
  return extractRawApprovalItems(raw)
    .map((item) => {
      const mapped = mapMuseApproval(item)
      return {
        ...item,
        id: mapped.id,
        title: mapped.title,
        ...(mapped.detail ? { detail: mapped.detail } : {}),
        ...(mapped.host ? { host: mapped.host } : {})
      }
    })
    .filter((entry) => Boolean(entry.id))
}

function toSharedSchedule(s: NativeSchedule): MuseSchedule {
  return {
    id: s.id,
    title: s.title,
    scheduleKey: s.scheduleKey,
    timezone: s.timezone,
    isHeartbeat: s.isHeartbeat,
    mode: s.mode,
    enabled: s.enabled,
    nextRunAtUtc: s.nextRunAtUtc,
    cadenceLabel: s.cadenceLabel
  }
}

function toSharedRun(r: NativeRun): MuseTaskRun {
  return {
    id: r.id,
    jobId: r.jobId,
    status: r.status,
    startedAtUtc: r.startedAtUtc,
    finishedAtUtc: r.finishedAtUtc,
    title: r.title
  }
}

function toSharedInvite(s: NativeInvite): MuseInviteSnapshot {
  return {
    fetchedAt: s.fetchedAt,
    inviteState: s.inviteState,
    title: s.title,
    subtitle: s.subtitle,
    code: s.code,
    inviteLink: s.inviteLink,
    shareText: s.shareText,
    maxUses: s.maxUses,
    useCount: s.useCount,
    usesRemaining: s.usesRemaining,
    hasRedeemedInviteCode: s.hasRedeemedInviteCode,
    inviteCodeEntryAvailable: s.inviteCodeEntryAvailable,
    reward: s.reward,
    redeemSubtitle: s.redeemSubtitle,
    redeemDisclaimer: s.redeemDisclaimer,
    error: s.error
  }
}

function mapConnectors(raw: unknown): MuseConnectorView[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const nested = o['connectors'] ?? o['items'] ?? o['results']
    if (Array.isArray(nested)) list = nested
  }
  return list.map((item, index) => {
    const r = (item ?? {}) as Record<string, unknown>
    const state = typeof r['state'] === 'string' ? r['state'].toLowerCase() : ''
    const connected = Boolean(
      r['connected'] ??
        r['is_connected'] ??
        (r['status'] === 'connected' || state === 'connected' || state === 'active')
    )
    return {
      id: String(r['id'] ?? r['connector_id'] ?? ('connector-' + String(index))),
      name: String(r['name'] ?? r['title'] ?? r['id'] ?? ('Connector ' + String(index + 1))),
      connected,
      description: typeof r['description'] === 'string' ? r['description'] : undefined
    }
  })
}

function extractOauthUrl(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  for (const key of ['oauth_url', 'oauthUrl', 'auth_url', 'authUrl', 'url', 'redirect_url', 'redirectUrl', 'connect_url', 'connectUrl']) {
    const v = o[key]
    if (typeof v === 'string' && /^https:\/\//i.test(v)) return v
  }
  const nested = o['oauth'] ?? o['authorization'] ?? o['auth']
  if (nested && typeof nested === 'object') {
    const n = nested as Record<string, unknown>
    for (const key of ['url', 'authorize_url', 'authorizeUrl']) {
      const v = n[key]
      if (typeof v === 'string' && /^https:\/\//i.test(v)) return v
    }
  }
  return undefined
}
