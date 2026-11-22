import { belongsToSelectedSession } from './sessionEvents'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterEvent, AttachmentMeta, PlatformId } from '@adapters/types'
import type { HermesApprovalView, MuseMediaPartView } from '@shared/ipc'
import type {
  MobileSyncedAccount,
  MobileSyncedBot,
  MobileSyncedMessage,
  MobileWorkspaceSnapshot
} from '@shared/mobileSync'
import { getBridge } from '@/lib/bridge'
import { useBotStore } from '@/store/botStore'

const MAX_MESSAGES_PER_BOT = 60
const MAX_MEDIA_CACHE_ENTRIES = 512
const MAX_MOBILE_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_MOBILE_VIDEO_BYTES = 8 * 1024 * 1024

const latestApprovals: Record<string, HermesApprovalView[]> = {}
const resolvedMediaCache = new Map<string, MuseMediaPartView>()
const pendingMediaResolves = new Set<string>()
const failedMediaResolves = new Set<string>()

function clearFailedMediaForAccount(accountId: string): void {
  const prefix = `${accountId}::`
  for (const key of failedMediaResolves) {
    if (key.startsWith(prefix)) failedMediaResolves.delete(key)
  }
}

function rememberResolvedMedia(key: string, part: MuseMediaPartView): void {
  if (resolvedMediaCache.has(key)) resolvedMediaCache.delete(key)
  resolvedMediaCache.set(key, part)
  while (resolvedMediaCache.size > MAX_MEDIA_CACHE_ENTRIES) {
    const oldest = resolvedMediaCache.keys().next().value
    if (!oldest) break
    resolvedMediaCache.delete(oldest)
    failedMediaResolves.add(oldest)
  }
}

function mapAttachmentsToMedia(attachments: AttachmentMeta[] | undefined): MuseMediaPartView[] {
  if (!attachments || attachments.length === 0) return []
  const out: MuseMediaPartView[] = []
  for (const att of attachments) {
    if (!att) continue
    const mime = att.mimeType || 'application/octet-stream'
    const dataUrl = att.dataBase64 ? `data:${mime};base64,${att.dataBase64}` : undefined
    const isImg = mime.startsWith('image/')
    if (isImg && dataUrl && dataUrl.length <= MAX_MOBILE_IMAGE_BYTES * 1.4) {
      out.push({
        kind: 'image',
        path: dataUrl,
        name: att.name,
        mimeType: mime
      })
    } else {
      out.push({
        kind: 'file',
        path:
          dataUrl && dataUrl.length <= MAX_MOBILE_VIDEO_BYTES * 1.4
            ? dataUrl
            : att.name || 'attachment',
        name: att.name,
        mimeType: mime
      })
    }
  }
  return out
}

function resolveMediaForMobile(
  accountId: string,
  rawMedia: MuseMediaPartView[] | undefined,
  attachments: AttachmentMeta[] | undefined,
  onResolved?: () => void
): MuseMediaPartView[] | undefined {
  const combined: MuseMediaPartView[] = [...mapAttachmentsToMedia(attachments)]

  for (const part of rawMedia ?? []) {
    if (!part || !part.path) continue
    if (part.path.startsWith('data:')) {
      const isImg = part.kind === 'image' || part.path.startsWith('data:image/')
      combined.push({
        ...part,
        kind: isImg ? 'image' : 'file'
      })
      continue
    }

    const cacheKey = `${accountId}::${part.path}`
    const cached = resolvedMediaCache.get(cacheKey)
    if (cached) {
      combined.push(cached)
      continue
    }

    // Keep original placeholder while background fetch resolves `fs.raw` / session media into a `data:` URI.
    combined.push(part)

    const muse = getBridge()?.muse
    const ownerPlatform = accountId ? useBotStore.getState().accounts[accountId]?.platformId : undefined
    const isMuseAccount = !ownerPlatform || ownerPlatform === 'meta-muse'
    if (
      accountId &&
      isMuseAccount &&
      muse?.previewWorkspaceFile &&
      !pendingMediaResolves.has(cacheKey) &&
      !failedMediaResolves.has(cacheKey)
    ) {
      pendingMediaResolves.add(cacheKey)
      void muse
        .previewWorkspaceFile(accountId, part.path)
        .then((res) => {
          if (!res?.dataBase64) {
            failedMediaResolves.add(cacheKey)
            return
          }
          const mime = res.mimeType || part.mimeType || 'application/octet-stream'
          if (mime.startsWith('image/') && res.byteLength <= MAX_MOBILE_IMAGE_BYTES) {
            rememberResolvedMedia(cacheKey, {
              kind: 'image',
              path: `data:${mime};base64,${res.dataBase64}`,
              name: part.name || part.path.split('/').pop(),
              imageId: part.imageId,
              mimeType: mime
            })
            onResolved?.()
          } else if (mime.startsWith('video/') && res.byteLength <= MAX_MOBILE_VIDEO_BYTES) {
            rememberResolvedMedia(cacheKey, {
              kind: 'file',
              path: `data:${mime};base64,${res.dataBase64}`,
              name: part.name || part.path.split('/').pop() || 'video.mp4',
              imageId: part.imageId,
              mimeType: mime
            })
            onResolved?.()
          } else {
            failedMediaResolves.add(cacheKey)
          }
        })
        .catch(() => {
          failedMediaResolves.add(cacheKey)
        })
        .finally(() => {
          pendingMediaResolves.delete(cacheKey)
        })
    }
  }

  return combined.length > 0 ? combined : undefined
}

function buildWorkspaceSnapshot(onMediaResolved?: () => void): MobileWorkspaceSnapshot {
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
      media: resolveMediaForMobile(m.accountId, m.media, m.attachments, onMediaResolved)
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
    approvals: Object.fromEntries(
      Object.entries(latestApprovals).filter(([accountId]) => Object.hasOwn(accounts, accountId))
    )
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
      mobileSync.pushSnapshot(buildWorkspaceSnapshot(scheduleSnapshotPush))
    }, 180)
  }

  const publishApprovals = (accountId: string, pending: HermesApprovalView[]) => {
    latestApprovals[accountId] = pending
    mobileSync.pushEvent({ type: 'approvals', accountId, pending })
    scheduleSnapshotPush()
  }

  // Push initial snapshot right away so pairing immediately has fresh state
  mobileSync.pushSnapshot(buildWorkspaceSnapshot(scheduleSnapshotPush))

  // Push whenever bots, groups, accounts, or messages change
  const unsubStore = useBotStore.subscribe((state, prev) => {
    if (
      state.bots !== prev.bots ||
      state.groups !== prev.groups ||
      state.accounts !== prev.accounts ||
      state.messages !== prev.messages ||
      state.collapsedGroups !== prev.collapsedGroups ||
      state.selectedBotId !== prev.selectedBotId
    ) {
      scheduleSnapshotPush()
    }
  })

  // Forward real-time streaming deltas, typing, status, and approvals immediately
  const handleAdapterEvent = (platformId: PlatformId, event: AdapterEvent) => {
    const store = useBotStore.getState()
    const accountId = event.type === 'message' ? event.message.accountId : event.accountId
    const account = store.accounts[accountId]
    if (account && account.platformId !== platformId) return
    if (!belongsToSelectedSession(event, store.bots)) return
    if (
      (event.type === 'status' && event.status === 'online') ||
      (event.type === 'login' && event.signedIn)
    ) {
      clearFailedMediaForAccount(event.accountId)
    }
    switch (event.type) {
      case 'message_delta':
        mobileSync.pushEvent({
          type: 'message_delta',
          botId: botIdForEvent(event.conversationId),
          accountId: event.accountId,
          messageId: event.messageId,
          text: event.text,
          tools: event.tools,
          media: resolveMediaForMobile(event.accountId, event.media, undefined, scheduleSnapshotPush)
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
            media: resolveMediaForMobile(
              event.message.accountId,
              event.message.media,
              undefined,
              scheduleSnapshotPush
            )
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
        publishApprovals(
          event.accountId,
          event.pending.map((a) => ({
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
        )
        break
    }
  }

  const adapterUnsubs = adapterRegistry.list().map((adapter) =>
    adapter.subscribe((event) => handleAdapterEvent(adapter.id, event))
  )

  const unsubscribeSend = mobileSync.onSendCommand((cmd) => {
    const result = useBotStore.getState().queueMobileMessage(cmd)
    if (result.ok) mobileSync.pushSnapshot(buildWorkspaceSnapshot(scheduleSnapshotPush))
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
            const current = latestApprovals[cmd.accountId]
            const refreshed = await adapter.listApprovals?.(cmd.accountId).catch(() => undefined)
            // A live update may have arrived while the refresh was in flight.
            if (latestApprovals[cmd.accountId] !== current) return
            publishApprovals(cmd.accountId, refreshed ?? (current ?? []).filter((a) => a.id !== cmd.approvalId))
          })
          .catch(() => {
            const current = latestApprovals[cmd.accountId]
            if (current) publishApprovals(cmd.accountId, current)
          })
      }
    }
  })

  // Refresh snapshot whenever sync server starts or a device pairs
  const unsubState = mobileSync.onStateChanged((st) => {
    if (st.running) {
      mobileSync.pushSnapshot(buildWorkspaceSnapshot(scheduleSnapshotPush))
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
