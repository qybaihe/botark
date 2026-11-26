/**
 * DS Bot Encrypted Relay RPC Client (`Fei-Craft/DS-Bot` Phone/Remote Link protocol).
 *
 * Connects outbound over WebSocket (`ws`) to a DS Bot Relay Server
 * (default `wss://relay.dsbot.app/v1/link` or self-hosted relay), completes the
 * `Noise_IK_25519_ChaChaPoly_SHA256` handshake with the paired host computer,
 * and multiplexes end-to-end encrypted `bot` RPC calls (`api/bot` endpoints)
 * alongside real-time live feed events (`stream`, `message`, `revision`, `live`, `room`, `notice`).
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  createDsBotNoisePrologue,
  decodeHandshakeHello,
  DS_BOT_LINK_PROTOCOL_VERSION,
  DS_BOT_MAX_CONTROL_FRAME_BYTES,
  DS_BOT_MAX_RELAY_FRAME_BYTES,
  DsBotNoiseIkSession,
  DsBotSecureMessageCodec,
  encodeHandshakeHello,
  fromBase64Url,
  toBase64Url
} from './dsBotNoise'

export interface DsBotRelayIdentity {
  deviceId: string
  publicKey: string
  privateKey: string
  accessToken: string
}

export interface DsBotRelayHost {
  server: string
  hostDeviceId: string
  hostKey: string
}

export interface DsBotRelayEvent {
  event: string
  data: unknown
  seq?: number
}

interface PendingRpc {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanupAbort?: () => void
}

interface ControlFrame {
  v: number
  id: string
  type: string
  timestamp: number
  payload: Record<string, unknown>
}

interface RemoteMessage {
  v: number
  id: string
  type: 'rpc.request' | 'rpc.response' | 'rpc.error' | 'event'
  timestamp: number
  payload: Record<string, unknown>
}

const RELAY_CAPABILITY = 'transport.relay'

export class DsBotRelayClient {
  private readonly host: DsBotRelayHost
  private readonly identity: DsBotRelayIdentity
  private readonly clientName: string
  private readonly pairingCode?: string
  private readonly agent?: unknown
  private ws: WebSocket | null = null
  private noise: DsBotNoiseIkSession | null = null
  private connectionId: string | null = null
  private relayCounter = 0
  private maxControlFrameBytes = DS_BOT_MAX_CONTROL_FRAME_BYTES
  private maxRelayFrameBytes = DS_BOT_MAX_RELAY_FRAME_BYTES
  private readonly incoming = new DsBotSecureMessageCodec()
  private readonly outgoing = new DsBotSecureMessageCodec()
  private sendChain: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, PendingRpc>()
  private readonly eventListeners = new Set<(event: DsBotRelayEvent) => void>()
  private readonly closeListeners = new Set<(reason?: Error) => void>()
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private closed = false
  private hostName?: string

  constructor(options: {
    host: DsBotRelayHost
    identity: DsBotRelayIdentity
    clientName?: string
    pairingCode?: string
    agent?: unknown
  }) {
    this.host = options.host
    this.identity = options.identity
    this.clientName = (options.clientName || 'BotArk Desktop').slice(0, 64)
    this.pairingCode = options.pairingCode
    this.agent = options.agent
  }

  get connected(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN && Boolean(this.noise?.complete)
  }

  get remoteHostName(): string | undefined {
    return this.hostName
  }

  onEvent(listener: (event: DsBotRelayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onClose(listener: (reason?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    if (this.connected) return
    this.closed = false
    this.incoming.reset()
    this.outgoing.reset()
    this.relayCounter = 0
    this.connectionId = null

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(
        this.host.server,
        this.agent ? ({ agent: this.agent } as WebSocket.ClientOptions) : undefined
      )
      this.ws = ws

      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          this.teardown(err)
          reject(err)
        } else {
          this.startHeartbeat()
          resolve()
        }
      }

      const timer = setTimeout(() => {
        finish(new Error(`连接 DS Bot 中继服务器超时（${this.host.server}）`))
      }, timeoutMs)

      ws.once('open', () => {
        try {
          this.sendControl('hello', {
            role: 'client',
            deviceId: this.identity.deviceId,
            identityKey: this.identity.publicKey,
            accessToken: this.identity.accessToken,
            protocols: [DS_BOT_LINK_PROTOCOL_VERSION],
            capabilities: [RELAY_CAPABILITY],
            clientVersion: 'botark-desktop'
          })
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })

      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
        try {
          const frame = JSON.parse(text) as ControlFrame
          if (!frame || frame.v !== DS_BOT_LINK_PROTOCOL_VERSION || typeof frame.type !== 'string') {
            throw new Error('收到无效的 DS Bot 中继帧')
          }
          if (frame.type === 'hello.ack') {
            const payload = frame.payload ?? {}
            if (payload.protocol !== DS_BOT_LINK_PROTOCOL_VERSION) {
              throw new Error('DS Bot 中继服务器协议版本不兼容')
            }
            if (typeof payload.maxControlFrameBytes === 'number' && payload.maxControlFrameBytes > 0) {
              this.maxControlFrameBytes = Math.min(DS_BOT_MAX_CONTROL_FRAME_BYTES, payload.maxControlFrameBytes)
            }
            if (typeof payload.maxRelayFrameBytes === 'number' && payload.maxRelayFrameBytes > 0) {
              this.maxRelayFrameBytes = Math.min(DS_BOT_MAX_RELAY_FRAME_BYTES, payload.maxRelayFrameBytes)
            }
            this.sendControl('connect.request', { hostDeviceId: this.host.hostDeviceId })
            return
          }
          if (frame.type === 'connect.accepted') {
            const connId = typeof frame.payload?.connectionId === 'string' ? frame.payload.connectionId : ''
            if (!connId) throw new Error('DS Bot 中继握手缺少 connectionId')
            this.connectionId = connId
            const noise = new DsBotNoiseIkSession({
              role: 'initiator',
              localPrivateKey: this.identity.privateKey,
              localPublicKey: this.identity.publicKey,
              remotePublicKey: this.host.hostKey,
              prologue: createDsBotNoisePrologue(connId, this.host.hostDeviceId, this.identity.deviceId)
            })
            this.noise = noise
            const helloBytes = encodeHandshakeHello({
              name: this.clientName,
              ...(this.pairingCode ? { pairingCode: this.pairingCode } : {})
            })
            const step1 = noise.writeHandshake(helloBytes)
            this.sendControl('secure.handshake', {
              connectionId: connId,
              targetDeviceId: this.host.hostDeviceId,
              step: 1,
              data: toBase64Url(step1)
            })
            return
          }
          if (frame.type === 'secure.handshake') {
            if (
              frame.payload?.connectionId !== this.connectionId ||
              frame.payload?.targetDeviceId !== this.identity.deviceId ||
              frame.payload?.step !== 2 ||
              typeof frame.payload?.data !== 'string' ||
              !this.noise
            ) {
              throw new Error('DS Bot 安全握手响应无效')
            }
            const replyPayload = this.noise.readHandshake(fromBase64Url(frame.payload.data))
            if (!this.noise.complete) throw new Error('DS Bot Noise 握手未完成')
            const remoteHello = decodeHandshakeHello(replyPayload)
            if (remoteHello.name) this.hostName = remoteHello.name
            finish()
            return
          }
          if (frame.type === 'connect.rejected' || frame.type === 'error') {
            const msg =
              typeof frame.payload?.message === 'string' && frame.payload.message.trim()
                ? frame.payload.message
                : 'DS Bot 主机拒绝连接（请确认 DS Bot 正在运行且已开启远程连接/配对码未过期）'
            const err = Object.assign(new Error(msg), { code: frame.payload?.code })
            if (!settled) finish(err)
            else this.teardown(err)
            return
          }
          if (frame.type === 'ping') {
            this.sendControl('pong', frame.payload ?? {})
            return
          }
          if (frame.type === 'pong') return
          if (frame.type === 'relay') {
            if (
              !this.noise?.complete ||
              frame.payload?.connectionId !== this.connectionId ||
              frame.payload?.targetDeviceId !== this.identity.deviceId ||
              typeof frame.payload?.ciphertext !== 'string'
            ) {
              return
            }
            const plaintext = this.noise.decrypt(fromBase64Url(frame.payload.ciphertext))
            const assembled = this.incoming.decode(plaintext)
            if (assembled) this.handleDecryptedMessage(assembled)
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          if (!settled) finish(err)
          else this.teardown(err)
        }
      })

      ws.once('error', (err) => {
        const error = new Error(
          `无法连接 DS Bot 中继服务器 (${this.host.server}): ${err instanceof Error ? err.message : String(err)}`
        )
        if (!settled) finish(error)
        else this.teardown(error)
      })

      ws.once('close', () => {
        const error = new Error('DS Bot 中继连接已断开')
        if (!settled) finish(error)
        else this.teardown(error)
      })
    })
  }

  async callBot<T = unknown>(
    endpoint: string,
    payload: unknown = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    const res = await this.rpc<{ ok: boolean; value?: T; error?: { code?: string; message?: string } }>(
      'bot',
      { endpoint, payload: payload ?? {} },
      options
    )
    if (!res?.ok) {
      const err = Object.assign(new Error(res?.error?.message || `DS Bot ${endpoint} 调用失败`), {
        code: res?.error?.code || 'bot/error'
      })
      throw err
    }
    return res.value as T
  }

  rpc<TResult = unknown>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<TResult> {
    if (!this.connected) {
      return Promise.reject(new Error('DS Bot 加密连接未就绪'))
    }
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException('DS Bot request aborted', 'AbortError'))
    }
    const id = randomUUID()
    const timeoutMs = options.timeoutMs ?? 30_000
    const request: RemoteMessage = {
      v: DS_BOT_LINK_PROTOCOL_VERSION,
      id,
      type: 'rpc.request',
      timestamp: Date.now(),
      payload: { method, params }
    }

    const promise = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.takePending(id)?.reject(new Error(`DS Bot RPC ${method} 超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      timer.unref?.()
      const entry: PendingRpc = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      }
      if (options.signal) {
        const onAbort = (): void => {
          this.takePending(id)?.reject(new DOMException(`DS Bot RPC ${method} aborted`, 'AbortError'))
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanupAbort = () => options.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, entry)
    })

    const bytes = new TextEncoder().encode(JSON.stringify(request))
    this.enqueueSecureSend(bytes).catch((error) => {
      this.takePending(id)?.reject(error instanceof Error ? error : new Error(String(error)))
    })
    return promise
  }

  close(): void {
    this.teardown()
  }

  private enqueueSecureSend(plaintext: Uint8Array): Promise<void> {
    const run = this.sendChain.then(() => {
      if (!this.connected || !this.noise || !this.connectionId || !this.ws) {
        throw new Error('DS Bot 加密通道已关闭')
      }
      const frames = this.outgoing.encode(plaintext)
      for (const chunk of frames) {
        const ciphertext = this.noise.encrypt(chunk)
        this.sendControl('relay', {
          connectionId: this.connectionId,
          targetDeviceId: this.host.hostDeviceId,
          counter: this.relayCounter++,
          ciphertext: toBase64Url(ciphertext)
        })
      }
    })
    this.sendChain = run.catch(() => undefined)
    return run
  }

  private sendControl(type: string, payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('DS Bot WebSocket 未连接')
    }
    const encoded = JSON.stringify({
      v: DS_BOT_LINK_PROTOCOL_VERSION,
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      payload
    })
    const limit = type === 'relay' ? this.maxRelayFrameBytes : this.maxControlFrameBytes
    if (Buffer.byteLength(encoded, 'utf8') > limit) {
      throw new Error(`DS Bot ${type} 帧超出大小限制`)
    }
    this.ws.send(encoded)
  }

  private handleDecryptedMessage(bytes: Uint8Array): void {
    const msg = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as RemoteMessage
    if (!msg || msg.v !== DS_BOT_LINK_PROTOCOL_VERSION) return
    if (msg.type === 'rpc.response') {
      const requestId = String(msg.payload?.requestId ?? '')
      this.takePending(requestId)?.resolve(msg.payload?.result)
    } else if (msg.type === 'rpc.error') {
      const requestId = String(msg.payload?.requestId ?? '')
      const err = Object.assign(new Error(String(msg.payload?.message || 'DS Bot RPC error')), {
        code: msg.payload?.code
      })
      this.takePending(requestId)?.reject(err)
    } else if (msg.type === 'event') {
      const event: DsBotRelayEvent = {
        event: String(msg.payload?.event ?? ''),
        data: msg.payload?.data,
        seq: typeof msg.payload?.seq === 'number' ? msg.payload.seq : undefined
      }
      for (const listener of this.eventListeners) {
        try {
          listener(event)
        } catch {
          /* isolate listener errors */
        }
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return
      try {
        this.sendControl('ping', { nonce: Date.now() })
      } catch {
        this.teardown(new Error('DS Bot 心跳发送失败'))
      }
    }, 20_000)
    this.heartbeatTimer.unref?.()
  }

  private takePending(id: string): PendingRpc | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.cleanupAbort?.()
    return entry
  }

  private teardown(reason?: Error): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.removeAllListeners()
        ws.close()
      } catch {
        /* ignore */
      }
    }
    this.noise?.destroy()
    this.noise = null
    this.connectionId = null
    this.incoming.reset()
    this.outgoing.reset()
    for (const id of [...this.pending.keys()]) {
      this.takePending(id)?.reject(reason ?? new Error('DS Bot 连接已关闭'))
    }
    for (const listener of this.closeListeners) {
      try {
        listener(reason)
      } catch {
        /* ignore */
      }
    }
  }
}
