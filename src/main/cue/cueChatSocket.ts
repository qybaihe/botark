/**
 * Native Cue by Manus (`wss://api.manus.im/socket.io/`) Engine.IO v4 / Socket.IO v4
 * WebSocket client for real-time Cue Agent chat and streaming updates.
 */
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { createProxyAgent } from '../muse/accountProxy'
import { CUE_CONNECT_BASE, CUE_ORIGIN, loadCueTokens } from './cueAuth'
import { getOrCreateCueDeviceId } from './cueDeviceId'
import { emitCueWatchEvent } from './cueWatchManager'

export interface CueNativeReplyResult {
  sessionId: string
  messageId: string
  reply?: {
    id: string
    text: string
  }
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

interface ManagedCueSocket {
  ws: WebSocket
  token: string
  wsUrl: string
  ready: Promise<void>
  joinedSessions: Set<string>
  listeners: Set<(packet: ParsedSocketIoPacket) => void>
}

const sockets = new Map<string, ManagedCueSocket>()

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
    clientVersion: '1.0.6',
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

export function stopCueChatSocket(accountId: string): void {
  if (accountId === '*') {
    for (const [id, entry] of sockets) {
      sockets.delete(id)
      try {
        entry.ws.close()
      } catch {
        /* ignore */
      }
    }
    return
  }
  const entry = sockets.get(accountId)
  if (!entry) return
  sockets.delete(accountId)
  try {
    entry.ws.close()
  } catch {
    /* ignore */
  }
}

async function ensureConnectedSocket(
  accountId: string,
  opts?: { wsBaseUrl?: string; timeoutMs?: number }
): Promise<ManagedCueSocket> {
  const auth = await loadCueTokens(accountId)
  const token = auth?.accessToken?.trim()
  if (!token) {
    throw new Error('未登录 Cue，请先完成登录后再发送消息')
  }

  const deviceId = auth?.deviceId || getOrCreateCueDeviceId(accountId)
  const wsUrl = buildCueSocketUrl({
    baseUrl: opts?.wsBaseUrl || auth?.baseUrl,
    deviceId
  })

  const existing = sockets.get(accountId)
  if (
    existing &&
    existing.token === token &&
    existing.wsUrl === wsUrl &&
    (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)
  ) {
    await existing.ready
    if (existing.ws.readyState === WebSocket.OPEN) {
      return existing
    }
  } else if (existing) {
    stopCueChatSocket(accountId)
  }

  const agent = await createProxyAgent(accountId)
  const listeners = new Set<(packet: ParsedSocketIoPacket) => void>()
  const joinedSessions = new Set<string>()
  let connectSettled = false
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const ws = new WebSocket(wsUrl, {
    headers: {
      Origin: CUE_ORIGIN,
      Authorization: `Bearer ${token}`,
      Cookie: `cue_session_id=${token}; session_id=${token}`,
      'x-product-name': 'manus-agents',
      'x-client-type': 'desktop',
      'x-client-version': '1.0.6',
      'x-client-id': deviceId
    },
    ...(agent ? { agent } : {})
  })

  const managed: ManagedCueSocket = {
    ws,
    token,
    wsUrl,
    ready,
    joinedSessions,
    listeners
  }
  sockets.set(accountId, managed)

  const connectTimer = setTimeout(() => {
    if (connectSettled) return
    connectSettled = true
    stopCueChatSocket(accountId)
    rejectReady(new Error('Cue 实时 WebSocket 连接超时'))
  }, Math.min(15_000, opts?.timeoutMs ?? 15_000))

  const finishConnect = (err?: Error) => {
    if (connectSettled) return
    connectSettled = true
    clearTimeout(connectTimer)
    if (err) rejectReady(err)
    else resolveReady()
  }

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8')
    const packet = parseSocketIoPacket(raw)
    if (packet.kind === 'ping') {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send('3')
      } catch {
        /* ignore */
      }
      return
    }
    if (packet.kind === 'open') {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`40${JSON.stringify({ token })}`)
        }
      } catch (err) {
        finishConnect(err instanceof Error ? err : new Error(String(err)))
      }
      return
    }
    if (packet.kind === 'connect') {
      finishConnect()
      return
    }
    if (packet.kind === 'connect_error' || packet.kind === 'disconnect') {
      const rec = packet.kind === 'connect_error' ? asRecord(packet.payload) : null
      const msg = nonEmptyString(rec?.['message']) || 'Cue 实时连接鉴权失败'
      finishConnect(new Error(msg))
      if (sockets.get(accountId) === managed) {
        stopCueChatSocket(accountId)
      }
      return
    }
    for (const listener of listeners) {
      try {
        listener(packet)
      } catch {
        /* isolate per-turn listener errors */
      }
    }
  })

  ws.on('error', (err) => {
    finishConnect(err instanceof Error ? err : new Error(String(err)))
  })

  ws.on('close', () => {
    if (sockets.get(accountId) === managed) {
      sockets.delete(accountId)
    }
    finishConnect(new Error('Cue 实时连接已关闭'))
  })

  await ready
  return managed
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

export async function sendCueNativeMessage(opts: {
  accountId: string
  sessionId: string
  agentId?: string
  conversationId?: string
  text: string
  wsBaseUrl?: string
  timeoutMs?: number
  settleIdleMs?: number
}): Promise<CueNativeReplyResult> {
  const { accountId, sessionId, agentId, conversationId, text } = opts
  const timeoutMs = opts.timeoutMs ?? 120_000
  const settleIdleMs = opts.settleIdleMs ?? 4_000
  const managed = await ensureConnectedSocket(accountId, {
    wsBaseUrl: opts.wsBaseUrl,
    timeoutMs: Math.min(15_000, timeoutMs)
  })

  const msgId = createCueEventId()
  const sentAtMs = Date.now()
  const deltaBuffers = new Map<string, string>()
  let latestReplyId: string | undefined
  let latestReplyText = ''
  let turnAccepted = false
  let seenRunning = false
  let settled = false
  let turnTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  return await new Promise<CueNativeReplyResult>((resolve, reject) => {
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }

    const cleanup = () => {
      if (turnTimer) clearTimeout(turnTimer)
      clearIdle()
      managed.listeners.delete(onPacket)
      managed.ws.off('close', onSocketClosed)
    }

    const settleOk = () => {
      if (settled) return
      settled = true
      cleanup()
      emitCueWatchEvent({
        type: 'activity',
        accountId,
        sessionId,
        agentId,
        busy: false,
        activityCode: 'idle'
      })
      const replyId = latestReplyId || msgId
      resolve({
        sessionId,
        messageId: replyId,
        ...(latestReplyText ? { reply: { id: replyId, text: latestReplyText } } : {})
      })
    }

    const settleErr = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      emitCueWatchEvent({
        type: 'activity',
        accountId,
        sessionId,
        agentId,
        busy: false,
        activityCode: 'idle'
      })
      reject(err)
    }

    const armIdleSettle = () => {
      clearIdle()
      if (seenRunning || !latestReplyText) return
      idleTimer = setTimeout(() => {
        settleOk()
      }, settleIdleMs)
    }

    const onSocketClosed = () => {
      if (latestReplyText) {
        settleOk()
      } else {
        settleErr(new Error('Cue 实时连接在等待回复时断开'))
      }
    }

    const onPacket = (packet: ParsedSocketIoPacket) => {
      if (settled || packet.kind !== 'event' || packet.eventName !== 'message') return
      const payload = asRecord(packet.payload)
      if (!payload) return
      const payloadSessionId = nonEmptyString(payload['sessionId'])
      if (payloadSessionId && payloadSessionId !== sessionId) return

      const payloadType = nonEmptyString(payload['type'])
      if (payloadType === 'agent_error' || payloadType === 'error') {
        const msg = nonEmptyString(payload['message'] ?? payload['error']) || 'Cue Agent 执行失败'
        settleErr(new Error(msg))
        return
      }
      if (payloadType !== 'event') return

      const ev = asRecord(payload['event'])
      if (!ev) return
      const evType = nonEmptyString(ev['type'])

      if (evType === 'chat' && nonEmptyString(ev['sender']) === 'user' && nonEmptyString(ev['id']) === msgId) {
        turnAccepted = true
        return
      }

      if (evType === 'chatDelta' && nonEmptyString(ev['sender']) === 'assistant') {
        turnAccepted = true
        const targetId = nonEmptyString(ev['targetEventId']) || latestReplyId || createCueEventId()
        const deltaObj = asRecord(ev['delta'])
        const chunk =
          typeof deltaObj?.['content'] === 'string'
            ? deltaObj['content']
            : typeof ev['content'] === 'string'
              ? ev['content']
              : ''
        if (!chunk) return
        const accumulated = (deltaBuffers.get(targetId) ?? '') + chunk
        deltaBuffers.set(targetId, accumulated)
        latestReplyId = targetId
        latestReplyText = accumulated
        emitCueWatchEvent({
          type: 'stream',
          accountId,
          sessionId,
          conversationId,
          messageId: targetId,
          text: accumulated,
          done: false
        })
        armIdleSettle()
        return
      }

      if (evType === 'chat' && nonEmptyString(ev['sender']) === 'assistant') {
        const evTs = toOptionalEpochMs(ev['timestamp'] ?? ev['createdAt'] ?? ev['created_at'])
        if (!turnAccepted && !seenRunning && evTs !== null && evTs < sentAtMs - 5_000) {
          return
        }
        const id = nonEmptyString(ev['id']) || latestReplyId || createCueEventId()
        const fullText = readAssistantEventText(ev)
        if (fullText) {
          latestReplyId = id
          if (fullText.length >= latestReplyText.length) {
            latestReplyText = fullText
            deltaBuffers.set(id, fullText)
          }
          emitCueWatchEvent({
            type: 'stream',
            accountId,
            sessionId,
            conversationId,
            messageId: id,
            text: latestReplyText,
            done: false
          })
          armIdleSettle()
        }
        return
      }

      if (evType === 'liveStatus' || evType === 'toolUsed') {
        turnAccepted = true
        clearIdle()
        const activityText =
          nonEmptyString(ev['title']) ||
          nonEmptyString(ev['toolName']) ||
          nonEmptyString(ev['status']) ||
          '正在执行…'
        emitCueWatchEvent({
          type: 'activity',
          accountId,
          sessionId,
          agentId,
          busy: true,
          activityCode: evType,
          activityText
        })
        return
      }

      if (evType === 'statusUpdate') {
        const agentStatus = nonEmptyString(ev['agentStatus'] ?? ev['status'])?.toLowerCase()
        if (agentStatus === 'running') {
          seenRunning = true
          turnAccepted = true
          clearIdle()
          emitCueWatchEvent({
            type: 'activity',
            accountId,
            sessionId,
            agentId,
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
          if (!seenRunning && !latestReplyText) {
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

    managed.listeners.add(onPacket)
    managed.ws.once('close', onSocketClosed)

    turnTimer = setTimeout(() => {
      if (latestReplyText) settleOk()
      else settleErr(new Error('等待 Cue 回复超时'))
    }, timeoutMs)

    try {
      if (!managed.joinedSessions.has(sessionId)) {
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

      managed.ws.send(
        encodeSocketIoEvent('message', {
          id: msgId,
          timestamp: Date.now(),
          type: 'user_message',
          sessionId,
          messageType: 'text',
          taskMode: 'standard',
          content: text,
          attachments: [],
          deliveryMode: 'interrupt'
        })
      )
    } catch (err) {
      settleErr(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
