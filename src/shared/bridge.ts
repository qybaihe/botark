import type { SlackBridge } from './slack'
import type { WorkspaceBridge } from './workspace'
import type { MuseAutoLoginRequest, MuseAutoLoginResult } from './museBatch'
import type {
  CreateWebViewRequest,
  MuseChatSessionView,
  MuseConnectorConnectResult,
  MuseConnectorView,
  MuseEnsureRequest,
  MuseFileEntryView,
  MuseHistoryMessageView,
  MuseInviteSnapshot,
  MuseMainEvent,
  MuseQuotaSnapshot,
  MuseRpcRequest,
  MuseSchedule,
  MuseSessionMutation,
  MuseSessionStatus,
  MuseTaskRun,
  MuseProxyView,
  MuseProxyConfigInput,
  MuseProxyPoolItemView,
  UpdateStatusEvent,
  WebViewBounds,
  WebViewInfo,
  OpenInPartitionRequest,
  GrokMainEvent,
  GrokOpenLoginRequest,
  GrokSetAccessTokenRequest,
  GrokAuthStatus,
  GrokAuthSessionPayload,
  GrokRpcRequest,
  GrokRpcResponse,
  HarkMainEvent,
  HarkOpenLoginRequest,
  HarkImportCredentialsRequest,
  HarkAuthStatus,
  HarkRpcRequest,
  HarkRpcResponse,
  DotMainEvent,
  DotOpenLoginRequest,
  DotAuthStatus,
  DotImportCredentialsRequest,
  DotRpcRequest,
  DotRpcResponse,
  HermesAuthStatus,
  HermesConfigureRequest,
  HermesLocalDetection,
  HermesMainEvent,
  HermesRpcRequest,
  HermesRpcResponse,
  AntigravityAuthStatus,
  AntigravityMainEvent,
  AntigravityOpenLoginRequest,
  AntigravityRpcRequest,
  AntigravityRpcResponse,
  AntigravitySendRequest,
  AntigravitySendResponse,
  CueAuthSessionPayload,
  CueAuthStatus,
  CueImportCredentialsRequest,
  CueMainEvent,
  CueOpenLoginRequest,
  CueRpcRequest,
  CueRpcResponse,
  SecurityVaultStatus,
  VaultStatusRequest
} from './ipc'
import type {
  MobileBridgeLiveEvent,
  MobileRelayCommand,
  MobileSendCommand,
  MobileSendResult,
  MobileSyncStateView,
  MobileWorkspaceSnapshot
} from './mobileSync'

/** Controls embedded platform web sessions (Electron WebContentsView). */
export interface WebViewBridge {
  /** Create (or reuse) the view for a bot + account. Does not show it. */
  create(request: CreateWebViewRequest): Promise<WebViewInfo>
  /** Show the view over the given region; hides any other attached view. */
  attach(viewId: string, bounds: WebViewBounds): Promise<WebViewInfo>
  /** Update the attached view's bounds (fire-and-forget, safe to call often). */
  resize(viewId: string, bounds: WebViewBounds): void
  /** Hide the view but keep its page and session alive. */
  detach(viewId: string): Promise<void>
  /** Close the view's page and free its resources. */
  destroy(viewId: string): Promise<void>
  /** Wipe cookies/storage for an account partition (sign out). */
  clearPartition(accountId: string): Promise<void>
  /** Navigate an existing view to a target http(s) URL (or reload if omitted). */
  navigate(viewId: string, url?: string): Promise<WebViewInfo>
  /** Open an authenticated in-app child window sharing the account's session partition & proxy. */
  openInPartition(request: OpenInPartitionRequest): Promise<void>
}

/**
 * Contract for the API the preload script exposes on `window.electron`.
 *
 * The renderer must treat it as optional: when it runs in a plain browser
 * (`npm run dev:web`) there is no preload and `window.electron` is undefined.
 */
export interface MuseBridge {
  ensure(request: MuseEnsureRequest): Promise<MuseSessionStatus>
  rpc(request: MuseRpcRequest): Promise<unknown>
  status(accountId: string): Promise<MuseSessionStatus | null>
  onEvent(listener: (event: MuseMainEvent) => void): () => void
  /** Destroy the muse view and clear the account partition. */
  signOut(accountId: string): Promise<void>
  /**
   * Open a BrowserWindow that shares the account persist partition and loads
   * muse.ai. Cookies land automatically; the window closes when hatch_sess appears.
   */
  openLogin(request: MuseEnsureRequest): Promise<MuseSessionStatus>
  /** Close an unfinished login window and wipe the account partition. */
  cancelLogin(accountId: string): Promise<void>
  /** Batch import: email one-time-code login, code read from the inbox page. */
  autoLogin(request: MuseAutoLoginRequest): Promise<MuseAutoLoginResult>
  /** Show the hidden login window (manual checkpoint). False when none is open. */
  showLogin(accountId: string): Promise<boolean>
  getQuota(accountId: string): Promise<MuseQuotaSnapshot | null>
  refreshQuota(accountId: string): Promise<MuseQuotaSnapshot>
  getInvite(accountId: string): Promise<MuseInviteSnapshot | null>
  refreshInvite(accountId: string): Promise<MuseInviteSnapshot>
  redeemInvite(accountId: string, code: string): Promise<{ ok: boolean; message: string; openSettings?: boolean }>
  listSchedules(accountId: string): Promise<MuseSchedule[]>
  listScheduleRuns(accountId: string, jobId?: string): Promise<MuseTaskRun[]>
  runSchedule(accountId: string, jobId: string): Promise<unknown>
  deleteSchedule(accountId: string, jobId: string): Promise<unknown>
  listSessions(accountId: string): Promise<MuseChatSessionView[]>
  mutateSession(accountId: string, mutation: MuseSessionMutation): Promise<unknown>
  startSession(accountId: string): Promise<{ sessionId: string | null }>
  loadSessionHistory(accountId: string, sessionId: string): Promise<MuseHistoryMessageView[]>
  cancelChat(accountId: string, sessionId?: string): Promise<{ ok: true }>
  listFiles(accountId: string): Promise<MuseFileEntryView[]>
  listConnectors(accountId: string): Promise<MuseConnectorView[]>
  connectConnector(accountId: string, connectorId: string): Promise<MuseConnectorConnectResult>
  disconnectConnector(accountId: string, connectorId: string): Promise<{ ok: boolean; message?: string }>
  openExternal(url: string): Promise<{ ok: true }>
  openHttps(url: string): Promise<{ ok: true }>
  selectOption(request: {
    accountId: string
    conversationId: string
    hostMessageId: string
    selectedText: string
    optionIndex: number
    widget: import('./ipc').MuseOptionWidgetView
    sessionId?: string
  }): Promise<unknown>
  previewWorkspaceFile(
    accountId: string,
    path: string
  ): Promise<{ path: string; mimeType: string; dataBase64: string; byteLength: number }>
  uploadWorkspaceFile(
    accountId: string,
    args: { filename: string; mimeType: string; dataBase64: string }
  ): Promise<{ path: string; filename: string; mimeType: string }>
  syncIdentity(accountId: string): Promise<import('./ipc').MuseIdentityView>
  getProxy(accountId: string): Promise<MuseProxyView>
  setProxy(accountId: string, config: MuseProxyConfigInput): Promise<MuseProxyView>
  listProxyPool(): Promise<MuseProxyPoolItemView[]>
  importProxyPool(
    rawText: string,
    defaultMode?: Exclude<import('./ipc').MuseProxyMode, 'direct'>
  ): Promise<{ added: number; total: number; items: MuseProxyPoolItemView[] }>
  removeProxyPoolItem(id: string): Promise<MuseProxyPoolItemView[]>
  clearProxyPool(): Promise<MuseProxyPoolItemView[]>
  /** `keepIds`: accounts whose current slot is kept but who get no new one. */
  assignProxyPool(accountIds: string[], keepIds?: string[]): Promise<{ assignedCount: number; items: MuseProxyPoolItemView[] }>
}

export interface UpdateBridge {
  check(): Promise<{ ok: true }>
  install(): Promise<{ ok: true }>
  version(): Promise<string>
  onEvent(listener: (event: UpdateStatusEvent) => void): () => void
}

export interface GrokBridge {
  /** Open Grok Bot PKCE login (embedded BrowserWindow by default, or OS browser when `openInBrowser: true`). */
  openLogin(request: GrokOpenLoginRequest): Promise<{ ok: true }>
  cancelLogin(accountId: string): Promise<{ ok: true }>
  /** Store a bearer token / cookie / JSON / API key for ConnectRPC. */
  setAccessToken(request: GrokSetAccessTokenRequest): Promise<GrokAuthStatus>
  clearAuth(accountId: string): Promise<GrokAuthStatus>
  authStatus(accountId: string): Promise<GrokAuthStatus>
  /** Hydrate renderer from main in-memory token store. */
  getSession(accountId: string): Promise<GrokAuthSessionPayload>
  /** ConnectRPC unary via main process (List/Send/Transcript/approvals) — avoids CORS. */
  rpc(request: GrokRpcRequest): Promise<GrokRpcResponse>
  onEvent(listener: (event: GrokMainEvent) => void): () => void
}


export interface HarkBridge {
  openLogin(request: HarkOpenLoginRequest): Promise<HarkAuthStatus>
  cancelLogin(accountId: string): Promise<HarkAuthStatus>
  authStatus(accountId: string): Promise<HarkAuthStatus>
  importCredentials(request: HarkImportCredentialsRequest): Promise<HarkAuthStatus>
  clearAuth(accountId: string): Promise<HarkAuthStatus>
  rpc(request: HarkRpcRequest): Promise<HarkRpcResponse>
  onEvent(listener: (event: HarkMainEvent) => void): () => void
}

export interface DotBridge {
  openLogin(request: DotOpenLoginRequest): Promise<DotAuthStatus>
  cancelLogin(accountId: string): Promise<DotAuthStatus>
  authStatus(accountId: string): Promise<DotAuthStatus>
  importCredentials(request: DotImportCredentialsRequest): Promise<DotAuthStatus>
  clearAuth(accountId: string): Promise<DotAuthStatus>
  rpc(request: DotRpcRequest): Promise<DotRpcResponse>
  onEvent(listener: (event: DotMainEvent) => void): () => void
}

export interface HermesBridge {
  configure(request: HermesConfigureRequest): Promise<HermesAuthStatus>
  detectLocal(baseUrl?: string): Promise<HermesLocalDetection>
  authStatus(accountId: string): Promise<HermesAuthStatus>
  listAccounts(): Promise<HermesAuthStatus[]>
  clearAuth(accountId: string): Promise<HermesAuthStatus>
  rpc(request: HermesRpcRequest): Promise<HermesRpcResponse>
  onEvent(listener: (event: HermesMainEvent) => void): () => void
}

export interface AntigravityBridge {
  openLogin(request: AntigravityOpenLoginRequest): Promise<AntigravityAuthStatus>
  cancelLogin(accountId: string): Promise<void>
  clearAuth(accountId: string): Promise<void>
  authStatus(accountId: string): Promise<AntigravityAuthStatus>
  sendMessage(request: AntigravitySendRequest): Promise<AntigravitySendResponse>
  cancelRun(accountId: string): Promise<void>
  rpc(request: AntigravityRpcRequest): Promise<AntigravityRpcResponse>
  onEvent(listener: (event: AntigravityMainEvent) => void): () => void
}

export interface CueBridge {
  openLogin(request: CueOpenLoginRequest): Promise<CueAuthStatus>
  cancelLogin(accountId: string): Promise<CueAuthStatus>
  importCredentials(request: CueImportCredentialsRequest): Promise<CueAuthStatus>
  clearAuth(accountId: string): Promise<CueAuthStatus>
  authStatus(accountId: string): Promise<CueAuthStatus>
  getSession(accountId: string): Promise<CueAuthSessionPayload>
  rpc(request: CueRpcRequest): Promise<CueRpcResponse>
  onEvent(listener: (event: CueMainEvent) => void): () => void
}

export interface MobileSyncBridge {
  getState(): Promise<MobileSyncStateView>
  start(): Promise<MobileSyncStateView>
  stop(): Promise<MobileSyncStateView>
  rotatePairing(): Promise<MobileSyncStateView>
  setIncludeDirectCredentials(enabled: boolean): Promise<MobileSyncStateView>
  revokeDevice(deviceId: string): Promise<MobileSyncStateView>
  exportOfflineBundle(): Promise<
    | { canceled: true }
    | { canceled: false; filePath: string; transferKey: string; fingerprint: string }
  >
  pushSnapshot(snapshot: MobileWorkspaceSnapshot): void
  pushEvent(event: MobileBridgeLiveEvent): void
  onStateChanged(listener: (state: MobileSyncStateView) => void): () => void
  onCommand(listener: (command: MobileRelayCommand) => void): () => void
  onSendCommand(listener: (command: MobileSendCommand) => MobileSendResult): () => void
}

export interface VaultBridge {
  status(request?: VaultStatusRequest): Promise<SecurityVaultStatus>
  getSecret(key: string): Promise<string | null>
  setSecret(key: string, value: string): Promise<{ ok: boolean; encrypted: boolean; updatedAtMs: number }>
  deleteSecret(key: string): Promise<{ ok: true }>
  clearAll(): Promise<{ ok: true }>
  hardenPermissions(): Promise<{ repaired: number; status: SecurityVaultStatus }>
}

export interface BotHubBridge {
  /** Node-style platform string, e.g. "darwin", "win32", "linux". */
  readonly platform: string
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
  readonly webViews: WebViewBridge
  readonly muse: MuseBridge
  readonly updates: UpdateBridge
  readonly grok: GrokBridge
  readonly hark: HarkBridge
  readonly dot: DotBridge
  readonly hermes: HermesBridge
  readonly antigravity: AntigravityBridge
  readonly cue?: CueBridge
  readonly mobileSync?: MobileSyncBridge
  readonly slack?: SlackBridge
  readonly workspace?: WorkspaceBridge
  readonly vault?: VaultBridge
}
