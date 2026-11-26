/**
 * Native Cue by Manus (`wss://api.manus.im/socket.io/`) Engine.IO v4 / Socket.IO v4
 * WebSocket client for real-time Cue Agent chat, streaming updates, turn cancellation,
 * attachment upload forwarding, and persistent background session watching.
 */
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import type { CueAttachmentPayload } from '@shared/ipc'
import { createProxyAgent } from '../muse/accountProxy'
import { CUE_CONNECT_BASE, CUE_ORIGIN, getCueCredentialRevision, loadCueTokens } from './cueAuth'
import { getOrCreateCueDeviceId } from './cueDeviceId'
import {
  CUE_CLIENT_VERSION,
  extractCueEventMedia,
  mapCueToolEvent,
  mergeCueMediaLists,
  type CueMediaPart,
  type CueToolCall
} from './cueEventParsers'
import { emitCueWatchEvent } from './cueWatchManager'

export interface CueNativeReplyEntry {
  id: string
  text: string
  tools?: CueToolCall[]
  media?: CueMediaPart[]
}

export interface CueNativeReplyResult {
  sessionId: string
  messageId: string
  reply?: CueNativeReplyEntry
  replies?: CueNativeReplyEntry[]
}

export interface CueUploadedAttachment {
  file_id: string
  filename: string
  mime_type?: string
  size?: number
  file_url?: string
}

export type ParsedSocketIoPacket =
  | { kind: 'open'; payload: unknown }
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'connect'; payload: unknown }
  | { kind: 'disconnect' }
  | { kind: 'connect_error'; payload: unknown }
  | { kind: 'event'; eventName: string; payload: unknown }
  | { kind: 'other'; raw: string }

interface ConnectedCueSocket {
  ws: WebSocket
  close: (error: Error) => void
  joinedSessions: Set<string>
  listeners: Set<(packet: ParsedSocketIoPacket) => void>
  closeListeners: Set<(error: Error) => void>
  completedMessages: Set<string>
  watchAttached?: boolean
}

interface SocketAttempt {
  token: string
  wsUrl: string
  ready: Promise<ConnectedCueSocket>
  close: (error: Error) => void
}

interface ActiveCueTurn {
  accountId: string
  sessionId: string
  requestId?: string
  cancel: (reason?: string) => void
}

interface UnsolicitedTurnBuffer {
  messageId?: string
  text: string
  tools: Map<string, CueToolCall>
  media: CueMediaPart[]
  seenRunning: boolean
}

interface BackgroundWatchState {
  accountId: string
  wsBaseUrl?: string
  revision: symbol
  credentials: symbol
  sessions: Map<string, { agentId?: string; watchedSinceMs: number }>
  buffers: Map<string, UnsolicitedTurnBuffer>
  reconnectAttempt: number
  reconnectTimer?: ReturnType<typeof setTimeout>
  connecting?: boolean
}

const sockets = new Map<string, SocketAttempt>()
const sessionSends = new Map<string, Promise<unknown>>()
const activeTurns = new Map<string, Set<ActiveCueTurn>>()
const backgroundWatches = new Map<string, BackgroundWatchState>()
const socketRevisions = new Map<string, symbol>()
let defaultSocketRevision = Symbol()
const socketRevision = (accountId: string) => socketRevisions.get(accountId) ?? defaultSocketRevision

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const CUE_EVENT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Generates a 22-character alphanumeric ID matching Cue/Manus schema (`^[A-Za-z0-9]{22}$`). */
export function createCueEventId(): string {
  const bytes = randomBytes(22)
  let out = ''
  for (let i = 0; i < 22; i += 1) {
    out += CUE_EVENT_ID_ALPHABET[bytes[i]! % CUE_EVENT_ID_ALPHABET.length]!
  }
  return out
}

function toOptionalEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value.trim())
    if (Number.isFinite(num)) {
      return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function buildCueSocketUrl(opts: {
  baseUrl?: string
  deviceId: string
  locale?: string
  tz?: string
}): string {
  const rawBase = (opts.baseUrl || CUE_CONNECT_BASE).replace(/\/+$/, '')
  const parsed = new URL(rawBase)
  const wsProto = parsed.protocol === 'http:' ? 'ws:' : 'wss:'
  const params = new URLSearchParams({
    EIO: '4',
    transport: 'websocket',
    locale: opts.locale || 'zh-CN',
    tz: opts.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    clientType: 'desktop',
    clientVersion: CUE_CLIENT_VERSION,
    'x-product-name': 'manus-agents',
    deviceId: opts.deviceId
  })
  return `${wsProto}//${parsed.host}/socket.io/?${params.toString()}`
}

export function encodeSocketIoEvent(eventName: string, payload: unknown): string {
  return `42${JSON.stringify([eventName, payload])}`
}

function safeJsonParse(raw: string): unknown {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseSocketIoPacket(raw: string): ParsedSocketIoPacket {
  if (!raw) return { kind: 'other', raw }
  if (raw === '2' || raw.startsWith('2')) {
    return { kind: 'ping' }
  }
  if (raw === '3') {
    return { kind: 'pong' }
  }
  if (raw.startsWith('0')) {
    return { kind: 'open', payload: safeJsonParse(raw.slice(1)) }
  }
  if (raw.startsWith('40')) {
    return { kind: 'connect', payload: safeJsonParse(raw.slice(2)) }
  }
  if (raw.startsWith('41')) {
    return { kind: 'disconnect' }
  }
  if (raw.startsWith('44')) {
    return { kind: 'connect_error', payload: safeJsonParse(raw.slice(2)) }
  }
  if (raw.startsWith('42')) {
    const arrStart = raw.indexOf('[', 2)
    if (arrStart >= 2) {
      const parsed = safeJsonParse(raw.slice(arrStart))
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
        return { kind: 'event', eventName: parsed[0], payload: parsed[1] }
      }
    }
  }
  return { kind: 'other', raw }
}

function clearBackgroundWatch(accountId: string): void {
  if (accountId === '*') {
    for (const watch of backgroundWatches.values()) {
      if (watch.reconnectTimer) clearTimeout(watch.reconnectTimer)
      watch.sessions.clear()
      watch.buffers.clear()
    }
    backgroundWatches.clear()
    return
  }
  const watch = backgroundWatches.get(accountId)
  if (!watch) return
  if (watch.reconnectTimer) clearTimeout(watch.reconnectTimer)
  watch.sessions.clear()
  watch.buffers.clear()
  backgroundWatches.delete(accountId)
}

function registerActiveTurn(turn: ActiveCueTurn): () => void {
  let set = activeTurns.get(turn.accountId)
  if (!set) {
    set = new Set()
    activeTurns.set(turn.accountId, set)
  }
  set.add(turn)
  return () => {
    const current = activeTurns.get(turn.accountId)
    if (!current) return
    current.delete(turn)
    if (current.size === 0) activeTurns.delete(turn.accountId)
  }
}

function hasActiveTurnForSession(accountId: string, sessionId: string): boolean {
  const set = activeTurns.get(accountId)
  if (!set) return false
  for (const turn of set) {
    if (turn.sessionId === sessionId) return true
  }
  return false
}

/**
 * Immediately cancel any active native Cue turn(s) for an account (optionally
 * filtered by `sessionId` or `requestId`) without tearing down the shared socket.
 */
export function cancelCueNativeTurn(opts: {
  accountId: string
  sessionId?: string
  requestId?: string
}): { cancelledCount: number; sessionIds: string[] } {
  const set = activeTurns.get(opts.accountId)
  if (!set || set.size === 0) return { cancelledCount: 0, sessionIds: [] }
  const sessionIds = new Set<string>()
  let cancelledCount = 0
  for (const turn of [...set]) {
    if (opts.requestId && turn.requestId !== opts.requestId) continue
    if (opts.sessionId && turn.sessionId !== opts.sessionId) continue
    sessionIds.add(turn.sessionId)
    turn.cancel('Cue 运行已停止')
    cancelledCount += 1
  }
  return { cancelledCount, sessionIds: [...sessionIds] }
}

export function stopCueChatSocket(accountId: string): void {
  clearBackgroundWatch(accountId)
  if (accountId === '*') {
    socketRevisions.clear()
    defaultSocketRevision = Symbol()
    for (const set of activeTurns.values()) {
      for (const turn of [...set]) turn.cancel('Cue 实时连接已关闭')
    }
    activeTurns.clear()
    for (const entry of sockets.values()) entry.close(new Error('Cue 实时连接已关闭'))
    return
  }
  socketRevisions.set(accountId, Symbol())
  const set = activeTurns.get(accountId)
  if (set) {
    for (const turn of [...set]) turn.cancel('Cue 实时连接已关闭')
    activeTurns.delete(accountId)
  }
  sockets.get(accountId)?.close(new Error('Cue 实时连接已关闭'))
}

function recordCompletedMessage(managed: ConnectedCueSocket, id: string): void {
  managed.completedMessages.add(id)
  while (managed.completedMessages.size > 1_000) {
    managed.completedMessages.delete(managed.completedMessages.values().next().value!)
  }
}

function joinSessionIfNeeded(managed: ConnectedCueSocket, sessionId: string): void {
  if (managed.joinedSessions.has(sessionId) || managed.ws.readyState !== WebSocket.OPEN) return
  managed.ws.send(
    encodeSocketIoEvent('message', {
      id: createCueEventId(),
      timestamp: Date.now(),
      type: 'join_session',
      sessionId,
      lastMessageId: 'new_session',
      version: 2
    })
  )
  managed.joinedSessions.add(sessionId)
}

function attachUnsolicitedWatchToSocket(accountId: string, managed: ConnectedCueSocket): void {
  if (managed.watchAttached) return
  managed.watchAttached = true

  const getWatch = () => backgroundWatches.get(accountId)

  const getOrCreateBuffer = (watch: BackgroundWatchState, sessionId: string): UnsolicitedTurnBuffer => {
    let buf = watch.buffers.get(sessionId)
    if (!buf) {
      buf = { text: '', tools: new Map(), media: [], seenRunning: false }
      watch.buffers.set(sessionId, buf)
    }
    return buf
  }

  const flushBuffer = (
    watch: BackgroundWatchState,
    sessionId: string,
    agentId: string | undefined,
    override?: { id?: string; text?: string; media?: CueMediaPart[] }
  ) => {
    const buf = watch.buffers.get(sessionId)
    const id = override?.id ?? buf?.messageId
    const text = override?.text ?? buf?.text ?? ''
    const media = override?.media?.length
      ? mergeCueMediaLists(buf?.media ?? [], override.media)
      : (buf?.media ?? [])
    const tools = buf
      ? [...buf.tools.values()].map((tool) =>
          tool.status === 'running' ? { ...tool, status: 'completed' as const } : tool
        )
      : []
    watch.buffers.delete(sessionId)
    if (id && (text || media.length > 0)) {
      recordCompletedMessage(managed, id)
      emitCueWatchEvent({
        type: 'stream',
        accountId,
        sessionId,
        agentId,
        messageId: id,
        text,
        done: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(media.length > 0 ? { media } : {})
      })
    }
  }

  const onPacket = (packet: ParsedSocketIoPacket) => {
    const watch = getWatch()
    if (!watch || packet.kind !== 'event' || packet.eventName !== 'message') return
    const payload = asRecord(packet.payload)
    if (!payload || nonEmptyString(payload['type']) !== 'event') return
    const ev = asRecord(payload['event'])
    if (!ev) return
    const sessionId = nonEmptyString(
      payload['sessionId'] ?? payload['session_id'] ?? ev['sessionId'] ?? ev['session_id']
    )
    if (!sessionId) return
    // Foreground `sendCueTurn` owns events for its active session.
    if (hasActiveTurnForSession(accountId, sessionId)) return
    const entry = watch.sessions.get(sessionId)
    if (!entry) return

    const evType = nonEmptyString(ev['type'])
    if (evType === 'chatDelta' && nonEmptyString(ev['sender']) === 'assistant') {
      const targetId = nonEmptyString(ev['targetEventId']) || watch.buffers.get(sessionId)?.messageId || createCueEventId()
      if (managed.completedMessages.has(targetId)) return
      const deltaObj = asRecord(ev['delta'])
      const chunk =
        typeof deltaObj?.['content'] === 'string'
          ? deltaObj['content']
          : typeof ev['content'] === 'string'
            ? ev['content']
            : ''
      if (!chunk) return
      const buf = getOrCreateBuffer(watch, sessionId)
      buf.messageId = targetId
      buf.text += chunk
      const toolsSnapshot = [...buf.tools.values()]
      emitCueWatchEvent({
        type: 'stream',
        accountId,
        sessionId,
        agentId: entry.agentId,
        messageId: targetId,
        text: buf.text,
        done: false,
        ...(toolsSnapshot.length > 0 ? { tools: toolsSnapshot } : {}),
        ...(buf.media.length > 0 ? { media: buf.media } : {})
      })
      return
    }

    if (evType === 'chat' && nonEmptyString(ev['sender']) === 'assistant') {
      const evTs = toOptionalEpochMs(ev['timestamp'] ?? ev['createdAt'] ?? ev['created_at'])
      if (evTs !== null && evTs < entry.watchedSinceMs - 5_000) return
      const buf = watch.buffers.get(sessionId)
      const id = nonEmptyString(ev['id']) || buf?.messageId || createCueEventId()
      if (managed.completedMessages.has(id)) return
      const fullText = readAssistantEventText(ev)
      const media = extractCueEventMedia(ev)
      if (!fullText && media.length === 0) return
      // Ignore historical replays without timestamps if we haven't seen a running signal or delta.
      if (evTs === null && !buf?.seenRunning && !buf?.messageId) return
      flushBuffer(watch, sessionId, entry.agentId, { id, text: fullText, media })
      return
    }

    if (evType === 'liveStatus' || evType === 'toolUsed') {
      const buf = getOrCreateBuffer(watch, sessionId)
      buf.seenRunning = true
      if (evType === 'toolUsed') {
        const mapped = mapCueToolEvent(ev, 'running')
        if (mapped) buf.tools.set(mapped.id, mapped)
      }
      const activityText =
        nonEmptyString(ev['title']) ||
        nonEmptyString(ev['toolName'] ?? ev['tool']) ||
        nonEmptyString(ev['status']) ||
        '正在执行…'
      emitCueWatchEvent({
        type: 'activity',
        accountId,
        sessionId,
        agentId: entry.agentId,
        busy: true,
        activityCode: evType,
        activityText
      })
      return
    }

    if (evType === 'statusUpdate') {
      const agentStatus = nonEmptyString(ev['agentStatus'] ?? ev['status'])?.toLowerCase()
      if (agentStatus === 'running') {
        const buf = getOrCreateBuffer(watch, sessionId)
        buf.seenRunning = true
        emitCueWatchEvent({
          type: 'activity',
          accountId,
          sessionId,
          agentId: entry.agentId,
          busy: true,
          activityCode: 'running',
          activityText: 'Cue 正在思考并执行…'
        })
        return
      }
      if (
        agentStatus === 'stopped' ||
        agentStatus === 'waiting' ||
        agentStatus === 'idle' ||
        agentStatus === 'completed'
      ) {
        const buf = watch.buffers.get(sessionId)
        if (!buf) return
        flushBuffer(watch, sessionId, entry.agentId)
        emitCueWatchEvent({
          type: 'activity',
          accountId,
          sessionId,
          agentId: entry.agentId,
          busy: false,
          activityCode: 'idle'
        })
      }
    }
  }

  const onClosed = (error: Error) => {
    const watch = getWatch()
    if (!watch) return
    if (
      socketRevision(accountId) !== watch.revision ||
      getCueCredentialRevision(accountId) !== watch.credentials
    ) {
      clearBackgroundWatch(accountId)
      return
    }
    if (/401|403|unauthorized|forbidden|未登录/i.test(error.message)) {
      return
    }
    scheduleBackgroundWatchReconnect(watch)
  }

  managed.listeners.add(onPacket)
  managed.closeListeners.add(onClosed)
}

function scheduleBackgroundWatchReconnect(watch: BackgroundWatchState): void {
  if (watch.reconnectTimer || backgroundWatches.get(watch.accountId) !== watch) return
  const delayMs = Math.min(30_000, 3_000 * 2 ** Math.min(watch.reconnectAttempt, 4))
  watch.reconnectAttempt += 1
  watch.reconnectTimer = setTimeout(() => {
    watch.reconnectTimer = undefined
    if (backgroundWatches.get(watch.accountId) !== watch) return
    void connectBackgroundWatch(watch)
  }, delayMs)
}

async function connectBackgroundWatch(watch: BackgroundWatchState): Promise<void> {
  if (watch.connecting || backgroundWatches.get(watch.accountId) !== watch) return
  const isCurrent = () =>
    backgroundWatches.get(watch.accountId) === watch &&
    socketRevision(watch.accountId) === watch.revision &&
    getCueCredentialRevision(watch.accountId) === watch.credentials
  if (!isCurrent() || watch.sessions.size === 0) return
  watch.connecting = true
  try {
    const managed = await ensureConnectedSocket(watch.accountId, {
      wsBaseUrl: watch.wsBaseUrl,
      timeoutMs: 15_000,
      isCurrent
    })
    if (!isCurrent() || managed.ws.readyState !== WebSocket.OPEN) return
    watch.reconnectAttempt = 0
    attachUnsolicitedWatchToSocket(watch.accountId, managed)
    for (const sessionId of watch.sessions.keys()) {
      joinSessionIfNeeded(managed, sessionId)
    }
  } catch (err) {
    if (isCurrent()) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/401|403|unauthorized|forbidden|未登录/i.test(msg)) {
        scheduleBackgroundWatchReconnect(watch)
      }
    }
  } finally {
    watch.connecting = false
  }
}

/**
 * Maintain a warm Socket.IO subscription for an account's known Cue sessions so
 * scheduled tasks and cross-device replies arrive in BotArk in real time.
 */
export async function syncCueWatchedSessions(
  accountId: string,
  sessions: ReadonlyArray<{ sessionId: string; agentId?: string }>,
  opts?: { wsBaseUrl?: string }
): Promise<void> {
  const valid = sessions.filter((item) => item.sessionId?.trim())
  if (valid.length === 0) return
  const revision = socketRevision(accountId)
  const credentials = getCueCredentialRevision(accountId)
  let watch = backgroundWatches.get(accountId)
  if (!watch || watch.revision !== revision || watch.credentials !== credentials) {
    clearBackgroundWatch(accountId)
    watch = {
      accountId,
      wsBaseUrl: opts?.wsBaseUrl,
      revision,
      credentials,
      sessions: new Map(),
      buffers: new Map(),
      reconnectAttempt: 0
    }
    backgroundWatches.set(accountId, watch)
  } else if (opts?.wsBaseUrl) {
    watch.wsBaseUrl = opts.wsBaseUrl
  }
  const now = Date.now()
  for (const item of valid) {
    const sid = item.sessionId.trim()
    const existing = watch.sessions.get(sid)
    watch.sessions.set(sid, {
      agentId: item.agentId || existing?.agentId,
      watchedSinceMs: existing?.watchedSinceMs ?? now
    })
  }
  await connectBackgroundWatch(watch)
}

async function ensureConnectedSocket(
  accountId: string,
  opts: { wsBaseUrl?: string; timeoutMs: number; isCurrent: () => boolean }
): Promise<ConnectedCueSocket> {
  const auth = await loadCueTokens(accountId)
  if (!opts.isCurrent()) throw new Error('Cue 账号或连接已更改')
  const token = auth?.accessToken?.trim()
  if (!token) {
    throw new Error('未登录 Cue，请先完成登录后再发送消息')
  }

  const deviceId = auth?.deviceId || getOrCreateCueDeviceId(accountId)
  const wsUrl = buildCueSocketUrl({
    baseUrl: opts.wsBaseUrl || auth?.baseUrl,
    deviceId
  })

  const existing = sockets.get(accountId)
  if (existing?.token === token && existing.wsUrl === wsUrl) return existing.ready
  existing?.close(new Error('Cue 实时连接已更改'))

  let resolveReady!: (socket: ConnectedCueSocket) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<ConnectedCueSocket>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let connected: ConnectedCueSocket | undefined
  let closed = false
  let pingDeadline: ReturnType<typeof setTimeout> | undefined
  let heartbeatMs = 45_000
  const connectTimer = setTimeout(
    () => attempt.close(new Error('Cue 实时 WebSocket 连接超时')),
    Math.min(15_000, opts.timeoutMs)
  )
  const attempt: SocketAttempt = {
    token,
    wsUrl,
    ready,
    close(error) {
      if (closed) return
      closed = true
      if (sockets.get(accountId) === attempt) sockets.delete(accountId)
      clearTimeout(connectTimer)
      clearTimeout(pingDeadline)
      rejectReady(error)
      for (const listener of connected?.closeListeners ?? []) listener(error)
      connected?.ws.terminate()
    }
  }
  sockets.set(accountId, attempt)
  const armHeartbeat = () => {
    clearTimeout(pingDeadline)
    pingDeadline = setTimeout(() => attempt.close(new Error('Cue 实时连接心跳超时')), heartbeatMs)
  }

  void (async () => {
    const agent = await createProxyAgent(accountId)
    if (closed || sockets.get(accountId) !== attempt) return
    if (!opts.isCurrent()) {
      attempt.close(new Error('Cue 账号或连接已更改'))
      return
    }
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: CUE_ORIGIN,
        Authorization: `Bearer ${token}`,
        Cookie: `cue_session_id=${token}; session_id=${token}`,
        'x-product-name': 'manus-agents',
        'x-client-type': 'desktop',
        'x-client-version': CUE_CLIENT_VERSION,
        'x-client-id': deviceId
      },
      ...(agent ? { agent } : {})
    })
    const managed: ConnectedCueSocket = {
      ws,
      close: attempt.close,
      joinedSessions: new Set(),
      listeners: new Set(),
      closeListeners: new Set(),
      completedMessages: new Set()
    }
    connected = managed
    ws.on('error', (error) => attempt.close(error))
    ws.on('close', () => attempt.close(new Error('Cue 实时连接已关闭')))
    ws.on('message', (data) => {
      if (closed) return
      const packet = parseSocketIoPacket(data.toString())
      try {
        if (packet.kind === 'ping') {
          armHeartbeat()
          ws.send('3')
          return
        }
        if (packet.kind === 'open') {
          const params = asRecord(packet.payload)
          const interval = params?.['pingInterval']
          const timeout = params?.['pingTimeout']
          if (
            typeof interval === 'number' &&
            typeof timeout === 'number' &&
            interval > 0 &&
            timeout > 0
          ) {
            heartbeatMs = Math.min(2_147_483_647, interval + timeout)
          }
          armHeartbeat()
          ws.send(`40${JSON.stringify({ token })}`)
          return
        }
        if (packet.kind === 'connect') {
          clearTimeout(connectTimer)
          resolveReady(managed)
          return
        }
        if (packet.kind === 'connect_error' || packet.kind === 'disconnect') {
          const detail = packet.kind === 'connect_error' ? asRecord(packet.payload) : null
          attempt.close(new Error(nonEmptyString(detail?.['message']) || 'Cue 实时连接已断开'))
          return
        }
        for (const listener of managed.listeners) listener(packet)
      } catch (error) {
        attempt.close(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })().catch((error: unknown) =>
    attempt.close(error instanceof Error ? error : new Error(String(error)))
  )
  return ready
}

function readAssistantEventText(ev: Record<string, unknown>): string {
  if (typeof ev['content'] === 'string' && ev['content']) {
    return ev['content']
  }
  const contents = ev['contents']
  if (Array.isArray(contents)) {
    const parts = contents
      .map((item) => {
        const part = asRecord(item)
        if (!part) return ''
        const val = part['value'] ?? part['text'] ?? part['content']
        return typeof val === 'string' ? val : ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

export interface CueNativeSendOptions {
  accountId: string
  sessionId: string
  agentId?: string
  conversationId?: string
  requestId?: string
  text: string
  attachments?: CueAttachmentPayload[]
  uploadAttachment?: (attachment: CueAttachmentPayload) => Promise<CueUploadedAttachment>
  wsBaseUrl?: string
  timeoutMs?: number
  maxTurnMs?: number
  settleIdleMs?: number
}

export async function sendCueNativeMessage(opts: CueNativeSendOptions): Promise<CueNativeReplyResult> {
  const { accountId, sessionId } = opts
  const key = JSON.stringify([accountId, sessionId])
  const revision = socketRevision(accountId)
  const credentials = getCueCredentialRevision(accountId)
  const isCurrent = () =>
    socketRevision(accountId) === revision && getCueCredentialRevision(accountId) === credentials
  const turn = (sessionSends.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => sendCueTurn(opts, isCurrent))
  sessionSends.set(key, turn)
  try {
    return await turn
  } finally {
    if (sessionSends.get(key) === turn) sessionSends.delete(key)
  }
}

async function sendCueTurn(
  opts: CueNativeSendOptions,
  isCurrent: () => boolean
): Promise<CueNativeReplyResult> {
  const { accountId, sessionId, agentId, conversationId, requestId, text } = opts
  if (!isCurrent()) throw new Error('Cue 账号或连接已更改')
  const inactivityTimeoutMs = opts.timeoutMs ?? 180_000
  const maxTurnMs = Math.max(inactivityTimeoutMs, opts.maxTurnMs ?? 10 * 60_000)
  const settleIdleMs = opts.settleIdleMs ?? 6_000

  let uploadedAttachments: CueUploadedAttachment[] = []
  if (opts.attachments?.length) {
    const uploader = opts.uploadAttachment
    if (!uploader) {
      throw new Error('当前环境不支持 Cue 附件上传，请在内置网页中发送附件')
    }
    uploadedAttachments = []
    for (const att of opts.attachments) {
      if (!isCurrent()) throw new Error('Cue 账号或连接已更改')
      uploadedAttachments.push(await uploader(att))
    }
  }

  const managed = await ensureConnectedSocket(accountId, {
    wsBaseUrl: opts.wsBaseUrl,
    timeoutMs: Math.min(15_000, inactivityTimeoutMs),
    isCurrent
  })
  if (!isCurrent() || managed.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Cue 实时连接已关闭')
  }

  const msgId = createCueEventId()
  const sentAtMs = Date.now()
  const messages = new Map<
    string,
    { text: string; final: boolean; tools: Map<string, CueToolCall>; media: CueMediaPart[] }
  >()
  const turnTools = new Map<string, CueToolCall>()
  let latestReplyId: string | undefined
  let seenUserEcho = false
  let seenRunning = false
  let settled = false
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let hardCapTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  return await new Promise<CueNativeReplyResult>((resolve, reject) => {
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    let unregisterTurn: (() => void) | undefined

    const cleanup = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      if (hardCapTimer) clearTimeout(hardCapTimer)
      clearIdle()
      unregisterTurn?.()
      managed.listeners.delete(onPacket)
      managed.closeListeners.delete(onSocketClosed)
      for (const id of messages.keys()) recordCompletedMessage(managed, id)
    }

    const activity = (busy: boolean, activityCode: string, activityText?: string) =>
      emitCueWatchEvent({
        type: 'activity',
        accountId,
        sessionId,
        agentId,
        requestId,
        busy,
        activityCode,
        activityText
      })

    const buildReplies = (markToolsDone: boolean): CueNativeReplyEntry[] => {
      const entries = Array.from(messages, ([id, entry]) => {
        const toolsArr = [...entry.tools.values()].map((tool) =>
          markToolsDone && tool.status === 'running' ? { ...tool, status: 'completed' as const } : tool
        )
        return {
          id,
          text: entry.text,
          ...(toolsArr.length > 0 ? { tools: toolsArr } : {}),
          ...(entry.media.length > 0 ? { media: entry.media } : {})
        }
      })
      // If tools ran in this turn and no message captured them individually, attach to the last reply.
      if (entries.length > 0 && turnTools.size > 0 && !entries.some((item) => item.tools?.length)) {
        const last = entries[entries.length - 1]!
        last.tools = [...turnTools.values()].map((tool) =>
          markToolsDone && tool.status === 'running' ? { ...tool, status: 'completed' as const } : tool
        )
      }
      return entries
    }

    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      activity(false, 'idle')
      const replies = buildReplies(true)
      const reply = replies.at(-1)
      resolve({
        sessionId,
        messageId: reply?.id ?? msgId,
        ...(reply && (reply.text || reply.media?.length) ? { reply } : {}),
        ...(replies.length > 1 || (reply && !reply.text && !reply.media?.length) ? { replies } : {})
      })
    }

    const settleErr = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      activity(false, 'idle')
      reject(err)
    }

    const armInactivityTimeout = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        if (messages.size) settleOk()
        else settleErr(new Error('等待 Cue 回复超时'))
      }, inactivityTimeoutMs)
    }

    const armIdleSettle = () => {
      clearIdle()
      if (seenRunning || messages.size === 0) return
      idleTimer = setTimeout(() => {
        settleOk()
      }, settleIdleMs)
    }

    const onSocketClosed = (error: Error) => settleErr(error)

    const progress = (id: string, nextText: string, final: boolean, incomingMedia: CueMediaPart[] = []) => {
      armInactivityTimeout()
      latestReplyId = id
      const prev = messages.get(id)
      const mergedTools = new Map(prev?.tools ?? turnTools)
      for (const [tid, tool] of turnTools) mergedTools.set(tid, tool)
      const mergedMedia = mergeCueMediaLists(prev?.media ?? [], incomingMedia)
      messages.set(id, { text: nextText, final, tools: mergedTools, media: mergedMedia })
      const toolsSnapshot = [...mergedTools.values()]
      emitCueWatchEvent({
        type: 'stream',
        accountId,
        sessionId,
        conversationId,
        requestId,
        messageId: id,
        text: nextText,
        done: false,
        ...(toolsSnapshot.length > 0 ? { tools: toolsSnapshot } : {}),
        ...(mergedMedia.length > 0 ? { media: mergedMedia } : {})
      })
      armIdleSettle()
    }

    const onPacket = (packet: ParsedSocketIoPacket) => {
      if (settled || packet.kind !== 'event' || packet.eventName !== 'message') return
      const payload = asRecord(packet.payload)
      if (!payload) return
      const ev = asRecord(payload['event'])
      const payloadSessionId = nonEmptyString(
        payload['sessionId'] ?? payload['session_id'] ?? ev?.['sessionId'] ?? ev?.['session_id']
      )
      const matchingEcho = ev?.['type'] === 'chat' && ev['sender'] === 'user' && ev['id'] === msgId
      if (matchingEcho && (!payloadSessionId || payloadSessionId === sessionId)) {
        if (!seenUserEcho && requestId) {
          emitCueWatchEvent({ type: 'accepted', accountId, sessionId, requestId })
        }
        seenUserEcho = true
        armInactivityTimeout()
        return
      }
      if (payloadSessionId !== sessionId) return

      const payloadType = nonEmptyString(payload['type'])
      if (payloadType === 'agent_error' || payloadType === 'error') {
        const msg = nonEmptyString(payload['message'] ?? payload['error']) || 'Cue Agent 执行失败'
        settleErr(new Error(msg))
        return
      }
      if (payloadType !== 'event') return

      if (!ev) return
      const evType = nonEmptyString(ev['type'])

      if (evType === 'chatDelta' && nonEmptyString(ev['sender']) === 'assistant') {
        const targetId = nonEmptyString(ev['targetEventId']) || latestReplyId || createCueEventId()
        const previous = messages.get(targetId)
        if (previous?.final || managed.completedMessages.has(targetId)) return
        const deltaObj = asRecord(ev['delta'])
        const chunk =
          typeof deltaObj?.['content'] === 'string'
            ? deltaObj['content']
            : typeof ev['content'] === 'string'
              ? ev['content']
              : ''
        if (!chunk) return
        progress(targetId, (previous?.text ?? '') + chunk, false)
        return
      }

      if (evType === 'chat' && nonEmptyString(ev['sender']) === 'assistant') {
        const evTs = toOptionalEpochMs(ev['timestamp'] ?? ev['createdAt'] ?? ev['created_at'])
        if (evTs !== null && evTs < sentAtMs - 5_000) return
        const id = nonEmptyString(ev['id']) || latestReplyId || createCueEventId()
        if (managed.completedMessages.has(id)) return
        const fullText = readAssistantEventText(ev)
        const media = extractCueEventMedia(ev)
        if (fullText || media.length > 0 || messages.has(id)) {
          progress(id, fullText, true, media)
        }
        return
      }

      if (evType === 'liveStatus' || evType === 'toolUsed') {
        clearIdle()
        armInactivityTimeout()
        if (evType === 'toolUsed') {
          const mapped = mapCueToolEvent(ev, 'running')
          if (mapped) {
            turnTools.set(mapped.id, mapped)
            const currentId = latestReplyId || createCueEventId()
            const existing = messages.get(currentId)
            if (existing) {
              existing.tools.set(mapped.id, mapped)
              emitCueWatchEvent({
                type: 'stream',
                accountId,
                sessionId,
                conversationId,
                requestId,
                messageId: currentId,
                text: existing.text,
                done: false,
                tools: [...existing.tools.values()],
                ...(existing.media.length > 0 ? { media: existing.media } : {})
              })
            }
          }
        }
        const activityText =
          nonEmptyString(ev['title']) ||
          nonEmptyString(ev['toolName'] ?? ev['tool']) ||
          nonEmptyString(ev['status']) ||
          '正在执行…'
        activity(true, evType, activityText)
        return
      }

      if (evType === 'statusUpdate') {
        const agentStatus = nonEmptyString(ev['agentStatus'] ?? ev['status'])?.toLowerCase()
        if (agentStatus === 'running') {
          seenRunning = true
          clearIdle()
          armInactivityTimeout()
          activity(true, 'running', 'Cue 正在思考并执行…')
          return
        }
        if (
          agentStatus === 'stopped' ||
          agentStatus === 'waiting' ||
          agentStatus === 'idle' ||
          agentStatus === 'completed'
        ) {
          if (!seenRunning && messages.size === 0) {
            return
          }
          seenRunning = false
          settleOk()
          return
        }
        if (agentStatus === 'error' || agentStatus === 'failed') {
          seenRunning = false
          const msg = nonEmptyString(ev['message']) || 'Cue Agent 执行出错'
          settleErr(new Error(msg))
        }
      }
    }

    unregisterTurn = registerActiveTurn({
      accountId,
      sessionId,
      requestId,
      cancel: (reason) => {
        const err = new Error(reason || 'Cue 运行已停止') as Error & { code?: string }
        err.code = 'cancelled'
        settleErr(err)
      }
    })

    managed.listeners.add(onPacket)
    managed.closeListeners.add(onSocketClosed)
    armInactivityTimeout()
    hardCapTimer = setTimeout(() => {
      if (messages.size) settleOk()
      else settleErr(new Error('等待 Cue 回复超时'))
    }, maxTurnMs)

    try {
      joinSessionIfNeeded(managed, sessionId)
      const wireAttachments = uploadedAttachments.map((att) => ({
        id: att.file_id,
        fileId: att.file_id,
        file_id: att.file_id,
        filename: att.filename,
        name: att.filename,
        ...(att.mime_type ? { mimeType: att.mime_type, mime_type: att.mime_type } : {}),
        ...(typeof att.size === 'number' ? { size: att.size } : {}),
        ...(att.file_url ? { url: att.file_url, file_url: att.file_url } : {})
      }))
      managed.ws.send(
        encodeSocketIoEvent('message', {
          id: msgId,
          timestamp: Date.now(),
          type: 'user_message',
          sessionId,
          messageType: wireAttachments.length > 0 && !text.trim() ? 'file' : 'text',
          taskMode: 'standard',
          content: text,
          attachments: wireAttachments,
          deliveryMode: 'interrupt'
        })
      )
    } catch (err) {
      settleErr(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
