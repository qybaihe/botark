/**
 * Encrypted credential & endpoint store for Fei-Craft/DS-Bot accounts.
 *
 * Persists `dsbot-accounts.json` in `userData` with `0600` atomic writes.
 * All secrets (MCP bearer tokens, DSH signed session cookies, and Relay
 * X25519 private keys + access tokens) are encrypted via Electron `safeStorage`
 * (fail-closed: refuses plaintext storage if keychain encryption is unavailable).
 * Raw secrets never cross IPC to the renderer process.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { DsBotTransportMode } from '@shared/ipc'
import { createMutex } from '@shared/proxyPool'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'

const STORE_FILE = 'dsbot-accounts.json'
const DEFAULT_MCP_PORT = 8797
const withStoreLock = createMutex()
const accountRevisions = new Map<string, symbol>()
let defaultRevision = Symbol()

export interface StoredDsBotAccountRecord {
  mode: DsBotTransportMode
  displayName?: string
  /** MCP mode (`http://.../mcp`) or Channel mode (`http://127.0.0.1:3080`). */
  baseUrl?: string
  /** Base64 safeStorage ciphertext for MCP Bearer token or Channel Cookie header. */
  secretEnc?: string
  /** Relay mode fields (Noise_IK paired host & client identity). */
  relayServer?: string
  hostDeviceId?: string
  hostKey?: string
  hostName?: string
  deviceId?: string
  publicKey?: string
  privateKeyEnc?: string
  accessTokenEnc?: string
  updatedAtMs: number
}

type StoredDsBotAccountMap = Record<string, StoredDsBotAccountRecord>

export interface DsBotAccountMetadata {
  accountId: string
  mode: DsBotTransportMode
  displayName?: string
  baseUrl?: string
  hasSecret: boolean
  relayServer?: string
  hostDeviceId?: string
  hostKey?: string
  hostName?: string
  deviceId?: string
  publicKey?: string
  updatedAtMs: number
}

export interface ResolvedDsBotAccount extends DsBotAccountMetadata {
  /** MCP Bearer token or Channel Cookie header. */
  secret?: string
  /** Relay client X25519 private key (base64url). */
  privateKey?: string
  /** Relay client access token. */
  accessToken?: string
}

export interface LocalDsBotDiskInfo {
  mcpPort: number
  mcpUrl: string
  mcpEnabledInConfig: boolean
  mcpConfigPath?: string
  channelPort?: number
  channelUrl?: string
  dataDir?: string
}

export function normalizeDsBotMcpUrl(raw: string): string {
  let trimmed = (raw ?? '').trim()
  if (!trimmed) {
    return `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`
  }
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = Number(trimmed)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口号无效：${raw}`)
    }
    return `http://127.0.0.1:${port}/mcp`
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    trimmed = `http://${trimmed}`
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`DS Bot MCP 地址格式无效：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http:// 或 https:// 协议（当前为 ${parsed.protocol}）`)
  }
  if (!parsed.hostname) {
    throw new Error('DS Bot MCP 地址缺少主机名')
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = cleanPath === '' ? '/mcp' : cleanPath
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

export function normalizeDsBotChannelUrl(raw: string): { baseUrl: string; initialToken?: string } {
  let trimmed = (raw ?? '').trim()
  if (!trimmed) {
    throw new Error('请输入 DS Bot / DSH Web 地址（例如 http://127.0.0.1:3080/?token=...）')
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    trimmed = `http://${trimmed}`
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`DS Bot Web 地址格式无效：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http:// 或 https:// 协议（当前为 ${parsed.protocol}）`)
  }
  if (!parsed.hostname) {
    throw new Error('DS Bot Web 地址缺少主机名')
  }
  const initialToken = parsed.searchParams.get('token')?.trim() || undefined
  let pathname = parsed.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/api\/bot(?:\/feed)?$/i, '')
  pathname = pathname.replace(/\/+$/, '')
  return {
    baseUrl: `${parsed.origin}${pathname}`,
    ...(initialToken ? { initialToken } : {})
  }
}

export function dsBotHandleForAccount(meta: Pick<DsBotAccountMetadata, 'mode' | 'baseUrl' | 'relayServer' | 'hostName' | 'hostDeviceId'>): string {
  if (meta.mode === 'relay') {
    const label = meta.hostName || meta.hostDeviceId?.slice(0, 12) || 'Relay'
    try {
      const host = meta.relayServer ? new URL(meta.relayServer).host : ''
      return host ? `${label} · ${host}` : label
    } catch {
      return label
    }
  }
  if (meta.baseUrl) {
    try {
      const u = new URL(meta.baseUrl)
      const path = u.pathname && u.pathname !== '/' ? u.pathname : ''
      return `${u.host}${path}`
    } catch {
      return meta.baseUrl
    }
  }
  return 'DS Bot'
}

export function sameDsBotOrigin(a?: string, b?: string): boolean {
  if (!a || !b) return false
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function readRawStore(): StoredDsBotAccountMap {
  return readJsonFile<StoredDsBotAccountMap>(
    storePath(),
    {},
    (raw) => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
  )
}

function writeRawStore(data: StoredDsBotAccountMap): void {
  writeJsonAtomic(storePath(), data, 0o600)
}

function isEncryptionAvailable(): boolean {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSecret(secret: string): string {
  if (!isEncryptionAvailable()) {
    throw new Error('系统钥匙串加密（safeStorage）当前不可用，已拒绝明文保存 DS Bot 凭据')
  }
  return safeStorage.encryptString(secret).toString('base64')
}

function decryptSecret(encBase64: string | undefined): string | undefined {
  if (!encBase64) return undefined
  if (!isEncryptionAvailable()) {
    throw new Error('系统钥匙串加密（safeStorage）不可用，无法解密 DS Bot 凭据')
  }
  return safeStorage.decryptString(Buffer.from(encBase64, 'base64'))
}

function metadataOf(accountId: string, rec: StoredDsBotAccountRecord): DsBotAccountMetadata {
  return {
    accountId,
    mode: rec.mode,
    displayName: rec.displayName,
    baseUrl: rec.baseUrl,
    hasSecret: Boolean(rec.secretEnc || (rec.privateKeyEnc && rec.accessTokenEnc)),
    relayServer: rec.relayServer,
    hostDeviceId: rec.hostDeviceId,
    hostKey: rec.hostKey,
    hostName: rec.hostName,
    deviceId: rec.deviceId,
    publicKey: rec.publicKey,
    updatedAtMs: rec.updatedAtMs
  }
}

export function getDsBotAccount(accountId: string): ResolvedDsBotAccount | null {
  const id = (accountId ?? '').trim()
  if (!id) return null
  const rec = readRawStore()[id]
  if (!rec?.mode) return null
  return {
    ...metadataOf(id, rec),
    secret: decryptSecret(rec.secretEnc),
    privateKey: decryptSecret(rec.privateKeyEnc),
    accessToken: decryptSecret(rec.accessTokenEnc)
  }
}

export function getDsBotAccountMetadata(accountId: string): DsBotAccountMetadata | null {
  const rec = readRawStore()[accountId]
  return rec?.mode ? metadataOf(accountId, rec) : null
}

export function listDsBotAccountRecords(): DsBotAccountMetadata[] {
  return Object.entries(readRawStore())
    .filter(([, rec]) => Boolean(rec?.mode))
    .map(([accountId, rec]) => metadataOf(accountId, rec))
}

export function getDsBotAccountRevision(accountId: string): symbol {
  return accountRevisions.get(accountId) ?? defaultRevision
}

export async function saveDsBotAccount(args: {
  accountId: string
  mode: DsBotTransportMode
  expectedRevision: symbol
  displayName?: string
  baseUrl?: string
  secret?: string
  keepExistingSecret?: boolean
  relayServer?: string
  hostDeviceId?: string
  hostKey?: string
  hostName?: string
  deviceId?: string
  publicKey?: string
  privateKey?: string
  accessToken?: string
}): Promise<DsBotAccountMetadata> {
  const id = (args.accountId ?? '').trim()
  if (!id) throw new Error('accountId required')

  return withStoreLock(async () => {
    if (args.expectedRevision !== getDsBotAccountRevision(id)) {
      throw new Error('验证期间 DS Bot 账号配置已更改，请重试')
    }
    const store = readRawStore()
    const prev = store[id]
    const next: StoredDsBotAccountRecord = {
      mode: args.mode,
      displayName: args.displayName?.trim() || prev?.displayName || undefined,
      updatedAtMs: Date.now()
    }

    if (args.mode === 'mcp' || args.mode === 'channel') {
      const normalized =
        args.mode === 'mcp'
          ? normalizeDsBotMcpUrl(args.baseUrl ?? '')
          : normalizeDsBotChannelUrl(args.baseUrl ?? '').baseUrl
      next.baseUrl = normalized
      const trimmedSecret = typeof args.secret === 'string' ? args.secret.trim() : ''
      if (trimmedSecret) {
        next.secretEnc = encryptSecret(trimmedSecret)
      } else if (args.keepExistingSecret && prev?.secretEnc && sameDsBotOrigin(normalized, prev.baseUrl)) {
        next.secretEnc = prev.secretEnc
      }
    } else {
      next.relayServer = args.relayServer
      next.hostDeviceId = args.hostDeviceId
      next.hostKey = args.hostKey
      next.hostName = args.hostName?.trim() || prev?.hostName
      next.deviceId = args.deviceId
      next.publicKey = args.publicKey
      if (args.privateKey) next.privateKeyEnc = encryptSecret(args.privateKey)
      else if (prev?.privateKeyEnc) next.privateKeyEnc = prev.privateKeyEnc
      if (args.accessToken) next.accessTokenEnc = encryptSecret(args.accessToken)
      else if (prev?.accessTokenEnc) next.accessTokenEnc = prev.accessTokenEnc
    }

    store[id] = next
    writeRawStore(store)
    accountRevisions.set(id, Symbol())
    return metadataOf(id, next)
  })
}

export async function clearDsBotAccount(accountId: string): Promise<void> {
  const id = (accountId ?? '').trim()
  if (!id) return
  await withStoreLock(async () => {
    if (id === '*') {
      writeRawStore({})
      accountRevisions.clear()
      defaultRevision = Symbol()
      return
    }
    const store = readRawStore()
    if (id in store) {
      delete store[id]
      writeRawStore(store)
    }
    accountRevisions.set(id, Symbol())
  })
}

/**
 * Detect local DS Bot installation configuration on disk (safe metadata only —
 * never reads or exposes tokens/keys). Checks:
 * - DS Bot Desktop `locations.json` / `host-port.json`
 * - Default DS Bot home `~/.ds-bot/mcp.json`
 * - DSH plugin home `~/.dsh/bot/mcp.json` (and `DSH_HOME/bot/mcp.json`)
 */
export function detectLocalDsBotDiskConfig(): LocalDsBotDiskInfo {
  const home = homedir()
  const desktopUserDataCandidates: string[] = []
  if (process.platform === 'darwin') {
    desktopUserDataCandidates.push(join(home, 'Library', 'Application Support', 'DS Bot'))
  } else if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) desktopUserDataCandidates.push(join(appData, 'DS Bot'))
  } else {
    desktopUserDataCandidates.push(join(home, '.config', 'DS Bot'))
  }

  let channelPort: number | undefined
  let customDataDir: string | undefined

  for (const dir of desktopUserDataCandidates) {
    const locPath = join(dir, 'locations.json')
    if (!customDataDir && existsSync(locPath)) {
      try {
        const parsed = JSON.parse(readFileSync(locPath, 'utf8')) as { dataDir?: unknown }
        if (typeof parsed.dataDir === 'string' && parsed.dataDir.trim()) {
          customDataDir = parsed.dataDir.trim()
        }
      } catch {
        /* ignore */
      }
    }
    const hostPortPath = join(dir, 'host-port.json')
    if (channelPort === undefined && existsSync(hostPortPath)) {
      try {
        const parsed = JSON.parse(readFileSync(hostPortPath, 'utf8')) as { port?: unknown }
        if (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) {
          channelPort = parsed.port
        }
      } catch {
        /* ignore */
      }
    }
  }

  const dshHome = process.env['DSH_HOME']?.trim()
  const dsBotHomeEnv = process.env['DS_BOT_HOME']?.trim()
  const mcpCandidates = [
    ...(dsBotHomeEnv ? [join(dsBotHomeEnv, 'bot', 'mcp.json'), join(dsBotHomeEnv, 'mcp.json')] : []),
    ...(customDataDir ? [join(customDataDir, 'bot', 'mcp.json'), join(customDataDir, 'mcp.json')] : []),
    join(home, '.ds-bot', 'bot', 'mcp.json'),
    join(home, '.ds-bot', 'mcp.json'),
    ...(dshHome ? [join(dshHome, 'bot', 'mcp.json')] : []),
    join(home, '.dsh', 'bot', 'mcp.json')
  ]

  let mcpPort = DEFAULT_MCP_PORT
  let mcpEnabledInConfig = false
  let mcpConfigPath: string | undefined
  let dataDir = customDataDir

  for (const file of mcpCandidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { on?: unknown; port?: unknown }
      mcpConfigPath = file
      if (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) {
        mcpPort = parsed.port
      }
      mcpEnabledInConfig = parsed.on === true
      if (!dataDir) dataDir = file.replace(/[\\/]mcp\.json$/, '')
      break
    } catch {
      /* ignore malformed config */
    }
  }

  return {
    mcpPort,
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    mcpEnabledInConfig,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(channelPort !== undefined ? { channelPort, channelUrl: `http://127.0.0.1:${channelPort}` } : {}),
    ...(dataDir ? { dataDir } : {})
  }
}
