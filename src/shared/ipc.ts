import type { HarkBrowserPreview } from './harkBrowserPreview'
/**
 * IPC contract between the renderer (via preload) and the main process.
 * Shared so channel names and payload shapes cannot drift apart.
 */

export const WEB_VIEW_CHANNELS = {
  create: 'bothub:web-view:create',
  attach: 'bothub:web-view:attach',
  resize: 'bothub:web-view:resize',
  detach: 'bothub:web-view:detach',
  destroy: 'bothub:web-view:destroy',
  clearPartition: 'bothub:web-view:clear-partition',
  navigate: 'bothub:web-view:navigate',
  openInPartition: 'bothub:web-view:open-in-partition'
} as const

export interface OpenInPartitionRequest {
  accountId: string
  url: string
  title?: string
}

/** Rectangle in CSS pixels relative to the window's content area. */
export interface WebViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CreateWebViewRequest {
  botId: string
  accountId: string
  /** http(s) URL to load. Omit to show a local placeholder page. */
  url?: string
  /** Human-readable label (e.g. "Meta Muse · Alex Rivera") for the placeholder. */
  label?: string
}

export interface WebViewInfo {
  /** Stable id for a bot + account pair. */
  viewId: string
  botId: string
  accountId: string
  /** Session partition; one per account so logins stay isolated. */
  partition: string
  url: string
  attached: boolean
}


export const MUSE_CHANNELS = {
  ensure: 'bothub:muse:ensure',
  rpc: 'bothub:muse:rpc',
  status: 'bothub:muse:status',
  event: 'bothub:muse:event',
  signOut: 'bothub:muse:sign-out',
  /** Open a same-partition BrowserWindow for interactive muse.ai login. */
  openLogin: 'bothub:muse:open-login',
  /** Close an unfinished login window and wipe its partition. */
  cancelLogin: 'bothub:muse:cancel-login',
  /** Batch import: drive email one-time-code login in a hidden login window. */
  autoLogin: 'bothub:muse:auto-login',
  /** Reveal a hidden (auto) login window for a manual checkpoint. */
  showLogin: 'bothub:muse:show-login',
  getQuota: 'bothub:muse:quota:get',
  refreshQuota: 'bothub:muse:quota:refresh',
  getInvite: 'bothub:muse:invite:get',
  refreshInvite: 'bothub:muse:invite:refresh',
  redeemInvite: 'bothub:muse:invite:redeem',
  listSchedules: 'bothub:muse:schedules:list',
  listScheduleRuns: 'bothub:muse:schedules:runs',
  runSchedule: 'bothub:muse:schedules:run',
  deleteSchedule: 'bothub:muse:schedules:delete',
  listSessions: 'bothub:muse:sessions:list',
  mutateSession: 'bothub:muse:sessions:mutate',
  listFiles: 'bothub:muse:files:list',
  listConnectors: 'bothub:muse:connectors:list',
  connectConnector: 'bothub:muse:connectors:connect',
  disconnectConnector: 'bothub:muse:connectors:disconnect',
  /** Open https://muse.ai URL in the system browser (Upgrade CTA). */
  openExternal: 'bothub:muse:open-external',
  /** Open any https URL (connector OAuth). */
  openHttps: 'bothub:muse:open-https',
  /** Cancel generation (chat.cancel). */
  cancelChat: 'bothub:muse:chat:cancel',
  /** Start a new session (session.start) or load chat.history for a session. */
  startSession: 'bothub:muse:sessions:start',
  loadSessionHistory: 'bothub:muse:sessions:history',
  /** Tap Muse option widget (Kai/Juno). */
  selectOption: 'bothub:muse:select-option',
  /** fs.raw preview for workspace image/file paths. */
  previewWorkspaceFile: 'bothub:muse:files:preview',
  /** Chunked fs.write eager upload → file_ref path. */
  uploadWorkspaceFile: 'bothub:muse:files:upload',
  /** Fetch Muse virtual avatar & persona identity (identity / peers.avatar / IDENTITY.md). */
  syncIdentity: 'bothub:muse:identity:sync',
  getProxy: 'bothub:muse:proxy:get',
  setProxy: 'bothub:muse:proxy:set',
  listProxyPool: 'bothub:muse:proxy-pool:list',
  importProxyPool: 'bothub:muse:proxy-pool:import',
  removeProxyPoolItem: 'bothub:muse:proxy-pool:remove',
  clearProxyPool: 'bothub:muse:proxy-pool:clear',
  assignProxyPool: 'bothub:muse:proxy-pool:assign'
} as const

export interface MuseEnsureRequest {
  botId: string
  accountId: string
  /** When true, attach/show the view for interactive login. */
  show?: boolean
  bounds?: WebViewBounds
}

export interface MuseRpcRequest {
  accountId: string
  method: string
  params?: unknown
  /** BotHub conversation/bot id — used to emit progressive stream events for chat.stream. */
  conversationId?: string
}

export interface MuseSessionStatus {
  accountId: string
  signedIn: boolean
  ready: boolean
  hook: 'sendRequest' | 'dom' | 'none'
  url: string
  pendingApprovals: number
  /** Connection lifecycle for UI: connecting → waking-vm → ready. */
  phase?: MuseConnectionPhase
  /** Human-readable detail for the current phase. */
  phaseDetail?: string
}

export type MuseConnectionPhase = 'signed-out' | 'connecting' | 'hydrating' | 'waking-vm' | 'reloading' | 'ready'


/** Renderer-safe option chip widget (onboarding Kai/Juno, etc.). */
export interface MuseToolCallView {
  id: string
  name: string
  toolType?: string
  status: 'running' | 'completed' | 'errored'
  summary?: string
}

export interface MuseMediaPartView {
  kind: 'image' | 'file'
  path: string
  name?: string
  imageId?: string
  mimeType?: string
}

export type MuseRichWidgetView =
  | {
      kind: 'shopping_results' | 'shopping_results_v2'
      widgetId: string
      products: Array<{ name: string; url?: string; imageUrl?: string; price?: string; retailer?: string }>
    }
  | {
      kind: 'shopping_cart'
      widgetId: string
      retailerName?: string
      subtotal?: string
      items: Array<{ id: string; name: string; quantity: number; imageUrl?: string; linePrice?: string }>
    }
  | {
      kind: 'local_map'
      widgetId: string
      html?: string
      places: Array<{ id: string; name: string; latitude: number; longitude: number; category?: string }>
    }
  | {
      kind: 'marketplace_map'
      widgetId: string
      listings: Array<{
        id: string
        name: string
        url?: string
        price?: string
        imageUrl?: string
        latitude?: number
        longitude?: number
      }>
    }
  | { kind: 'html'; widgetId: string; html: string; downloadable?: boolean }
  | { kind: 'slides'; widgetId: string; label: string; path?: string; slug: string }
  | {
      kind: 'image_options'
      widgetId: string
      images: Array<{ path: string; imageId?: string }>
      multiSelect?: boolean
      selectedPath?: string | null
      selectedIndices?: number[]
      baseVersion: number
    }
  | {
      kind: 'text_with_button'
      widgetId: string
      text: string
      buttons: Array<{ label: string; actionText?: string; url?: string; command?: string }>
    }
  | {
      kind: 'generic_list'
      widgetId: string
      title?: string
      items: Array<{ id: string; title: string; subtitle?: string; sendText?: string; url?: string }>
    }
  | {
      kind: 'voice_options'
      widgetId: string
      voices: Array<{ id: string; name: string; description?: string; selected?: boolean }>
    }
  | {
      kind: 'markdown'
      widgetId: string
      title?: string
      markdown: string
      path?: string
    }
  | {
      kind: 'hotel_results'
      widgetId: string
      hotels: Array<{ name: string; price?: string; rating?: string; url?: string; imageUrl?: string; location?: string }>
    }
  | {
      kind: 'idea_cards'
      widgetId: string
      cards: Array<{ id: string; title: string; subtitle?: string; prompt?: string }>
    }
  | {
      kind: 'grok_form'
      widgetId: string
      formKind: 'user-form' | 'secret-request' | 'messaging-card'
      entryId: string
      cardVersion?: number
      title?: string
      subtitle?: string
      fields: Array<{
        id: string
        label: string
        type?: string
        required?: boolean
        placeholder?: string
        secret?: boolean
        options?: Array<{ id: string; label: string }>
      }>
      submitted?: boolean
    }
  | {
      kind: 'session_card'
      widgetId: string
      cardType: 'browser' | 'computer' | 'vault'
      title: string
      subtitle?: string
      status?: string
      url?: string
      taskId?: string
      previewSha256?: string
      actionLabel?: string
    }

export interface MuseOptionWidgetView {
  kind: 'option'
  widgetId: string
  options: string[]
  /** Parallel wire values when option value differs from display label (e.g. Grok RespondGrokBotWidget). */
  optionValues?: string[]
  /** Transcript entry id or card id backing this widget. */
  entryId?: string
  /** Optional card version for GrokBotMessagingCard (AnswerGrokBotMessagingCard). */
  cardVersion?: number
  /** Subtype hint ('widget' | 'messaging-card'). */
  widgetSource?: 'muse' | 'grok-widget' | 'grok-card'
  buttonStyle: 'dotted_lines' | 'center_aligned_filled'
  customInputPlaceholder?: string
  selectedText?: string | null
  baseVersion: number
}


export type MuseProxyMode = 'direct' | 'http' | 'https' | 'socks5' | 'socks5h'

/** Renderer-safe proxy view (password never returned). */
export interface MuseProxyView {
  mode: MuseProxyMode
  host?: string
  port?: number
  username?: string
  hasPassword: boolean
}

export interface MuseProxyConfigInput {
  mode: MuseProxyMode
  host?: string
  port?: number
  username?: string
  /** Empty string keeps previous password when hasPassword. */
  password?: string
}

export interface MuseProxyPoolItemView {
  id: string
  mode: Exclude<MuseProxyMode, 'direct'>
  host: string
  port: number
  username?: string
  hasPassword: boolean
  assignedAccountId?: string
}

export interface MuseIdentityView {
  displayName?: string
  emoji?: string
  avatarDataUrl?: string
  avatarColor?: string
}

export type MuseMainEvent =
  | { type: 'status'; status: MuseSessionStatus }
  /** The platform acknowledged the user message of the turn in flight. */
  | { type: 'sent'; accountId: string; conversationId?: string }
  | { type: 'approvals'; accountId: string; pending: unknown[] }
  | {
      type: 'stream'
      accountId: string
      conversationId?: string
      messageId: string
      text: string
      done: boolean
      widgets?: MuseOptionWidgetView[]
      richWidgets?: MuseRichWidgetView[]
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
    }
  | {
      type: 'activity'
      accountId: string
      activityCode: string
      activityText?: string
      activityEmoji?: string
      agentId?: string
      subagents?: number
      busy: boolean
      ctaLabel?: string
    }
  | {
      type: 'login'
      accountId: string
      signedIn: boolean
      handle?: string
      displayName?: string
      /** Set when the login window was closed before a session appeared. */
      windowClosed?: boolean
    }
  | { type: 'quota'; accountId: string; snapshot: MuseQuotaSnapshot }
  | { type: 'schedules'; accountId: string; schedules: MuseSchedule[] }
  | { type: 'invite'; accountId: string; snapshot: MuseInviteSnapshot }
  | { type: 'sessions'; accountId: string; sessions: MuseChatSessionView[] }
  | { type: 'files'; accountId: string; files: MuseFileEntryView[] }
  | { type: 'connectors'; accountId: string; connectors: MuseConnectorView[] }
  | { type: 'identity'; accountId: string; identity: MuseIdentityView }

/** Renderer-safe quota snapshot (no cookies/tokens). */
export interface MuseQuotaSnapshot {
  fetchedAt: number
  stale: boolean
  success: boolean
  subscription: MuseSubscriptionView | null
  error?: string
  inviteUsesRemaining?: number | null
}

export interface MuseSubscriptionView {
  tier: { tierId: string; name: string; tierCode: string; isPaid: boolean; rank: number }
  usage: { state: string; percentUsed: number; resetsAt: number | null; quotaStatus: string }
  statusSubtitle: string | null
  usageRowLabel: string | null
  usageRowValueLabel: string | null
  usageRowFooter: string | null
  billingSubtitle: string | null
  topupBalance: number | null
  topupTotal: number | null
  topupRowLabel: string | null
  topupRowValueLabel: string | null
  topupEligible: boolean | null
  entryPointCtaLabel: string | null
}

export interface MuseSchedule {
  id: string
  title: string
  scheduleKey: string
  timezone: string | null
  isHeartbeat: boolean
  mode: string | null
  enabled: boolean
  nextRunAtUtc: number | null
  cadenceLabel: string
}

export interface MuseTaskRun {
  id: string
  jobId: string
  status: string
  startedAtUtc: number | null
  finishedAtUtc: number | null
  title: string | null
}

/** Renderer-safe invite snapshot (may include code for copy — never log it). */
export interface MuseInviteSnapshot {
  fetchedAt: number
  inviteState: string
  title: string | null
  subtitle: string | null
  code: string | null
  inviteLink: string | null
  shareText: string | null
  maxUses: number | null
  useCount: number | null
  usesRemaining: number | null
  hasRedeemedInviteCode: boolean
  inviteCodeEntryAvailable: boolean
  reward: { title: string | null; body: string | null } | null
  redeemSubtitle: string | null
  redeemDisclaimer: string | null
  error?: string
}

export type MuseSessionMutation =
  | { op: 'archive' | 'unarchive' | 'pin' | 'unpin' | 'delete'; sessionId: string }
  | { op: 'rename'; sessionId: string; title: string }

export interface MuseHistoryMessageView {
  id: string
  role: 'user' | 'bot'
  text: string
  createdAt: number
  widgets?: MuseOptionWidgetView[]
  richWidgets?: MuseRichWidgetView[]
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
}

export interface MuseChatSessionView {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  updatedAtMs: number | null
  createdAtMs: number | null
  preview: string | null
}

export interface MuseFileEntryView {
  id: string
  name: string
  kind: string
  path: string | null
  sizeBytes: number | null
  mimeType: string | null
  pinned: boolean
  updatedAtMs: number | null
  source: 'artifact' | 'library' | 'fs'
}

export interface MuseConnectorView {
  id: string
  name: string
  connected: boolean
  description?: string
}

export interface MuseConnectorConnectResult {
  ok: boolean
  /** Present when the user must finish OAuth in an external browser. */
  oauthUrl?: string
  message?: string
}

export const UPDATE_CHANNELS = {
  check: 'bothub:update:check',
  install: 'bothub:update:install',
  version: 'bothub:update:version',
  event: 'bothub:update:event'
} as const

export type UpdateStatusEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string; manualInstall?: boolean }
  | { type: 'not-available'; version: string }
  | {
      type: 'downloading'
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { type: 'downloaded'; version: string; releaseNotes?: string }
  | { type: 'error'; message: string }


export const GROK_CHANNELS = {
  openLogin: 'bothub:grok:open-login',
  cancelLogin: 'bothub:grok:cancel-login',
  setAccessToken: 'bothub:grok:set-access-token',
  clearAuth: 'bothub:grok:clear-auth',
  authStatus: 'bothub:grok:auth-status',
  getSession: 'bothub:grok:get-session',
  rpc: 'bothub:grok:rpc',
  event: 'bothub:grok:event'
} as const

export type GrokMainEvent =
  | {
      type: 'auth'
      accountId: string
      signedIn: true
      /** Kept optional for backward compatibility; main no longer needs to leak raw tokens to renderer. */
      accessToken?: string
      accountSlot?: string
      teamId?: string
      machineId?: string
    }
  | { type: 'auth'; accountId: string; signedIn: false; windowClosed?: boolean }
  | {
      type: 'stream'
      accountId: string
      conversationId?: string
      agentId: string
      sessionId?: string
      messageId: string
      text: string
      done: boolean
      widgets?: MuseOptionWidgetView[]
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
      richWidgets?: MuseRichWidgetView[]
    }
  | {
      type: 'activity'
      accountId: string
      agentId: string
      sessionId?: string
      busy: boolean
      isComposing?: boolean
      hasRunningSubagents?: boolean
      activityCode: string
      activityText?: string
      activityEmoji?: string
    }
  | {
      type: 'approvals'
      accountId: string
      agentId?: string
      pending: unknown[]
    }
  | {
      type: 'roster_changed'
      accountId: string
      kind: string
      agentId: string
      agent?: Record<string, unknown>
    }
  | {
      type: 'turn_failed'
      accountId: string
      agentId: string
      sessionId?: string
      turnId?: string
      code: string
      summary: string
    }
  | {
      type: 'box_state'
      accountId: string
      state: Record<string, unknown>
    }
  | {
      type: 'page_changed'
      accountId: string
      storeId: string
      canvasId?: string
      documentId: string
      title: string
      contentChanged?: boolean
    }
  | {
      type: 'message_deleted'
      accountId: string
      agentId: string
      sessionId?: string
      messageIds: string[]
    }

export interface GrokOpenLoginRequest {
  accountId: string
  /** When true, opens the PKCE authorization link in the OS default browser instead of an embedded window. */
  openInBrowser?: boolean
}

export interface GrokSetAccessTokenRequest {
  accountId: string
  /** Accepts Bearer accessToken, Cursor user API key (exchanged via /auth/exchange_user_api_key), or JSON {accessToken, refreshToken, xaiAccessToken, ...}. */
  accessToken: string
  refreshToken?: string
  accountSlot?: string
  teamId?: string
  machineId?: string
}

export interface GrokAuthStatus {
  accountId: string
  signedIn: boolean
  accountSlot?: string
  teamId?: string
  machineId?: string
  hasRefreshToken?: boolean
  authKind?: 'cursor' | 'xai' | 'web'
  hasProxy?: boolean
}

/** In-memory session hydrate for renderer (never needs raw Bearer token). */
export interface GrokAuthSessionPayload {
  accountId: string
  signedIn: boolean
  accessToken?: string
  accountSlot?: string
  teamId?: string
  machineId?: string
  hasRefreshToken?: boolean
  authKind?: 'cursor' | 'xai' | 'web'
}

export type GrokServiceId = 'grokbot' | 'sandbox' | 'agentstore' | 'dashboard' | 'ai'

/** Renderer → main ConnectRPC unary & streaming orchestration (avoids api2 CORS). */
export type GrokRpcRequest =
  | {
      accountId: string
      timeZone?: string
      op: 'listAgents'
      role?: string
      includeTeamAgents?: boolean
    }
  | {
      accountId: string
      timeZone?: string
      op: 'listAgentStatuses'
      agentIds?: string[]
    }
  | {
      accountId: string
      timeZone?: string
      op: 'ensureWatch'
      agentIds?: string[]
      conversationMap?: Record<string, string | string[]>
    }
  | {
      accountId: string
      timeZone?: string
      op: 'stopWatch'
    }
  | {
      accountId: string
      timeZone?: string
      op: 'listApprovals'
      agentId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'sendUserMessage'
      agentId: string
      messageId: string
      text: string
      sessionId?: string
      machineId?: string
      sentAtMs?: number
      replyToId?: string
      replyQuote?: string
      attachmentPaths?: string[]
      attachmentNames?: string[]
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string; size?: number }>
    }
  | {
      accountId: string
      timeZone?: string
      op: 'uploadAttachment'
      agentId: string
      sessionId?: string
      fileName: string
      mimeType?: string
      dataBase64: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'resolveAttachmentReads'
      agentId: string
      sessionId?: string
      paths: string[]
    }
  | {
      accountId: string
      timeZone?: string
      op: 'downloadAttachment'
      agentId?: string
      sessionId?: string
      path?: string
      url?: string
      storeId?: string
      documentId?: string
      groupChatId?: string
      name?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'uploadAgentFile'
      agentId: string
      fileName: string
      contentType?: string
      dataBase64: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'respondWidget'
      agentId: string
      entryId: string
      value: string
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'dismissWidget'
      agentId: string
      entryId: string
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'answerMessagingCard'
      cardId: string
      version: number
      answer: 'APPROVE' | 'DENY' | 'CHOOSE' | 'SUBMIT' | 'ALWAYS' | 'ESCALATE' | number
      optionId?: string
      values?: Record<string, string>
    }
  | {
      accountId: string
      timeZone?: string
      op: 'submitUserForm'
      agentId: string
      entryId: string
      values: Record<string, string>
      sessionId?: string
      saveToVault?: boolean
    }
  | {
      accountId: string
      timeZone?: string
      op: 'submitSecret'
      agentId: string
      entryId: string
      value: string
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'reactMessage'
      agentId: string
      entryId: string
      emoji: string
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'searchTranscripts'
      query: string
      target?: 'MESSAGES' | 'FILES'
      agentId?: string
      limit?: number
      continuation?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'exportRecipe'
      agentId: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'importRecipe'
      recipeJson: string
      nameOverride?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'getSendStatus'
      agentId: string
      messageId: string
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'listTranscriptEntries'
      agentId: string
      sessionId?: string
      limit?: number
      beforeSeq?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'watchUntilReply'
      agentId: string
      conversationId?: string
      sessionId?: string
      afterUpdatedSeq?: string
      afterMessageId?: string
      timeoutMs?: number
    }
  | {
      accountId: string
      timeZone?: string
      op: 'call'
      service?: GrokServiceId
      method: string
      params?: Record<string, unknown>
    }
  | {
      accountId: string
      timeZone?: string
      op: 'resolveAutoReview'
      agentId: string
      requestId: string
      resolution: number
      sessionId?: string
      approvalPlatform?: string
      approvedCommand?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'resolveLocalTool'
      agentId: string
      entryId?: string
      requestId: string
      resolution: number
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'resolveConnectorGrant'
      agentId: string
      entryId?: string
      requestId: string
      resolution: number
      sessionId?: string
    }
  | {
      accountId: string
      timeZone?: string
      op: 'resolveVirtualCard'
      agentId: string
      entryId: string
      requestId: string
      resolution: number
      paymentMethodId?: string
    }

export type GrokRpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message: string; body?: string }


export const HARK_CHANNELS = {
  openLogin: 'bothub:hark:open-login',
  cancelLogin: 'bothub:hark:cancel-login',
  authStatus: 'bothub:hark:auth-status',
  importCredentials: 'bothub:hark:import-credentials',
  clearAuth: 'bothub:hark:clear-auth',
  rpc: 'bothub:hark:rpc',
  event: 'bothub:hark:event'
} as const

export type HarkMainEvent =
  | { type: 'projectHistory'; accountId: string; conversationId: string; subscription: string; messages: unknown[]; browserPreview?: HarkBrowserPreview | null }
  | {
      type: 'login'
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
    }
  | {
      type: 'login'
      accountId: string
      signedIn: false
      windowClosed?: boolean
    }
  | {
      type: 'stream'
      sessionId: string
      accountId: string
      conversationId?: string
      messageId: string
      text: string
      done: boolean
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
      richWidgets?: MuseRichWidgetView[]
    }
  | {
      type: 'activity'
      sessionId?: string
      accountId: string
      activityCode: string
      activityText?: string
      activityEmoji?: string
      busy: boolean
    }

export interface HarkOpenLoginRequest {
  accountId: string
}

export interface HarkImportCredentialsRequest {
  accountId: string
  rawInput: string
}

export interface HarkAuthStatus {
  accountId: string
  signedIn: boolean
  handle?: string
  displayName?: string
  hasProxy?: boolean
}

export type HarkRpcRequest =
  | { accountId: string; op: 'authStatus' }
  | { accountId: string; op: 'getSession' }
  | { accountId: string; op: 'profile' }
  | { accountId: string; op: 'listConversations' }
  | { accountId: string; op: 'mainConversation'; timezone?: string }
  | { accountId: string; op: 'observeProject'; conversationId: string; subscription: string }
  | { accountId: string; op: 'leaveProject'; subscription: string }
  | { accountId: string; op: 'browserPreview'; conversationId?: string }
  | { accountId: string; op: 'conversationSnapshot'; conversationId: string }
  | { accountId: string; op: 'createConversation'; title: string; timezone?: string }
  | { accountId: string; op: 'conversationStatus' }
  | {
      accountId: string
      op: 'sendMessage'
      conversationId: string
      text: string
      timezone?: string
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>
    }
  | {
      accountId: string
      op: 'pollReply'
      conversationId: string
      botId?: string
      responseMessageId?: string
      timezone?: string
      afterMessageCount?: number
      afterMessageIds?: string[]
      timeoutMs?: number
    }
  | {
      accountId: string
      op: 'downloadArtifact'
      url?: string
      fileId?: string
      name?: string
    }
  | {
      accountId: string
      op: 'call'
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      path: string
      query?: Record<string, string | undefined>
      body?: unknown
    }

export type HarkRpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message: string; body?: string }


export const DOT_CHANNELS = {
  openLogin: 'bothub:dot:open-login',
  cancelLogin: 'bothub:dot:cancel-login',
  authStatus: 'bothub:dot:auth-status',
  importCredentials: 'bothub:dot:import-credentials',
  clearAuth: 'bothub:dot:clear-auth',
  rpc: 'bothub:dot:rpc',
  event: 'bothub:dot:event'
} as const

export type DotMainEvent =
  /** The room message of the send in flight was posted. */
  | { type: 'sent'; accountId: string }
  | {
      type: 'login'
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
      planType?: string
      chatgptAccountId?: string
    }
  | {
      type: 'login'
      accountId: string
      signedIn: false
      windowClosed?: boolean
    }
  | {
      type: 'stream'
      accountId: string
      conversationId?: string
      dotId?: string
      messageId: string
      text: string
      done: boolean
      stillBusy?: boolean
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
      richWidgets?: MuseRichWidgetView[]
    }
  | {
      type: 'activity'
      accountId: string
      activityCode: string
      activityText?: string
      activityEmoji?: string
      busy: boolean
    }

export interface DotOpenLoginRequest {
  accountId: string
}

export interface DotAuthStatus {
  accountId: string
  signedIn: boolean
  handle?: string
  displayName?: string
  planType?: string
  chatgptAccountId?: string
  activeDotId?: string
  roomId?: string
  threadId?: string
  mode?: 'dot' | 'native'
  model?: string
  effort?: string
  hasRefreshToken?: boolean
  expiresAtMs?: number
  updatedAt?: number
  hasProxy?: boolean
  migration?: {
    goalCopied: boolean
    memoriesCopied: number
  }
}

export interface DotImportCredentialsRequest {
  accountId: string
  /** Raw ChatGPT access_token (eyJ...), refresh_token (rt_...), or JSON (auth.json / session JSON). */
  rawInput: string
  refreshToken?: string
  chatgptAccountId?: string
  proxyUrl?: string
  /** Optional source accountId to migrate Dot goal & memory from when replacing credentials. */
  migrateDataFromAccountId?: string
}

export type DotRpcRequest =
  | { accountId: string; op: 'authStatus' }
  | { accountId: string; op: 'listStoredAccounts' }
  | { accountId: string; op: 'listDots'; ensureDefault?: boolean }
  | { accountId: string; op: 'createDot'; displayName?: string; color?: string }
  | { accountId: string; op: 'getDot'; dotId: string }
  | { accountId: string; op: 'deleteDot'; dotId: string }
  | { accountId: string; op: 'selectDot'; dotId: string; botId?: string }
  | { accountId: string; op: 'pauseRuntime'; dotId?: string }
  | { accountId: string; op: 'resumeRuntime'; dotId?: string }
  | { accountId: string; op: 'cancelTurn'; dotId?: string }
  | { accountId: string; op: 'listThreads'; dotId?: string }
  | {
      accountId: string
      op: 'listRoomMessages'
      roomId?: string
      dotId?: string
      limit?: number
      after?: string
    }
  | {
      accountId: string
      op: 'sendMessage'
      botId?: string
      dotId?: string
      roomId?: string
      text: string
      mode?: 'dot' | 'native'
      model?: string
      effort?: string
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>
    }
  | {
      accountId: string
      op: 'setMode'
      mode: 'dot' | 'native'
      model?: string
      effort?: string
    }
  | { accountId: string; op: 'rateLimits' }
  | { accountId: string; op: 'listModels' }
  | { accountId: string; op: 'listLibrary'; limit?: number }
  | {
      accountId: string
      op: 'downloadFile'
      url?: string
      downloadUrl?: string
      fileId?: string
      roomId?: string
      name?: string
    }
  | { accountId: string; op: 'createPage'; title: string; layout?: 'document' | 'spatial' }
  | { accountId: string; op: 'deletePage'; pageId: string }
  | { accountId: string; op: 'getGoal'; threadId?: string }
  | { accountId: string; op: 'setGoal'; threadId?: string; goal: string }
  | { accountId: string; op: 'clearGoal'; threadId?: string }
  | {
      accountId: string
      op: 'exportMemory'
      mode?: 'fast' | 'deep'
      dotId?: string
      roomId?: string
    }
  | {
      accountId: string
      op: 'importMemory'
      markdown: string
      goal?: string
      botId?: string
      dotId?: string
      roomId?: string
    }
  | {
      accountId: string
      op: 'call'
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      path: string
      query?: Record<string, string | undefined>
      body?: unknown
    }

export type DotRpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message: string; body?: string }

export const HERMES_CHANNELS = {
  configure: 'bothub:hermes:configure',
  detectLocal: 'bothub:hermes:detect-local',
  authStatus: 'bothub:hermes:auth-status',
  listAccounts: 'bothub:hermes:list-accounts',
  clearAuth: 'bothub:hermes:clear-auth',
  rpc: 'bothub:hermes:rpc',
  event: 'bothub:hermes:event'
} as const

export interface HermesConfigureRequest {
  accountId: string
  baseUrl: string
  /** Optional API_SERVER_KEY; leave empty for unauthenticated local listener or set `useLocalKey` to read ~/.hermes/.env in main process. */
  apiKey?: string
  /** When true, keep the currently stored encrypted API key if `apiKey` is omitted. */
  keepExistingKey?: boolean
  /** When true, import API_SERVER_KEY directly from local ~/.hermes/.env inside main process (never sent to renderer). */
  useLocalKey?: boolean
  /** Optional model / route alias override (defaults to server default, e.g. hermes-agent). */
  model?: string
  displayName?: string
}

export interface HermesLocalDetection {
  reachable: boolean
  baseUrl: string
  version?: string
  platform?: string
  hasLocalEnvKey: boolean
  localEnvHost?: string
  localEnvPort?: number
  requiresAuth?: boolean
}

export interface HermesAuthStatus {
  accountId: string
  signedIn: boolean
  baseUrl?: string
  handle?: string
  displayName?: string
  model?: string
  version?: string
  hasApiKey?: boolean
  hasProxy?: boolean
  supportsSessions?: boolean
  error?: string
}

export interface HermesSessionSummary {
  id: string
  title?: string | null
  model?: string | null
  source?: string | null
  startedAt?: string | number | null
  lastActive?: string | number | null
  preview?: string | null
  messageCount?: number
  toolCallCount?: number
  pinned?: boolean
  archived?: boolean
}

export interface HermesSkillItem {
  name: string
  description?: string
  category?: string
  enabled?: boolean
}

export interface HermesToolsetItem {
  name: string
  label?: string
  description?: string
  enabled: boolean
  configured: boolean
  tools: string[]
}

export interface HermesCronJob {
  id: string
  name: string
  schedule: string
  prompt?: string
  enabled: boolean
  paused?: boolean
  lastRunAt?: string | number | null
  nextRunAt?: string | number | null
}

export interface HermesApprovalView {
  id: string
  status: string
  title: string
  detail?: string
  approvalType?: string
  host?: string
  decisionOptions?: Array<'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always'>
  reason?: string
  raw?: unknown
}

export type HermesMainEvent =
  | { type: 'accepted'; accountId: string; requestId: string }
  | {
      type: 'login'
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
    }
  | {
      type: 'login'
      accountId: string
      signedIn: false
    }
  | {
      type: 'stream'
      accountId: string
      conversationId?: string
      sessionId?: string
      messageId: string
      text: string
      done: boolean
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
    }
  | {
      type: 'activity'
      accountId: string
      activityCode: string
      activityText?: string
      activityEmoji?: string
      busy: boolean
    }
  | {
      type: 'approvals'
      accountId: string
      pending: HermesApprovalView[]
    }

export type HermesRpcRequest =
  | { accountId: string; op: 'health' }
  | { accountId: string; op: 'models' }
  | { accountId: string; op: 'capabilities' }
  | { accountId: string; op: 'skills' }
  | { accountId: string; op: 'toolsets' }
  | { accountId: string; op: 'listJobs' }
  | { accountId: string; op: 'toggleJob'; jobId: string; pause: boolean }
  | { accountId: string; op: 'runJob'; jobId: string }
  | { accountId: string; op: 'deleteJob'; jobId: string }
  | { accountId: string; op: 'listSessions'; limit?: number }
  | { accountId: string; op: 'createSession'; title?: string; model?: string }
  | { accountId: string; op: 'deleteSession'; sessionId: string }
  | { accountId: string; op: 'getSessionMessages'; sessionId: string }
  | { accountId: string; op: 'setModel'; model: string }
  | { accountId: string; op: 'listApprovals' }
  | {
      accountId: string
      op: 'decideApproval'
      approvalId: string
      decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always'
    }
  | { accountId: string; op: 'stopRun' }
  | {
      accountId: string
      op: 'sendMessage'
      botId?: string
      requestId?: string
      sessionId?: string
      sessionKey?: string
      text: string
      model?: string
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>
    }

export type HermesRpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message: string; body?: string }

export const VAULT_CHANNELS = {
  status: 'bothub:vault:status',
  getSecret: 'bothub:vault:get-secret',
  setSecret: 'bothub:vault:set-secret',
  deleteSecret: 'bothub:vault:delete-secret',
  clearAll: 'bothub:vault:clear-all',
  hardenPermissions: 'bothub:vault:harden-permissions'
} as const

export interface SecurityStoreAudit {
  id: string
  label: string
  fileName: string
  exists: boolean
  modeOctal: string | null
  ownerOnly: boolean
  entryCount: number
}

export interface SecurityAccountAudit {
  accountId: string
  platformId?: 'meta-muse' | 'grok' | 'hark' | 'dot' | 'hermes' | 'antigravity' | 'cue' | 'ds-bot'
  partition: string
  transportProtocol: string
  credentialIsolation: string
  proxyMode: MuseProxyMode
  proxyEndpoint?: string
  proxyReadable: boolean
  failClosedGuard: boolean
}

export interface SecurityVaultStatus {
  checkedAtMs: number
  keychainAvailable: boolean
  cipherSuite: string
  codeSigned: boolean
  signingAuthority?: string
  rendererSandbox: {
    contextIsolation: boolean
    sandbox: boolean
    zeroRendererTokens: boolean
  }
  stores: SecurityStoreAudit[]
  accountAudit?: SecurityAccountAudit
}

export interface VaultStatusRequest {
  accountId?: string
  platformId?: 'meta-muse' | 'grok' | 'hark' | 'dot' | 'hermes' | 'antigravity' | 'cue' | 'ds-bot'
}

export const CUE_CHANNELS = {
  openLogin: 'bothub:cue:open-login',
  cancelLogin: 'bothub:cue:cancel-login',
  importCredentials: 'bothub:cue:import-credentials',
  clearAuth: 'bothub:cue:clear-auth',
  authStatus: 'bothub:cue:auth-status',
  getSession: 'bothub:cue:get-session',
  rpc: 'bothub:cue:rpc',
  event: 'bothub:cue:event'
} as const

export interface CueOpenLoginRequest {
  accountId: string
  openInBrowser?: boolean
}

export interface CueImportCredentialsRequest {
  accountId: string
  verifyApiKey?: boolean
  credential?: string
  rawInput?: string
  accessToken?: string
  refreshToken?: string
}

export interface CueAuthStatus {
  accountId: string
  signedIn: boolean
  handle?: string
  displayName?: string
  accountSlot?: string
  deviceId?: string
  authKind?: 'oauth' | 'api-key' | 'session' | 'mock'
  hasProxy?: boolean
  error?: string
}

export interface CueAuthSessionPayload {
  accountId: string
  signedIn: boolean
  handle?: string
  displayName?: string
  accountSlot?: string
  deviceId?: string
  authKind?: 'oauth' | 'api-key' | 'session' | 'mock'
}

export type CueRpcRequest =
  | { accountId: string; op: 'health'; baseUrl?: string }
  | { accountId: string; op: 'listAgents'; baseUrl?: string }
  | { accountId: string; op: 'listTasks'; agentId?: string; baseUrl?: string }
  | {
      accountId: string
      op: 'getHistory'
      sessionId?: string
      agentId?: string
      limit?: number
      baseUrl?: string
    }
  | {
      accountId: string
      op: 'sendMessage'
      agentId?: string
      sessionId?: string
      conversationId?: string
      text: string
      baseUrl?: string
    }
  | {
      accountId: string
      op: 'watchUntilReply'
      agentId?: string
      sessionId?: string
      conversationId?: string
      afterMessageId?: string
      expectedUserText?: string
      baseUrl?: string
    }
  | {
      accountId: string
      op: 'approve'
      approvalId: string
      decision: string
      sessionId?: string
      baseUrl?: string
    }
  | { accountId: string; op: 'quota'; baseUrl?: string }
  | {
      accountId: string
      op: 'call'
      path: string
      method?: 'GET' | 'POST'
      body?: unknown
      baseUrl?: string
    }

export type CueRpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message: string }

export type CueMainEvent =
  | {
      type: 'auth'
      accountId: string
      signedIn: boolean
      handle?: string
      displayName?: string
      accountSlot?: string
      windowClosed?: boolean
    }
  | {
      type: 'roster_changed'
      accountId: string
    }
  | {
      type: 'activity'
      accountId: string
      agentId?: string
      sessionId?: string
      activityCode?: string
      activityText?: string | null
      busy: boolean
    }
  | {
      type: 'stream'
      accountId: string
      agentId?: string
      conversationId?: string
      sessionId?: string
      messageId: string
      text: string
      done: boolean
    }
  | {
      type: 'turn_failed'
      accountId: string
      agentId?: string
      conversationId?: string
      message: string
    }
  | {
      type: 'approvals'
      accountId: string
      pending: Array<Record<string, unknown>>
    }
  | {
      type: 'message_deleted'
      accountId: string
      conversationId?: string
      messageIds: string[]
    }

export const ANTIGRAVITY_CHANNELS = {
  openLogin: 'bothub:antigravity:open-login',
  cancelLogin: 'bothub:antigravity:cancel-login',
  importCredentials: 'bothub:antigravity:import-credentials',
  clearAuth: 'bothub:antigravity:clear-auth',
  authStatus: 'bothub:antigravity:auth-status',
  sendMessage: 'bothub:antigravity:send-message',
  cancelRun: 'bothub:antigravity:cancel-run',
  rpc: 'bothub:antigravity:rpc',
  event: 'bothub:antigravity:event'
} as const

export interface AntigravityOpenLoginRequest {
  accountId: string
}

export interface AntigravityImportCredentialsRequest {
  accountId: string
  rawInput: string
}

export interface AntigravityAuthStatus {
  accountId: string
  signedIn: boolean
  handle?: string
  displayName?: string
  planDisplayName?: string
  selectedModelEnum?: number
  selectedModelName?: string
  sessionCookieNames: string[]
  error?: string
}

export interface AntigravitySendRequest {
  accountId: string
  conversationId: string
  sessionId?: string
  text: string
  clientMessageId?: string
}

export type AntigravitySendResponse =
  | { ok: true; cascadeId: string; messageId: string }
  | { ok: false; status: number; message: string }

export interface AntigravityRpcRequest {
  accountId: string
  action:
    | 'profile'
    | 'models'
    | 'agents'
    | 'environments'
    | 'workspaces'
    | 'listConversations'
    | 'getConversation'
    | 'deleteConversation'
    | 'setPrefs'
  pageSize?: number
  conversationId?: string
  modelEnum?: number
  modelDisplayName?: string
  capsuleId?: string
  agentPath?: string
}

export type AntigravityRpcResponse =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; message: string }

export type AntigravityMainEvent =
  | {
      type: 'login'
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
      planDisplayName?: string
    }
  | {
      type: 'login'
      accountId: string
      signedIn: false
      windowClosed?: boolean
    }
  | {
      type: 'stream'
      accountId: string
      conversationId?: string
      sessionId?: string
      messageId: string
      text: string
      done: boolean
      tools?: MuseToolCallView[]
    }
  | {
      type: 'activity'
      accountId: string
      activityCode: string
      activityText?: string | null
      activityEmoji?: string | null
      busy: boolean
    }

export const DS_BOT_CHANNELS = {
  configure: 'bothub:dsbot:configure',
  detectLocal: 'bothub:dsbot:detect-local',
  authStatus: 'bothub:dsbot:auth-status',
  listAccounts: 'bothub:dsbot:list-accounts',
  clearAuth: 'bothub:dsbot:clear-auth',
  rpc: 'bothub:dsbot:rpc',
  event: 'bothub:dsbot:event'
} as const

export type DsBotTransportMode = 'mcp' | 'channel' | 'relay'

export interface DsBotConfigureRequest {
  accountId: string
  mode: DsBotTransportMode
  /** Display name for this DS Bot team/host instance. */
  displayName?: string
  /** MCP mode: `http://127.0.0.1:8797/mcp` or remote URL; Channel mode: DSH Web URL (may include `?token=...`). */
  endpointUrl?: string
  /** MCP mode bearer token (`dsb_...`) or Channel mode optional `Cookie` header. */
  secret?: string
  /** Relay mode: `dsbot://pair?v=1&...` or browser pairing URL. */
  pairingUri?: string
  /** Keep previously stored encrypted credentials when editing displayName / endpoint on same origin. */
  keepExistingSecret?: boolean
}

export interface DsBotLocalDetection {
  mcpReachable: boolean
  mcpUrl: string
  mcpPort: number
  mcpEnabledInConfig: boolean
  mcpConfigPath?: string
  channelReachable: boolean
  channelUrl?: string
  channelPort?: number
  dataDir?: string
}

export interface DsBotAuthStatus {
  accountId: string
  signedIn: boolean
  mode?: DsBotTransportMode
  baseUrl?: string
  relayServer?: string
  hostDeviceId?: string
  hostName?: string
  handle?: string
  displayName?: string
  version?: string
  hasSecret?: boolean
  hasProxy?: boolean
  botCount?: number
  groupCount?: number
  supportsLiveStream?: boolean
  supportsApprovals?: boolean
  supportsMemory?: boolean
  supportsSchedules?: boolean
  supportsImages?: boolean
  error?: string
}

export interface DsBotTargetInfo {
  /** Prefixed agent id for BotArk routing: `bot:<id>` or `room:<id>`. */
  id: string
  /** Raw DS Bot botId or roomId. */
  rawId: string
  kind: 'bot' | 'room'
  name: string
  role?: string
  model?: string
  color?: string
  avatarShape?: string
  avatarImage?: string
  main?: boolean
  working?: boolean
  sessionId?: string
  workDir?: string
  members?: string[]
  preview?: string
  lastAt?: number
}

export interface DsBotModelInfo {
  ref: string
  name: string
  provider?: string
  providerName?: string
}

export interface DsBotApprovalView {
  id: string
  botId?: string
  botName?: string
  roomId?: string
  roomName?: string
  sessionId?: string
  tool: string
  reason?: string
  detail?: string
  at?: number
  answerable: boolean
}

export interface DsBotQuestionView {
  id: string
  sessionId: string
  botId?: string
  botName?: string
  question: string
  detail?: string
  options?: Array<{ label: string }>
  multiSelect?: boolean
  answerable: boolean
}

export interface DsBotMemoryEntry {
  scope: string
  topic?: string
  text: string
  pinned?: boolean
  added?: string
}

export interface DsBotMemoryView {
  summary?: string | null
  entries: DsBotMemoryEntry[]
  memoryEnabled: boolean
}

export interface DsBotScheduleItem {
  id: string
  sessionId: string
  title: string
  prompt: string
  kind?: string
  state: string
  status?: string
  scheduledAt?: string
  botId?: string
  roomId?: string
  canPause?: boolean
}

export interface DsBotUsageBucket {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  calls: number
}

export interface DsBotUsageSummary {
  botId: string
  day: DsBotUsageBucket
  week: DsBotUsageBucket
  month: DsBotUsageBucket
  models: Array<{ key: string; name: string } & DsBotUsageBucket>
  scanning?: boolean
}

export interface DsBotHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  senderName?: string
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
}

export type DsBotMainEvent =
  | { type: 'accepted'; accountId: string; requestId: string; agentId?: string }
  | {
      type: 'login'
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
    }
  | {
      type: 'login'
      accountId: string
      signedIn: false
    }
  | {
      type: 'roster_changed'
      accountId: string
    }
  | {
      type: 'stream'
      accountId: string
      agentId: string
      conversationId?: string
      sessionId?: string
      requestId?: string
      messageId: string
      text: string
      done: boolean
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
    }
  | {
      type: 'activity'
      accountId: string
      agentId?: string
      requestId?: string
      activityCode: string
      activityText?: string
      activityEmoji?: string
      busy: boolean
    }
  | {
      type: 'approvals'
      accountId: string
      pending: DsBotApprovalView[]
      questions?: DsBotQuestionView[]
    }

export type DsBotRpcRequest =
  | { accountId: string; op: 'listTargets' }
  | { accountId: string; op: 'getState' }
  | { accountId: string; op: 'listModels' }
  | { accountId: string; op: 'getHistory'; agentId: string }
  | {
      accountId: string
      op: 'sendMessage'
      agentId: string
      botId?: string
      requestId?: string
      text: string
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>
    }
  | { accountId: string; op: 'stopRun'; agentId?: string; requestId?: string }
  | { accountId: string; op: 'listWaiting' }
  | { accountId: string; op: 'decideApproval'; approvalId: string; choice: 'allow' | 'reject' }
  | { accountId: string; op: 'answerQuestion'; sessionId: string; questionId: string; answer: string }
  | { accountId: string; op: 'getMemory'; agentId: string }
  | { accountId: string; op: 'addMemory'; agentId: string; text: string; scope?: string; topic?: string }
  | { accountId: string; op: 'forgetMemory'; agentId: string; text: string; scope?: string; topic?: string }
  | { accountId: string; op: 'listSchedules' }
  | {
      accountId: string
      op: 'toggleSchedule'
      scheduleId: string
      sessionId: string
      active: boolean
    }
  | { accountId: string; op: 'deleteSchedule'; scheduleId: string; sessionId: string }
  | { accountId: string; op: 'getUsage'; agentId: string }
  | { accountId: string; op: 'setBotModel'; agentId: string; model: string }
  | { accountId: string; op: 'createBot'; name: string; role?: string; model?: string; instructions?: string }

export type DsBotRpcResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code?: string; message: string; body?: string }




