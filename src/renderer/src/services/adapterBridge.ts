import { getEventBot } from './sessionEvents'
import { adapterRegistry } from "@adapters/registry"
import type { AdapterEvent, PlatformId } from "@adapters/types"
import { useBotStore } from "@/store/botStore"
import { replyWatchdog as watchdog } from "@/store/replyWatchdog"

/** Clear stale "thinking" and flag the unanswered message. */
function checkStalledReplies(): void {
  const store = useBotStore.getState()
  const waitingIds = store.bots.filter((bot) => store.typing[bot.id] || store.activity[bot.activeAccountId]?.busy)
    .map((bot) => bot.id)
  const stalled = watchdog.stalled(waitingIds, (botId) => {
    const bot = store.bots.find((b) => b.id === botId)
    return Boolean(bot && store.activity[bot.activeAccountId]?.busy)
  })
  for (const botId of stalled) store.finishReply(botId, true)
}

function electronBridge(): Window["electron"] | undefined {
  return typeof window !== "undefined" ? window.electron : undefined
}

function handleEvent(platformId: PlatformId, event: AdapterEvent): void {
  const store = useBotStore.getState()
  const accountId = event.type === "message" ? event.message.accountId : event.accountId
  const account = store.accounts[accountId]
  if (!account || account.platformId !== platformId) return
  switch (event.type) {
    case "message": {
      const message = event.message
      const bot = getEventBot(store.bots, accountId, message.conversationId, message.sessionId)
      if (!bot) return
      watchdog.touch(bot.id)
      store.receiveMessage({ ...message, conversationId: bot.id })
      break
    }
    case "typing": {
      const bot = getEventBot(store.bots, accountId, event.conversationId, event.sessionId)
      if (!bot) return
      if (event.isTyping) {
        watchdog.touch(bot.id)
        if (!store.typing[bot.id]) store.setTyping(bot.id, true)
      } else {
        store.finishReply(bot.id)
      }
      break
    }
    case "status":
      store.setAccountStatus(event.accountId, event.status, event.detail)
      break
    case "message_delta": {
      const bot = getEventBot(store.bots, accountId, event.conversationId, event.sessionId)
      if (!bot) return
      watchdog.touch(bot.id)
      if (!store.typing[bot.id]) store.setTyping(bot.id, true)
      if (
        event.text ||
        event.widgets?.length ||
        event.richWidgets?.length ||
        event.tools?.length ||
        event.media?.length
      ) {
        store.applyMessageDelta(
          event.messageId,
          bot.id,
          event.accountId,
          event.text || "",
          event.widgets,
          event.tools,
          event.media,
          event.richWidgets
        )
      }
      break
    }
    case "approvals":
      if (event.pending.length > 0) store.setAccountStatus(event.accountId, "attention")
      break
    case "login":
      store.setAccountStatus(event.accountId, event.signedIn ? "online" : "offline")
      break
    case "activity": {
      const targets = store.bots.filter((bot) => bot.activeAccountId === accountId &&
        (!event.sessionId || !bot.activeSessionId || bot.activeSessionId === event.sessionId))
      if (!targets.length) return
      for (const bot of targets) watchdog.touch(bot.id)
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
}

/**
 * Pipe events from every registered platform adapter into the store.
 * Also listen for main-process Grok auth capture (login window).
 * Returns a cleanup function that unsubscribes all listeners.
 */
export function startAdapterBridge(): () => void {
  const unsubscribers = adapterRegistry.list().map((adapter) =>
    adapter.subscribe((event) => handleEvent(adapter.id, event))
  )

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
        const matchGrokBots = (accountId: string, agentId: string, sessionId?: string) => {
          const eligible = store.bots.filter((b) =>
            b.platformId === "grok" && b.activeAccountId === accountId &&
            (!sessionId || !b.activeSessionId || b.activeSessionId === sessionId))
          const exact = eligible.filter((b) => b.selectedAgentId === agentId)
          if (exact.length > 0) return exact
          return eligible.filter((b) => !b.selectedAgentId)
        }
        if (event.type === "activity") {
          const targets = matchGrokBots(event.accountId, event.agentId, event.sessionId)
          if (!targets.length) return
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
          for (const targetBot of targets) {
            if (event.busy) {
              watchdog.touch(targetBot.id)
              if (!store.typing[targetBot.id]) store.setTyping(targetBot.id, true)
            } else {
              store.finishReply(targetBot.id)
            }
          }
          return
        }
        if (event.type === "turn_failed") {
          for (const targetBot of matchGrokBots(event.accountId, event.agentId, event.sessionId)) {
            store.finishReply(targetBot.id)
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
          for (const targetBot of matchGrokBots(event.accountId, event.agentId, event.sessionId)) {
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
                  b.platformId === "grok" &&
                  b.activeAccountId === event.accountId &&
                  (!event.sessionId || !b.activeSessionId || b.activeSessionId === event.sessionId) &&
                  (!b.selectedAgentId || b.selectedAgentId === event.agentId)
              )
            : matchGrokBots(event.accountId, event.agentId, event.sessionId)
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
            if (!event.done) {
              watchdog.touch(convId)
              if (!store.typing[convId]) store.setTyping(convId, true)
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
              store.finishReply(convId)
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
        if (!store.accounts[event.accountId]) {
          // Account is not materialized in botStore yet (e.g. AddBotDialog is still on NameStep);
          // avoid creating a duplicate bot prematurely before the user finishes naming.
          return
        }
        if (event.type === "auth") {
          if (event.signedIn) {
            store.setAccountStatus(event.accountId, "online")
              void store.syncCueAccountBots(event.accountId).catch(() => undefined)
          } else if (!event.windowClosed) {
            store.setAccountStatus(event.accountId, "offline", "未登录 Cue")
          }
          return
        }
        if (event.type === "roster_changed") {
          void store.syncCueAccountBots(event.accountId).catch(() => undefined)
        }
      })
    )
  }

  const dsBotBridge = electronBridge()?.dsBot
  if (dsBotBridge?.onEvent) {
    unsubscribers.push(
      dsBotBridge.onEvent((event) => {
        const store = useBotStore.getState()
        if (!store.accounts[event.accountId]) return
        if (event.type === "roster_changed") {
          void store.syncDsBotAccountBots(event.accountId).catch(() => undefined)
          return
        }
        if (event.type === "stream" && !event.conversationId && event.agentId) {
          const targets = store.bots.filter(
            (b) =>
              b.platformId === "ds-bot" &&
              b.activeAccountId === event.accountId &&
              b.selectedAgentId === event.agentId
          )
          for (const targetBot of targets) {
            if (!event.done) {
              watchdog.touch(targetBot.id)
              if (!store.typing[targetBot.id]) store.setTyping(targetBot.id, true)
              if (event.text) {
                store.applyMessageDelta(event.messageId, targetBot.id, event.accountId, event.text)
              }
            } else {
              store.finishReply(targetBot.id)
              if (event.text) {
                store.receiveMessage({
                  id: event.messageId,
                  conversationId: targetBot.id,
                  accountId: event.accountId,
                  text: event.text,
                  createdAt: Date.now()
                })
              }
            }
          }
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
