import { adapterRegistry } from '@adapters/registry'
import type { AdapterEvent } from '@adapters/types'
import type { HermesApprovalView } from '@shared/ipc'
import type {
  MobileSyncedAccount,
  MobileSyncedBot,
  MobileSyncedMessage,
  MobileWorkspaceSnapshot
} from '@shared/mobileSync'
import { getBridge } from '@/lib/bridge'
import { useBotStore } from '@/store/botStore'

const MAX_MESSAGES_PER_BOT = 60

const latestApprovals: Record<string, HermesApprovalView[]> = {}

function buildWorkspaceSnapshot(): MobileWorkspaceSnapshot {
  const s = useBotStore.getState()
  const accounts: Record<string, MobileSyncedAccount> = {}
  for (const [id, acc] of Object.entries(s.accounts)) {
    accounts[id] = {
      id: acc.id,
      platformId: acc.platformId,
      displayName: acc.displayName,
      handle: acc.handle,
      status: acc.status,
      statusDetail: acc.statusDetail
    }
  }

  const bots: MobileSyncedBot[] = s.bots.map((b) => {
    const botMsgs = s.messages[b.id] ?? []
    const lastMsgAt = botMsgs.length ? botMsgs[botMsgs.length - 1]!.createdAt : b.createdAt
    return {
      id: b.id,
      platformId: b.platformId,
      name: b.name,
      avatar: b.avatar,
      avatarShape: b.avatarShape,
      avatarColor: b.avatarColor,
      emoji: b.emoji,
      groupId: b.groupId,
      pinned: b.pinned,
      activeAccountId: b.activeAccountId,
      activeSessionId: b.activeSessionId,
      lastActivityAt: lastMsgAt
    }
  })

  const messages: Record<string, MobileSyncedMessage[]> = {}
  for (const [botId, list] of Object.entries(s.messages)) {
    const tail = list.slice(-MAX_MESSAGES_PER_BOT)
    messages[botId] = tail.map((m) => ({
      id: m.id,
      botId: m.botId,
      accountId: m.accountId,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      delivery: m.delivery,
      error: m.error,
      tools: m.tools,
      media: m.media
    }))
  }

  return {
    version: 1,
    updatedAtMs: Date.now(),
    hostName: 'BotArk Desktop',
    selectedBotId: s.selectedBotId,
    groups: s.groups.map((g) => ({ id: g.id, name: g.name, collapsed: Boolean(s.collapsedGroups[g.id]) })),
    bots,
    accounts,
    messages,
    approvals: { ...latestApprovals }
  }
}

function botIdForEvent(idOrAccount: string): string {
  const { bots } = useBotStore.getState()
  return bots.some((b) => b.id === idOrAccount)
    ? idOrAccount
    : bots.find((b) => b.accountIds.includes(idOrAccount) || b.activeAccountId === idOrAccount)?.id ?? idOrAccount
}

/**
 * Connects BotArk Desktop's renderer store & adapters to the local zero-server
 * MobileSyncServer running in the Electron main process.
 */
export function startMobileSyncBridge(): () => void {
  const mobileSync = getBridge()?.mobileSync
  if (!mobileSync) return () => undefined

  let timer: ReturnType<typeof setTimeout> | null = null
  const scheduleSnapshotPush = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      mobileSync.pushSnapshot(buildWorkspaceSnapshot())
    }, 180)
  }

  // Push initial snapshot right away so pairing immediately has fresh state
  mobileSync.pushSnapshot(buildWorkspaceSnapshot())

  // Push whenever bots, groups, accounts, or messages change
  const unsubStore = useBotStore.subscribe((state, prev) => {
    if (
      state.bots !== prev.bots ||
      state.groups !== prev.groups ||
      state.accounts !== prev.accounts ||
      state.messages !== prev.messages ||
      state.selectedBotId !== prev.selectedBotId
    ) {
      scheduleSnapshotPush()
    }
  })

  // Forward real-time streaming deltas, typing, status, and approvals immediately
  const handleAdapterEvent = (event: AdapterEvent) => {
    switch (event.type) {
      case 'message_delta':
        mobileSync.pushEvent({
          type: 'message_delta',
          botId: botIdForEvent(event.conversationId),
          accountId: event.accountId,
          messageId: event.messageId,
          text: event.text,
          tools: event.tools,
          media: event.media
        })
        break
      case 'message':
        mobileSync.pushEvent({
          type: 'message',
          botId: botIdForEvent(event.message.conversationId),
          message: {
            id: event.message.id,
            botId: botIdForEvent(event.message.conversationId),
            accountId: event.message.accountId,
            role: 'bot',
            text: event.message.text,
            createdAt: event.message.createdAt,
            tools: event.message.tools,
            media: event.message.media
          }
        })
        break
      case 'typing':
        mobileSync.pushEvent({
          type: 'typing',
          botId: botIdForEvent(event.conversationId),
          isTyping: event.isTyping
        })
        break
      case 'status':
        mobileSync.pushEvent({
          type: 'status',
          accountId: event.accountId,
          status: event.status,
          detail: event.detail
        })
        break
      case 'approvals':
        latestApprovals[event.accountId] = event.pending.map((a) => ({
          id: a.id,
          status: a.status,
          title: a.title,
          detail: a.detail,
          approvalType: a.approvalType,
          host: a.host,
          decisionOptions: a.decisionOptions,
          reason: a.reason,
          raw: a.raw
        }))
        mobileSync.pushEvent({
          type: 'approvals',
          accountId: event.accountId,
          pending: latestApprovals[event.accountId]!
        })
        break
    }
  }

  const adapterUnsubs = adapterRegistry.list().map((adapter) => adapter.subscribe(handleAdapterEvent))

  const unsubscribeSend = mobileSync.onSendCommand((cmd) => {
    const result = useBotStore.getState().queueMobileMessage(cmd)
    if (result.ok) mobileSync.pushSnapshot(buildWorkspaceSnapshot())
    return result
  })

  // Execute the remaining commands sent from paired devices.
  const unsubCommands = mobileSync.onCommand((cmd) => {
    const store = useBotStore.getState()
    if (cmd.kind === 'stopGeneration') {
      void store.cancelGeneration(cmd.botId)
    } else if (cmd.kind === 'newSession') {
      const bot = store.bots.find((b) => b.id === cmd.botId)
      if (!bot) return
      if (bot.platformId === 'meta-muse') void store.startNewMuseSession(bot.id)
      else if (bot.platformId === 'hermes') void store.startNewHermesSession(bot.id)
      else if (bot.platformId === 'antigravity') store.startNewAntigravitySession(bot.id)
      else if (bot.platformId === 'grok' && bot.activeAccountId && bot.selectedAgentId) {
        void getBridge()
          ?.grok?.rpc({
            accountId: bot.activeAccountId,
            op: 'call',
            method: 'StartFreshGrokBotConversation',
            params: { agent_id: bot.selectedAgentId }
          })
          .then(() => store.setSelectedAgent(bot.id, bot.selectedAgentId!))
          .catch(() => undefined)
      }
    } else if (cmd.kind === 'decideApproval') {
      const adapter = adapterRegistry.get(cmd.platformId)
      if (adapter?.decideApproval) {
        void adapter
          .decideApproval(cmd.accountId, cmd.approvalId, cmd.decision)
          .then(async () => {
            const refreshed = (await adapter.listApprovals?.(cmd.accountId).catch(() => [])) ?? []
            latestApprovals[cmd.accountId] = refreshed
            mobileSync.pushEvent({
              type: 'approvals',
              accountId: cmd.accountId,
              pending: refreshed
            })
          })
          .catch(() => undefined)
      }
    }
  })

  // Refresh snapshot whenever sync server starts or a device pairs
  const unsubState = mobileSync.onStateChanged((st) => {
    if (st.running) {
      mobileSync.pushSnapshot(buildWorkspaceSnapshot())
    }
  })

  return () => {
    if (timer) clearTimeout(timer)
    unsubStore()
    unsubscribeSend()
    unsubCommands()
    unsubState()
    for (const u of adapterUnsubs) u()
  }
}
