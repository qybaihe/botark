import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getPlatform } from '@adapters/platforms'
import { adapterRegistry } from '@adapters/registry'
import { AdapterError, type AttachmentMeta, type ConnectionStatus, type IncomingMessage, type PlatformId } from '@adapters/types'
import { createId } from '@shared/id'
import { createSeed } from '@/data/seed'
import { t } from '@/lib/i18n'
import type { AccountDraft, Bot, BotAccount, BotGroup, ChatMessage, ChatReplyTarget, NewBotInput } from '@/types'
import { clearNoReplyFlag, createSafeStorage, sanitizePersisted, SEND_HARD_TIMEOUT_MS, SendTimeoutError, toPersistedMessages, withTimeout, deliveryAfterError, createInFlightSet, hasLostAttachments, ATTACHMENTS_LOST_TEXT } from './delivery'

let warnedStorage = false
const workspaceStorage = createJSONStorage(() =>
  createSafeStorage(
    () => (typeof localStorage === 'undefined' ? undefined : localStorage),
    (error) => {
      if (warnedStorage) return
      warnedStorage = true
      console.warn('[bothub] could not save workspace:', error instanceof Error ? error.name : 'error')
    }
  )
)

const NO_REPLY_TEXT = '已送达，但没有收到回复'

function electronBridge() {
  if (typeof window === 'undefined') return undefined
  return window.electron
}

export interface BotHubState {
  groups: BotGroup[]
  bots: Bot[]
  accounts: Record<string, BotAccount>
  /** Conversation per bot, keyed by bot id. */
  messages: Record<string, ChatMessage[]>
  /** Bot ids whose reply is currently being generated. */
  typing: Record<string, boolean>
  /** Per-account Muse agent.status phrase. */
  activity: Record<string, import('@/types').BotActivity>
  selectedBotId: string | null
  collapsedGroups: Record<string, boolean>
  infoPanelOpen: boolean
  /** Sidebar collapsed into compact icon rail (Grok Bot style). */
  sidebarCollapsed: boolean
  /** Sidebar width in px (dragged by its right edge). */
  sidebarWidth: number
  addBotOpen: boolean
  /** Optional platform pre-highlighted when opening AddBotDialog from Onboarding. */
  addBotInitialPlatform: PlatformId | null
  /** Bumped on every open so each add-bot flow starts fresh. */
  addBotKey: number
  /** Interactive product & security onboarding tour modal. */
  onboardingOpen: boolean
  /** Command palette (⌘K); `paletteQuery` seeds it when typing opens it. */
  paletteOpen: boolean
  paletteQuery: string
  paletteKey: number
  /** Show the embedded platform web session instead of the chat (Electron only). */
  webSessionOpen: boolean
  /** Open the dedicated Grok Bot-style Settings view in the main pane. */
  settingsOpen: boolean
  settingsTab:
    | 'overview'
    | 'general'
    | 'muse-accounts'
    | 'dot-accounts'
    | 'grok-accounts'
    | 'hark-accounts'
    | 'hermes-accounts'
    | 'antigravity-accounts'
    | 'mobile-sync'
    | 'proxy-pool'
  /** Active document/article opened in the right-side Split-Pane Document Canvas. */
  activeDocument: import('@/components/chat/NativeDocumentDialog').NativeDocumentTarget | null
  /** Per-bot pending quote-reply target shown in Composer. */
  replyingTo: Record<string, ChatReplyTarget | undefined>
  hermesSessionErrors: Record<string, string | undefined>
  /** Per-account Grok agentIds explicitly removed from sidebar so auto-sync respects user deletion until manual sync. */
  dismissedGrokAgents: Record<string, string[]>

  // Navigation & layout
  selectBot: (botId: string) => void
  setActiveDocument: (doc: import('@/components/chat/NativeDocumentDialog').NativeDocumentTarget | null) => void
  setReplyTarget: (botId: string, target: ChatReplyTarget | null) => void
  deleteMessages: (botId: string, messageIds: string[]) => void
  toggleGroup: (groupId: string) => void
  /** Create a local sidebar section (Grok-like; not a host API). */
  addGroup: (name?: string) => string
  renameGroup: (groupId: string, name: string) => void
  /** Drop a section; its bots move to another section. Keeps at least one. */
  removeGroup: (groupId: string) => void
  moveBotToGroup: (botId: string, groupId: string) => void
  togglePinBot: (botId: string) => void
  /** Local drag-reorder: place `botId` before `beforeId` (or at end) inside `groupId`. */
  reorderBot: (botId: string, groupId: string, beforeId: string | null) => void
  toggleInfoPanel: () => void
  toggleSidebarCollapsed: () => void
  setSidebarWidth: (width: number) => void
  setAddBotOpen: (open: boolean, initialPlatform?: PlatformId | null) => void
  setOnboardingOpen: (open: boolean) => void
  toggleWebSession: () => void
  setSettingsOpen: (
    open: boolean,
    tab?:
      | 'overview'
      | 'general'
      | 'muse-accounts'
      | 'dot-accounts'
      | 'grok-accounts'
      | 'hark-accounts'
      | 'hermes-accounts'
      | 'antigravity-accounts'
      | 'mobile-sync'
      | 'proxy-pool'
  ) => void
  openPalette: (query?: string) => void
  closePalette: () => void
  /** Select the bot `offset` rows away in sidebar order (wraps). */
  selectAdjacentBot: (offset: number) => void

  // Creation
  /** Create a bot (and any new accounts/group), select it, and connect its accounts. */
  addBot: (input: NewBotInput) => string
  addAccountsToBot: (botId: string, drafts: AccountDraft[]) => void
  renameBot: (botId: string, name: string) => void
  setBotAvatar: (botId: string, avatar: string | undefined) => void
  setBotCharacter: (botId: string, character: { shape?: string; color?: string }) => void
  /** Delete a bot; accounts no other bot uses are signed out and dropped. */
  removeBot: (botId: string) => Promise<void>

  // Conversation
  sendMessage: (botId: string, text: string, attachments?: AttachmentMeta[]) => Promise<void>
  retryMessage: (botId: string, messageId: string) => Promise<void>
  receiveMessage: (message: IncomingMessage) => void
  /** Upsert a streaming assistant bubble (same id updated as deltas arrive). */
  applyMessageDelta: (messageId: string, conversationId: string, accountId: string, text: string, widgets?: import('@/types').ChatOptionWidget[], tools?: import('@/types').ChatToolCall[], media?: import('@/types').ChatMediaPart[], richWidgets?: import('@/types').ChatRichWidget[]) => void
  setTyping: (botId: string, isTyping: boolean) => void
  setActivity: (accountId: string, activity: import('@/types').BotActivity | null) => void
  setMessageWidgets: (botId: string, messageId: string, widgets: import('@/types').ChatOptionWidget[]) => void
  selectChatOption: (botId: string, messageId: string, widgetId: string, selectedText: string, optionIndex: number) => Promise<void>
  cancelGeneration: (botId: string) => Promise<void>
  switchMuseSession: (botId: string, sessionId: string) => Promise<void>
  startNewMuseSession: (botId: string) => Promise<void>
  switchHermesSession: (botId: string, sessionId: string) => Promise<void>
  startNewHermesSession: (botId: string) => Promise<boolean>
  switchAntigravitySession: (botId: string, sessionId: string) => Promise<void>
  startNewAntigravitySession: (botId: string) => void

  // Bot details
  updateNotes: (botId: string, notes: string) => void
  addMemory: (botId: string, text: string) => void
  removeMemory: (botId: string, memoryId: string) => void

  // Accounts
  removeAccountFromBot: (botId: string, accountId: string) => void
  setActiveAccount: (botId: string, accountId: string) => void
  setSelectedAgent: (botId: string, agentId: string) => void
  renameAccount: (accountId: string, displayName: string) => void
  /** Sign out: clear persist partition + mark offline. */
  signOutAccount: (accountId: string) => Promise<void>
  /** Remove from bot and wipe the partition (full delete). */
  removeAndClearAccount: (botId: string, accountId: string) => Promise<void>
  setAccountStatus: (accountId: string, status: ConnectionStatus, detail?: string) => void
  connectAccount: (accountId: string) => Promise<void>
  /** Muse: open same-partition login BrowserWindow. */
  openMuseLogin: (accountId: string) => Promise<void>
  /** Grok: open PKCE login (embedded window by default, or OS browser when `openInBrowser` is true). */
  openGrokLogin: (accountId: string, openInBrowser?: boolean) => Promise<void>
  /** Sync all Agents under a Grok account so each Agent appears as its own Bot in the left sidebar. */
  syncGrokAccountBots: (
    accountId: string,
    opts?: { includeDismissed?: boolean; selectFirst?: boolean; preferredGroupId?: string }
  ) => Promise<number>
  /** Hark: open Hark login window (Google / Apple / Email OTP). */
  openHarkLogin: (accountId: string) => Promise<void>
  /** Dot: open ChatGPT Dot login window (chatgpt.com/dots). */
  openDotLogin: (accountId: string) => Promise<void>
  /** Antigravity: open Google Antigravity login window (antigravity.google.com). */
  openAntigravityLogin: (accountId: string) => Promise<void>
  /** Inject Grok accessToken (or mark main-captured PKCE session active) in adapter. */
  setGrokAccessToken: (
    accountId: string,
    accessToken?: string,
    accountSlot?: string,
    machineId?: string,
    refreshToken?: string
  ) => Promise<void>
  disconnectAccount: (accountId: string) => Promise<void>
  /** Wipe all stored credentials, tokens, cookies, and proxy pool across all platforms. */
  clearAllCredentials: () => Promise<void>
  /** Wipe all credentials and reset workspace (bots, accounts, messages, groups) to factory defaults. */
  resetWorkspace: () => Promise<void>
}


function uniqueGroupName(groups: BotGroup[], base = 'New section'): string {
  const taken = new Set(groups.map((g) => g.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

const seed = createSeed()

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 400
export const SIDEBAR_DEFAULT = 280

/** Turn form drafts into account ids, creating BotAccounts for new ones. */
function materializeAccounts(
  platformId: PlatformId,
  drafts: AccountDraft[],
  existing: Record<string, BotAccount>
): { ids: string[]; created: Record<string, BotAccount> } {
  const ids: string[] = []
  const created: Record<string, BotAccount> = {}
  for (const draft of drafts) {
    const displayName = draft.displayName.trim() || draft.handle.trim()
    // Keep drafts that already have a partition account id even if the name is empty.
    if (!displayName && !draft.accountId) continue
    if (draft.accountId && existing[draft.accountId]) {
      if (!ids.includes(draft.accountId)) ids.push(draft.accountId)
      continue
    }
    const id = draft.accountId ?? createId('acc')
    created[id] = {
      id,
      platformId,
      displayName: displayName || getPlatform(platformId).name,
      handle: draft.handle.trim(),
      status: 'offline',
      ...(draft.importKey ? { importKey: draft.importKey } : {})
    }
    ids.push(id)
  }
  return { ids, created }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function prevMediaMerge(
  prev: import('@/types').ChatMediaPart[] | undefined,
  incoming: import('@/types').ChatMediaPart[] | undefined
): import('@/types').ChatMediaPart[] | undefined {
  if (!incoming?.length) return prev
  if (!prev?.length) return incoming
  const out = [...prev]
  const byPath = new Map<string, number>()
  for (let i = 0; i < out.length; i += 1) {
    byPath.set(out[i]!.path, i)
  }
  let changed = false
  for (const part of incoming) {
    const idx = byPath.get(part.path)
    if (idx === undefined) {
      byPath.set(part.path, out.length)
      out.push(part)
      changed = true
    } else {
      const cur = out[idx]!
      const nextKind = cur.kind === 'image' || part.kind === 'image' ? 'image' : cur.kind
      const nextName = cur.name || part.name
      const nextMime = cur.mimeType || part.mimeType
      const nextImgId = cur.imageId || part.imageId
      if (
        nextKind !== cur.kind ||
        nextName !== cur.name ||
        nextMime !== cur.mimeType ||
        nextImgId !== cur.imageId
      ) {
        out[idx] = {
          ...cur,
          kind: nextKind,
          name: nextName,
          mimeType: nextMime,
          imageId: nextImgId
        }
        changed = true
      }
    }
  }
  return changed ? out : prev
}

function normalizeDotMsgId(rawId: string, role: 'user' | 'bot'): string {
  const clean = rawId.replace(/^(dot_u_|dot_)+/, '')
  return role === 'user' ? `dot_u_${clean}` : `dot_${clean}`
}

function isOmittedPlaceholderText(text: string): boolean {
  return text.startsWith('[消息内容较大') || text.startsWith('[Message body omitted')
}

function mergeHydratedMessages(existing: ChatMessage[], hydrated: ChatMessage[]): ChatMessage[] {
  if (hydrated.length === 0) return existing
  const targetAgentId = hydrated.find((m) => m.agentId)?.agentId
  const normalizedExisting = existing
    .filter((m) => !targetAgentId || !m.agentId || m.agentId === targetAgentId)
    .map((m) =>
      m.id.startsWith('dot_dot_') ? { ...m, id: m.id.replace(/^dot_dot_/, 'dot_') } : m
    )
  const hydratedById = new Map(hydrated.map((m) => [m.id, m]))
  const existingById = new Map(normalizedExisting.map((m) => [m.id, m]))
  const mergedHydrated = hydrated.map((h) => {
    const local = existingById.get(h.id)
    if (!local) return h
    const media = prevMediaMerge(local.media, h.media)
    if (media === h.media) return h
    return { ...h, media }
  })
  const keptLocal: ChatMessage[] = []
  const earliestHydratedTs = hydrated[0]?.createdAt ?? 0

  for (const localMsg of normalizedExisting) {
    if (hydratedById.has(localMsg.id)) continue
    // If this was a local user message (`msg_...`) that now exists in `hydrated` from the server, skip the duplicate
    if (
      localMsg.role === 'user' &&
      localMsg.id.startsWith('msg_') &&
      (localMsg.delivery === 'sent' || localMsg.delivery === 'no-reply' || localMsg.delivery === 'accepted') &&
      hydrated.some(
        (h) =>
          h.role === 'user' &&
          h.text.trim() === localMsg.text.trim() &&
          Math.abs(h.createdAt - localMsg.createdAt) < 120_000
      )
    ) {
      continue
    }
    // Keep older history before the hydrated window, or in-flight/failed local messages, or newer real-time messages
    if (
      localMsg.delivery === 'sending' ||
      localMsg.delivery === 'accepted' ||
      localMsg.delivery === 'failed' ||
      localMsg.createdAt < earliestHydratedTs - 1000 ||
      localMsg.createdAt > (hydrated[hydrated.length - 1]?.createdAt ?? 0) + 1000
    ) {
      keptLocal.push(localMsg)
    }
  }

  const combined = [...keptLocal, ...mergedHydrated]
  combined.sort((a, b) => a.createdAt - b.createdAt)
  const seen = new Set<string>()
  return combined.filter((m) => {
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}

/** Pool bookkeeping lists: Muse, Grok & Dot accounts can receive pool assignments; Hark accounts keep their slot. */
export function poolAccountIds(accounts: Record<string, { id: string; platformId: string }>): {
  museIds: string[]
  grokIds: string[]
  dotIds: string[]
  harkIds: string[]
  assignableIds: string[]
} {
  const all = Object.values(accounts)
  const museIds = all.filter((a) => a.platformId === 'meta-muse').map((a) => a.id)
  const grokIds = all.filter((a) => a.platformId === 'grok').map((a) => a.id)
  const dotIds = all.filter((a) => a.platformId === 'dot').map((a) => a.id)
  const harkIds = all.filter((a) => a.platformId === 'hark').map((a) => a.id)
  return {
    museIds,
    grokIds,
    dotIds,
    harkIds,
    assignableIds: [...museIds, ...grokIds, ...dotIds]
  }
}

export const useBotStore = create<BotHubState>()(
  persist((set, get) => {
  const updateMessage = (botId: string, messageId: string, patch: Partial<ChatMessage>) =>
    set((state) => {
      const list = state.messages[botId]
      if (!list?.some((m) => m.id === messageId)) return state
      return {
        messages: { ...state.messages, [botId]: list.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) }
      }
    })

  const patchBot = (botId: string, patch: (bot: Bot) => Partial<Bot>) =>
    set((state) => ({ bots: state.bots.map((b) => (b.id === botId ? { ...b, ...patch(b) } : b)) }))

  // An account or session can be selected again while an earlier request for it is still pending.
  const sessionSelections = new Map<string, symbol>()
  const markSessionSelection = (botId: string) => {
    const selection = Symbol()
    sessionSelections.set(botId, selection)
    return selection
  }
  const getBotForSessionSelection = (bot: Bot, selection: symbol | undefined) => {
    if (sessionSelections.get(bot.id) !== selection) return undefined
    const current = get().bots.find((b) => b.id === bot.id)
    if (!current || current.activeAccountId !== bot.activeAccountId || current.selectedAgentId !== bot.selectedAgentId) {
      return undefined
    }
    return current
  }
  const setFreshSession = (botId: string, activeSessionId: string | undefined, hermesSessionKey?: string) =>
    set((state) => ({
      bots: state.bots.map((bot) => bot.id === botId
        ? { ...bot, activeSessionId, ...(hermesSessionKey ? { hermesSessionKey } : {}) }
        : bot),
      messages: { ...state.messages, [botId]: [] }
    }))

  const setHermesSessionError = (botId: string, error?: string) =>
    set((state) => ({ hermesSessionErrors: { ...state.hermesSessionErrors, [botId]: error } }))

  const patchAccount = (accountId: string, patch: Partial<BotAccount>) =>
    set((state) => {
      const account = state.accounts[accountId]
      if (!account) return state
      return { accounts: { ...state.accounts, [accountId]: { ...account, ...patch } } }
    })

  const inFlight = createInFlightSet()

  /** Hand a stored user message to the bot's platform adapter. */
  const deliver = async (botId: string, messageId: string) => {
    if (!inFlight.enter(messageId)) return
    try {
      await deliverOnce(botId, messageId)
    } finally {
      inFlight.leave(messageId)
    }
  }

  const deliverOnce = async (botId: string, messageId: string) => {
    const state = get()
    const bot = state.bots.find((b) => b.id === botId)
    const message = state.messages[botId]?.find((m) => m.id === messageId)
    if (!bot || !message) return

    const adapter = adapterRegistry.get(bot.platformId)
    if (!adapter) {
      updateMessage(botId, messageId, { delivery: 'failed', error: 'This platform is not available yet.' })
      return
    }

    const selection = sessionSelections.get(botId)
    const applyReceipt = (receipt: import('@adapters/types').SendReceipt) => {
      const current = getBotForSessionSelection(bot, selection)
      if (
        current &&
        current.activeAccountId === message.accountId &&
        current.activeSessionId === bot.activeSessionId &&
        receipt.sessionId &&
        receipt.sessionId !== current.activeSessionId
      ) {
        patchBot(botId, () => ({ activeSessionId: receipt.sessionId }))
      }
      updateMessage(
        botId,
        messageId,
        receipt.noReply ? { delivery: 'no-reply', error: NO_REPLY_TEXT } : { delivery: 'sent', error: undefined }
      )
    }

    let accepted = false
    const onAccepted = () => {
      if (accepted) return
      accepted = true
      const current = get().messages[botId]?.find((m) => m.id === messageId)
      if (current?.delivery === 'sending') updateMessage(botId, messageId, { delivery: 'accepted', error: undefined })
    }

    try {
      const receipt = await withTimeout(
        adapter.sendMessage({
          conversationId: botId,
          accountId: message.accountId,
          sessionId: bot.activeSessionId,
          ...(bot.hermesSessionKey ? { hermesSessionKey: bot.hermesSessionKey } : {}),
          text: message.text,
          attachments: message.attachments,
          replyToId: message.replyToId,
          replyQuote: message.replyQuote,
          onAccepted
        }),
        SEND_HARD_TIMEOUT_MS,
        // The adapter answered after we gave up: show what really happened.
        (late) => {
          if (late.ok) applyReceipt(late.value)
        }
      )
      applyReceipt(receipt)
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'no-reply') {
        updateMessage(botId, messageId, deliveryAfterError(accepted, 'no-reply', error.message || NO_REPLY_TEXT))
      } else if (error instanceof SendTimeoutError) {
        updateMessage(botId, messageId, deliveryAfterError(accepted, 'timeout', error.message))
        get().setTyping(botId, false)
      } else {
        updateMessage(botId, messageId, deliveryAfterError(accepted, 'other', errorMessage(error)))
      }
    }
  }

  return {
    ...seed,
    typing: {},
    activity: {},
    selectedBotId: seed.bots[0]?.id ?? null,
    collapsedGroups: {},
    infoPanelOpen: true,
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT,
    addBotOpen: false,
    addBotInitialPlatform: null,
    addBotKey: 0,
    onboardingOpen: false,
    paletteOpen: false,
    paletteQuery: '',
    paletteKey: 0,
    webSessionOpen: false,
    settingsOpen: false,
    settingsTab: 'overview',
    activeDocument: null,
    replyingTo: {},
    hermesSessionErrors: {},
    dismissedGrokAgents: {},

    setActiveDocument: (doc) => set({ activeDocument: doc }),

    setReplyTarget: (botId, target) =>
      set((state) => {
        if (!target) {
          if (!state.replyingTo[botId]) return state
          const { [botId]: _removed, ...rest } = state.replyingTo
          return { replyingTo: rest }
        }
        return { replyingTo: { ...state.replyingTo, [botId]: target } }
      }),

    deleteMessages: (botId, messageIds) =>
      set((state) => {
        const list = state.messages[botId]
        if (!list || messageIds.length === 0) return state
        const drop = new Set(messageIds)
        const nextList = list.filter((m) => !drop.has(m.id))
        if (nextList.length === list.length) return state
        return { messages: { ...state.messages, [botId]: nextList } }
      }),

    selectBot: (botId) =>
      set((state) => {
        const targetBot = state.bots.find((b) => b.id === botId)
        let nextAccounts = state.accounts
        if (targetBot) {
          for (const accId of targetBot.accountIds) {
            const acc = nextAccounts[accId]
            if (acc && (acc.unread ?? 0) > 0) {
              nextAccounts = {
                ...nextAccounts,
                [accId]: { ...acc, unread: 0 }
              }
            }
          }
        }
        return {
          selectedBotId: botId,
          settingsOpen: false,
          activeDocument:
            state.activeDocument && targetBot?.accountIds.includes(state.activeDocument.accountId)
              ? state.activeDocument
              : null,
          accounts: nextAccounts,
          bots: state.bots.map((b) => (b.id === botId && b.unread > 0 ? { ...b, unread: 0 } : b))
        }
      }),

    toggleGroup: (groupId) =>
      set((state) => ({
        collapsedGroups: { ...state.collapsedGroups, [groupId]: !state.collapsedGroups[groupId] }
      })),

    addGroup: (name) => {
      const id = createId('grp')
      set((state) => {
        const requested = name?.trim()
        const finalName = requested
          ? (
              state.groups.some((g) => g.name.toLowerCase() === requested.toLowerCase())
                ? uniqueGroupName(state.groups, requested)
                : requested
            )
          : uniqueGroupName(state.groups)
        return {
          groups: [...state.groups, { id, name: finalName }],
          collapsedGroups: { ...state.collapsedGroups, [id]: false }
        }
      })
      return id
    },

    renameGroup: (groupId, name) => {
      const next = name.trim()
      if (!next) return
      set((state) => ({
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, name: next } : g))
      }))
    },

    removeGroup: (groupId) =>
      set((state) => {
        if (state.groups.length <= 1) return state
        if (!state.groups.some((g) => g.id === groupId)) return state
        const fallback = state.groups.find((g) => g.id !== groupId)
        if (!fallback) return state
        const { [groupId]: _collapsed, ...collapsedGroups } = state.collapsedGroups
        return {
          groups: state.groups.filter((g) => g.id !== groupId),
          bots: state.bots.map((b) => (b.groupId === groupId ? { ...b, groupId: fallback.id } : b)),
          collapsedGroups
        }
      }),

    moveBotToGroup: (botId, groupId) =>
      set((state) => {
        if (!state.groups.some((g) => g.id === groupId)) return state
        return {
          bots: state.bots.map((b) => (b.id === botId ? { ...b, groupId } : b)),
          collapsedGroups: { ...state.collapsedGroups, [groupId]: false }
        }
      }),

    togglePinBot: (botId) =>
      set((state) => ({ bots: state.bots.map((b) => (b.id === botId ? { ...b, pinned: !b.pinned } : b)) })),

    reorderBot: (botId, groupId, beforeId) =>
      set((state) => {
        if (botId === beforeId) return state
        const bot = state.bots.find((b) => b.id === botId)
        if (!bot || !state.groups.some((g) => g.id === groupId)) return state
        const rest = state.bots.filter((b) => b.id !== botId)
        const moved = { ...bot, groupId }
        let at = beforeId ? rest.findIndex((b) => b.id === beforeId) : -1
        if (at < 0) {
          const lastInGroup = rest.map((b) => b.groupId).lastIndexOf(groupId)
          at = lastInGroup < 0 ? rest.length : lastInGroup + 1
        }
        rest.splice(at, 0, moved)
        return { bots: rest }
      }),

    toggleInfoPanel: () => set((state) => ({ infoPanelOpen: !state.infoPanelOpen })),

    toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

    setSidebarWidth: (width) =>
      set({ sidebarWidth: Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width))) }),

    setAddBotOpen: (open, initialPlatform = null) =>
      set((state) =>
        open
          ? {
              addBotOpen: true,
              addBotInitialPlatform: initialPlatform,
              addBotKey: state.addBotKey + 1,
              onboardingOpen: false
            }
          : { addBotOpen: false, addBotInitialPlatform: null }
      ),

    setOnboardingOpen: (open) => set({ onboardingOpen: open }),

    toggleWebSession: () => set((state) => ({ webSessionOpen: !state.webSessionOpen })),

    setSettingsOpen: (open, tab) =>
      set((state) => ({
        settingsOpen: open,
        settingsTab: tab ?? state.settingsTab
      })),

    openPalette: (query = '') =>
      set((state) => ({ paletteOpen: true, paletteQuery: query, paletteKey: state.paletteKey + 1 })),

    closePalette: () => set({ paletteOpen: false }),

    selectAdjacentBot: (offset) => {
      const state = get()
      const ordered = state.groups.flatMap((g) => state.bots.filter((b) => b.groupId === g.id))
      if (ordered.length === 0) return
      const index = ordered.findIndex((b) => b.id === state.selectedBotId)
      const next = ordered[(index + offset + ordered.length) % ordered.length]
      if (next) get().selectBot(next.id)
    },

    addBot: (input) => {
      const state = get()
      const { ids, created } = materializeAccounts(input.platformId, input.accounts, state.accounts)
      if (ids.length === 0) throw new Error('A bot needs at least one account.')

      let groups = state.groups
      let groupId: string
      const choice = input.group
      if (choice?.kind === 'existing' && groups.some((g) => g.id === choice.groupId)) {
        groupId = choice.groupId
      } else if (choice?.kind === 'new' && choice.name.trim()) {
        const name = choice.name.trim()
        const match = groups.find((g) => g.name.toLowerCase() === name.toLowerCase())
        groupId = match?.id ?? createId('grp')
        if (!match) groups = [...groups, { id: groupId, name }]
      } else {
        const selectedGroup = state.bots.find((b) => b.id === state.selectedBotId)?.groupId
        groupId = selectedGroup ?? groups[0]?.id ?? createId('grp')
        if (!groups.some((g) => g.id === groupId)) groups = [...groups, { id: groupId, name: 'Workspace' }]
      }

      const bot: Bot = {
        id: input.id ?? createId('bot'),
        name: input.name.trim() || getPlatform(input.platformId).name,
        emoji: input.emoji ?? '🤖',
        avatar: input.avatar,
        ...(input.avatarShape ? { avatarShape: input.avatarShape } : {}),
        ...(input.avatarColor ? { avatarColor: input.avatarColor } : {}),
        ...(input.selectedAgentId ? { selectedAgentId: input.selectedAgentId } : {}),
        description: input.description?.trim() ?? '',
        platformId: input.platformId,
        groupId,
        accountIds: ids,
        activeAccountId: ids[0]!,
        memory: [],
        notes: input.notes?.trim() ?? '',
        createdAt: Date.now(),
        unread: 0
      }

      set((s) => ({
        groups,
        bots: [...s.bots, bot],
        accounts: { ...s.accounts, ...created },
        messages: { ...s.messages, [bot.id]: [] },
        selectedBotId: input.background ? s.selectedBotId ?? bot.id : bot.id,
        collapsedGroups: { ...s.collapsedGroups, [groupId]: false },
        addBotOpen: input.background ? s.addBotOpen : false
      }))

      const accounts = get().accounts
      const bridge = electronBridge()
      if (input.platformId === 'meta-muse' && bridge?.muse?.assignProxyPool) {
        // Hark accounts share the pool: keep their slots, but only Muse gets new ones.
        const { museIds, harkIds } = poolAccountIds(accounts)
        void bridge.muse.assignProxyPool(museIds, harkIds).catch(() => undefined)
      }
      for (const id of ids) if (accounts[id]?.status === 'offline') void get().connectAccount(id)
      return bot.id
    },

    addAccountsToBot: (botId, drafts) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return
      const { ids, created } = materializeAccounts(bot.platformId, drafts, state.accounts)
      const newIds = ids.filter((id) => !bot.accountIds.includes(id))
      if (newIds.length === 0) return

      set((s) => ({
        accounts: { ...s.accounts, ...created },
        bots: s.bots.map((b) => (b.id === botId ? { ...b, accountIds: [...b.accountIds, ...newIds] } : b))
      }))

      const accounts = get().accounts
      const bridge = electronBridge()
      if (bot.platformId === 'meta-muse' && bridge?.muse?.assignProxyPool) {
        // Hark accounts share the pool: keep their slots, but only Muse gets new ones.
        const { museIds, harkIds } = poolAccountIds(accounts)
        void bridge.muse.assignProxyPool(museIds, harkIds).catch(() => undefined)
      }
      for (const id of newIds) if (accounts[id]?.status === 'offline') void get().connectAccount(id)
    },

    renameBot: (botId, name) => {
      const trimmed = name.trim()
      if (trimmed) patchBot(botId, () => ({ name: trimmed }))
    },

    setBotAvatar: (botId, avatar) => patchBot(botId, () => ({ avatar })),

    setBotCharacter: (botId, character) =>
      patchBot(botId, (b) => ({
        avatarShape: character.shape ?? b.avatarShape,
        avatarColor: character.color ?? b.avatarColor
      })),

    removeBot: async (botId) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return
      sessionSelections.delete(botId)
      const orphaned = bot.accountIds.filter((id) => !state.bots.some((b) => b.id !== botId && b.accountIds.includes(id)))
      const ordered = state.groups.flatMap((g) => state.bots.filter((b) => b.groupId === g.id))
      const index = ordered.findIndex((b) => b.id === botId)
      const neighbour = ordered[index + 1] ?? ordered[index - 1]
      set((s) => {
        const { [botId]: _messages, ...messages } = s.messages
        const { [botId]: _typing, ...typing } = s.typing
        const { [botId]: _sessionError, ...hermesSessionErrors } = s.hermesSessionErrors
        let dismissedGrokAgents = s.dismissedGrokAgents
        if (
          bot.platformId === 'grok' &&
          bot.selectedAgentId &&
          bot.activeAccountId &&
          !orphaned.includes(bot.activeAccountId)
        ) {
          const prev = s.dismissedGrokAgents[bot.activeAccountId] ?? []
          if (!prev.includes(bot.selectedAgentId)) {
            dismissedGrokAgents = {
              ...s.dismissedGrokAgents,
              [bot.activeAccountId]: [...prev, bot.selectedAgentId]
            }
          }
        }
        return {
          bots: s.bots.filter((b) => b.id !== botId),
          messages,
          typing,
          hermesSessionErrors,
          dismissedGrokAgents,
          selectedBotId: s.selectedBotId === botId ? (neighbour?.id ?? null) : s.selectedBotId
        }
      })
      for (const accountId of orphaned) {
        await get().signOutAccount(accountId)
        set((s) => {
          const { [accountId]: _removed, ...accounts } = s.accounts
          return { accounts }
        })
      }
    },

    sendMessage: async (botId, text, attachments) => {
      const stateBefore = get()
      const bot = stateBefore.bots.find((b) => b.id === botId)
      const trimmed = text.trim()
      if (!bot || (!trimmed && !attachments?.length)) return
      const replyTarget = stateBefore.replyingTo[botId]

      const message: ChatMessage = {
        id: createId('msg'),
        botId,
        accountId: bot.activeAccountId,
        ...(bot.selectedAgentId ? { agentId: bot.selectedAgentId } : {}),
        role: 'user',
        text: trimmed,
        createdAt: Date.now(),
        delivery: 'sending',
        ...(replyTarget
          ? { replyToId: replyTarget.entryId, replyQuote: replyTarget.quote }
          : {}),
        attachments: attachments?.length ? attachments : undefined
      }
      set((state) => {
        const { [botId]: _clearedReply, ...restReplies } = state.replyingTo
        return {
          replyingTo: restReplies,
          messages: { ...state.messages, [botId]: [...(state.messages[botId] ?? []), message] }
        }
      })
      await deliver(botId, message.id)
    },

    retryMessage: async (botId, messageId) => {
      const message = get().messages[botId]?.find((m) => m.id === messageId)
      // Retrying would silently drop the files (or send an empty message).
      if (message && hasLostAttachments(message)) {
        // Keep "delivered" messages delivered: looking unsent invites a duplicate.
        updateMessage(botId, messageId, {
          delivery: message.delivery === 'no-reply' ? 'no-reply' : 'failed',
          error: ATTACHMENTS_LOST_TEXT
        })
        return
      }
      updateMessage(botId, messageId, { delivery: 'sending', error: undefined })
      await deliver(botId, messageId)
    },

    receiveMessage: (incoming) =>
      set((state) => {
        const botId = state.bots.some((b) => b.id === incoming.conversationId)
          ? incoming.conversationId
          : state.bots.find((b) => b.accountIds.includes(incoming.accountId))?.id
        if (!botId) return state
        const list = state.messages[botId] ?? []
        const existingIdx = list.findIndex((m) => m.id === incoming.id)
        const prevText = existingIdx >= 0 ? list[existingIdx]!.text : ''
        const incomingText = incoming.text
        const mergedText =
          existingIdx < 0
            ? incomingText
            : !incomingText
              ? prevText
              : isOmittedPlaceholderText(prevText) && !isOmittedPlaceholderText(incomingText)
                ? incomingText
                : incomingText.length < prevText.length
                  ? prevText
                  : incomingText.startsWith(prevText) || prevText.length === 0
                    ? incomingText
                    : incomingText.length > prevText.length
                      ? incomingText
                      : prevText
        const prevWidgets = existingIdx >= 0 ? list[existingIdx]!.widgets : undefined
        const incomingWidgets = (incoming as { widgets?: ChatMessage['widgets'] }).widgets
        const prevTools = existingIdx >= 0 ? list[existingIdx]!.tools : undefined
        const incomingTools = (incoming as { tools?: ChatMessage['tools'] }).tools
        const prevMedia = existingIdx >= 0 ? list[existingIdx]!.media : undefined
        const incomingMedia = (incoming as { media?: ChatMessage['media'] }).media
        const prevRich = existingIdx >= 0 ? list[existingIdx]!.richWidgets : undefined
        const incomingRich = (incoming as { richWidgets?: ChatMessage['richWidgets'] }).richWidgets
        const targetBot = state.bots.find((b) => b.id === botId)
        const message: ChatMessage = {
          id: incoming.id,
          botId,
          accountId: incoming.accountId,
          ...(targetBot?.selectedAgentId ? { agentId: targetBot.selectedAgentId } : {}),
          role: 'bot',
          text: mergedText,
          createdAt: existingIdx >= 0 ? list[existingIdx]!.createdAt : incoming.createdAt,
          widgets: incomingWidgets?.length ? incomingWidgets : prevWidgets,
          tools: incomingTools?.length ? incomingTools : prevTools,
          media: prevMediaMerge(prevMedia, incomingMedia),
          richWidgets: incomingRich?.length ? incomingRich : prevRich
        }
        const selected = state.selectedBotId === botId
        const isNew = existingIdx < 0
        const account = state.accounts[incoming.accountId]
        const accounts =
          account && isNew
            ? {
                ...state.accounts,
                [incoming.accountId]: {
                  ...account,
                  unread: selected ? 0 : (account.unread ?? 0) + 1
                }
              }
            : state.accounts
        const nextList =
          existingIdx >= 0
            ? list.map((m, i) => (i === existingIdx ? message : m))
            : clearNoReplyFlag([...list, message])
        return {
          messages: { ...state.messages, [botId]: nextList },
          accounts,
          bots:
            selected || !isNew
              ? state.bots
              : state.bots.map((b) => (b.id === botId ? { ...b, unread: b.unread + 1 } : b))
        }
      }),

    applyMessageDelta: (messageId, conversationId, accountId, text, widgets, tools, media, richWidgets) =>
      set((state) => {
        const botId = state.bots.some((b) => b.id === conversationId)
          ? conversationId
          : state.bots.find((b) => b.accountIds.includes(accountId))?.id
        if (!botId) return state
        const list = state.messages[botId] ?? []
        const existingIdx = list.findIndex((m) => m.id === messageId)
        if (existingIdx >= 0) {
          const prev = list[existingIdx]!.text
          // Reconnect/backfill can briefly send a shorter snapshot — never shrink,
          // unless replacing an omitted-body placeholder with hydrated real text.
          const next =
            !text
              ? prev
              : isOmittedPlaceholderText(prev) && !isOmittedPlaceholderText(text)
                ? text
                : text.length < prev.length
                  ? prev
                  : text.startsWith(prev) || prev.length === 0
                    ? text
                    : text.length > prev.length
                      ? text
                      : prev
          const prevMsg = list[existingIdx]!
          const nextWidgets = widgets?.length ? widgets : prevMsg.widgets
          const nextTools = tools?.length ? tools : prevMsg.tools
          const nextMedia = prevMediaMerge(prevMsg.media, media)
          const nextRich = richWidgets?.length ? richWidgets : prevMsg.richWidgets
          if (
            next === prev &&
            nextWidgets === prevMsg.widgets &&
            nextTools === prevMsg.tools &&
            nextMedia === prevMsg.media &&
            nextRich === prevMsg.richWidgets
          )
            return state
          return {
            messages: {
              ...state.messages,
              [botId]: list.map((m, i) =>
                i === existingIdx
                  ? {
                      ...m,
                      text: next,
                      widgets: nextWidgets,
                      tools: nextTools,
                      media: nextMedia,
                      richWidgets: nextRich
                    }
                  : m
              )
            }
          }
        }
        const targetBot = state.bots.find((b) => b.id === botId)
        const message: ChatMessage = {
          id: messageId,
          botId,
          accountId,
          ...(targetBot?.selectedAgentId ? { agentId: targetBot.selectedAgentId } : {}),
          role: 'bot',
          text,
          createdAt: Date.now(),
          widgets: widgets?.length ? widgets : undefined,
          tools: tools?.length ? tools : undefined,
          media: media?.length ? media : undefined,
          richWidgets: richWidgets?.length ? richWidgets : undefined
        }
        return { messages: { ...state.messages, [botId]: clearNoReplyFlag([...list, message]) } }
      }),

    setTyping: (botIdOrAccountId, isTyping) =>
      set((state) => {
        const botId = state.bots.some((b) => b.id === botIdOrAccountId)
          ? botIdOrAccountId
          : state.bots.find((b) => b.accountIds.includes(botIdOrAccountId))?.id ?? botIdOrAccountId
        if ((state.typing[botId] === true) === isTyping) return state
        const typing = { ...state.typing }
        if (isTyping) typing[botId] = true
        else delete typing[botId]
        return { typing }
      }),

    setActivity: (accountId, activity) =>
      set((state) => {
        if (!activity || !activity.busy || activity.code === 'idle') {
          if (!(accountId in state.activity)) return state
          const { [accountId]: _removed, ...rest } = state.activity
          return { activity: rest }
        }
        const prev = state.activity[accountId]
        if (
          prev &&
          prev.code === activity.code &&
          prev.text === activity.text &&
          prev.emoji === activity.emoji &&
          prev.busy === activity.busy &&
          prev.subagents === activity.subagents
        ) {
          return state
        }
        return { activity: { ...state.activity, [accountId]: activity } }
      }),

    setMessageWidgets: (botId, messageId, widgets) =>
      set((state) => {
        const list = state.messages[botId] ?? []
        const idx = list.findIndex((m) => m.id === messageId)
        if (idx < 0) return state
        return {
          messages: {
            ...state.messages,
            [botId]: list.map((m, i) => (i === idx ? { ...m, widgets } : m))
          }
        }
      }),

    selectChatOption: async (botId, messageId, widgetId, selectedText, optionIndex) => {
      const state = get()
      const bot = state.bots.find((b) => b.id === botId)
      if (!bot) return
      const list = state.messages[botId] ?? []
      const host = list.find((m) => m.id === messageId)
      const widget = host?.widgets?.find((w) => w.widgetId === widgetId)
      if (!host || !widget) return
      const adapter = adapterRegistry.get(bot.platformId) as {
        selectOptionWidget?: (a: {
          accountId: string
          conversationId: string
          hostMessageId: string
          widget: NonNullable<ChatMessage['widgets']>[number]
          selectedText: string
          optionIndex: number
        }) => Promise<void>
      }
      const markChosen = (selected: string | undefined) =>
        set((s) => ({
          messages: {
            ...s.messages,
            [botId]: (s.messages[botId] ?? []).map((m) =>
              m.id !== messageId || !m.widgets
                ? m
                : { ...m, widgets: m.widgets.map((w) => (w.widgetId === widgetId ? { ...w, selectedText: selected } : w)) }
            )
          }
        }))
      if (!adapter?.selectOptionWidget) {
        // Platforms without a native option call (Grok, Hark, Dot): the chip
        // is just a reply, so send it as a normal message. Before, the chip
        // showed a "sent" bubble while nothing was sent at all.
        markChosen(selectedText)
        await get().sendMessage(botId, selectedText)
        return
      }
      const optId = createId('opt')
      set((s) => {
        const msgs = s.messages[botId] ?? []
        const nextMsgs = msgs.map((m) => {
          if (m.id !== messageId || !m.widgets) return m
          return {
            ...m,
            widgets: m.widgets.map((w) =>
              w.widgetId === widgetId ? { ...w, selectedText } : w
            )
          }
        })
        const userMsg: ChatMessage = {
          id: optId,
          botId,
          accountId: bot.activeAccountId,
          role: 'user',
          text: selectedText,
          createdAt: Date.now(),
          delivery: 'sending'
        }
        return { messages: { ...s.messages, [botId]: [...nextMsgs, userMsg] } }
      })
      try {
        await adapter.selectOptionWidget({
          accountId: bot.activeAccountId,
          conversationId: botId,
          hostMessageId: messageId,
          widget,
          selectedText,
          optionIndex
        })
        updateMessage(botId, optId, { delivery: 'sent', error: undefined })
      } catch (error) {
        // Unlock the chips so the user can pick again; keep the reason visible.
        markChosen(undefined)
        updateMessage(botId, optId, { delivery: 'failed', error: errorMessage(error) })
      }
    },

    cancelGeneration: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot) return
      get().setTyping(botId, false)
      get().setActivity(bot.activeAccountId, null)
      get().setAccountStatus(bot.activeAccountId, 'online')
      const bridge = electronBridge()
      if (bot.platformId === 'meta-muse' && bridge?.muse?.cancelChat) {
        await bridge.muse.cancelChat(bot.activeAccountId, bot.activeSessionId)
      } else if (bot.platformId === 'grok' && bot.selectedAgentId && bridge?.grok?.rpc) {
        await bridge.grok
          .rpc({
            accountId: bot.activeAccountId,
            op: 'call',
            method: 'InterruptGrokBotAgentRun',
            params: {
              agent_id: bot.selectedAgentId,
              reason: 'user_interrupt',
              ...(bot.activeSessionId ? { session_id: bot.activeSessionId } : {})
            }
          })
          .catch(() => undefined)
      } else if (bot.platformId === 'hark' && bridge?.hark?.rpc) {
        await Promise.all([
          bridge.hark
            .rpc({
              accountId: bot.activeAccountId,
              op: 'call',
              method: 'POST',
              path: '/messages/pause-agent',
              body: bot.activeSessionId ? { conversationId: bot.activeSessionId } : {}
            })
            .catch(() => undefined),
          bridge.hark
            .rpc({
              accountId: bot.activeAccountId,
              op: 'call',
              method: 'POST',
              path: '/messages/stop-tool',
              body: bot.activeSessionId ? { conversationId: bot.activeSessionId } : {}
            })
            .catch(() => undefined)
        ])
      } else if (bot.platformId === 'dot' && bridge?.dot?.rpc) {
        await bridge.dot
          .rpc({
            accountId: bot.activeAccountId,
            op: 'cancelTurn'
          })
          .catch(() => undefined)
      } else if (bot.platformId === 'hermes' && bridge?.hermes?.rpc) {
        await bridge.hermes
          .rpc({
            accountId: bot.activeAccountId,
            op: 'stopRun'
          })
          .catch(() => undefined)
      } else if (bot.platformId === 'antigravity' && bridge?.antigravity?.cancelRun) {
        await bridge.antigravity.cancelRun(bot.activeAccountId).catch(() => undefined)
      }
    },

    switchMuseSession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'meta-muse') return
      const selection = markSessionSelection(botId)
      patchBot(botId, () => ({ activeSessionId: sessionId }))
      const bridge = electronBridge()
      if (!bridge?.muse?.loadSessionHistory) return
      const rows = await bridge.muse.loadSessionHistory(bot.activeAccountId, sessionId)
      if (getBotForSessionSelection(bot, selection)?.activeSessionId !== sessionId) return
      const hydrated: ChatMessage[] = rows.map((r) => ({
        id: r.id,
        botId,
        accountId: bot.activeAccountId,
        role: r.role,
        text: r.text,
        createdAt: r.createdAt,
        delivery: r.role === 'user' ? 'sent' : undefined,
        widgets: r.widgets,
        richWidgets: r.richWidgets,
        tools: r.tools,
        media: r.media
      }))
      set((s) => ({
        messages: { ...s.messages, [botId]: hydrated }
      }))
    },

    startNewMuseSession: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'meta-muse') return
      const selection = markSessionSelection(botId)
      const bridge = electronBridge()
      let newSessionId: string | undefined
      if (bridge?.muse?.startSession) {
        try {
          const res = await bridge.muse.startSession(bot.activeAccountId)
          if (res.sessionId) newSessionId = res.sessionId
        } catch {
          /* ignore */
        }
      }
      if (getBotForSessionSelection(bot, selection)) setFreshSession(botId, newSessionId)
    },

    switchHermesSession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'hermes') return
      const selection = markSessionSelection(botId)
      setHermesSessionError(botId)
      patchBot(botId, () => ({ activeSessionId: sessionId }))
      const bridge = electronBridge()
      if (!bridge?.hermes?.rpc) return
      const res = await bridge.hermes.rpc({
        accountId: bot.activeAccountId,
        op: 'getSessionMessages',
        sessionId
      })
      if (getBotForSessionSelection(bot, selection)?.activeSessionId !== sessionId) return
      if (!res.ok || !Array.isArray(res.data)) return
      const rows = res.data as Array<{
        id: string
        role: 'user' | 'assistant'
        text: string
        createdAt: number
        tools?: import('@/types').ChatToolCall[]
        media?: import('@/types').ChatMediaPart[]
      }>
      const hydrated: ChatMessage[] = rows.map((r) => ({
        id: r.id,
        botId,
        accountId: bot.activeAccountId,
        role: r.role === 'user' ? 'user' : 'bot',
        text: r.text,
        createdAt: r.createdAt,
        delivery: r.role === 'user' ? 'sent' : undefined,
        ...(r.tools?.length ? { tools: r.tools } : {}),
        ...(r.media?.length ? { media: r.media } : {})
      }))
      set((s) => ({
        messages: { ...s.messages, [botId]: hydrated }
      }))
    },

    startNewHermesSession: async (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'hermes') return false
      const selection = markSessionSelection(botId)
      setHermesSessionError(botId)
      const bridge = electronBridge()
      try {
        if (!bridge?.hermes?.rpc) throw new Error(t('Hermes connection unavailable'))
        const res = await bridge.hermes.rpc({
          accountId: bot.activeAccountId,
          op: 'createSession',
          title: bot.name
        })
        if (!getBotForSessionSelection(bot, selection)) return false
        if (!res.ok) {
          if (![404, 405, 501].includes(res.status)) throw new Error(res.message)
          // Legacy gateways identify a conversation by X-Hermes-Session-Key.
          setFreshSession(botId, undefined, createId('hermes'))
          return true
        }
        const id = (res.data as { id?: unknown } | null)?.id
        if (typeof id !== 'string' || !id.trim()) throw new Error(t('Hermes returned no session ID'))
        setFreshSession(botId, id, createId('hermes'))
        return true
      } catch (error) {
        if (getBotForSessionSelection(bot, selection)) setHermesSessionError(botId, errorMessage(error))
        return false
      }
    },

    switchAntigravitySession: async (botId, sessionId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'antigravity') return
      const selection = markSessionSelection(botId)
      patchBot(botId, () => ({ activeSessionId: sessionId }))
      const bridge = electronBridge()
      if (!bridge?.antigravity?.rpc) return
      const res = await bridge.antigravity.rpc({
        accountId: bot.activeAccountId,
        action: 'getConversation',
        conversationId: sessionId
      })
      if (getBotForSessionSelection(bot, selection)?.activeSessionId !== sessionId) return
      if (!res.ok || !res.data || typeof res.data !== 'object') return
      const rows = (
        res.data as {
          messages?: Array<{
            id: string
            role: 'user' | 'assistant'
            text: string
            createdAt: number
            tools?: import('@/types').ChatToolCall[]
          }>
        }
      ).messages
      if (!Array.isArray(rows)) return
      const hydrated: ChatMessage[] = rows.map((r) => ({
        id: r.id,
        botId,
        accountId: bot.activeAccountId,
        role: r.role === 'user' ? 'user' : 'bot',
        text: r.text,
        createdAt: r.createdAt,
        delivery: r.role === 'user' ? 'sent' : undefined,
        ...(r.tools?.length ? { tools: r.tools } : {})
      }))
      set((s) => ({
        messages: { ...s.messages, [botId]: hydrated }
      }))
    },

    startNewAntigravitySession: (botId) => {
      const bot = get().bots.find((b) => b.id === botId)
      if (!bot || bot.platformId !== 'antigravity') return
      markSessionSelection(botId)
      setFreshSession(botId, undefined)
    },

    updateNotes: (botId, notes) => patchBot(botId, () => ({ notes })),

    addMemory: (botId, text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      patchBot(botId, (bot) => ({
        memory: [...bot.memory, { id: createId('mem'), text: trimmed, createdAt: Date.now() }]
      }))
    },

    removeMemory: (botId, memoryId) =>
      patchBot(botId, (bot) => ({ memory: bot.memory.filter((m) => m.id !== memoryId) })),

    removeAccountFromBot: (botId, accountId) =>
      patchBot(botId, (bot) => {
        // A bot always keeps at least one account.
        if (bot.accountIds.length <= 1 || !bot.accountIds.includes(accountId)) return {}
        const accountIds = bot.accountIds.filter((id) => id !== accountId)
        if (bot.activeAccountId === accountId) markSessionSelection(botId)
        return {
          accountIds,
          activeAccountId: bot.activeAccountId === accountId ? accountIds[0]! : bot.activeAccountId
        }
      }),

    setActiveAccount: (botId, accountId) => {
      set((state) => {
        const bot = state.bots.find((b) => b.id === botId && b.accountIds.includes(accountId))
        if (!bot) return state
        if (bot.activeAccountId !== accountId) markSessionSelection(botId)
        const account = state.accounts[accountId]
        return {
          bots: state.bots.map((b) =>
            b.id === botId && b.accountIds.includes(accountId) ? { ...b, activeAccountId: accountId } : b
          ),
          accounts: account
            ? { ...state.accounts, [accountId]: { ...account, unread: 0 } }
            : state.accounts
        }
      })
      const acc = get().accounts[accountId]
      if (acc && acc.status === 'offline') {
        void get().connectAccount(accountId)
      }
    },

    setSelectedAgent: (botId, agentId) => {
      const trimmed = agentId.trim()
      if (!trimmed) return
      const botBefore = get().bots.find((b) => b.id === botId)
      if (!botBefore) return
      const selection = markSessionSelection(botId)
      const adapterBefore = adapterRegistry.get(botBefore.platformId)
      const grokAdapter = adapterBefore as
        | {
            listCachedAgents?: (accId: string) => Array<{
              id: string
              name: string
              avatarShape?: string
              avatarColor?: string
            }>
            bindConversationAgent?: (c: string, a: string, accId?: string) => void
          }
        | undefined
      const matchedAgent = grokAdapter?.listCachedAgents?.(botBefore.activeAccountId)?.find((a) => a.id === trimmed)
      const prevAgentId = botBefore.selectedAgentId
      patchBot(botId, (b) => ({
        selectedAgentId: trimmed,
        ...(matchedAgent?.avatarShape ? { avatarShape: matchedAgent.avatarShape } : {}),
        ...(matchedAgent?.avatarColor ? { avatarColor: matchedAgent.avatarColor } : {}),
        ...(b.name === 'Grok Bot' && matchedAgent?.name ? { name: matchedAgent.name } : {})
      }))
      // Switching to a different agent clears the old agent's bubbles immediately
      if (prevAgentId && prevAgentId !== trimmed) {
        set((s) => ({
          messages: {
            ...s.messages,
            [botId]: (s.messages[botId] ?? []).filter((m) => m.agentId === trimmed)
          }
        }))
      }
      try {
        const bot = get().bots.find((b) => b.id === botId)
        if (!bot) return
        grokAdapter?.bindConversationAgent?.(botId, trimmed, bot.activeAccountId)
        const bridge = electronBridge()
        if (bot.platformId === 'grok' && bridge?.grok?.rpc) {
          void bridge.grok
            .rpc({
              accountId: bot.activeAccountId,
              op: 'listTranscriptEntries',
              agentId: trimmed,
              sessionId: bot.activeSessionId ?? '',
              limit: 60
            })
            .then((res) => {
              const latestBot = getBotForSessionSelection(bot, selection)
              if (!latestBot || latestBot.activeSessionId !== bot.activeSessionId) return
              if (!res.ok || !res.data || typeof res.data !== 'object') return
              const root = res.data as Record<string, unknown>
              // Prefer pre-decoded, chronological `hydrated` array with presigned media URLs from main
              if (Array.isArray(root['hydrated'])) {
                const hydrated: ChatMessage[] = (
                  root['hydrated'] as Array<Record<string, unknown>>
                ).map((item, idx) => ({
                  id: String(item['id'] ?? `grok_h_${idx}`),
                  botId,
                  accountId: bot.activeAccountId,
                  agentId: trimmed,
                  role: item['role'] === 'user' ? 'user' : 'bot',
                  text: String(item['text'] ?? ''),
                  createdAt: Number(item['createdAt'] ?? Date.now()) || Date.now(),
                  delivery: item['role'] === 'user' ? 'sent' : undefined,
                  ...(Array.isArray(item['widgets'])
                    ? { widgets: item['widgets'] as ChatMessage['widgets'] }
                    : {}),
                  ...(Array.isArray(item['richWidgets'])
                    ? { richWidgets: item['richWidgets'] as ChatMessage['richWidgets'] }
                    : {}),
                  ...(Array.isArray(item['media'])
                    ? { media: item['media'] as ChatMessage['media'] }
                    : {}),
                  ...(Array.isArray(item['tools'])
                    ? { tools: item['tools'] as ChatMessage['tools'] }
                    : {})
                }))
                set((s) => ({
                  messages: {
                    ...s.messages,
                    [botId]:
                      hydrated.length === 0
                        ? (s.messages[botId] ?? []).filter(
                            (m) => !m.agentId || m.agentId === trimmed
                          )
                        : prevAgentId && prevAgentId !== trimmed
                          ? hydrated
                          : mergeHydratedMessages(s.messages[botId] ?? [], hydrated)
                  }
                }))
              }
            })
            .catch(() => undefined)
        }
      } catch {
        /* ignore */
      }
    },

    renameAccount: (accountId, displayName) => {
      const trimmed = displayName.trim()
      if (!trimmed) return
      patchAccount(accountId, { displayName: trimmed, label: trimmed })
    },

    signOutAccount: async (accountId) => {
      const account = get().accounts[accountId]
      if (!account || account.pending) return
      patchAccount(accountId, { pending: true })
      try {
        const bridge = electronBridge()
        if (account.platformId === 'meta-muse' && bridge?.muse?.signOut) {
          await bridge.muse.signOut(accountId)
        } else if (account.platformId === 'grok' && bridge?.grok?.clearAuth) {
          await bridge.grok.clearAuth(accountId)
          await bridge.webViews?.clearPartition?.(accountId)
          const adapter = adapterRegistry.get('grok') as { clearAuth?: (id: string) => void }
          adapter?.clearAuth?.(accountId)
        } else if (account.platformId === 'dot' && bridge?.dot?.clearAuth) {
          await bridge.dot.clearAuth(accountId)
          await bridge.webViews?.clearPartition?.(accountId)
        } else if (account.platformId === 'hark' && bridge?.hark?.clearAuth) {
          await bridge.hark.clearAuth(accountId)
          await bridge.webViews?.clearPartition?.(accountId)
        } else if (account.platformId === 'hermes' && bridge?.hermes?.clearAuth) {
          await bridge.hermes.clearAuth(accountId)
        } else if (account.platformId === 'antigravity' && bridge?.antigravity?.clearAuth) {
          await bridge.antigravity.clearAuth(accountId)
          await bridge.webViews?.clearPartition?.(accountId)
        } else if (bridge?.webViews?.clearPartition) {
          await bridge.webViews.clearPartition(accountId)
        }
        const adapter = adapterRegistry.get(account.platformId)
        try {
          await adapter?.disconnect(accountId)
        } catch {
          /* ignore */
        }
        patchAccount(accountId, { status: 'offline', statusDetail: 'Signed out', unread: 0 })
      } catch (error) {
        patchAccount(accountId, { statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    removeAndClearAccount: async (botId, accountId) => {
      await get().signOutAccount(accountId)
      get().removeAccountFromBot(botId, accountId)
      set((state) => {
        const { [accountId]: _removed, ...rest } = state.accounts
        return { accounts: rest }
      })
    },

    setAccountStatus: (accountId, status, detail) => patchAccount(accountId, { status, statusDetail: detail }),

    connectAccount: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      patchAccount(accountId, { pending: true })
      try {
        const status = await adapter.connect(accountId)
        patchAccount(accountId, { status, statusDetail: undefined })
        if (account.platformId === 'hark' && status === 'online') {
          const bridge = electronBridge()
          const ownerBot = get().bots.find((b) => b.accountIds.includes(accountId))
          if (ownerBot && bridge?.hark?.rpc) {
            void bridge.hark
              .rpc({ accountId, op: 'mainConversation' })
              .then((res) => {
                if (!res.ok || !res.data || typeof res.data !== 'object') return
                const d = res.data as {
                  conversationId?: string
                  messages?: Array<{
                    id: string
                    role: string
                    content: string
                    thought?: string | null
                    narration?: string | null
                    createdAt?: string | number | null
                    toolCalls?: Array<{ dispatchId: string; name: string; status: string; url?: string }>
                    actions?: Array<{ kind: string; connector?: string; label: string }>
                    media?: ChatMessage['media']
                    richWidgets?: ChatMessage['richWidgets']
                  }>
                }
                if (d.conversationId) {
                  patchBot(ownerBot.id, () => ({ activeSessionId: d.conversationId }))
                }
                if (Array.isArray(d.messages) && d.messages.length > 0) {
                  const hydrated: ChatMessage[] = d.messages
                    .filter(
                      (m) =>
                        (m.content && m.content.trim()) ||
                        (m.actions && m.actions.length > 0) ||
                        (m.media && m.media.length > 0) ||
                        (m.richWidgets && m.richWidgets.length > 0)
                    )
                    .map((m) => {
                      const isUser = /^user$/i.test(m.role)
                      const ts =
                        typeof m.createdAt === 'number'
                          ? m.createdAt
                          : typeof m.createdAt === 'string'
                            ? Date.parse(m.createdAt) || Date.now()
                            : Date.now()
                      const combinedRich: NonNullable<ChatMessage['richWidgets']> = [
                        ...(m.richWidgets ?? [])
                      ]
                      if (m.actions && m.actions.length > 0) {
                        combinedRich.push({
                          kind: 'text_with_button',
                          widgetId: `hark_act_${m.id}`,
                          text: '',
                          buttons: m.actions.map((a) => ({
                            label: a.label || `Connect ${a.connector ?? ''}`,
                            actionText: a.connector ? `Connect ${a.connector}` : a.label
                          }))
                        })
                      }
                      const richWidgets = combinedRich.length > 0 ? combinedRich : undefined
                      const tools: ChatMessage['tools'] =
                        m.toolCalls && m.toolCalls.length > 0
                          ? m.toolCalls.map((tc) => ({
                              id: tc.dispatchId,
                              name: tc.name,
                              status:
                                tc.status === 'running'
                                  ? 'running'
                                  : tc.status === 'failed'
                                    ? 'errored'
                                    : 'completed',
                              summary: tc.url || m.narration || undefined
                            }))
                          : m.narration || m.thought
                            ? [
                                {
                                  id: `hark_thought_${m.id}`,
                                  name: m.narration ? 'Agent Activity' : 'Thinking',
                                  status: 'completed',
                                  summary: (m.narration || m.thought || '').slice(0, 140)
                                }
                              ]
                            : undefined
                      return {
                        id: isUser ? `hark_u_${m.id}` : `hark_${m.id}`,
                        botId: ownerBot.id,
                        accountId,
                        role: isUser ? 'user' : 'bot',
                        text: m.content?.trim() || '',
                        createdAt: ts,
                        delivery: isUser ? 'sent' : undefined,
                        richWidgets,
                        tools,
                        ...(m.media && m.media.length > 0 ? { media: m.media } : {})
                      }
                    })
                  if (hydrated.length > 0) {
                    set((s) => ({
                      messages: {
                        ...s.messages,
                        [ownerBot.id]: mergeHydratedMessages(s.messages[ownerBot.id] ?? [], hydrated)
                      }
                    }))
                  }
                }
              })
              .catch(() => undefined)
          }
        } else if (account.platformId === 'dot' && status === 'online') {
          const bridge = electronBridge()
          const ownerBot =
            get().bots.find((b) => b.activeAccountId === accountId) ??
            get().bots.find((b) => b.accountIds.includes(accountId))
          if (ownerBot && bridge?.dot?.rpc) {
            void bridge.dot
              .authStatus(accountId)
              .then((st) => {
                if (st.handle || st.displayName) {
                  patchAccount(accountId, {
                    handle: st.handle || account.handle,
                    displayName: st.displayName || account.displayName
                  })
                }
              })
              .catch(() => undefined)
            void bridge.dot
              .rpc({ accountId, op: 'listRoomMessages', limit: 32 })
              .then((res) => {
                if (!res.ok || !res.data || typeof res.data !== 'object') return
                const d = res.data as {
                  roomId?: string
                  dotId?: string
                  messages?: Array<{
                    id: string
                    role: 'user' | 'bot'
                    text: string
                    createdAtMs: number
                    media?: ChatMessage['media']
                  }>
                }
                if (d.roomId) {
                  patchBot(ownerBot.id, () => ({ activeSessionId: d.roomId }))
                }
                if (Array.isArray(d.messages) && d.messages.length > 0) {
                  const hydrated: ChatMessage[] = d.messages
                    .filter((m) => (m.text && m.text.trim()) || (m.media && m.media.length > 0))
                    .map((m) => ({
                      id: normalizeDotMsgId(m.id, m.role),
                      botId: ownerBot.id,
                      accountId,
                      role: m.role,
                      text: (m.text || '').trim(),
                      createdAt: m.createdAtMs || Date.now(),
                      delivery: m.role === 'user' ? 'sent' : undefined,
                      ...(m.media && m.media.length > 0 ? { media: m.media } : {})
                    }))
                  if (hydrated.length > 0) {
                    set((s) => ({
                      messages: {
                        ...s.messages,
                        [ownerBot.id]: mergeHydratedMessages(s.messages[ownerBot.id] ?? [], hydrated)
                      }
                    }))
                  }
                }
              })
              .catch(() => undefined)
          }
        } else if (account.platformId === 'grok' && (status === 'online' || status === 'busy')) {
          const bridge = electronBridge()
          void bridge?.grok
            ?.authStatus(accountId)
            .then((st) => {
              if (st.accountSlot) {
                const latestAcc = get().accounts[accountId]
                patchAccount(accountId, {
                  handle: st.accountSlot,
                  displayName: latestAcc?.label || st.accountSlot
                })
              }
            })
            .catch(() => undefined)
          await get().syncGrokAccountBots(accountId)
        }
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openMuseLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'meta-muse' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '等待在登录窗口完成…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail: status === 'offline' ? '在弹出的窗口里完成 Muse 登录' : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openGrokLogin: async (accountId, openInBrowser = false) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'grok') {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, {
        pending: true,
        statusDetail: openInBrowser ? '请在浏览器完成 Grok Bot 授权确认…' : '请在弹出的窗口完成 Grok Bot 登录…'
      })
      try {
        const bridge = electronBridge()
        if (bridge?.grok?.openLogin) {
          await bridge.grok.openLogin({ accountId, openInBrowser })
        } else if (adapter.openLogin) {
          await adapter.openLogin(accountId, bot?.id)
        }
        patchAccount(accountId, {
          status: account.status === 'online' ? 'online' : 'offline',
          statusDetail: openInBrowser
            ? '已在默认浏览器打开授权页，点击确认后自动同步全部 Bot'
            : '在弹出的窗口完成登录，成功后自动同步账号下全部 Bot'
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    syncGrokAccountBots: async (accountId, opts) => {
      const adapter = adapterRegistry.get('grok') as
        | {
            connect?: (id: string) => Promise<ConnectionStatus>
            refreshAgents?: (id: string) => Promise<
              Array<{
                id: string
                name: string
                description?: string
                avatarShape?: string
                avatarColor?: string
              }>
            >
            listCachedAgents?: (id: string) => Array<{
              id: string
              name: string
              description?: string
              avatarShape?: string
              avatarColor?: string
            }>
            bindConversationAgent?: (convId: string, agentId: string, accId?: string) => void
          }
        | undefined
      if (!adapter) return 0

      // Materialize account if syncing straight from AddBotDialog before `addBot` ran
      if (!get().accounts[accountId]) {
        const bridge = electronBridge()
        const authSt = await bridge?.grok?.authStatus?.(accountId).catch(() => null)
        const slot = authSt?.accountSlot || ''
        set((s) => ({
          accounts: {
            ...s.accounts,
            [accountId]: {
              id: accountId,
              platformId: 'grok',
              displayName: slot || 'Grok Bot',
              handle: slot,
              status: authSt?.signedIn ? 'online' : 'offline'
            }
          }
        }))
        await adapter.connect?.(accountId).catch(() => undefined)
      }

      if (opts?.includeDismissed) {
        set((s) => {
          if (!s.dismissedGrokAgents[accountId]) return s
          const { [accountId]: _cleared, ...rest } = s.dismissedGrokAgents
          return { dismissedGrokAgents: rest }
        })
      }

      let agents = adapter.listCachedAgents?.(accountId) ?? []
      if (agents.length === 0 && adapter.refreshAgents) {
        agents = await adapter.refreshAgents(accountId).catch(() => [])
      }

      const state = get()
      const dismissed = new Set(
        opts?.includeDismissed ? [] : (state.dismissedGrokAgents[accountId] ?? [])
      )
      const visibleAgents = agents.filter((a) => !dismissed.has(a.id))
      const allAgentIds = new Set(agents.map((a) => a.id))

      let groups = state.groups
      const existingForAccount = state.bots.filter(
        (b) => b.platformId === 'grok' && b.accountIds.includes(accountId)
      )
      const selectedGroup = state.bots.find((b) => b.id === state.selectedBotId)?.groupId
      let targetGroupId =
        opts?.preferredGroupId ??
        existingForAccount[0]?.groupId ??
        selectedGroup ??
        groups[0]?.id ??
        createId('grp')
      if (!groups.some((g) => g.id === targetGroupId)) {
        groups = [...groups, { id: targetGroupId, name: 'Workspace' }]
      }

      // Brand-new Grok account with 0 server agents yet: ensure at least 1 placeholder Bot row
      if (visibleAgents.length === 0) {
        if (existingForAccount.length === 0 && agents.length === 0) {
          const placeholderId = createId('bot')
          const acc = get().accounts[accountId]
          const bot: Bot = {
            id: placeholderId,
            name: acc?.handle ? `Grok · ${acc.handle}` : 'Grok Bot',
            emoji: '🤖',
            description: '',
            platformId: 'grok',
            groupId: targetGroupId,
            accountIds: [accountId],
            activeAccountId: accountId,
            memory: [],
            notes: '',
            createdAt: Date.now(),
            unread: 0
          }
          set((s) => ({
            groups,
            bots: [...s.bots, bot],
            messages: { ...s.messages, [bot.id]: s.messages[bot.id] ?? [] },
            selectedBotId: opts?.selectFirst || !s.selectedBotId ? bot.id : s.selectedBotId,
            collapsedGroups: { ...s.collapsedGroups, [targetGroupId]: false }
          }))
          return 1
        }
        return existingForAccount.length
      }

      // Match or create one sidebar Bot per Grok Agent
      const claimedBotIds = new Set<string>()
      const botsToHydrate: Array<{ botId: string; agentId: string }> = []
      let nextBots = [...state.bots]
      const nextMessages = { ...state.messages }

      const isGenericGrokName = (name: string) =>
        /^Grok(?:\s+Bot)?(?:\s+\d+)?$/i.test(name.trim())

      // Pass 1: exact selectedAgentId matches
      const unmatchedAgents: typeof visibleAgents = []
      for (const agent of visibleAgents) {
        const exactIdx = nextBots.findIndex(
          (b) =>
            b.platformId === 'grok' &&
            b.accountIds.includes(accountId) &&
            b.selectedAgentId === agent.id &&
            !claimedBotIds.has(b.id)
        )
        if (exactIdx >= 0) {
          const prev = nextBots[exactIdx]!
          claimedBotIds.add(prev.id)
          nextBots[exactIdx] = {
            ...prev,
            name: isGenericGrokName(prev.name) && agent.name ? agent.name : prev.name,
            description: agent.description ?? prev.description,
            ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
            ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {})
          }
          adapter.bindConversationAgent?.(prev.id, agent.id, accountId)
        } else {
          unmatchedAgents.push(agent)
        }
      }

      // Pass 2: bind unbound/stale placeholder bots first, then create dedicated Bots for remaining agents
      for (const agent of unmatchedAgents) {
        const placeholderIdx = nextBots.findIndex(
          (b) =>
            b.platformId === 'grok' &&
            b.accountIds.includes(accountId) &&
            !claimedBotIds.has(b.id) &&
            (!b.selectedAgentId || !allAgentIds.has(b.selectedAgentId))
        )
        if (placeholderIdx >= 0) {
          const prev = nextBots[placeholderIdx]!
          claimedBotIds.add(prev.id)
          nextBots[placeholderIdx] = {
            ...prev,
            name: agent.name || prev.name,
            selectedAgentId: agent.id,
            description: agent.description ?? prev.description,
            ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
            ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {})
          }
          botsToHydrate.push({ botId: prev.id, agentId: agent.id })
        } else {
          const newBotId = createId('bot')
          claimedBotIds.add(newBotId)
          const newBot: Bot = {
            id: newBotId,
            name: agent.name || 'Grok Bot',
            emoji: '🤖',
            ...(agent.avatarShape ? { avatarShape: agent.avatarShape } : {}),
            ...(agent.avatarColor ? { avatarColor: agent.avatarColor } : {}),
            selectedAgentId: agent.id,
            description: agent.description ?? '',
            platformId: 'grok',
            groupId: targetGroupId,
            accountIds: [accountId],
            activeAccountId: accountId,
            memory: [],
            notes: '',
            createdAt: Date.now(),
            unread: 0
          }
          nextBots.push(newBot)
          nextMessages[newBotId] = nextMessages[newBotId] ?? []
          botsToHydrate.push({ botId: newBotId, agentId: agent.id })
        }
      }

      const accountBots = nextBots.filter(
        (b) => b.platformId === 'grok' && b.accountIds.includes(accountId)
      )
      const firstAccountBot = accountBots[0]
      const nextSelectedId =
        opts?.selectFirst && firstAccountBot
          ? firstAccountBot.id
          : state.selectedBotId ?? firstAccountBot?.id ?? null

      set((s) => ({
        groups,
        bots: nextBots,
        messages: nextMessages,
        selectedBotId: nextSelectedId,
        collapsedGroups: { ...s.collapsedGroups, [targetGroupId]: false }
      }))

      // Hydrate newly bound bots + the currently selected Grok bot
      const hydrateSet = new Map<string, string>()
      for (const item of botsToHydrate) hydrateSet.set(item.botId, item.agentId)
      const activeSelected = get().bots.find((b) => b.id === get().selectedBotId)
      if (
        activeSelected &&
        activeSelected.platformId === 'grok' &&
        activeSelected.accountIds.includes(accountId) &&
        activeSelected.selectedAgentId
      ) {
        hydrateSet.set(activeSelected.id, activeSelected.selectedAgentId)
      }
      for (const [bId, agId] of hydrateSet.entries()) {
        get().setSelectedAgent(bId, agId)
      }

      return accountBots.length
    },

    openHarkLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'hark' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '在弹出的窗口完成 Hark 登录…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail: status === 'offline' ? '在弹出的窗口完成 Hark 登录' : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openDotLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'dot' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '在弹出的窗口完成 ChatGPT Dot 登录…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail: status === 'offline' ? '在弹出的窗口完成 ChatGPT 登录或导入凭据' : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    openAntigravityLogin: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      if (account.platformId !== 'antigravity' || !adapter.openLogin) {
        await get().connectAccount(accountId)
        return
      }
      const bot = get().bots.find((b) => b.accountIds.includes(accountId))
      patchAccount(accountId, { pending: true, statusDetail: '在弹出的窗口完成 Google Antigravity 登录…' })
      try {
        const status = await adapter.openLogin(accountId, bot?.id)
        patchAccount(accountId, {
          status,
          statusDetail: status === 'offline' ? '在弹出的窗口完成 Google Antigravity 登录' : undefined
        })
      } catch (error) {
        patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    setGrokAccessToken: async (accountId, accessToken, accountSlot, machineId, refreshToken) => {
      const existingAcc = get().accounts[accountId]
      if (existingAcc && existingAcc.platformId !== 'grok') return
      const adapter = adapterRegistry.get('grok')
      if (!adapter) return
      if (existingAcc) patchAccount(accountId, { pending: true })
      try {
        const bridge = electronBridge()
        let resolvedSlot = accountSlot
        if (accessToken?.trim() && bridge?.grok?.setAccessToken) {
          const st = await bridge.grok.setAccessToken({
            accountId,
            accessToken: accessToken.trim(),
            refreshToken,
            accountSlot,
            machineId
          })
          resolvedSlot = st.accountSlot ?? resolvedSlot
        }
        if (!get().accounts[accountId]) {
          // Only auto-materialize if explicitly importing a raw token (not during AddBotDialog waiting step)
          if (!accessToken?.trim()) return
          set((s) => ({
            accounts: {
              ...s.accounts,
              [accountId]: {
                id: accountId,
                platformId: 'grok',
                displayName: resolvedSlot || 'Grok Bot',
                handle: resolvedSlot || '',
                status: 'offline'
              }
            }
          }))
        } else if (resolvedSlot) {
          patchAccount(accountId, {
            handle: resolvedSlot,
            displayName: get().accounts[accountId]?.label || resolvedSlot
          })
        }
        const grok = adapter as {
          setAuth?: (s: {
            accountId: string
            signedIn?: boolean
            accountSlot?: string
            machineId?: string
          }) => void
        }
        grok.setAuth?.({ accountId, signedIn: true, accountSlot: resolvedSlot, machineId })
        patchAccount(accountId, { pending: false })
        await get().connectAccount(accountId)
      } catch (error) {
        if (get().accounts[accountId]) {
          patchAccount(accountId, { status: 'error', statusDetail: errorMessage(error), pending: false })
        }
        throw error
      }
    },

    disconnectAccount: async (accountId) => {
      const account = get().accounts[accountId]
      const adapter = account && adapterRegistry.get(account.platformId)
      if (!account || !adapter || account.pending) return
      patchAccount(accountId, { pending: true })
      try {
        await adapter.disconnect(accountId)
        patchAccount(accountId, { status: 'offline', statusDetail: undefined })
      } catch (error) {
        patchAccount(accountId, { statusDetail: errorMessage(error) })
      } finally {
        patchAccount(accountId, { pending: false })
      }
    },

    clearAllCredentials: async () => {
      const bridge = electronBridge()
      const allAccounts = Object.values(get().accounts)
      for (const acc of allAccounts) {
        await get().signOutAccount(acc.id).catch(() => undefined)
      }
      await bridge?.dot?.clearAuth?.('*').catch(() => undefined)
      await bridge?.grok?.clearAuth?.('*').catch(() => undefined)
      await bridge?.hermes?.clearAuth?.('*').catch(() => undefined)
      await bridge?.muse?.clearProxyPool?.().catch(() => undefined)
      await bridge?.vault?.clearAll?.().catch(() => undefined)
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem('bothub.dot.memorySnapshot')
        }
      } catch {
        /* ignore */
      }
    },

    resetWorkspace: async () => {
      await get().clearAllCredentials()
      const fresh = createSeed()
      sessionSelections.clear()
      set({
        groups: fresh.groups,
        bots: fresh.bots,
        accounts: fresh.accounts,
        messages: fresh.messages,
        typing: {},
        activity: {},
        hermesSessionErrors: {},
        selectedBotId: null,
        collapsedGroups: {}
      })
    }
  }
  },
  {
    name: 'bothub-workspace-v1',
    storage: workspaceStorage,
    // Nothing is in flight after a restart; drop stale `sending`/`pending`.
    merge: (persisted, current) => ({
      ...current,
      ...sanitizePersisted((persisted ?? {}) as Partial<BotHubState>)
    }),
    partialize: (state) => ({
      groups: state.groups,
      bots: state.bots,
      accounts: state.accounts,
      messages: toPersistedMessages(state.messages),
      selectedBotId: state.selectedBotId,
      collapsedGroups: state.collapsedGroups,
      dismissedGrokAgents: state.dismissedGrokAgents,
      infoPanelOpen: state.infoPanelOpen,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth
    })
  }
)
)
