/**
 * Zero-Server Local / Tailscale Companion Sync Bridge for BotArk iOS.
 *
 * Runs strictly inside BotArk Desktop (opt-in, no cloud relay server):
 * - Discovers LAN Wi-Fi & Tailscale IPv4 addresses automatically
 * - Issues short-lived 256-bit QR pairing tokens (`botark://pair?...`)
 * - Authenticates paired iOS devices with SHA-256 hashed Bearer tokens stored in `mobile-sync-devices.json` (`0600`)
 * - Streams live workspace snapshots, message deltas, tool calls, typing, status & approvals over WebSocket
 * - Relays iOS user sends / stop / new-session / approval decisions into BotArk Desktop's native adapters
 * - Optionally exports AES-256-GCM encrypted Hermes direct-connect credentials (or standalone `.botark-sync` AirDrop bundle)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  buildPairingUri,
  type DirectHermesCredential,
  type MobileBridgeLiveEvent,
  type MobileRelayCommand,
  type MobileSendCommand,
  type MobileSendResult,
  type MobileSyncStateView,
  type MobileWorkspaceSnapshot,
  type PairedMobileDeviceView
} from '@shared/mobileSync'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'
import {
  encryptAesGcmCombined,
  fingerprintFromKey,
  generateAes256KeyBase64Url,
  generateRandomToken,
  safeEqualText,
  sha256Hex
} from './mobileSyncCrypto'

const DEFAULT_PORT = 19472
const PAIR_TTL_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const SEND_RETRY_TTL_MS = 2 * 60 * 1000
const MAX_SEND_RECORDS = 512

interface StoredDeviceRecord {
  deviceId: string
  deviceName: string
  deviceModel?: string
  tokenHash: string
  pairedAtMs: number
  lastSeenAtMs: number
}

interface StoredDeviceFile {
  devices: StoredDeviceRecord[]
}

export interface MobileSyncServerOptions {
  storePath?: string
  defaultPort?: number
  hostName?: string
  appVersion?: string
  getDirectCredentials?: () => DirectHermesCredential[]
  onCommand?: (command: MobileRelayCommand) => void
  onSendMessage?: (command: MobileSendCommand) => Promise<MobileSendResult>
  onStateChange?: (state: MobileSyncStateView) => void
}

/**
 * Rank local IPv4 addresses for iPhone reachability:
 * 1. Primary LAN Wi-Fi (`en0` / `192.168.*` / `10.*` / `172.16-31.*`)
 * 2. Tailscale / CGNAT overlay (`100.64.0.0/10`)
 * Excludes loopback (`127.*`) and link-local (`169.254.*`).
 */
export function discoverReachableLanHosts(): string[] {
  const ifaces = networkInterfaces()
  const scored: Array<{ ip: string; score: number }> = []
  const seen = new Set<string>()

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = entry.address
      if (!ip || seen.has(ip) || ip.startsWith('127.') || ip.startsWith('169.254.')) continue
      seen.add(ip)

      let score = 50
      if (name === 'en0' || name === 'Wi-Fi' || name === 'wlan0') score = 10
      else if (ip.startsWith('192.168.')) score = 20
      else if (ip.startsWith('10.')) score = 25
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score = 30
      else if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip)) score = 35 // Tailscale CGNAT
      scored.push({ ip, score })
    }
  }

  scored.sort((a, b) => a.score - b.score || a.ip.localeCompare(b.ip))
  return scored.length > 0 ? scored.map((s) => s.ip) : ['127.0.0.1']
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('Payload too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON object expected')
  }
  return parsed as Record<string, unknown>
}

export class MobileSyncServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private hosts: string[] = []
  private pairToken: string | null = null
  private pairKey: string | null = null
  private pairExpiresAtMs: number | null = null
  private includeDirectCredentials = true
  private latestSnapshot: MobileWorkspaceSnapshot
  private readonly devices = new Map<string, StoredDeviceRecord>()
  private readonly sockets = new Map<WebSocket, string>() // ws -> deviceId
  private readonly sends = new Map<string, {
    fingerprint: string
    result: Promise<MobileSendResult>
    expiresAt: number
  }>()
  private readonly options: MobileSyncServerOptions
  private readonly hostLabel: string
  private readonly appVersion: string

  constructor(options: MobileSyncServerOptions = {}) {
    this.options = options
    this.hostLabel = (options.hostName || hostname() || 'BotArk Desktop').replace(/\.local$/i, '')
    this.appVersion = options.appVersion || '0.8.0'
    this.latestSnapshot = {
      version: 1,
      updatedAtMs: Date.now(),
      hostName: this.hostLabel,
      selectedBotId: null,
      groups: [],
      bots: [],
      accounts: {},
      messages: {},
      approvals: {}
    }
    this.loadDevicesFromDisk()
  }

  private loadDevicesFromDisk(): void {
    if (!this.options.storePath) return
    const file = readJsonFile<StoredDeviceFile>(
      this.options.storePath,
      { devices: [] },
      (raw) => Boolean(raw) && typeof raw === 'object' && Array.isArray((raw as StoredDeviceFile).devices)
    )
    this.devices.clear()
    for (const rec of file.devices) {
      if (rec?.deviceId && rec?.tokenHash) {
        this.devices.set(rec.deviceId, rec)
      }
    }
  }

  private persistDevicesToDisk(): void {
    if (!this.options.storePath) return
    writeJsonAtomic(this.options.storePath, { devices: [...this.devices.values()] }, 0o600)
  }

  private emitState(): void {
    this.options.onStateChange?.(this.getState())
  }

  private authenticateToken(rawToken: string | null | undefined): StoredDeviceRecord | null {
    const clean = (rawToken ?? '').trim()
    if (!clean) return null
    const hash = sha256Hex(clean)
    for (const rec of this.devices.values()) {
      if (safeEqualText(rec.tokenHash, hash)) {
        rec.lastSeenAtMs = Date.now()
        return rec
      }
    }
    return null
  }

  private authenticateRequest(req: IncomingMessage): StoredDeviceRecord | null {
    const auth = req.headers['authorization'] || ''
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return this.authenticateToken(auth.slice(7))
    }
    return null
  }

  private rotatePairingSecretsInternal(): void {
    this.pairToken = generateRandomToken(24)
    this.pairKey = generateAes256KeyBase64Url()
    this.pairExpiresAtMs = Date.now() + PAIR_TTL_MS
  }

  getState(): MobileSyncStateView {
    const connectedIds = new Set(this.sockets.values())
    const devices: PairedMobileDeviceView[] = [...this.devices.values()]
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
      .map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        deviceModel: d.deviceModel,
        pairedAtMs: d.pairedAtMs,
        lastSeenAtMs: d.lastSeenAtMs,
        connected: connectedIds.has(d.deviceId)
      }))

    const running = Boolean(this.server && this.port)
    const fp = this.pairKey ? fingerprintFromKey(this.pairKey) : '--------'
    const pairUri =
      running && this.port && this.pairToken && this.pairKey && this.hosts.length > 0
        ? buildPairingUri({
            version: 1,
            hosts: this.hosts,
            port: this.port,
            token: this.pairToken,
            key: this.pairKey,
            name: this.hostLabel,
            fp
          })
        : null

    return {
      running,
      port: this.port,
      hosts: [...this.hosts],
      primaryHost: this.hosts[0] ?? null,
      hostName: this.hostLabel,
      fingerprint: fp,
      pairUri,
      pairExpiresAtMs: this.pairExpiresAtMs,
      includeDirectCredentials: this.includeDirectCredentials,
      devices
    }
  }

  async start(): Promise<MobileSyncStateView> {
    if (this.server && this.port) {
      this.hosts = discoverReachableLanHosts()
      if (!this.pairToken || !this.pairExpiresAtMs || Date.now() > this.pairExpiresAtMs) {
        this.rotatePairingSecretsInternal()
      }
      this.emitState()
      return this.getState()
    }

    this.hosts = discoverReachableLanHosts()
    this.rotatePairingSecretsInternal()

    const preferredPort = this.options.defaultPort ?? DEFAULT_PORT
    const srv = createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    const wss = new WebSocketServer({ noServer: true })

    srv.on('upgrade', (req, socket, head) => {
      try {
        const u = new URL(req.url || '/', 'http://localhost')
        if (u.pathname !== '/api/mobile/v1/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        const tokenFromQuery = u.searchParams.get('token')
        const device = this.authenticateRequest(req) ?? this.authenticateToken(tokenFromQuery)
        if (!device) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.sockets.set(ws, device.deviceId)
          this.persistDevicesToDisk()
          this.emitState()

          // Push immediate snapshot on connect
          this.sendWs(ws, { type: 'snapshot', snapshot: this.latestSnapshot })

          ws.on('close', () => {
            this.sockets.delete(ws)
            this.emitState()
          })
          ws.on('error', () => {
            this.sockets.delete(ws)
            this.emitState()
          })
          ws.on('message', (raw) => {
            try {
              const parsed = JSON.parse(String(raw)) as Record<string, unknown>
              if (parsed['type'] === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
              }
            } catch {
              /* ignore malformed client ping */
            }
          })
        })
      } catch {
        socket.destroy()
      }
    })

    const listenOn = (p: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          srv.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          srv.off('error', onError)
          const addr = srv.address()
          resolve(typeof addr === 'object' && addr ? addr.port : p)
        }
        srv.once('error', onError)
        srv.once('listening', onListening)
        srv.listen(p, '0.0.0.0')
      })

    try {
      this.port = await listenOn(preferredPort)
    } catch {
      this.port = await listenOn(0)
    }

    this.server = srv
    this.wss = wss
    this.emitState()
    return this.getState()
  }

  async stop(): Promise<MobileSyncStateView> {
    for (const ws of this.sockets.keys()) {
      try {
        ws.close(1001, 'Server stopped')
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.server) {
      const s = this.server
      this.server = null
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
    this.port = null
    this.pairToken = null
    this.pairKey = null
    this.pairExpiresAtMs = null
    this.emitState()
    return this.getState()
  }

  rotatePairing(): MobileSyncStateView {
    this.hosts = discoverReachableLanHosts()
    this.rotatePairingSecretsInternal()
    this.emitState()
    return this.getState()
  }

  setIncludeDirectCredentials(enabled: boolean): MobileSyncStateView {
    this.includeDirectCredentials = Boolean(enabled)
    this.emitState()
    return this.getState()
  }

  revokeDevice(deviceId: string): MobileSyncStateView {
    const cleanId = (deviceId ?? '').trim()
    if (cleanId === '*') {
      this.devices.clear()
      for (const ws of this.sockets.keys()) {
        try {
          ws.close(4001, 'Revoked')
        } catch {
          /* ignore */
        }
      }
      this.sockets.clear()
    } else if (cleanId) {
      this.devices.delete(cleanId)
      for (const [ws, id] of this.sockets.entries()) {
        if (id === cleanId) {
          try {
            ws.close(4001, 'Revoked')
          } catch {
            /* ignore */
          }
          this.sockets.delete(ws)
        }
      }
    }
    this.persistDevicesToDisk()
    this.emitState()
    return this.getState()
  }

  updateSnapshot(snapshot: MobileWorkspaceSnapshot): void {
    this.latestSnapshot = {
      ...snapshot,
      hostName: this.hostLabel,
      updatedAtMs: Date.now()
    }
    this.broadcastLiveEvent({ type: 'snapshot', snapshot: this.latestSnapshot })
  }

  broadcastLiveEvent(event: MobileBridgeLiveEvent): void {
    if (this.sockets.size === 0) return
    const encoded = JSON.stringify(event)
    for (const ws of this.sockets.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(encoded)
        } catch {
          /* ignore broken pipe */
        }
      }
    }
  }

  private sendWs(ws: WebSocket, event: MobileBridgeLiveEvent): void {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(event))
    } catch {
      /* ignore */
    }
  }

  /**
   * Build an AES-256-GCM encrypted offline transfer bundle (`.botark-sync`)
   * so users can AirDrop it directly to BotArk iOS without even needing the same Wi-Fi LAN.
   */
  createOfflineEncryptedBundle(): { bundleJson: string; transferKey: string; fingerprint: string } {
    const transferKey = generateAes256KeyBase64Url()
    const fp = fingerprintFromKey(transferKey)
    const directCredentials = this.includeDirectCredentials
      ? (this.options.getDirectCredentials?.() ?? [])
      : []
    const innerPayload = JSON.stringify({
      version: 1,
      exportedAtMs: Date.now(),
      hostName: this.hostLabel,
      snapshot: this.latestSnapshot,
      directCredentials
    })
    const ciphertext = encryptAesGcmCombined(innerPayload, transferKey)
    const outer = {
      format: 'botark-sync-v1',
      cipher: 'AES-256-GCM',
      hostName: this.hostLabel,
      fingerprint: fp,
      exportedAtMs: Date.now(),
      payload: ciphertext
    }
    return {
      bundleJson: JSON.stringify(outer, null, 2),
      transferKey,
      fingerprint: fp
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase()
    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, message: 'Bad URL' })
      return
    }

    try {
      // Friendly landing page if scanned with iOS Camera / Safari
      if (method === 'GET' && (pathname === '/' || pathname === '/pair')) {
        const state = this.getState()
        const deepLink = state.pairUri || 'botark://pair'
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BotArk iOS Sync</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.card{max-width:360px;background:#161b22;border:1px solid #30363d;border-radius:20px;padding:28px}
a.btn{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:12px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600}
code{color:#93c5fd}</style></head><body><div class="card">
<h2>BotArk Zero-Server Sync</h2>
<p>Host: <strong>${this.hostLabel}</strong> · FP: <code>${state.fingerprint}</code></p>
<p style="color:#94a3b8;font-size:14px">Open this link in the native BotArk iOS app to pair directly over LAN / Tailscale with zero cloud server.</p>
<a class="btn" href="${deepLink.replace(/"/g, '&quot;')}">Open in BotArk iOS</a>
</div></body></html>`)
        return
      }

      if (method === 'GET' && pathname === '/api/mobile/v1/ping') {
        sendJson(res, 200, {
          ok: true,
          app: 'botark',
          version: this.appVersion,
          hostName: this.hostLabel,
          fp: this.pairKey ? fingerprintFromKey(this.pairKey) : ''
        })
        return
      }

      if (method === 'POST' && pathname === '/api/mobile/v1/pair') {
        const body = await readJsonBody(req)
        const token = typeof body['pairToken'] === 'string' ? body['pairToken'].trim() : ''
        if (
          !this.pairToken ||
          !this.pairKey ||
          !this.pairExpiresAtMs ||
          Date.now() > this.pairExpiresAtMs ||
          !safeEqualText(token, this.pairToken)
        ) {
          sendJson(res, 401, { ok: false, message: '配对码无效或已过期，请在电脑端刷新二维码重试' })
          return
        }

        const prefix = String(body.deviceModel || '').toLowerCase().includes('android') ? 'and' : 'ios'
        const deviceId = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const deviceToken = generateRandomToken(32)
        const deviceName =
          typeof body['deviceName'] === 'string' && body['deviceName'].trim()
            ? body['deviceName'].trim().slice(0, 64)
            : 'iPhone'
        const deviceModel =
          typeof body['deviceModel'] === 'string' && body['deviceModel'].trim()
            ? body['deviceModel'].trim().slice(0, 64)
            : 'iOS'

        const now = Date.now()
        this.devices.set(deviceId, {
          deviceId,
          deviceName,
          deviceModel,
          tokenHash: sha256Hex(deviceToken),
          pairedAtMs: now,
          lastSeenAtMs: now
        })
        this.persistDevicesToDisk()

        // Encrypt direct-connect Hermes credentials with the ephemeral QR AES-256-GCM key when allowed
        let directCredentialsEnc: string | undefined
        if (this.includeDirectCredentials) {
          const creds = this.options.getDirectCredentials?.() ?? []
          if (creds.length > 0) {
            directCredentialsEnc = encryptAesGcmCombined(JSON.stringify(creds), this.pairKey)
          }
        }

        const fp = fingerprintFromKey(this.pairKey)
        // Rotate pairing token immediately after successful single-use pairing!
        this.rotatePairingSecretsInternal()
        this.emitState()

        sendJson(res, 200, {
          ok: true,
          deviceId,
          deviceToken,
          hostName: this.hostLabel,
          fp,
          snapshot: this.latestSnapshot,
          ...(directCredentialsEnc ? { directCredentialsEnc } : {})
        })
        return
      }

      // All endpoints below require an authenticated paired device Bearer token
      const device = this.authenticateRequest(req)
      if (!device) {
        sendJson(res, 401, { ok: false, message: '设备未授权或已被电脑端移除' })
        return
      }
      this.persistDevicesToDisk()

      if (method === 'GET' && pathname === '/api/mobile/v1/snapshot') {
        sendJson(res, 200, { ok: true, snapshot: this.latestSnapshot })
        return
      }

      const sendMatch = /^\/api\/mobile\/v1\/bots\/([^/]+)\/send$/.exec(pathname)
      if (method === 'POST' && sendMatch) {
        const botId = decodeURIComponent(sendMatch[1]!)
        const body = await readJsonBody(req)
        const text = typeof body['text'] === 'string' ? body['text'].trim() : ''
        if (!text) {
          sendJson(res, 400, { ok: false, message: 'Message text is required' })
          return
        }
        const id = body['clientMessageId']
        if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
          sendJson(res, 400, { ok: false, message: 'Invalid client message ID' })
          return
        }
        const result = await this.queueSend(device.deviceId, {
          botId,
          text,
          clientMessageId: id ?? `mobile_${randomUUID()}`
        })
        if (!result.ok) {
          sendJson(res, result.status, { ok: false, message: result.message })
        } else {
          sendJson(res, 200, { ok: true, messageId: result.messageId, acceptedAt: Date.now() })
        }
        return
      }

      const stopMatch = /^\/api\/mobile\/v1\/bots\/([^/]+)\/stop$/.exec(pathname)
      if (method === 'POST' && stopMatch) {
        const botId = decodeURIComponent(stopMatch[1]!)
        this.options.onCommand?.({ kind: 'stopGeneration', botId })
        sendJson(res, 200, { ok: true })
        return
      }

      const newSessionMatch = /^\/api\/mobile\/v1\/bots\/([^/]+)\/new-session$/.exec(pathname)
      if (method === 'POST' && newSessionMatch) {
        const botId = decodeURIComponent(newSessionMatch[1]!)
        this.options.onCommand?.({ kind: 'newSession', botId })
        sendJson(res, 200, { ok: true })
        return
      }

      const approvalMatch = /^\/api\/mobile\/v1\/approvals\/([^/]+)\/([^/]+)$/.exec(pathname)
      if (method === 'POST' && approvalMatch) {
        const accountId = decodeURIComponent(approvalMatch[1]!)
        const approvalId = decodeURIComponent(approvalMatch[2]!)
        const body = await readJsonBody(req)
        const platformId = String(body['platformId'] ?? 'meta-muse') as MobileRelayCommand & {
          kind: 'decideApproval'
        } extends { platformId: infer P }
          ? P
          : never
        const decision = String(body['decision'] ?? 'deny') as
          | 'allow_once'
          | 'allow_session'
          | 'allow_always'
          | 'deny'
          | 'deny_always'
        this.options.onCommand?.({
          kind: 'decideApproval',
          accountId,
          platformId,
          approvalId,
          decision
        })
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, message: 'Not found' })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async queueSend(deviceId: string, command: MobileSendCommand): Promise<MobileSendResult> {
    const now = Date.now()
    for (const [id, entry] of this.sends) {
      if (entry.expiresAt <= now) this.sends.delete(id)
    }
    const key = JSON.stringify([deviceId, command.clientMessageId])
    const fingerprint = sha256Hex(JSON.stringify([command.botId, command.text]))
    const previous = this.sends.get(key)
    if (previous) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : { ok: false, status: 409, message: 'Message ID is already in use' }
    }
    if (!this.options.onSendMessage || this.sends.size >= MAX_SEND_RECORDS) {
      return { ok: false, status: 503, message: 'Desktop is unavailable' }
    }

    const entry = { fingerprint, result: this.options.onSendMessage(command), expiresAt: Infinity }
    this.sends.set(key, entry)
    try {
      const result = await entry.result
      if (result.ok) entry.expiresAt = Date.now() + SEND_RETRY_TTL_MS
      return result
    } finally {
      if (entry.expiresAt === Infinity) this.sends.delete(key)
    }
  }
}

export function defaultMobileSyncDevicesPath(userDataDir: string): string {
  return join(userDataDir, 'mobile-sync-devices.json')
}
