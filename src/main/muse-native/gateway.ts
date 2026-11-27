/**
 * Native Muse gateway: Noise_XX over wss://hatch.metaaivm.com/v1/noise with
 * HTTP-over-Noise RPC, NDJSON subscriptions, heartbeat and reconnect.
 * Secrets (auth_token / notary / cookies) are never logged.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { TextDecoder } from 'node:util'
import WebSocket from 'ws'
import { MuseControlPlane, MuseControlPlaneError, type FetchFn, type GatewayCreds } from './controlPlane'
import { abortable } from './lifecycle'
import { MUSE_METHODS } from './methods'
import { NoiseXXInitiator } from './noise'
import { PbWriter, pbDecode, pbGet } from './protobuf'
import { extractStartedSessionId } from './sessions'
import { NoisePayloadTooLargeError, NoiseTransport, type InboundFrame, type ServiceName } from './transport'

const NOISE_URL = 'wss://hatch.metaaivm.com/v1/noise'
const APP_ID = 'hatch-web'
const HANDSHAKE_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

export type GatewayPhase = 'idle' | 'credentials' | 'connecting' | 'handshake' | 'ready' | 'reconnecting' | 'error'

export class MuseGatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'cvm_required'
      | 'signed_out'
      | 'handshake_failed'
      | 'closed'
      | 'timeout'
      | 'http'
      | 'payload_too_large'
      | 'reset'
      | 'unknown_method',
    readonly status?: number
  ) {
    super(message)
    this.name = 'MuseGatewayError'
  }
}

export interface SubscriptionHandle {
  /** First non-event JSON object (RPC ack). */
  ack: Promise<Record<string, unknown>>
  /** Resolves when the server ends the body, rejects on cancellation or failure. */
  done: Promise<void>
  cancel(reason?: string): void
}

interface UnaryResponse {
  status: number
  body: Uint8Array
  headers?: Array<[string, string]>
  truncated: boolean
}

interface PendingStream {
  service: ServiceName
  responseHeaders?: Array<[string, string]>
  subscription: boolean
  status?: number
  chunks: Uint8Array[]
  lineBuf: string
  decoder: TextDecoder
  ackSeen: boolean
  resolveUnary?: (v: UnaryResponse) => void
  rejectUnary?: (e: Error) => void
  maxResponseBytes?: number
  receivedBytes?: number
  truncated?: boolean
  removeAbortListener?: () => void
  onAck?: (v: Record<string, unknown>) => void
  onEvent?: (e: Record<string, unknown>) => void
  onDone?: (err?: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** RV challenge detection, mirrors muse.ai `(0,s.d)` (field1 bytes, field2 1|2, field3 32B). */
function isOwnerRvChallenge(payload: Uint8Array): boolean {
  try {
    const f = pbDecode(payload)
    const att = pbGet(f, 1)
    const state = pbGet(f, 2)
    const nonce = pbGet(f, 3)
    return (
      att?.wire === 2 &&
      state?.wire === 0 &&
      (state.int === 1n || state.int === 2n) &&
      nonce?.wire === 2 &&
      nonce.bytes?.length === 32
    )
  } catch {
    return false
  }
}

function backoffMs(attempt: number, trusted: boolean): number {
  const t = trusted ? 1 : 0
  if (attempt < 40 * t) return 1000
  const base = Math.min((t ? 1000 : 200) * Math.pow(1.5, Math.max(0, attempt - 40 * t)), 8000)
  return Math.round(base * (1 + 0.2 * Math.random()))
}

function substitutePath(path: string, params: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
  const rest = { ...params }
  const qIdx = path.indexOf('?')
  const basePath = qIdx >= 0 ? path.slice(0, qIdx) : path
  const queryTemplate = qIdx >= 0 ? path.slice(qIdx + 1) : ''

  // Official paths use `{id}` and splat `{*path}` (e.g. /fs/raw/{*path}).
  const outBase = basePath.replace(/\{\*?(\w+)\}/g, (full, k: string) => {
    const splat = full.startsWith('{*')
    const v = rest[k]
    delete rest[k]
    if (v == null) return ''
    const s = String(v).replace(/^\/+/, '')
    if (splat) {
      // Keep path separators; encode each segment.
      return s
        .split('/')
        .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
        .map((seg) => encodeURIComponent(seg))
        .join('/')
    }
    return encodeURIComponent(s)
  })

  if (!queryTemplate) return { path: outBase, rest }

  // Strip optional query params when their placeholder value is missing/null.
  const keepPairs: string[] = []
  for (const rawPair of queryTemplate.split('&')) {
    if (!rawPair) continue
    let missing = false
    const substituted = rawPair.replace(/\{(\w+)\}/g, (_m, k: string) => {
      const v = rest[k]
      delete rest[k]
      if (v == null || v === '') {
        missing = true
        return ''
      }
      return encodeURIComponent(String(v))
    })
    if (!missing) keepPairs.push(substituted)
  }
  const outQuery = keepPairs.join('&')
  return { path: outQuery ? `${outBase}?${outQuery}` : outBase, rest }
}

function toQuery(params: Record<string, unknown>, existingPath = ''): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  const s = q.toString()
  if (!s) return ''
  return existingPath.includes('?') ? `&${s}` : `?${s}`
}

/**
 * Extract canonical daemon method/path from Muse 400 validation errors such as:
 * `{"ok":false,"error":{"code":"invalid_params","message":"\`method\` must be \`/api/session/start\`"}}`
 */
export function extractRequiredMethodPath(errText: string): string | null {
  if (!errText) return null
  const m = /`method`\s+must\s+be\s+`(\/[A-Za-z0-9_./-]+)`/i.exec(errText)
  const candidate = m?.[1]?.trim()
  if (!candidate || candidate.includes('..') || candidate.startsWith('//')) return null
  return candidate
}

/**
 * Detect Muse daemon 400 validation errors indicating the endpoint requires a
 * `{ method, params }` JSON envelope, e.g.:
 * `{"ok":false,"error":{"code":"invalid_params","message":"\`params\` is required"}}`
 */
export function requiresParamsEnvelope(errText: string): boolean {
  if (!errText) return false
  return /`params`\s+(?:is\s+required|must\s+be\b)|"params"\s+is\s+required/i.test(errText)
}

/** Toggle `/api/session/*` <-> `/session/*` when a daemon returns 404 on one prefix. */
export function computeSessionPathFallback(currentBase: string): string | null {
  if (currentBase.startsWith('/api/session/')) return currentBase.slice('/api'.length)
  if (currentBase.startsWith('/session/')) return `/api${currentBase}`
  return null
}

/** Noise handshake class. Personal VM = hatch_vm; Shared Agent remote = shared_agent. */
export type MuseNoiseConnectionClass = 'hatch_vm' | 'shared_agent'

export interface MuseNativeGatewayOptions {
  fetch: FetchFn
  /** Keep the socket up (heartbeat + auto reconnect) even without in-flight calls. */
  keepAlive?: boolean
  /**
   * Noise connection class (protocol.md §3.3).
   * `shared_agent` requires `sharedAgentTicket` for Msg3 — ticket bootstrap is
   * not fully captured yet; UI must stay honest-unavailable until then.
   */
  connectionClass?: MuseNoiseConnectionClass
  /** Fresh ticket bytes for Shared Agent Msg3 (required when connectionClass=shared_agent). */
  sharedAgentTicket?: Uint8Array
  /** Optional per-account egress proxy agent for Noise WSS (Node `ws`). */
  agent?: import('node:https').Agent
  /** Refresh agent before each connect (e.g. after proxy settings change). */
  resolveAgent?: () => Promise<import('node:https').Agent | undefined>
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

export class MuseNativeGateway extends EventEmitter {
  private readonly cp: MuseControlPlane
  private ws: WebSocket | null = null
  private transport: NoiseTransport | null = null
  private connecting: Promise<void> | null = null
  private connection = new AbortController()
  private streams = new Map<bigint, PendingStream>()
  private pathOverrides = new Map<string, string>()
  private bodyMethodOverrides = new Map<string, string>()
  private bodyParamsEnvelopeOverrides = new Set<string>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private trusted = false
  private forceRefresh = false
  private closedByUser = false
  phase: GatewayPhase = 'idle'
  lastError: string | null = null

  constructor(private readonly opts: MuseNativeGatewayOptions) {
    super()
    this.cp = new MuseControlPlane(opts.fetch)
  }

  /** Hot-swap WSS proxy agent (session.setProxy is applied separately). */
  setProxyAgent(agent: import('node:https').Agent | undefined): void {
    this.opts.agent = agent
  }

  /** Update WSS proxy agent and drop any live socket so traffic immediately switches to the new proxy. */
  reconnectWithProxyAgent(agent: import('node:https').Agent | undefined): void {
    this.opts.agent = agent
    if (this.closedByUser) return
    this.forceRefresh = true
    this.disconnect(new MuseGatewayError('gateway proxy updated', 'closed'), 'reconnecting')
    if (this.opts.keepAlive) this.scheduleReconnect()
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    this.opts.log?.(msg, extra)
  }

  private setPhase(p: GatewayPhase, err?: string): void {
    this.phase = p
    if (err !== undefined) this.lastError = err
    this.emit('phase', p, this.lastError)
  }

  isReady(): boolean {
    return this.phase === 'ready' && !!this.transport && !this.transport.isDead() && this.ws?.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.closedByUser) throw new MuseGatewayError('gateway disposed', 'closed')
    if (this.isReady()) return
    if (this.connecting) return this.connecting
    this.clearReconnectTimer()
    const { signal } = this.connection
    const connecting = abortable(signal, () => this.doConnect(signal)).finally(() => {
      if (this.connecting === connecting) this.connecting = null
    })
    this.connecting = connecting
    return connecting
  }

  private async doConnect(signal: AbortSignal): Promise<void> {
    this.setPhase('credentials')
    signal.throwIfAborted()
    let creds: GatewayCreds
    let agent: import('node:https').Agent | undefined
    try {
      creds = await this.cp.credentials({ forceRefresh: this.forceRefresh, signal })
      signal.throwIfAborted()
      this.forceRefresh = false
      this.setPhase('connecting')
      signal.throwIfAborted()
      agent = this.opts.resolveAgent ? await this.opts.resolveAgent() : this.opts.agent
      signal.throwIfAborted()
    } catch (e) {
      signal.throwIfAborted()
      const msg = e instanceof Error ? e.message : String(e)
      this.setPhase('error', msg)
      if (e instanceof MuseControlPlaneError && e.code === 'signed_out') throw new MuseGatewayError(msg, 'signed_out', e.status)
      throw new MuseGatewayError(msg, 'http', e instanceof MuseControlPlaneError ? e.status : undefined)
    }

    const parts = [
      `vm_id=${encodeURIComponent(creds.vmId)}`,
      `auth_token=${encodeURIComponent(creds.authToken)}`
    ]
    if (creds.notaryToken) parts.push(`notary_token=${encodeURIComponent(creds.notaryToken)}`)
    parts.push(`app_id=${APP_ID}`, `request_id=${randomUUID()}`)
    const url = `${NOISE_URL}?${parts.join('&')}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url, {
        headers: { Origin: 'https://muse.ai', 'User-Agent': UA },
        perMessageDeflate: false,
        ...(agent ? { agent } : {})
      })
    } catch {
      const error = new MuseGatewayError('could not open Muse websocket', 'handshake_failed')
      this.setPhase('error', error.message)
      throw error
    }
    ws.binaryType = 'nodebuffer'
    this.ws = ws
    ws.on('error', () => { /* Opening/handshake also listen for errors. */ })

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new MuseGatewayError('websocket open timeout', 'timeout')), HANDSHAKE_TIMEOUT_MS)
        const finish = (error?: Error): void => {
          clearTimeout(timer)
          ws.off('open', onOpen)
          ws.off('unexpected-response', onResponse)
          ws.off('close', onClose)
          ws.off('error', onError)
          signal.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve()
        }
        const onOpen = () => finish()
        const onClose = () => finish(new MuseGatewayError('websocket closed before opening', 'handshake_failed'))
        const onError = (err: Error) => finish(new MuseGatewayError(`websocket error: ${err.message}`, 'handshake_failed'))
        const onAbort = () => finish(signal.reason as Error)
        const onResponse = (_req: ClientRequest, res: IncomingMessage) => {
          const status = res.statusCode ?? 0
          if (status === 401 || status === 403) this.forceRefresh = true
          finish(new MuseGatewayError(`websocket rejected: HTTP ${status}`, status === 401 || status === 403 ? 'signed_out' : 'handshake_failed', status))
        }
        ws.once('open', onOpen)
        ws.once('unexpected-response', onResponse)
        ws.once('close', onClose)
        ws.once('error', onError)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      signal.throwIfAborted()
      this.setPhase('handshake')
      signal.throwIfAborted()
      const transport = await this.handshake(ws, signal)
      signal.throwIfAborted()
      this.transport = transport
    } catch (e) {
      signal.throwIfAborted()
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      this.ws = null
      const msg = e instanceof Error ? e.message : String(e)
      this.setPhase('error', msg)
      throw e instanceof MuseGatewayError ? e : new MuseGatewayError(msg, 'handshake_failed')
    }

    ws.on('message', (data: Buffer, isBinary: boolean) => this.onMessage(ws, data, isBinary))
    ws.on('close', (code: number, reason: Buffer) => this.onClose(ws, code, reason.toString()))
    this.attempt = 0
    this.trusted = true
    this.lastError = null
    this.startHeartbeat(signal)
    this.setPhase('ready')
    this.log('muse-native: connected', { vm: creds.vmId.slice(0, 8) })
  }

  private handshake(ws: WebSocket, signal: AbortSignal): Promise<NoiseTransport> {
    return new Promise<NoiseTransport>((resolve, reject) => {
      const hs = new NoiseXXInitiator()
      const timer = setTimeout(() => fail(new MuseGatewayError('noise handshake timeout', 'timeout')), HANDSHAKE_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        ws.off('message', onMsg)
        ws.off('close', onClose)
        ws.off('error', fail)
        signal.removeEventListener('abort', onAbort)
      }
      const fail = (e: Error): void => {
        cleanup()
        reject(e)
      }
      const onAbort = () => fail(signal.reason as Error)
      const onClose = (code: number, reason: Buffer): void => {
        if (code === 4001 || code === 4003 || code === 1008) this.forceRefresh = true
        fail(new MuseGatewayError(`closed during handshake (${code} ${reason.toString().slice(0, 80)})`, 'handshake_failed'))
      }
      const onMsg = (data: Buffer, isBinary: boolean): void => {
        if (!isBinary) return fail(new MuseGatewayError('plaintext frame during handshake', 'handshake_failed'))
        try {
          if (data.length > 65535) throw new Error('handshake message too large')
          const payload2 = hs.readMessage2(new Uint8Array(data))
          if (isOwnerRvChallenge(payload2)) {
            throw new MuseGatewayError(
              'This Muse VM is a confidential VM (Owner RV challenge). Open muse.ai in the browser to enroll it, or use a standard VM — BotArk does not handle CVM recovery keys.',
              'cvm_required'
            )
          }
          // Standard personal VM: payload2 is an attestation bundle (accepted as
          // NON_TEE / auth_token-bound, like the web client's default policy).
          // Shared Agent: Msg3 = fresh ticket bytes (protocol.md §3.3).
          const klass = this.opts.connectionClass ?? 'hatch_vm'
          let payload3 = new Uint8Array(0)
          if (klass === 'shared_agent') {
            const ticket = this.opts.sharedAgentTicket
            if (!ticket || ticket.byteLength === 0) {
              throw new MuseGatewayError(
                'Shared Agent Noise class requires a fresh ticket for Msg3 — ticket bootstrap not wired (needs live capture).',
                'handshake_failed'
              )
            }
            payload3 = Uint8Array.from(ticket)
          }
          const msg3 = hs.writeMessage3(payload3)
          ws.send(msg3)
          const [send, recv] = hs.split()
          cleanup()
          resolve(new NoiseTransport(send, recv))
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)))
        }
      }
      ws.on('message', onMsg)
      ws.once('close', onClose)
      ws.once('error', fail)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const klass = this.opts.connectionClass ?? 'hatch_vm'
        // hatch_vm: field1 = 32B freshness nonce.
        // shared_agent: field2 = 1 (Writer.uint32(16).int32(1)), no nonce — protocol.md §3.3.
        const payload1 =
          klass === 'shared_agent'
            ? new PbWriter().uint(2, 1).finish()
            : new PbWriter().bytes(1, new Uint8Array(randomBytes(32))).finish()
        ws.send(hs.writeMessage1(payload1))
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private onMessage(ws: WebSocket, data: Buffer, isBinary: boolean): void {
    if (ws !== this.ws || !this.transport) return
    if (!isBinary) {
      this.hardClose(4004, 'plaintext frame')
      return
    }
    let frame: InboundFrame | null
    try {
      frame = this.transport.decrypt(new Uint8Array(data))
    } catch (e) {
      this.log('muse-native: decrypt failed, re-handshaking', { err: e instanceof Error ? e.message : String(e) })
      this.hardClose(4004, 'decrypt failed')
      return
    }
    if (!frame) return
    if (process.env['BOTHUB_MUSE_NATIVE_TRACE'] === '1') {
      const size = frame.kind === 'response' ? frame.body.length : frame.kind === 'bodyChunk' ? frame.data.length : 0
      const end = frame.kind === 'reset' ? true : frame.endBody
      this.log('muse-native: frame', { kind: frame.kind, stream: Number(frame.streamId), size, end, status: frame.kind === 'response' ? frame.status : undefined })
    }
    const st = this.streams.get(frame.streamId)
    if (!st) return
    if (frame.kind === 'reset') {
      this.finishStream(frame.streamId, new MuseGatewayError(`stream reset (${frame.code}${frame.reason ? ` ${frame.reason}` : ''})`, 'reset'))
      return
    }
    if (frame.kind === 'response') {
      if (st.status !== undefined) {
        this.cancelStream(frame.streamId, st, new MuseGatewayError('duplicate response headers', 'http', frame.status))
        return
      }
      st.status = frame.status
      st.responseHeaders = frame.headers
      if (st.subscription && (frame.status < 200 || frame.status >= 300)) {
        const error = new MuseGatewayError(`HTTP ${frame.status}`, 'http', frame.status)
        if (frame.status === 401) {
          this.finishStream(frame.streamId, error)
          this.refreshAuthentication()
        } else if (frame.endBody) {
          this.finishStream(frame.streamId, error)
        } else {
          this.cancelStream(frame.streamId, st, error)
        }
        return
      }
      if (frame.body.length) this.feed(frame.streamId, st, frame.body)
      if (frame.endBody) this.finishStream(frame.streamId)
      return
    }
    if (st.status === undefined) {
      this.cancelStream(frame.streamId, st, new MuseGatewayError('response body arrived before headers', 'http'))
      return
    }
    if (frame.data.length) this.feed(frame.streamId, st, frame.data)
    if (frame.endBody) this.finishStream(frame.streamId)
  }

  private feed(id: bigint, st: PendingStream, data: Uint8Array): void {
    if (!st.subscription) {
      const received = st.receivedBytes ?? 0
      const remaining = st.maxResponseBytes === undefined ? data.length : st.maxResponseBytes - received
      if (remaining > 0) {
        const chunk = data.length > remaining ? data.slice(0, remaining) : data
        st.chunks.push(chunk)
        st.receivedBytes = received + chunk.length
      }
      if (data.length > remaining) {
        st.truncated = true
        this.finishStream(id)
        this.sendReset(st.service, id, 'response byte limit')
      }
      return
    }
    if (st.status === undefined || st.status < 200 || st.status >= 300) return
    st.lineBuf += st.decoder.decode(data, { stream: true })
    let idx: number
    while ((idx = st.lineBuf.indexOf('\n')) >= 0) {
      const line = st.lineBuf.slice(0, idx).trim()
      st.lineBuf = st.lineBuf.slice(idx + 1)
      if (line) this.dispatchLine(st, line)
      if (this.streams.get(id) !== st) return
    }
  }

  private dispatchLine(st: PendingStream, line: string): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
    if (obj['type'] === 'event') st.onEvent?.(obj)
    else if (!st.ackSeen) {
      st.ackSeen = true
      st.onAck?.(obj)
    } else st.onEvent?.(obj)
  }

  private finishStream(id: bigint, err?: Error): void {
    const st = this.streams.get(id)
    if (!st) return
    this.streams.delete(id)
    if (st.timer) clearTimeout(st.timer)
    st.removeAbortListener?.()
    if (st.subscription) {
      if (!err && (st.status === undefined || st.status < 200 || st.status >= 300)) {
        err = new MuseGatewayError(`HTTP ${st.status ?? 'status missing'}`, 'http', st.status)
      }
      const tail = (st.lineBuf + st.decoder.decode()).trim()
      st.lineBuf = ''
      if (tail && !err) this.dispatchLine(st, tail)
      st.onDone?.(err)
      return
    }
    if (err) st.rejectUnary?.(err)
    else {
      const body = new Uint8Array(st.receivedBytes ?? 0)
      let o = 0
      for (const c of st.chunks) {
        body.set(c, o)
        o += c.length
      }
      st.resolveUnary?.({ status: st.status ?? 0, body, headers: st.responseHeaders, truncated: st.truncated === true })
    }
  }

  private buildRequest(
    method: string,
    params: Record<string, unknown>,
    override?: { path?: string; bodyMethod?: string; wrapParams?: boolean }
  ): {
    service: ServiceName
    verb: string
    path: string
    body: Uint8Array
    subscription: boolean
    streamMode: 'unary' | 'subscription' | 'records'
    responseType?: 'binary'
    requestTimeoutMs?: number
    maxResponseBytes?: number
  } {
    const spec = MUSE_METHODS[method]
    if (!spec) throw new MuseGatewayError(`unknown muse method ${method}`, 'unknown_method')
    const template = override?.path ?? this.pathOverrides.get(method) ?? spec.path
    const learnedBodyMethod = this.bodyMethodOverrides.get(method)
    const effectiveParams =
      override?.bodyMethod
        ? { ...params, method: override.bodyMethod }
        : learnedBodyMethod && params['method'] === undefined
        ? { ...params, method: learnedBodyMethod }
        : params
    const { path, rest } = substitutePath(template, effectiveParams)
    const isGet = spec.httpMethod === 'GET'
    const isEmptyBody = isGet || spec.requestBody === 'empty'
    const wrapParams = !isEmptyBody && (override?.wrapParams === true || this.bodyParamsEnvelopeOverrides.has(method))
    let payload: Record<string, unknown> = rest
    if (wrapParams) {
      const { method: bodyMethodVal, params: existingInner, ...otherFields } = rest
      const inner =
        existingInner && typeof existingInner === 'object' && !Array.isArray(existingInner)
          ? { ...(existingInner as Record<string, unknown>), ...otherFields }
          : otherFields
      payload = {
        ...(bodyMethodVal !== undefined ? { method: bodyMethodVal } : {}),
        params: inner
      }
    }
    return {
      service: (spec.service ?? 'daemon') as ServiceName,
      verb: spec.httpMethod,
      path: isGet ? path + toQuery(rest, path) : path,
      body: isEmptyBody ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(payload)),
      subscription: !!spec.subscription,
      streamMode: spec.streamMode ?? (spec.subscription ? 'subscription' : 'unary'),
      responseType: spec.responseType,
      requestTimeoutMs: spec.requestTimeoutMs,
      maxResponseBytes: spec.maxResponseBytes
    }
  }

  private send(
    service: ServiceName,
    verb: string,
    path: string,
    body: Uint8Array,
    extraHeaders: Array<[string, string]> = []
  ): bigint {
    if (!this.transport || !this.ws || this.ws.readyState !== WebSocket.OPEN) throw new MuseGatewayError('gateway not connected', 'closed')
    const headers: Array<[string, string]> = []
    if (verb !== 'GET' && body.length) headers.push(['Content-Type', 'application/json'])
    headers.push(['x-request-id', randomUUID()], ['x-app-id', APP_ID], ['Accept-Language', 'en-US'], ...extraHeaders)
    try {
      const enc = this.transport.encryptRequest({ service, verb, path, headers, body })
      for (const f of enc.frames) this.ws.send(f)
      return enc.streamId
    } catch (e) {
      if (e instanceof NoisePayloadTooLargeError) throw new MuseGatewayError(e.message, 'payload_too_large')
      this.hardClose(4005, 'encrypt failed')
      throw new MuseGatewayError(`encrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'closed')
    }
  }

  private unary(
    method: string,
    req: ReturnType<MuseNativeGateway['buildRequest']>,
    timeoutMs: number,
    headers: Array<[string, string]> = [],
    maxResponseBytes?: number,
    signal?: AbortSignal
  ): Promise<UnaryResponse> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const id = this.send(req.service, req.verb, req.path, req.body, headers)
      const st: PendingStream = {
        service: req.service, subscription: false, chunks: [], lineBuf: '', decoder: new TextDecoder(),
        ackSeen: false, resolveUnary: resolve, rejectUnary: reject, maxResponseBytes
      }
      this.streams.set(id, st)
      st.timer = setTimeout(() => this.cancelStream(id, st, new MuseGatewayError(`${method} timed out`, 'timeout')), timeoutMs)
      if (signal) {
        const onAbort = () => this.cancelStream(id, st, signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        st.removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      }
    })
  }

  /** Unary RPC. Returns parsed JSON (or text/records/binary) body. */
  async request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const generation = this.connection.signal
    const pathBefore = this.pathOverrides.get(method)
    const bodyMethodBefore = this.bodyMethodOverrides.get(method)
    const wrapParamsBefore = this.bodyParamsEnvelopeOverrides.has(method)
    const candidate: { path?: string; bodyMethod?: string; wrapParams?: boolean } = {}
    while (true) {
      signal?.throwIfAborted()
      generation.throwIfAborted()
      await (signal ? abortable(signal, () => this.connect()) : this.connect())
      signal?.throwIfAborted()
      generation.throwIfAborted()
      const req = this.buildRequest(method, params, candidate)
      if (req.subscription) throw new MuseGatewayError(`${method} is a subscription; use subscribe()`, 'unknown_method')
      const res = await this.unary(method, req, timeoutMs ?? req.requestTimeoutMs ?? 30_000, [], req.maxResponseBytes, signal)
      generation.throwIfAborted()
      signal?.throwIfAborted()
      if (res.status < 200 || res.status >= 300) {
        const detail = new TextDecoder().decode(res.body)
        const spec = MUSE_METHODS[method]!
        if (res.status === 400 || res.status === 404) {
          const currentBase = req.path.split('?')[0]!
          const sessionFallback = computeSessionPathFallback(currentBase)
          const requiredPath = extractRequiredMethodPath(detail)
          const required = !sessionFallback || requiredPath === currentBase || requiredPath === sessionFallback ? requiredPath : null
          const sentMethod = candidate.bodyMethod ?? params['method'] ?? this.bodyMethodOverrides.get(method)
          if (required && !candidate.bodyMethod && sentMethod !== required && spec.httpMethod !== 'GET' && spec.requestBody !== 'empty') {
            candidate.bodyMethod = required
            continue
          }
          const alreadyWrapped = candidate.wrapParams === true || this.bodyParamsEnvelopeOverrides.has(method)
          if (!alreadyWrapped && requiresParamsEnvelope(detail) && spec.httpMethod !== 'GET' && spec.requestBody !== 'empty') {
            candidate.wrapParams = true
            continue
          }
          if (!candidate.path && !spec.path.includes('{')) {
            const alternative = required && required !== currentBase
              ? required
              : res.status === 404 ? sessionFallback : null
            if (alternative) {
              candidate.path = alternative
              continue
            }
          }
        }
        throw new MuseGatewayError(`${method}: HTTP ${res.status} ${detail.slice(0, 200)}`, 'http', res.status)
      }
      if (req.responseType === 'binary') {
        return {
          contentType: this.responseHeader(res, 'content-type') ?? 'application/octet-stream',
          byteLength: res.body.byteLength,
          dataBase64: Buffer.from(res.body).toString('base64'),
          ...(res.truncated ? { truncated: true } : {})
        }
      }
      const responseText = new TextDecoder().decode(res.body)
      if (req.streamMode === 'records') {
        const records: unknown[] = []
        for (const line of responseText.split(/\r?\n/)) {
          if (!line.trim()) continue
          try {
            records.push(JSON.parse(line))
          } catch {
            /* ignore non-JSON line */
          }
        }
        return { ok: true, result: { records, items: records } }
      }
      let result: unknown = responseText
      try {
        result = responseText ? JSON.parse(responseText) : null
      } catch {
        /* keep text */
      }
      const envelope = result as { ok?: unknown; success?: unknown; error?: unknown } | null
      const succeeded = envelope?.ok !== false && envelope?.success !== false && !envelope?.error
      const validated = method === 'session.start'
        ? Boolean(extractStartedSessionId(result)) && succeeded
        : !res.truncated && (res.status === 204 || (result !== null && typeof result === 'object' && succeeded))
      if (validated) {
        if (candidate.path && this.pathOverrides.get(method) === pathBefore) this.pathOverrides.set(method, candidate.path)
        if (candidate.bodyMethod && this.bodyMethodOverrides.get(method) === bodyMethodBefore) {
          this.bodyMethodOverrides.set(method, candidate.bodyMethod)
        }
        if (candidate.wrapParams && this.bodyParamsEnvelopeOverrides.has(method) === wrapParamsBefore) {
          this.bodyParamsEnvelopeOverrides.add(method)
        }
      }
      return result
    }
  }

  private responseHeader(res: UnaryResponse, key: string): string | undefined {
    return res.headers?.find(([name]) => name.toLowerCase() === key)?.[1]
  }

  /** Binary RPC with an optional Range header and receive-side byte budget. */
  async requestBinary(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
    maxResponseBytes?: number
  ): Promise<{ status: number; body: Uint8Array; contentType?: string; contentRange?: string; contentLength?: number; truncated: boolean }> {
    const generation = this.connection.signal
    await this.connect()
    generation.throwIfAborted()
    const range = params['_range'] as { start?: number; end?: number } | undefined
    const clean = { ...params }
    delete clean['_range']
    const req = this.buildRequest(method, clean)
    if (req.subscription) throw new MuseGatewayError(`${method} is a subscription; use subscribe()`, 'unknown_method')
    const headers: Array<[string, string]> = []
    if (range && typeof range.start === 'number' && typeof range.end === 'number' &&
        Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start) {
      headers.push(['Range', `bytes=${range.start}-${range.end}`])
    }
    const res = await this.unary(method, req, timeoutMs ?? req.requestTimeoutMs ?? 120_000, headers, maxResponseBytes ?? req.maxResponseBytes)
    generation.throwIfAborted()
    if (res.status < 200 || res.status >= 300) {
      const detail = new TextDecoder().decode(res.body.subarray(0, 200))
      throw new MuseGatewayError(`${method}: HTTP ${res.status} ${detail}`, 'http', res.status)
    }
    const contentLength = this.responseHeader(res, 'content-length')
    return {
      status: res.status,
      body: res.body,
      contentType: this.responseHeader(res, 'content-type'),
      contentRange: this.responseHeader(res, 'content-range'),
      contentLength: contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined,
      truncated: res.truncated
    }
  }

  /** Subscription RPC (chat.stream / chat.subscribe …): ack + NDJSON events on one stream. */
  async subscribe(
    method: string,
    params: Record<string, unknown>,
    onEvent: (e: Record<string, unknown>) => void,
    signal?: AbortSignal,
    onDispatched?: () => void
  ): Promise<SubscriptionHandle> {
    const generation = this.connection.signal
    await (signal ? abortable(signal, () => this.connect()) : this.connect())
    signal?.throwIfAborted()
    generation.throwIfAborted()
    const req = this.buildRequest(method, params)
    let resolveAck!: (v: Record<string, unknown>) => void
    let rejectAck!: (e: Error) => void
    let resolveDone!: () => void
    let rejectDone!: (e: Error) => void
    const ack = new Promise<Record<string, unknown>>((a, b) => {
      resolveAck = a
      rejectAck = b
    })
    const done = new Promise<void>((a, b) => {
      resolveDone = a
      rejectDone = b
    })
    ack.catch(() => undefined)
    done.catch(() => undefined)
    const id = this.send(req.service, req.verb, req.path, req.body)
    const st: PendingStream = {
      service: req.service,
      subscription: true,
      chunks: [],
      lineBuf: '',
      decoder: new TextDecoder(),
      ackSeen: false,
      onAck: (value) => {
        if (st.timer) clearTimeout(st.timer)
        st.timer = undefined
        if (value['ok'] === false || value['success'] === false) {
          const err = new MuseGatewayError(`${method}: subscription rejected`, 'http', st.status)
          this.cancelStream(id, st, err)
        } else {
          resolveAck(value)
        }
      },
      onEvent,
      onDone: (err) => {
        if (err || (!st.ackSeen && (method === 'chat.stream' || method === 'chat.subscribe'))) {
          err ??= new MuseGatewayError(`${method}: missing acknowledgement`, 'http', st.status)
          rejectAck(err)
          rejectDone(err)
        } else {
          resolveAck({})
          resolveDone()
        }
      }
    }
    this.streams.set(id, st)
    st.timer = setTimeout(() => this.cancelStream(id, st, new MuseGatewayError(`${method} acknowledgement timed out`, 'timeout')), req.requestTimeoutMs ?? 30_000)
    onDispatched?.()
    return {
      ack,
      done,
      cancel: (reason) => this.cancelStream(id, st, new MuseGatewayError(reason ?? 'cancelled', 'closed'))
    }
  }

  private cancelStream(id: bigint, st: PendingStream, error: unknown): void {
    if (this.streams.get(id) !== st) return
    const err = error instanceof Error ? error : new MuseGatewayError(String(error ?? 'cancelled'), 'closed')
    this.finishStream(id, err)
    this.sendReset(st.service, id, err.message)
  }

  private sendReset(service: ServiceName, id: bigint, reason: string): void {
    try {
      if (this.transport && this.ws?.readyState === WebSocket.OPEN) {
        for (const f of this.transport.encryptReset(service, id, reason)) this.ws.send(f)
      }
    } catch {
      this.hardClose(4005, 'reset send failed')
    }
  }

  private startHeartbeat(signal: AbortSignal): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (signal.aborted || !this.isReady()) return
      this.request('connection.ping', { presence: 'visible' }, HEARTBEAT_TIMEOUT_MS).catch((e) => {
        if (!signal.aborted && e instanceof MuseGatewayError && e.code === 'timeout') this.hardClose(4002, 'heartbeat timeout')
      })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private hardClose(code: number, reason: string): void {
    const ws = this.ws
    if (!ws) return
    this.onClose(ws, code, reason)
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return
    const err = new MuseGatewayError(`gateway closed (${code}${reason ? ` ${reason.slice(0, 80)}` : ''})`, 'closed')
    if (code === 4001 || code === 4003 || code === 1008) this.forceRefresh = true
    this.log('muse-native: closed', { code })
    this.disconnect(err, 'reconnecting')
    if (this.opts.keepAlive) this.scheduleReconnect()
  }

  private disconnect(err: MuseGatewayError, phase: 'idle' | 'reconnecting'): void {
    const ws = this.ws
    this.ws = null
    this.transport = null
    this.connecting = null
    const old = this.connection
    this.connection = new AbortController()
    old.abort(err)
    this.stopHeartbeat()
    this.clearReconnectTimer()
    for (const id of this.streams.keys()) this.finishStream(id, err)
    ws?.terminate()
    if (phase === 'idle') this.lastError = null
    this.setPhase(phase, phase === 'reconnecting' ? err.message : undefined)
  }

  private refreshAuthentication(): void {
    if (this.closedByUser) return
    this.forceRefresh = true
    this.disconnect(new MuseGatewayError('gateway subscription unauthorized', 'signed_out', 401), 'reconnecting')
    if (this.opts.keepAlive) this.scheduleReconnect()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private scheduleReconnect(authFailure = false): void {
    if (this.reconnectTimer || this.closedByUser) return
    const delay = authFailure ? 30_000 : backoffMs(this.attempt++, this.trusted)
    const generation = this.connection.signal
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (generation.aborted) return
      this.connect().catch((e) => {
        if (generation.aborted) return
        const auth = e instanceof MuseGatewayError && (e.code === 'signed_out' || e.code === 'cvm_required')
        if (e instanceof MuseGatewayError && e.code === 'cvm_required') return // do not hammer a CVM
        this.scheduleReconnect(auth)
      })
    }, delay)
  }

  /** Test hook: drop the socket as if the network died. */
  simulateDrop(): void {
    this.ws?.terminate()
  }

  close(): void {
    if (this.closedByUser) return
    this.closedByUser = true
    this.disconnect(new MuseGatewayError('gateway disposed', 'closed'), 'idle')
  }
}
