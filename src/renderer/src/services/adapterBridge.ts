import { belongsToSelectedSession } from './sessionEvents'
import { adapterRegistry } from "@adapters/registry"
import type { AdapterEvent } from "@adapters/types"
import { useBotStore } from "@/store/botStore"
import { ReplyWatchdog } from "@/store/replyWatchdog"

const STALLED_TEXT = "很久没有收到回复，已停止等待；可以刷新会话或再发一次"
const watchdog = new ReplyWatchdog()

/** Typing is keyed by bot id; events may carry a bot id or an account id. */
function botIdFor(idOrAccount: string): string {
  const { bots } = useBotStore.getState()
  return bots.some((b) => b.id === idOrAccount)
    ? idOrAccount
    : bots.find((b) => b.accountIds.includes(idOrAccount))?.id ?? idOrAccount
}

function touchAccount(accountId: string): void {
  for (const b of useBotStore.getState().bots) if (b.accountIds.includes(accountId)) watchdog.touch(b.id)
}

/** Clear stale "thinking" and flag the unanswered message. */
function checkStalledReplies(): void {
  const store = useBotStore.getState()
  const typingIds = Object.keys(store.typing).filter((id) => store.typing[id])
  const stalled = watchdog.stalled(typingIds, (botId) => {
    const bot = store.bots.find((b) => b.id === botId)
    return Boolean(bot && store.activity[bot.activeAccountId]?.busy)
  })
  for (const botId of stalled) {
    watchdog.forget(botId)
    store.setTyping(botId, false)
    const list = store.messages[botId] ?? []
    const lastUser = [...list].reverse().find((m) => m.role === "user")
    const lastIsUser = list[list.length - 1]?.role === "user"
    if (lastUser && lastIsUser && lastUser.delivery === "sent") {
      useBotStore.setState((s) => ({
        messages: {
          ...s.messages,
          [botId]: (s.messages[botId] ?? []).map((m) =>
            m.id === lastUser.id ? { ...m, delivery: "no-reply" as const, error: STALLED_TEXT } : m
          )
        }
      }))
    }
  }
}

function electronBridge(): Window["electron"] | undefined {
  return typeof window !== "undefined" ? window.electron : undefined
}

function handleEvent(event: AdapterEvent): void {
    if (!belongsToSelectedSession(event, useBotStore.getState().bots)) return
  const store = useBotStore.getState()
  if (event.type === "message") watchdog.touch(botIdFor(event.message.conversationId))
  else if (event.type === "typing" || event.type === "message_delta") watchdog.touch(botIdFor(event.conversationId))
  else if (event.type === "activity") touchAccount(event.accountId)
  switch (event.type) {
    case "message":
      // Typing state is driven solely by the adapter's typing events, so a
      // reply does not hide the indicator while another one is pending.
      store.receiveMessage(event.message)
      break
    case "typing":
      store.setTyping(event.conversationId, event.isTyping)
      break
    case "status":
      store.setAccountStatus(event.accountId, event.status, event.detail)
      break
    case "message_delta":
      store.setTyping(event.conversationId, true)
      if (
        event.text ||
        event.widgets?.length ||
        event.richWidgets?.length ||
        event.tools?.length ||
        event.media?.length
      ) {
        store.applyMessageDelta(
          event.messageId,
          event.conversationId,
          event.accountId,
          event.text || "",
          event.widgets,
          event.tools,
          event.media,
          event.richWidgets
        )
      }
      break
    case "approvals":
      if (event.pending.length > 0) store.setAccountStatus(event.accountId, "attention")
      break
    case "login":
      store.setAccountStatus(event.accountId, event.signedIn ? "online" : "offline")
      break
    case "activity":
      store.setActivity(event.accountId, {
        code: event.activity.code,
        text: event.activity.text,
        emoji: event.activity.emoji,
        busy: event.activity.busy,
        subagents: event.activity.subagents,
        ctaLabel: event.activity.ctaLabel
      })
      break
  }
}

/**
 * Pipe events from every registered platform adapter into the store.
 * Also listen for main-process Grok auth capture (login window).
 * Returns a cleanup function that unsubscribes all listeners.
 */
export function startAdapterBridge(): () => void {
  const unsubscribers = adapterRegistry.list().map((adapter) => adapter.subscribe(handleEvent))

  const bridge = electronBridge()
  if (bridge?.grok?.onEvent) {
    unsubscribers.push(
      bridge.grok.onEvent((event) => {
        const store = useBotStore.getState()
        if (event.type === "auth") {
          if (event.signedIn) {
            if (store.accounts[event.accountId]) {
              void store
                .setGrokAccessToken(
                  event.accountId,
                  event.accessToken,
                  event.accountSlot,
                  event.machineId
                )
                .catch(() => undefined)
            }
          } else if (store.accounts[event.accountId]) {
            store.setAccountStatus(
              event.accountId,
              "offline",
              event.windowClosed ? "登录窗口已关闭，未完成授权" : "已退出 Grok Bot"
            )
          }
          return
        }
        if (event.type === "roster_changed") {
          if (store.accounts[event.accountId]) {
            void store.syncGrokAccountBots(event.accountId).catch(() => undefined)
          }
          return
        }
        const matchGrokBots = (accountId: string, agentId: string) => {
          const exact = store.bots.filter(
            (b) =>
              b.platformId === "grok" &&
              b.accountIds.includes(accountId) &&
              b.selectedAgentId === agentId
          )
          if (exact.length > 0) return exact
          return store.bots.filter(
            (b) =>
              b.platformId === "grok" &&
              b.accountIds.includes(accountId) &&
              !b.selectedAgentId
          )
        }
        if (event.type === "activity") {
          touchAccount(event.accountId)
          store.setActivity(
            event.accountId,
            event.busy
              ? {
                  code: event.activityCode,
                  text: event.activityText ?? "正在运行…",
                  emoji: event.activityEmoji ?? null,
                  busy: true,
                  subagents: event.hasRunningSubagents ? 1 : undefined
                }
              : null
          )
          for (const targetBot of matchGrokBots(event.accountId, event.agentId)) {
            store.setTyping(targetBot.id, event.busy)
          }
          return
        }
        if (event.type === "turn_failed") {
          store.setActivity(event.accountId, null)
          for (const targetBot of matchGrokBots(event.accountId, event.agentId)) {
            store.setTyping(targetBot.id, false)
            store.receiveMessage({
              id: `grok_err_${event.turnId || Date.now()}`,
              conversationId: targetBot.id,
              accountId: event.accountId,
              text: `⚠️ **Grok Bot 执行中断 (${event.code})**：${event.summary}`,
              createdAt: Date.now()
            })
          }
          return
        }
        if (event.type === "message_deleted") {
          for (const targetBot of matchGrokBots(event.accountId, event.agentId)) {
            store.deleteMessages(targetBot.id, event.messageIds)
          }
          return
        }
        if (event.type === "stream") {
          // Route strictly to `(accountId, selectedAgentId)` or explicit `conversationId`
          const targets = event.conversationId
            ? store.bots.filter(
                (b) =>
                  b.id === event.conversationId &&
                  (!b.selectedAgentId || b.selectedAgentId === event.agentId)
              )
            : matchGrokBots(event.accountId, event.agentId)
          if (targets.length === 0) return
          const hasPayload = Boolean(
            event.text ||
              event.widgets?.length ||
              event.richWidgets?.length ||
              event.tools?.length ||
              event.media?.length
          )
          for (const matchingBot of targets) {
            const convId = matchingBot.id
            watchdog.touch(botIdFor(convId))
            if (!event.done) {
              store.setTyping(convId, true)
              if (hasPayload) {
                store.applyMessageDelta(
                  event.messageId,
                  convId,
                  event.accountId,
                  event.text || "",
                  event.widgets,
                  event.tools,
                  event.media,
                  event.richWidgets
                )
              }
            } else {
              store.setTyping(convId, false)
              if (hasPayload) {
                store.receiveMessage({
                  id: event.messageId,
                  conversationId: convId,
                  accountId: event.accountId,
                  text: event.text || "",
                  createdAt: Date.now(),
                  widgets: event.widgets,
                  tools: event.tools,
                  media: event.media,
                  richWidgets: event.richWidgets
                })
              }
            }
          }
          return
        }
      })
    )
  }

  const museBridge = electronBridge()?.muse
  if (museBridge?.onEvent) {
    unsubscribers.push(
      museBridge.onEvent((event) => {
        if (event.type !== "identity") return
        const store = useBotStore.getState()
        const { displayName, avatarDataUrl } = event.identity
        if (displayName) {
          store.renameAccount(event.accountId, displayName)
        }
        const museBots = store.bots.filter(
          (b) => b.platformId === "meta-muse" && b.accountIds.includes(event.accountId)
        )
        for (const bot of museBots) {
          if (avatarDataUrl && !bot.avatar) {
            store.setBotAvatar(bot.id, avatarDataUrl)
          }
          if (displayName && /^(?:Meta Muse|Muse)(?:\s+\d+)?$/i.test(bot.name.trim())) {
            store.renameBot(bot.id, `Muse · ${displayName}`)
          }
        }
      })
    )
  }

  const cueBridge = electronBridge()?.cue
  if (cueBridge?.onEvent) {
    unsubscribers.push(
      cueBridge.onEvent((event) => {
        const store = useBotStore.getState()
        if (event.type === "auth") {
          if (event.signedIn) {
            store.setAccountStatus(event.accountId, "online")
            void store.syncCueAccountBots(event.accountId)
          } else if (!event.windowClosed) {
            store.setAccountStatus(event.accountId, "offline", "未登录 Cue")
          }
          return
        }
        if (event.type === "roster_changed") {
          void store.syncCueAccountBots(event.accountId)
        }
      })
    )
  }

  const watchdogTimer = setInterval(checkStalledReplies, 15_000)

  return () => {
    clearInterval(watchdogTimer)
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
