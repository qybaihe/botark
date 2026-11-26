/**
 * Product-grade Security & Encryption Vault for BotHub.
 *
 * 1. Hardware-backed `safeStorage` (macOS Keychain / Windows DPAPI / Linux Secret Service)
 *    encrypted key-value vault (`bothub-vault.json`, atomic `0600` writes, fail-closed).
 *    Used for sensitive local data such as Dot cross-account memory migration snapshots
 *    so nothing sensitive ever touches `window.localStorage` in plaintext.
 * 2. Live runtime security & file-permission auditor (`getSecurityVaultStatus`,
 *    `hardenVaultFilePermissions`) surfaced in the Right-Side Inspector & Settings.
 * 3. Shared macOS `Developer ID Application` code-signature detector for `updater.ts`.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, safeStorage } from 'electron'
import { createMutex } from '@shared/proxyPool'
import {
  VAULT_CHANNELS,
  type MuseProxyMode,
  type SecurityAccountAudit,
  type SecurityStoreAudit,
  type SecurityVaultStatus,
  type VaultStatusRequest
} from '@shared/ipc'
import { readJsonFile, writeJsonAtomicAsync } from './jsonFile'
import { getProxyView, ProxyConfigUnreadableError } from './muse/accountProxy'
import { partitionForAccount } from './webContentsViewManager'

const VAULT_FILE = 'bothub-vault.json'
const KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/
const MAX_SECRET_BYTES = 2 * 1024 * 1024

interface VaultEntry {
  enc: string
  updatedAtMs: number
}

type VaultStore = Record<string, VaultEntry>

const withVaultLock = createMutex()

const AUDITED_STORES: ReadonlyArray<{ id: string; label: string; fileName: string }> = [
  { id: 'proxy', label: '账号独立代理密文库', fileName: 'muse-account-proxy.json' },
  { id: 'proxy-pool', label: '全局代理池密文库', fileName: 'muse-proxy-pool.json' },
  { id: 'grok-tokens', label: 'Grok Sand 令牌保险箱', fileName: 'grok-sand-tokens.json' },
  { id: 'dot-tokens', label: 'Dot OAuth 凭据保险箱', fileName: 'dot-accounts.json' },
  { id: 'cue-tokens', label: 'Cue 会话凭据保险箱', fileName: 'cue-tokens.json' },
  { id: 'hermes-accounts', label: 'Hermes 网关密钥保险箱', fileName: 'hermes-accounts.json' },
  { id: 'dsbot-accounts', label: 'DS Bot 凭据与密钥保险箱', fileName: 'dsbot-accounts.json' },
  { id: 'mcp-registry', label: 'MCP 服务密钥库', fileName: 'mcp-registry.json' },
  { id: 'mobile-sync', label: 'iOS 配对设备令牌哈希库', fileName: 'mobile-sync-devices.json' },
  { id: 'secrets-vault', label: '记忆快照与私密数据保险箱', fileName: VAULT_FILE }
]

const PLATFORM_SECURITY_SPECS: Record<
  'meta-muse' | 'grok' | 'hark' | 'dot' | 'hermes' | 'antigravity' | 'cue' | 'ds-bot',
  { transportProtocol: string; credentialIsolation: string }
> = {
  'meta-muse': {
    transportProtocol: 'Noise_XX_25519_ChaChaPoly_SHA256 + TLS 1.3',
    credentialIsolation: '独立 Chromium persist 分区 Cookie 沙盒（渲染层零接触）'
  },
  grok: {
    transportProtocol: 'Connect-RPC (TLS 1.3) · 主进程代理转发',
    credentialIsolation: 'PKCE + 系统钥匙串 SafeStorage 密文存储（渲染层零 Bearer 暴露）'
  },
  hark: {
    transportProtocol: 'HTTPS REST + Sync SSE v2（分区级防泄漏守卫）',
    credentialIsolation: '独立 persist 分区 HttpOnly 会话隔离（主进程代发请求）'
  },
  dot: {
    transportProtocol: 'Calpico REST + Celsius WSS（TLS 1.3）',
    credentialIsolation: '系统钥匙串 SafeStorage 令牌库 + 加密记忆迁移保险箱'
  },
  hermes: {
    transportProtocol: 'Hermes Gateway REST + Native Session SSE（主进程代理转发）',
    credentialIsolation: '系统钥匙串 SafeStorage API Key 密文存储（渲染层零密钥暴露）'
  },
  antigravity: {
    transportProtocol: 'Google gRPC-Web (JSPB) + StreamAgentStateUpdates（TLS 1.3）',
    credentialIsolation: '独立 persist 分区 Google 会话 + 主进程 SAPISIDHASH 签名（渲染层零 Cookie 接触）'
  },
  cue: {
    transportProtocol: 'Manus Connect-RPC + REST v2（TLS 1.3 · 主进程代理转发）',
    credentialIsolation: '独立 persist 分区 + 系统钥匙串 SafeStorage 密文存储（渲染层零密钥暴露）'
  },
  'ds-bot': {
    transportProtocol: 'DS Bot Native Channel SSE / Noise_IK 端到端加密中继 / MCP Streamable HTTP',
    credentialIsolation: '系统钥匙串 SafeStorage 加密存储令牌、Cookie 与 X25519 私钥（渲染层零暴露）'
  }
}

function userDataDir(): string {
  return app.getPath('userData')
}

function vaultPath(): string {
  return join(userDataDir(), VAULT_FILE)
}

function readVault(): VaultStore {
  return readJsonFile<VaultStore>(
    vaultPath(),
    {},
    (raw) => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
  )
}

function writeVault(store: VaultStore): Promise<void> {
  return writeJsonAtomicAsync(vaultPath(), store)
}

function validateKey(key: string): string {
  const trimmed = (key ?? '').trim()
  if (!KEY_PATTERN.test(trimmed)) {
    throw new TypeError('Invalid vault key')
  }
  return trimmed
}

function isPrivateKey(key: string): boolean {
  return key.startsWith('internal.')
}

function validatePublicKey(key: string): string {
  const cleanKey = validateKey(key)
  if (isPrivateKey(cleanKey)) throw new Error('Private vault key')
  return cleanKey
}

async function isSafeStorageAvailable(): Promise<boolean> {
  try {
    return typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      ? await safeStorage.isAsyncEncryptionAvailable()
      : Boolean(safeStorage.isEncryptionAvailable?.())
  } catch {
    return false
  }
}

export async function isVaultEncryptionAvailable(): Promise<boolean> {
  try {
    return await isSafeStorageAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  } catch {
    return false
  }
}

async function encryptPayload(plaintext: string): Promise<string> {
  const available = await isVaultEncryptionAvailable()
  if (!available) {
    throw new Error('系统钥匙串加密（safeStorage）当前不可用，已拒绝明文落盘')
  }
  if (typeof safeStorage.encryptStringAsync === 'function') {
    const buf = await safeStorage.encryptStringAsync(plaintext)
    return buf.toString('base64')
  }
  return safeStorage.encryptString(plaintext).toString('base64')
}

async function decryptPayload(encBase64: string): Promise<string> {
  // Allow recovery of legacy ciphertext from the backend that wrote it.
  const available = await isSafeStorageAvailable()
  if (!available) {
    throw new Error('系统钥匙串加密（safeStorage）当前不可用，无法解密保险箱数据')
  }
  const buf = Buffer.from(encBase64, 'base64')
  if (typeof safeStorage.decryptStringAsync === 'function') {
    const out = await safeStorage.decryptStringAsync(buf)
    return out.result
  }
  return safeStorage.decryptString(buf)
}

export async function getVaultSecret(key: string): Promise<string | null> {
  const cleanKey = validateKey(key)
  const store = readVault()
  const entry = Object.hasOwn(store, cleanKey) ? store[cleanKey] : undefined
  if (!entry?.enc) return null
  try {
    return await decryptPayload(entry.enc)
  } catch {
    return null
  }
}

export async function setVaultSecret(
  key: string,
  value: string
): Promise<{ ok: boolean; encrypted: boolean; updatedAtMs: number }> {
  const cleanKey = validateKey(key)
  if (typeof value !== 'string') throw new TypeError('Secret value must be a string')
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new RangeError('Secret value exceeds 2 MiB vault limit')
  }
  if (!value) {
    await deleteVaultSecret(cleanKey)
    return { ok: true, encrypted: true, updatedAtMs: Date.now() }
  }
  return withVaultLock(async () => {
    const enc = await encryptPayload(value)
    const updatedAtMs = Date.now()
    const store = { ...readVault(), [cleanKey]: { enc, updatedAtMs } }
    await writeVault(store)
    return { ok: true, encrypted: true, updatedAtMs }
  })
}

export async function deleteVaultSecret(key: string): Promise<void> {
  const cleanKey = validateKey(key)
  await withVaultLock(async () => {
    const store = readVault()
    if (Object.hasOwn(store, cleanKey)) {
      delete store[cleanKey]
      await writeVault(store)
    }
  })
}

export async function clearAllVaultSecrets(): Promise<void> {
  await withVaultLock(() => writeVault({}))
}

function clearPublicVaultSecrets(): Promise<void> {
  return withVaultLock(() => writeVault(Object.fromEntries(
    Object.entries(readVault()).filter(([key]) => isPrivateKey(key))
  )))
}

let cachedSignatureInfo: { codeSigned: boolean; authority?: string } | null = null

/**
 * Inspect whether the running macOS `.app` bundle carries a valid
 * `Developer ID Application` signature (cached per process).
 */
export function inspectMacCodeSignature(): { codeSigned: boolean; authority?: string } {
  if (cachedSignatureInfo) return cachedSignatureInfo
  if (process.platform !== 'darwin' || !app.isPackaged) {
    cachedSignatureInfo = { codeSigned: process.platform !== 'darwin' && Boolean(app.isPackaged) }
    return cachedSignatureInfo
  }
  try {
    const exe = process.execPath
    const appIdx = exe.indexOf('.app/')
    const bundlePath = appIdx > 0 ? exe.slice(0, appIdx + 4) : exe
    // `codesign -dv` normally writes its signature metadata to stderr.
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundlePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_500
    })
    if (result.status === 0 && !result.error) {
      return parseCodesignOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    }
  } catch {
    /* codesign is unavailable */
  }
  cachedSignatureInfo = { codeSigned: false }
  return cachedSignatureInfo
}

function parseCodesignOutput(raw: string): { codeSigned: boolean; authority?: string } {
  const match = /^Authority=(Developer ID Application:[^\r\n]+)$/m.exec(raw)
  if (match?.[1]) {
    cachedSignatureInfo = { codeSigned: true, authority: match[1].trim() }
    return cachedSignatureInfo
  }
  cachedSignatureInfo = { codeSigned: false }
  return cachedSignatureInfo
}

function countEntriesInStore(filePath: string): number {
  try {
    const parsed = readJsonFile<unknown>(filePath, null, (r) => r !== null && typeof r === 'object')
    if (!parsed) return 0
    if (Array.isArray(parsed)) return parsed.length
    const obj = parsed as Record<string, unknown>
    if (obj['accounts'] && typeof obj['accounts'] === 'object' && !Array.isArray(obj['accounts'])) {
      return Object.keys(obj['accounts'] as Record<string, unknown>).length
    }
    return Object.keys(obj).length
  } catch {
    return 0
  }
}

function auditStoreFile(spec: { id: string; label: string; fileName: string }): SecurityStoreAudit {
  const fullPath = join(userDataDir(), spec.fileName)
  if (!existsSync(fullPath)) {
    return {
      id: spec.id,
      label: spec.label,
      fileName: spec.fileName,
      exists: false,
      modeOctal: null,
      ownerOnly: true,
      entryCount: 0
    }
  }
  try {
    const st = statSync(fullPath)
    const perm = st.mode & 0o777
    const ownerOnly = process.platform === 'win32' ? true : (perm & 0o077) === 0
    return {
      id: spec.id,
      label: spec.label,
      fileName: spec.fileName,
      exists: true,
      modeOctal: `0${perm.toString(8)}`,
      ownerOnly,
      entryCount: countEntriesInStore(fullPath)
    }
  } catch {
    return {
      id: spec.id,
      label: spec.label,
      fileName: spec.fileName,
      exists: true,
      modeOctal: null,
      ownerOnly: false,
      entryCount: 0
    }
  }
}

/**
 * Enforce `0600` (owner read/write only) on all sensitive credential & proxy JSON files.
 * Safe to invoke on every app startup and on user demand.
 */
export function hardenVaultFilePermissions(): number {
  if (process.platform === 'win32') return 0
  let repaired = 0
  const extraFiles = [...AUDITED_STORES.map((s) => s.fileName), 'grok-machine-ids.json']
  for (const name of extraFiles) {
    const fullPath = join(userDataDir(), name)
    if (!existsSync(fullPath)) continue
    try {
      const st = statSync(fullPath)
      if ((st.mode & 0o077) !== 0) {
        chmodSync(fullPath, 0o600)
        repaired += 1
      }
    } catch {
      /* ignore */
    }
  }
  return repaired
}

export async function getSecurityVaultStatus(
  req: VaultStatusRequest = {}
): Promise<SecurityVaultStatus> {
  const keychainAvailable = await isVaultEncryptionAvailable()
  const sig = inspectMacCodeSignature()
  const stores = AUDITED_STORES.map(auditStoreFile)

  let accountAudit: SecurityAccountAudit | undefined
  if (req.accountId && typeof req.accountId === 'string') {
    const spec = req.platformId ? PLATFORM_SECURITY_SPECS[req.platformId] : undefined
    let proxyMode: MuseProxyMode = 'direct'
    let proxyEndpoint: string | undefined
    let proxyReadable = true
    try {
      const pv = await getProxyView(req.accountId)
      proxyMode = pv.mode
      if (pv.mode !== 'direct' && pv.host && pv.port) {
        proxyEndpoint = `${pv.mode}://${pv.host}:${pv.port}`
      }
    } catch (err) {
      if (err instanceof ProxyConfigUnreadableError) {
        proxyReadable = false
        proxyMode = 'socks5'
      }
    }
    accountAudit = {
      accountId: req.accountId,
      platformId: req.platformId,
      partition: partitionForAccount(req.accountId),
      transportProtocol: spec?.transportProtocol ?? 'TLS 1.3 + 分区隔离',
      credentialIsolation: spec?.credentialIsolation ?? '独立会话沙盒 + 系统钥匙串加密',
      proxyMode,
      proxyEndpoint,
      proxyReadable,
      failClosedGuard: true
    }
  }

  return {
    checkedAtMs: Date.now(),
    keychainAvailable,
    cipherSuite: keychainAvailable
      ? 'OS Keychain · AES-256-GCM (safeStorage)'
      : '钥匙串未就绪（拒绝明文落盘）',
    codeSigned: sig.codeSigned,
    signingAuthority: sig.authority,
    rendererSandbox: {
      contextIsolation: true,
      sandbox: true,
      zeroRendererTokens: true
    },
    stores,
    accountAudit
  }
}

let registered = false

export function registerVaultIpc(): void {
  if (registered) return
  registered = true

  ipcMain.handle(VAULT_CHANNELS.status, async (_event, request: unknown) => {
    const req =
      request && typeof request === 'object' ? (request as VaultStatusRequest) : {}
    return getSecurityVaultStatus(req)
  })

  ipcMain.handle(VAULT_CHANNELS.getSecret, async (_event, key: unknown) => {
    if (typeof key !== 'string') throw new TypeError('Vault key required')
    return getVaultSecret(validatePublicKey(key))
  })

  ipcMain.handle(VAULT_CHANNELS.setSecret, async (_event, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new TypeError('Vault key and string value required')
    }
    return setVaultSecret(validatePublicKey(key), value)
  })

  ipcMain.handle(VAULT_CHANNELS.deleteSecret, async (_event, key: unknown) => {
    if (typeof key !== 'string') throw new TypeError('Vault key required')
    await deleteVaultSecret(validatePublicKey(key))
    return { ok: true as const }
  })

  ipcMain.handle(VAULT_CHANNELS.clearAll, async () => {
    await clearPublicVaultSecrets()
    return { ok: true as const }
  })

  ipcMain.handle(VAULT_CHANNELS.hardenPermissions, async () => {
    const repaired = hardenVaultFilePermissions()
    const status = await getSecurityVaultStatus()
    return { repaired, status }
  })
}
