import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { adapterRegistry } from '@adapters/registry'
import type { ConnectionStatus, SendReceipt } from '@adapters/types'
import { createId } from '@shared/id'
import { getBridge } from '@/lib/bridge'
import { cancelPlatformTurn, useBotStore } from '@/store/botStore'
import { createSafeStorage } from '@/store/delivery'
import type { Bot } from '@/types'
import {
  isFinal,
  mentions,
  turnPrompt,
  type CollabRoom,
  type RoomMember,
  type RoomMessage
} from './model'
import { requestedTool } from './toolRequests'

export interface RoomTurnProgress {
  turn: number
  limit: number
}

interface RoomState {
  externalAudiences: Record<string, string | undefined>
  rooms: CollabRoom[]
  speakers: Record<string, string | undefined>
  turnProgress: Record<string, RoomTurnProgress | undefined>
  errors: Record<string, string | undefined>
}

export const useRooms = create<RoomState>()(
  persist(
    (): RoomState => ({
      rooms: [],
      speakers: {},
      turnProgress: {},
      errors: {},
      externalAudiences: {}
    }),
    {
      name: 'botark-collaboration-rooms',
      storage: createJSONStorage(() =>
        createSafeStorage(() => (typeof localStorage === 'undefined' ? undefined : localStorage))
      ),
      partialize: (s) => ({ rooms: s.rooms }),
      merge: (persisted, current) => {
        const raw = persisted && typeof persisted === 'object' ? (persisted as { rooms?: unknown }) : {}
        const safeRooms = Array.isArray(raw.rooms)
          ? raw.rooms
              .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string'))
              .map((r) => ({
                id: String(r.id),
                title: typeof r.title === 'string' && r.title.trim() ? r.title : '协作讨论',
                members: Array.isArray(r.members) ? (r.members as RoomMember[]) : [],
                messages: Array.isArray(r.messages) ? (r.messages as RoomMessage[]) : [],
                mode: r.mode === 'manual' ? ('manual' as const) : ('auto' as const),
                limit: typeof r.limit === 'number' && r.limit > 0 ? r.limit : 6,
                brief: typeof r.brief === 'string' ? r.brief : '',
                slackParent: typeof r.slackParent === 'string' ? r.slackParent : undefined,
                slackChannel: typeof r.slackChannel === 'string' ? r.slackChannel : undefined,
                slackThread: typeof r.slackThread === 'string' ? r.slackThread : undefined,
                finalId: typeof r.finalId === 'string' ? r.finalId : undefined,
                createdAt: typeof r.createdAt === 'number' ? r.createdAt : undefined
              }))
          : []
        return { ...current, rooms: safeRooms }
      }
    }
  )
)

const isConnectedStatus = (status?: ConnectionStatus) =>
  status === 'online' || status === 'attention' || status === 'busy'

function turnLockKey(member: Pick<RoomMember, 'accountId' | 'agentId'>): string {
  return member.agentId ? `${member.accountId}::${member.agentId}` : member.accountId
}

function findBotForMember(member: RoomMember, bots: Bot[]): Bot | undefined {
  return (
    bots.find((b) => b.id === member.botId) ??
    bots.find(
      (b) =>
        b.platformId === member.platform &&
        (b.activeAccountId === member.accountId || b.accountIds?.includes(member.accountId)) &&
        (!member.agentId || b.selectedAgentId === member.agentId)
    )
  )
}

function reconcileRoomMemberList(
  members: RoomMember[],
  bots: Bot[],
  accounts: Record<string, { handle?: string } | undefined>
): { members: RoomMember[]; changed: boolean } {
  let changed = false
  const usedNames = new Set<string>()
  const next = members.map((member) => {
    const bot = findBotForMember(member, bots)
    if (!bot) {
      usedNames.add(member.name.toLowerCase())
      return member
    }
    const nextBotId = bot.id || member.botId
    const nextAccountId =
      bot.activeAccountId ||
      (bot.accountIds?.includes(member.accountId) ? member.accountId : bot.accountIds?.[0]) ||
      member.accountId
    const nextAgentId = bot.selectedAgentId
    const rawName = bot.name?.trim()
    let nextName = member.name
    if (rawName) {
      const handle = accounts[nextAccountId]?.handle?.trim()
      const escapedRaw = rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const matchesWithHandle =
        Boolean(handle) && member.name.toLowerCase() === `${rawName} · ${handle}`.toLowerCase()
      const matchesWithNum = new RegExp(`^${escapedRaw} \\(\\d+\\)$`, 'i').test(member.name)
      if (
        member.name.toLowerCase() === rawName.toLowerCase() ||
        matchesWithHandle ||
        matchesWithNum
      ) {
        nextName = member.name
      } else {
        nextName = rawName
      }
      if (usedNames.has(nextName.toLowerCase())) {
        if (handle && !usedNames.has(`${rawName} · ${handle}`.toLowerCase())) {
          nextName = `${rawName} · ${handle}`
        } else {
          let n = 2
          while (usedNames.has(`${rawName} (${n})`.toLowerCase())) n++
          nextName = `${rawName} (${n})`
        }
      }
    }
    usedNames.add(nextName.toLowerCase())
    const resetSession = nextAccountId !== member.accountId || nextAgentId !== member.agentId
    const nextSessionId = resetSession ? undefined : member.sessionId
    if (
      nextBotId !== member.botId ||
      nextAccountId !== member.accountId ||
      nextAgentId !== member.agentId ||
      nextName !== member.name ||
      nextSessionId !== member.sessionId
    ) {
      changed = true
      return {
        ...member,
        botId: nextBotId,
        accountId: nextAccountId,
        agentId: nextAgentId,
        name: nextName,
        cursor: resetSession ? 0 : member.cursor,
        sessionId: nextSessionId
      }
    }
    return member
  })
  return { members: changed ? next : members, changed }
}

function reconcileRooms(targetRoomId?: string) {
  const { bots, accounts } = useBotStore.getState()
  const { rooms } = useRooms.getState()
  let anyChanged = false
  const nextRooms = rooms.map((room) => {
    if (targetRoomId && room.id !== targetRoomId) return room
    const res = reconcileRoomMemberList(room.members, bots, accounts)
    if (!res.changed) return room
    anyChanged = true
    if (res.members.some((m, i) => m.accountId !== room.members[i]!.accountId || m.agentId !== room.members[i]!.agentId)) {
      stopRoom(room.id)
    }
    return { ...room, members: res.members }
  })
  if (anyChanged) {
    useRooms.setState({ rooms: nextRooms })
  }
}

useBotStore.subscribe((state, prev) => {
  if (state.bots !== prev.bots) {
    reconcileRooms()
  }
})

const pendingTurns = new Map<string, Promise<unknown>>()
const runs = new Map<string, AbortController>()
const activeAccounts = new Set<string>()
const roomById = (id: string) => useRooms.getState().rooms.find((r) => r.id === id)

function update(id: string, fn: (room: CollabRoom) => CollabRoom) {
  useRooms.setState((s) => ({ rooms: s.rooms.map((r) => (r.id === id ? fn(r) : r)) }))
}

export function stopRoom(id: string) {
  runs.get(id)?.abort()
  runs.delete(id)
  useRooms.setState((s) => ({
    speakers: { ...s.speakers, [id]: undefined },
    turnProgress: { ...s.turnProgress, [id]: undefined }
  }))
}

function setError(id: string, error?: string) {
  useRooms.setState((s) => ({ errors: { ...s.errors, [id]: error } }))
}

export function renameRoom(id: string, title: string) {
  const trimmed = title.trim()
  if (!trimmed) return
  update(id, (r) => ({ ...r, title: trimmed }))
}

export function updateRoomConfig(
  id: string,
  patch: Partial<Pick<CollabRoom, 'mode' | 'limit'>>
) {
  update(id, (r) => ({
    ...r,
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.limit !== undefined
      ? { limit: Math.max(1, Math.min(24, Math.round(patch.limit))) }
      : {})
  }))
}

export function clearRoomTranscript(id: string) {
  stopRoom(id)
  setError(id, undefined)
  update(id, (r) => ({
    ...r,
    messages: [],
    finalId: undefined,
    brief: '',
    members: r.members.map((m) => ({ ...m, cursor: 0, sessionId: undefined }))
  }))
}

export function deleteRoom(id: string) {
  stopRoom(id)
  const toRemove = new Set(
    useRooms
      .getState()
      .rooms.filter((r) => r.id === id || r.slackParent === id)
      .map((r) => r.id)
  )
  for (const rid of toRemove) stopRoom(rid)
  useRooms.setState((s) => ({
    rooms: s.rooms.filter((r) => !toRemove.has(r.id))
  }))
  const botState = useBotStore.getState()
  if (botState.selectedBotId && toRemove.has(botState.selectedBotId)) {
    const remainingRoom = useRooms.getState().rooms[0]?.id
    const firstBot = botState.bots[0]?.id ?? null
    botState.selectBot(remainingRoom ?? firstBot)
  }
}

export function addRoom(title: string, ids: string[], mode: CollabRoom['mode'], limit: number) {
  const { bots, accounts } = useBotStore.getState()
  const usedNames = new Set<string>()
  const members: RoomMember[] = [...new Set(ids)].map((id) => {
    const bot = bots.find((b) => b.id === id)
    const storeStatus = bot ? accounts[bot.activeAccountId]?.status : undefined
    const adapterStatus = bot
      ? adapterRegistry.get(bot.platformId)?.getStatus(bot.activeAccountId)
      : undefined
    if (!bot || (!isConnectedStatus(storeStatus) && !isConnectedStatus(adapterStatus))) {
      throw new Error('请选择已连接的 Bot')
    }
    const rawBase = bot.name?.trim() || accounts[bot.activeAccountId]?.displayName?.trim() || id
    let candidate = rawBase
    if (usedNames.has(candidate.toLowerCase())) {
      const handle = accounts[bot.activeAccountId]?.handle?.trim()
      if (handle && !usedNames.has(`${rawBase} · ${handle}`.toLowerCase())) {
        candidate = `${rawBase} · ${handle}`
      } else {
        let n = 2
        while (usedNames.has(`${rawBase} (${n})`.toLowerCase())) n++
        candidate = `${rawBase} (${n})`
      }
    }
    usedNames.add(candidate.toLowerCase())
    return {
      botId: id,
      platform: bot.platformId,
      accountId: bot.activeAccountId,
      name: candidate,
      agentId: bot.selectedAgentId,
      sessionId: undefined,
      cursor: 0
    }
  })
  if (members.length < 2 || members.length > 6) throw new Error('请选择 2–6 位成员')
  if (!Number.isInteger(limit) || limit < 1 || limit > 24) throw new Error('轮数应为 1–24')
  const room: CollabRoom = {
    id: createId('room'),
    title: title.trim() || members.map((m) => m.name).join(' · '),
    members,
    messages: [],
    mode,
    limit,
    brief: '',
    createdAt: Date.now()
  }
  useRooms.setState((s) => ({ rooms: [...s.rooms, room] }))
  return room
}

export function removeMember(roomId: string, botId: string): { ok: boolean; error?: string } {
  const room = roomById(roomId)
  if (!room) return { ok: false, error: '未找到该群聊' }
  if (!room.members.some((m) => m.botId === botId)) {
    return { ok: false, error: '该成员不在当前群聊中' }
  }
  if (room.members.length <= 1) {
    return { ok: false, error: '群聊至少需要保留一位成员' }
  }
  if (runs.has(roomId) || useRooms.getState().speakers[roomId]) {
    stopRoom(roomId)
  }
  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) =>
      r.id === roomId ? { ...r, members: r.members.filter((m) => m.botId !== botId) } : r
    ),
    errors: { ...s.errors, [roomId]: undefined }
  }))
  return { ok: true }
}

/** Add a sidebar bot to an existing group chat (used by drag-and-drop). */
export function addMemberToRoom(roomId: string, botId: string): { ok: boolean; error?: string } {
  const room = roomById(roomId)
  if (!room) return { ok: false, error: '未找到该群聊' }
  if (room.members.some((m) => m.botId === botId)) {
    return { ok: false, error: '该 Bot 已在群聊中' }
  }
  if (room.members.length >= 6) {
    return { ok: false, error: '群聊成员已达上限（6 位）' }
  }
  const { bots, accounts } = useBotStore.getState()
  const bot = bots.find((b) => b.id === botId)
  if (!bot) return { ok: false, error: '未找到该 Bot' }
  const storeStatus = accounts[bot.activeAccountId]?.status
  const adapterStatus = adapterRegistry.get(bot.platformId)?.getStatus(bot.activeAccountId)
  if (!isConnectedStatus(storeStatus) && !isConnectedStatus(adapterStatus)) {
    return { ok: false, error: '请先连接该 Bot 再加入群聊' }
  }

  const usedNames = new Set(room.members.map((m) => m.name.toLowerCase()))
  const rawBase = bot.name?.trim() || accounts[bot.activeAccountId]?.displayName?.trim() || botId
  let name = rawBase
  if (usedNames.has(name.toLowerCase())) {
    const handle = accounts[bot.activeAccountId]?.handle?.trim()
    if (handle && !usedNames.has(`${rawBase} · ${handle}`.toLowerCase())) {
      name = `${rawBase} · ${handle}`
    } else {
      let n = 2
      while (usedNames.has(`${rawBase} (${n})`.toLowerCase())) n++
      name = `${rawBase} (${n})`
    }
  }

  if (runs.has(roomId) || useRooms.getState().speakers[roomId]) {
    stopRoom(roomId)
  }
  const member: RoomMember = {
    botId,
    platform: bot.platformId,
    accountId: bot.activeAccountId,
    name,
    agentId: bot.selectedAgentId,
    sessionId: undefined,
    cursor: 0
  }
  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, members: [...r.members, member] } : r)),
    errors: { ...s.errors, [roomId]: undefined }
  }))
  return { ok: true }
}

export function moveMemberToRoom(
  sourceRoomId: string,
  botId: string,
  targetRoomId: string
): { ok: boolean; error?: string } {
  if (sourceRoomId === targetRoomId) {
    return { ok: false, error: '目标群聊不能与当前群聊相同' }
  }
  const source = roomById(sourceRoomId)
  if (!source) return { ok: false, error: '未找到源群聊' }
  const target = roomById(targetRoomId)
  if (!target) return { ok: false, error: '未找到目标群聊' }
  const member = source.members.find((m) => m.botId === botId)
  if (!member) return { ok: false, error: '该成员不在当前群聊中' }
  if (source.members.length <= 1) {
    return { ok: false, error: '当前群聊至少需要保留一位成员' }
  }
  if (target.members.length >= 6) {
    return { ok: false, error: '目标群聊成员已达上限（6 位）' }
  }
  if (target.members.some((m) => m.botId === botId)) {
    return { ok: false, error: '目标群聊中已包含该 Bot' }
  }
  if (target.members.some((m) => m.name.toLowerCase() === member.name.toLowerCase())) {
    return { ok: false, error: `目标群聊中已存在同名成员「${member.name}」` }
  }

  if (runs.has(sourceRoomId) || useRooms.getState().speakers[sourceRoomId]) {
    stopRoom(sourceRoomId)
  }
  if (runs.has(targetRoomId) || useRooms.getState().speakers[targetRoomId]) {
    stopRoom(targetRoomId)
  }

  const movedMember: RoomMember = {
    ...member,
    cursor: 0,
    sessionId: undefined
  }

  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) => {
      if (r.id === sourceRoomId) {
        return { ...r, members: r.members.filter((m) => m.botId !== botId) }
      }
      if (r.id === targetRoomId) {
        return { ...r, members: [...r.members, movedMember] }
      }
      return r
    }),
    errors: {
      ...s.errors,
      [sourceRoomId]: undefined,
      [targetRoomId]: undefined
    }
  }))
  return { ok: true }
}

async function memberReply(room: CollabRoom, member: RoomMember, signal: AbortSignal) {
  const adapter = adapterRegistry.get(member.platform)
  const bot = useBotStore
    .getState()
    .bots.find((b) => b.id === member.botId && b.accountIds.includes(member.accountId))
  const lockKey = turnLockKey(member)
  if (!bot || !adapter || activeAccounts.has(lockKey)) {
    throw new Error(`@${member.name} 正忙或已断开连接`)
  }
  let status = adapter.getStatus(member.accountId)
  if (status !== 'online' && status !== 'attention') {
    if (status !== 'busy' && typeof adapter.connect === 'function') {
      try {
        const next = await adapter.connect(member.accountId)
        signal.throwIfAborted()
        status = next
        if (next === 'online' || next === 'attention') {
          useBotStore.getState().setAccountStatus?.(member.accountId, next)
        }
      } catch (err) {
        if (signal.aborted) throw err
      }
    }
  }
  if ((status !== 'online' && status !== 'attention') || activeAccounts.has(lockKey)) {
    throw new Error(`@${member.name} 正忙或已断开连接`)
  }
  activeAccounts.add(lockKey)
  const conversationId = 'room-turn-' + createId('turn')
  const replies = new Map<string, string>()
  const unsubscribe = adapter.onMessage((m) => {
    if (m.conversationId === conversationId && m.accountId === member.accountId && m.text.trim())
      replies.set(m.id, m.text)
  })
  let sessionId = member.sessionId
  const cancel = () => {
    void cancelPlatformTurn({
      ...bot,
      activeAccountId: member.accountId,
      activeSessionId: sessionId,
      selectedAgentId: member.agentId
    }).catch(() => {})
  }
  try {
    if (!sessionId && member.platform === 'hark') {
      const res = await getBridge()?.hark.rpc({
        accountId: member.accountId,
        op: 'createConversation',
        title: room.title
      })
      if (!res?.ok) throw new Error(res?.message ?? 'Hark unavailable')
      sessionId = (res.data as { conversationId: string }).conversationId
    } else if (!sessionId && member.platform === 'meta-muse') {
      try {
        sessionId = (await getBridge()?.muse.startSession(member.accountId))?.sessionId ?? undefined
      } catch (err) {
        // Never brick the entire collaboration room if `session.start` fails or is unsupported
        // on a specific Muse VM: fall back to `chat.stream` allocating/returning `receipt.sessionId`.
        console.warn('[room] muse.startSession failed; falling back to chat.stream session allocation', err)
        sessionId = undefined
      }
    }
    signal.throwIfAborted()
    if (sessionId && sessionId !== member.sessionId)
      update(room.id, (r) => ({
        ...r,
        members: r.members.map((m) => (m.botId === member.botId ? { ...m, sessionId } : m))
      }))
    let prompt = turnPrompt(room, member)
    const hub = getBridge()?.workspace
    const workspace = hub ? await hub.manage(room.id, { op: 'status' }) : undefined
    if (workspace?.tools.length) {
      prompt +=
        '\n\nTo request one workspace tool, reply with [TOOL] followed by JSON {"name":"…","args":{…}}. A person approves each call. Available tools: ' +
        JSON.stringify(workspace.tools.map((t) => ({ name: t.name, schema: t.inputSchema })))
    }
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    const receipt = await new Promise<SendReceipt>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Aborted'))
        return
      }
      const onAbort = () => {
        reject(signal.reason ?? new Error('Aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      adapter
        .sendMessage({
          conversationId,
          sessionId,
          accountId: member.accountId,
          agentId: member.agentId,
          hermesSessionKey: room.id + '-' + member.botId,
          text: prompt,
          signal
        })
        .then(
          (res) => {
            signal.removeEventListener('abort', onAbort)
            resolve(res)
          },
          (err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          }
        )
    })
    signal.throwIfAborted()
    const text = [...replies.values()].join('\n\n')
    if (!text) throw new Error(`@${member.name} 没有返回文字回复`)
    return { text, sessionId: receipt.sessionId ?? sessionId }
  } finally {
    unsubscribe()
    activeAccounts.delete(lockKey)
    signal.removeEventListener('abort', cancel)
  }
}

export async function submitBrief(
  id: string,
  input: string,
  author = 'User',
  messageId = createId('post')
) {
  reconcileRooms(id)
  const room = roomById(id)
  const text = input.trim()
  if (!room || !text) return
  stopRoom(id)
  setError(id)
  const controller = new AbortController()
  runs.set(id, controller)
  const message: RoomMessage = { id: messageId, author, text, createdAt: Date.now() }
  update(id, (r) => ({ ...r, brief: text, finalId: undefined, messages: [...r.messages, message] }))
  const queue = mentions(text, room.members)
  if (!queue.length && room.mode === 'auto') {
    const { accounts } = useBotStore.getState()
    const first = room.members.find((member) => {
      const status = adapterRegistry.get(member.platform)?.getStatus(member.accountId)
      return status === 'online' || status === 'attention'
    }) ?? room.members.find((member) => isConnectedStatus(accounts[member.accountId]?.status))
      ?? room.members[0]
    if (first) queue.push(first)
  }
  try {
    if (room.members.length === 0) {
      setError(id, '群聊没有可对话的成员')
      return
    }
    if (!queue.length && room.mode === 'manual') {
      setError(
        id,
        `当前为「手动 @」模式，请用 @成员名 指定回复的成员（如 @${room.members[0]?.name ?? '成员'}）`
      )
      return
    }
    const previous = pendingTurns.get(id)
    if (previous) await previous.catch(() => {})
    controller.signal.throwIfAborted()
    for (let turn = 0; queue.length; turn++) {
      const next = queue.shift()!
      const current = roomById(id)
      if (!current || turn >= current.limit) break
      const member = current.members.find((m) => m.botId === next.botId)
      if (!member) continue
      useRooms.setState((s) => ({
        speakers: { ...s.speakers, [id]: member.name },
        turnProgress: { ...s.turnProgress, [id]: { turn: turn + 1, limit: current.limit } }
      }))
      const pending = memberReply(current, member, controller.signal)
      pendingTurns.set(id, pending)
      const reply = await pending.finally(() => {
        if (pendingTurns.get(id) === pending) pendingTurns.delete(id)
      })
      controller.signal.throwIfAborted()
      const post: RoomMessage = {
        id: createId('post'),
        author: member.name,
        text: reply.text,
        createdAt: Date.now()
      }
      const done = isFinal(post.text)
      update(id, (r) => ({
        ...r,
        finalId: done ? post.id : undefined,
        messages: [...r.messages, post],
        members: r.members.map((m) =>
          m.botId === member.botId
            ? { ...m, cursor: r.messages.length + 1, sessionId: reply.sessionId }
            : m
        )
      }))
      if (done) break
      const tool = requestedTool(post.text)
      const latest = roomById(id)!
      if (tool && turn + 1 < latest.limit) {
        const bridge = getBridge()?.workspace
        if (!bridge) throw new Error('工作区不可用')
        const recipient = [
          room.title,
          room.members.map((m) => m.name).join(', '),
          useRooms.getState().externalAudiences[id]
        ]
          .filter(Boolean)
          .join(' · ')
        const result = await bridge.run(id, tool.name, tool.args, recipient)
        controller.signal.throwIfAborted()
        update(id, (r) => ({
          ...r,
          messages: [
            ...r.messages,
            { id: createId('post'), author: 'Tool', text: result, createdAt: Date.now() }
          ]
        }))
        queue.unshift(member)
        continue
      }
      if (latest.mode === 'auto') {
        for (const target of mentions(post.text, latest.members)) {
          if (target.botId !== member.botId && !queue.some((m) => m.botId === target.botId)) {
            queue.push(target)
          }
        }
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) setError(id, e instanceof Error ? e.message : String(e))
  } finally {
    if (runs.get(id) === controller) {
      pendingTurns.delete(id)
      runs.delete(id)
      useRooms.setState((s) => ({
        speakers: { ...s.speakers, [id]: undefined },
        turnProgress: { ...s.turnProgress, [id]: undefined }
      }))
    }
  }
}
