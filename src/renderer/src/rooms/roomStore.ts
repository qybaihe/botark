import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { adapterRegistry } from '@adapters/registry'
import { AdapterError, type ConnectionStatus, type SendReceipt } from '@adapters/types'
import { createId } from '@shared/id'
import { getBridge } from '@/lib/bridge'
import { cancelPlatformTurn, useBotStore } from '@/store/botStore'
import { createSafeStorage } from '@/store/delivery'
import type { Bot } from '@/types'
import {
  classifyRoomReply,
  freshRoomSession,
  mentions,
  normalizeMentionName,
  refusesRoomFrame,
  roomRecipient,
  turnPrompt,
  type CollabRoom,
  type RoomMember,
  type RoomMessage,
  type RoomReference
} from './model'
import { requestedTool } from './toolRequests'

export interface RoomTurnProgress {
  turn: number
  limit: number
}

interface SlackDestination {
  channel: string
  thread?: string
  bindingGeneration?: number
}

interface RoomState {
  externalAudiences: Record<string, string | undefined>
  slackDestinations: Record<string, SlackDestination | undefined>
  rooms: CollabRoom[]
  speakers: Record<string, string | undefined>
  turnProgress: Record<string, RoomTurnProgress | undefined>
  errors: Record<string, string | undefined>
}

function roomStorageBacking(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

let storedRooms: {
  backing: Storage
  name: string
  value: string | null
  rooms?: CollabRoom[]
  version?: number
} | undefined
const safeRoomStorage = createSafeStorage(roomStorageBacking, () => { storedRooms = undefined })
const roomStorage: PersistStorage<Pick<RoomState, 'rooms'>> = {
  getItem(name) {
    const backing = roomStorageBacking()
    const value = safeRoomStorage.getItem(name)
    storedRooms = backing ? { backing, name, value } : undefined
    return value ? JSON.parse(value) : null
  },
  setItem(name, item) {
    const backing = roomStorageBacking()
    if (!backing) return
    const previous = storedRooms?.backing === backing && storedRooms.name === name ? storedRooms : undefined
    if (previous?.rooms === item.state.rooms && previous.version === item.version) return
    const value = JSON.stringify(item)
    storedRooms = { backing, name, value, rooms: item.state.rooms, version: item.version }
    if (value !== previous?.value) safeRoomStorage.setItem(name, value)
  },
  removeItem(name) {
    storedRooms = undefined
    safeRoomStorage.removeItem(name)
  }
}

export const useRooms = create<RoomState>()(
  persist(
    (): RoomState => ({
      rooms: [],
      speakers: {},
      turnProgress: {},
      errors: {},
      slackDestinations: {},
      externalAudiences: {}
    }),
    {
      name: 'botark-collaboration-rooms',
      storage: roomStorage,
      partialize: (s) => ({ rooms: s.rooms }),
      onRehydrateStorage: () => (state) => {
        if (state && storedRooms) {
          storedRooms.rooms = state.rooms
          storedRooms.version = 0
        }
      },
      merge: (persisted, current) => {
        const raw = persisted && typeof persisted === 'object' ? (persisted as { rooms?: unknown }) : {}
        const safeRooms = Array.isArray(raw.rooms)
          ? raw.rooms
              .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string'))
              .map((r) => ({
                id: String(r.id),
                title: typeof r.title === 'string' && r.title.trim() ? r.title : '协作讨论',
                pinned: typeof r.pinned === 'boolean' ? r.pinned : undefined,
                members: Array.isArray(r.members) ? (r.members as RoomMember[]) : [],
                messages: Array.isArray(r.messages) ? (r.messages as RoomMessage[]).map((m) =>
                  r.finalId && m?.id === r.finalId ? { ...m, final: true } : m
                ) : [],
                mode: r.mode === 'manual' ? ('manual' as const) : ('auto' as const),
                limit: typeof r.limit === 'number' && r.limit > 0 ? r.limit : 6,
                brief: typeof r.brief === 'string' ? r.brief : '',
                coordinatorId: typeof r.coordinatorId === 'string' ? r.coordinatorId : undefined,
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

function findBotForMember(member: RoomMember, bots: Bot[], occupiedIds: ReadonlySet<string>): Bot | undefined {
  return (
    bots.find((b) => b.id === member.botId) ??
    bots.find(
      (b) =>
        !occupiedIds.has(b.id) &&
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
  const occupiedIds = new Set(members.map((member) => member.botId))
  const next = members.map((member) => {
    const bot = findBotForMember(member, bots, occupiedIds)
    if (!bot) {
      usedNames.add(normalizeMentionName(member.name))
      return member
    }
    const nextBotId = bot.id || member.botId
    occupiedIds.add(nextBotId)
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
      if (usedNames.has(normalizeMentionName(nextName))) {
        if (handle && !usedNames.has(normalizeMentionName(`${rawName} · ${handle}`))) {
          nextName = `${rawName} · ${handle}`
        } else {
          let n = 2
          while (usedNames.has(normalizeMentionName(`${rawName} (${n})`))) n++
          nextName = `${rawName} (${n})`
        }
      }
    }
    usedNames.add(normalizeMentionName(nextName))
    const resetSession = nextAccountId !== member.accountId || nextAgentId !== member.agentId
    if (
      nextBotId !== member.botId ||
      nextAccountId !== member.accountId ||
      nextAgentId !== member.agentId ||
      nextName !== member.name
    ) {
      changed = true
      return {
        ...member,
        botId: nextBotId,
        accountId: nextAccountId,
        agentId: nextAgentId,
        name: nextName,
        ...(resetSession ? freshRoomSession(member.platform) : {})
      }
    }
    return member
  })
  return { members: changed ? next : members, changed }
}

function initialMember(bot: Bot): RoomMember {
  return {
    botId: bot.id, platform: bot.platformId, accountId: bot.activeAccountId,
    agentId: bot.selectedAgentId, name: bot.name.trim() || bot.id, ...freshRoomSession(bot.platformId)
  }
}

function revokeCoordination(room: CollabRoom): CollabRoom {
  stopRoom(room.id)
  return {
    ...room, coordinatorId: undefined, mode: 'manual',
    members: room.members.filter((m) => m.botId === room.coordinatorId)
  }
}

export function setRoomAdministrator(botId: string, enabled: boolean) {
  const existing = useRooms.getState().rooms.find((r) => r.coordinatorId === botId)
  if (existing) {
    if (!enabled) update(existing.id, revokeCoordination)
    return existing.id
  }
  const { bots, accounts } = useBotStore.getState()
  const owner = bots.find((b) => b.id === botId)
  if (!enabled || !owner) return
  const members = [owner, ...bots.filter((b) => b !== owner)].map(initialMember)
  const room: CollabRoom = {
    id: createId('room'), title: owner.name + ' · 管理员调度', coordinatorId: owner.id,
    members: reconcileRoomMemberList(members, bots, accounts).members,
    messages: [], brief: '', mode: 'auto', limit: 8, createdAt: Date.now()
  }
  useRooms.setState((s) => ({ rooms: [...s.rooms, room] }))
  return room.id
}

function reconcileRooms(targetRoomId?: string) {
  const { bots, accounts } = useBotStore.getState()
  const { rooms } = useRooms.getState()
  let anyChanged = false
  const nextRooms = rooms.map((room) => {
    if (targetRoomId && room.id !== targetRoomId) return room
    let members = room.members
    if (room.coordinatorId) {
      const owner = bots.find((b) => b.id === room.coordinatorId)
      const original = members.find((m) => m.botId === room.coordinatorId)
      if (!owner || owner.activeAccountId !== original?.accountId || owner.selectedAgentId !== original?.agentId) {
        anyChanged = true
        return revokeCoordination(room)
      }
      const roster = [owner, ...bots.filter((b) => b !== owner)].map((b) =>
        members.find((m) => m.botId === b.id) ?? initialMember(b)
      )
      if (roster.length !== members.length || roster.some((m, i) => m !== members[i])) {
        stopRoom(room.id)
        members = roster
      }
    }
    const res = reconcileRoomMemberList(members, bots, accounts)
    if (!res.changed && members === room.members) return room
    anyChanged = true
    if (res.members.some((m, i) => m.accountId !== members[i]!.accountId || m.agentId !== members[i]!.agentId)) {
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
const runs = new Map<string, {
  controller: AbortController
  finished: Promise<void>
  finish: () => void
  slackDestination?: SlackDestination
}>()
const activeAccounts = new Set<string>()
const roomById = (id: string) => useRooms.getState().rooms.find((r) => r.id === id)

export const roomRunFinished = (id: string) => runs.get(id)?.finished

export function roomSlackDestination(room: CollabRoom): SlackDestination | undefined {
  if (room.coordinatorId) return
  const binding = useRooms.getState().slackDestinations[room.slackParent ?? room.id]
  const active = runs.get(room.id)
  if (active) return active.slackDestination
  if (binding && room.slackChannel) return { ...binding, channel: room.slackChannel, thread: room.slackThread }
  return binding
}

function update(id: string, fn: (room: CollabRoom) => CollabRoom) {
  useRooms.setState((s) => ({ rooms: s.rooms.map((r) => (r.id === id ? fn(r) : r)) }))
}

function recordHandoff(roomId: string, post: RoomMessage, botId: string) {
  update(roomId, (room) => ({ ...room, messages: room.messages.map((message) =>
    message.id === post.id && !message.handoffBotIds?.includes(botId)
      ? { ...message, handoffBotIds: [...(message.handoffBotIds ?? []), botId] }
      : message
  ) }))
}

export function stopRoom(id: string) {
  const run = runs.get(id)
  runs.delete(id)
  run?.controller.abort()
  run?.finish()
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

export function togglePinRoom(id: string) {
  update(id, (room) => ({ ...room, pinned: !room.pinned }))
}

export function updateRoomConfig(
  id: string,
  patch: Partial<Pick<CollabRoom, 'mode' | 'limit'>>
) {
  update(id, (r) => ({
    ...r,
    ...(patch.mode && !r.coordinatorId ? { mode: patch.mode } : {}),
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
    members: r.members.map((m) => ({ ...m, ...freshRoomSession(m.platform) }))
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
  const workspace = getBridge()?.workspace
  if (workspace) {
    // The IPC handler disposes the workspace scope alongside the deleted room.
    const dispose = { op: 'dispose' } as { op: 'dispose' } & Parameters<typeof workspace.manage>[1]
    for (const rid of toRemove) {
      void workspace.manage(rid, dispose).catch((error) => console.error('[room] workspace cleanup failed', error))
    }
  }
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
    if (usedNames.has(normalizeMentionName(candidate))) {
      const handle = accounts[bot.activeAccountId]?.handle?.trim()
      if (handle && !usedNames.has(normalizeMentionName(`${rawBase} · ${handle}`))) {
        candidate = `${rawBase} · ${handle}`
      } else {
        let n = 2
        while (usedNames.has(normalizeMentionName(`${rawBase} (${n})`))) n++
        candidate = `${rawBase} (${n})`
      }
    }
    usedNames.add(normalizeMentionName(candidate))
    return {
      botId: id,
      platform: bot.platformId,
      accountId: bot.activeAccountId,
      name: candidate,
      agentId: bot.selectedAgentId,
      ...freshRoomSession(bot.platformId)
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
  if (room.coordinatorId) return { ok: false, error: '管理员调度自动同步 Bot 列表' }
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
  if (room.coordinatorId) return { ok: false, error: '管理员调度自动同步 Bot 列表' }
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

  const usedNames = new Set(room.members.map((m) => normalizeMentionName(m.name)))
  const rawBase = bot.name?.trim() || accounts[bot.activeAccountId]?.displayName?.trim() || botId
  let name = rawBase
  if (usedNames.has(normalizeMentionName(name))) {
    const handle = accounts[bot.activeAccountId]?.handle?.trim()
    if (handle && !usedNames.has(normalizeMentionName(`${rawBase} · ${handle}`))) {
      name = `${rawBase} · ${handle}`
    } else {
      let n = 2
      while (usedNames.has(normalizeMentionName(`${rawBase} (${n})`))) n++
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
    ...freshRoomSession(bot.platformId)
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
  if (source.coordinatorId || target.coordinatorId) return { ok: false, error: '管理员调度自动同步 Bot 列表' }
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
  if (target.members.some((m) => normalizeMentionName(m.name) === normalizeMentionName(member.name))) {
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
    ...freshRoomSession(member.platform)
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

/**
 * Publish the workspace over HTTP so a member that refuses the external
 * `[TOOL]` protocol can still read and write it with its own web tools.
 * Returns the prompt fragment to append, or an empty string when the portal
 * could not be started (or no workspace directory is bound).
 */
async function openWorkspacePortal(scope: string): Promise<string> {
  const bridge = getBridge()?.workspacePortal
  if (!bridge) return ''
  try {
    const state = await bridge.manage({ op: 'open', scope })
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('botark:workspace-portal-updated', { detail: { scope } }))
    }
    if (!state.running || !state.entryUrl) return ''
    return (
      `\n\n本机工作区已挂载为在线文档：${state.entryUrl}\n` +
      '需要查看、搜索或修改工作区时，用你的网页抓取工具打开这个地址，按页面上的说明操作即可。'
    )
  } catch {
    return ''
  }
}

/** A delivered turn that produced no reply: the member has the message, only the answer is missing. */
export const NO_REPLY_ERROR = '已送达，但没有收到回复'

/** A failed turn, and whether the member's platform had already taken the message. */
export class RoomTurnError extends Error {
  constructor(message: string, readonly delivered: boolean) {
    super(message)
    this.name = 'RoomTurnError'
  }
}

/** The notice posted in the room when a member did not answer: delivered-but-silent reads differently from not delivered. */
export function roomFailureNotice(name: string, delivered: boolean): string {
  return delivered ? `${name} 已收到消息，本轮还没有回复。` : `${name} 本轮未送达。`
}

async function memberReply(room: CollabRoom, member: RoomMember, trigger: RoomMessage, signal: AbortSignal) {
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
  let accepted = false
  const replies = new Map<string, string>()
  const unsubscribe = adapter.onMessage((m) => {
    if (m.conversationId === conversationId && m.accountId === member.accountId && m.text.trim())
      replies.set(m.id, m.text)
  })
  let sessionId = member.sessionId
  const hermesSessionKey = member.platform === 'hermes'
    ? member.hermesSessionKey || `${room.id}-${member.botId}` : undefined
  const cancel = () => {
    // Gemini's adapter aborts this exact room request via the supplied signal.
    if (member.platform === 'gemini') return
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
    const contextMember = member.sessionId || hermesSessionKey ? member : { ...member, cursor: 0 }
    let prompt = turnPrompt(room, contextMember, trigger)
    if (refusesRoomFrame(member.platform)) {
      const portal = await openWorkspacePortal(room.id)
      if (portal) prompt += portal
    } else {
      const hub = getBridge()?.workspace
      const workspace = hub ? await hub.manage(room.id, { op: 'status' }) : undefined
      if (workspace?.tools.length) {
        prompt +=
          '\n\nTo request one workspace tool, reply with [TOOL] followed by JSON {"name":"…","args":{…}}. A person approves each call. ' +
          'Use paths relative to the workspace directory and use "." for the workspace root. Available tools: ' +
          JSON.stringify(workspace.tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema })))
      }
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
          hermesSessionKey,
          text: prompt,
          onAccepted: () => { accepted = true },
          signal
        })
        .then(
          (res) => {
            accepted = true
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
    if (!text) throw new RoomTurnError(NO_REPLY_ERROR, true)
    return { text, sessionId: receipt.sessionId || sessionId, hermesSessionKey }
  } catch (error) {
    if (signal.aborted || error instanceof RoomTurnError) throw error
    // An adapter's 'no-reply' means the platform took the message even when onAccepted never fired.
    const delivered = accepted || (error instanceof AdapterError && error.code === 'no-reply')
    throw new RoomTurnError(error instanceof Error ? error.message : String(error), delivered)
  } finally {
    unsubscribe()
    activeAccounts.delete(lockKey)
    signal.removeEventListener('abort', cancel)
  }
}

export async function submitBrief(
  id: string,
  input: string,
  { author = 'User', messageId = createId('post'), references = [], slackDestination }: {
    author?: string
    messageId?: string
    references?: RoomReference[]
    slackDestination?: SlackDestination
  } = {}
) {
  reconcileRooms(id)
  const room = roomById(id)
  const text = input.trim() || (references.length ? '请查看随附资料。' : '')
  if (!room || !text) return
  stopRoom(id)
  setError(id)
  const controller = new AbortController()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const destination = slackDestination ?? roomSlackDestination(room)
  const run = { controller, finished, finish, slackDestination: destination }
  const signal = controller.signal
  runs.set(id, run)
  const message: RoomMessage = {
    id: messageId, author, text, createdAt: Date.now(),
    ...(references.length ? { references } : {})
  }
  try {
    update(id, (r) => ({ ...r, brief: text, finalId: undefined, messages: [...r.messages, message] }))
    const coordinator = room.members.find((m) => m.botId === room.coordinatorId)
    const initial = coordinator ? [coordinator] : mentions(text, room.members)
    if (!initial.length && room.mode === 'auto') {
      const { accounts } = useBotStore.getState()
      const first = room.members.find((member) => {
        const status = adapterRegistry.get(member.platform)?.getStatus(member.accountId)
        return status === 'online' || status === 'attention'
      }) ?? room.members.find((member) => isConnectedStatus(accounts[member.accountId]?.status))
        ?? room.members[0]
      if (first) initial.push(first)
    }
    const queue: Array<{ member: RoomMember; trigger: RoomMessage; handoff?: RoomMessage }> =
      initial.map((member) => ({ member, trigger: message }))
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
    const failed = new Set<string>()
    const toolRecovery = new Set<string>()
    const isQueued = (botId: string) => queue.some(({ member }) => member.botId === botId)
    for (let turn = 0; queue.length; turn++) {
      const pendingKey = JSON.stringify([id, turnLockKey(queue[0]!.member)])
      const previous = pendingTurns.get(pendingKey)
      if (previous) await previous.catch(() => {})
      signal.throwIfAborted()
      const current = roomById(id)
      if (!current) break
      if (turn >= current.limit) {
        setError(id, `已达 ${current.limit} 轮上限，待回复：${queue.map(({ member }) => '@' + member.name).join('、')}`)
        break
      }
      const next = queue.shift()!
      const member = current.members.find((m) => m.botId === next.member.botId)
      if (!member) continue
      const isCoordinator = member.botId === coordinator?.botId
      if (next.handoff) recordHandoff(id, next.handoff, member.botId)
      useRooms.setState((s) => ({
        speakers: { ...s.speakers, [id]: member.name },
        turnProgress: { ...s.turnProgress, [id]: { turn: turn + 1, limit: current.limit } }
      }))
      const pending = memberReply(current, member, next.trigger, signal)
      pendingTurns.set(pendingKey, pending)
      let reply: Awaited<typeof pending>
      try {
        reply = await pending
      } catch (error) {
        signal.throwIfAborted()
        if (isCoordinator) throw error
        failed.add(member.botId)
        const detail = error instanceof Error ? error.message : String(error)
        const delivered = error instanceof RoomTurnError && error.delivered
        setError(id, `@${member.name}：${delivered && detail !== NO_REPLY_ERROR ? `已送达，但没有回复（${detail}）` : detail}`)
        const notice: RoomMessage = {
          id: createId('post'), author: 'BotArk', notice: true,
          text: roomFailureNotice(member.name, delivered), createdAt: Date.now()
        }
        update(id, (r) => ({ ...r, messages: [...r.messages, notice] }))
        if (coordinator && !isQueued(coordinator.botId)) queue.push({ member: coordinator, trigger: notice })
        continue
      } finally {
        if (pendingTurns.get(pendingKey) === pending) pendingTurns.delete(pendingKey)
      }
      signal.throwIfAborted()
      const latest = roomById(id)
      if (!latest) break
      // Use the roster from the prompt to resolve names, then deliver by current bot ID.
      const classified = classifyRoomReply(reply.text, member.botId, current.members, latest)
      const currentMembers = new Map(latest.members.map((m) => [m.botId, m]))
      const targets = classified.kind === 'post' ? classified.botIds : []
      const done = classified.kind === 'final'
      const toolRequest = classified.kind === 'tool'
      const post: RoomMessage = {
        id: createId('post'),
        author: member.name,
        authorBotId: member.botId,
        ...(done ? { final: true } : {}),
        ...(toolRequest ? { localOnly: true } : {}),
        text: classified.text,
        createdAt: Date.now()
      }
      const appendPost = Boolean(post.text || targets.length)
      const cursor = reply.sessionId || reply.hermesSessionKey ? latest.messages.length + Number(appendPost) : 0
      const storedMember = currentMembers.get(member.botId)
      const members = storedMember && (storedMember.cursor !== cursor || storedMember.sessionId !== reply.sessionId ||
        storedMember.hermesSessionKey !== reply.hermesSessionKey)
        ? latest.members.map((m) => m === storedMember ? {
          ...m, cursor, sessionId: reply.sessionId, hermesSessionKey: reply.hermesSessionKey
        } : m)
        : latest.members
      update(id, (r) => ({
        ...r,
        finalId: done ? post.id : undefined,
        messages: appendPost ? [...r.messages, post] : r.messages,
        members
      }))
      if (done) break
      if (toolRequest) {
        let resultText: string
        let toolFailed = false
        let requestedToolName: string | undefined
        try {
          signal.throwIfAborted()
          const tool = requestedTool(post.text)
          if (!tool) throw new Error('无效的工具请求')
          requestedToolName = tool.name
          if (turn + 1 >= latest.limit) {
            setError(id, `已达 ${latest.limit} 轮上限，工具 ${tool.name} 尚未执行。`)
            break
          }
          const bridge = getBridge()?.workspace
          if (!bridge) throw new Error('工作区不可用')
          const recipient = roomRecipient(latest, destination ? `Slack ${destination.channel}` : undefined)
          resultText = await bridge.run(id, tool.name, tool.args, recipient)
        } catch (error) {
          signal.throwIfAborted()
          const toolError = `工具请求失败：${error instanceof Error ? error.message : String(error)}`
          resultText = destination && requestedToolName ? '工具请求失败。请使用已有信息继续。' : toolError
          toolFailed = true
          setError(id, `@${member.name}：${toolError}`)
        }
        signal.throwIfAborted()
        const result: RoomMessage = {
          id: createId('post'), author: 'Tool', text: resultText, createdAt: Date.now(),
          ...(toolFailed ? { localOnly: true } : {}),
          ...(!toolFailed && requestedToolName ? { references: [{ label: 'Requested tool', text: requestedToolName }] } : {})
        }
        update(id, (r) => ({
          ...r,
          messages: [...r.messages, result]
        }))
        if (!toolFailed) {
          queue.unshift({ member, trigger: result })
        } else if (coordinator && !isCoordinator) {
          if (!isQueued(coordinator.botId)) queue.push({ member: coordinator, trigger: result })
        } else if (!queue.length && turn + 1 < latest.limit && !toolRecovery.has(member.botId)) {
          toolRecovery.add(member.botId)
          queue.push({ member, trigger: result })
        }
        continue
      }
      for (const botId of targets) {
        const target = currentMembers.get(botId)
        if (!target || botId === member.botId || failed.has(botId)) continue
        const queued = queue.find(({ member }) => member.botId === botId)
        if (queued) {
          queued.trigger = post
          queued.handoff = post
        } else {
          queue.push({ member: target, trigger: post, handoff: post })
        }
      }
    }
  } catch (e) {
    if (!signal.aborted) setError(id, e instanceof Error ? e.message : String(e))
  } finally {
    if (runs.get(id) === run) {
      runs.delete(id)
      useRooms.setState((s) => ({
        speakers: { ...s.speakers, [id]: undefined },
        turnProgress: { ...s.turnProgress, [id]: undefined }
      }))
    }
    finish()
  }
}
