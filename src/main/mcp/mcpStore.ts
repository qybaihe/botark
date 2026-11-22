import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { createMutex } from '@shared/proxyPool'
import type { McpConfigScope, McpServerSource, McpTransportType } from '@shared/workspace'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'
import type { ParsedMcpServer } from './configParser'

const STORE_FILE = 'mcp-registry.json'
const withStoreLock = createMutex()

export interface StoredMcpSecrets {
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface StoredMcpServerRecord {
  name: string
  transport: McpTransportType | 'auto'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envKeys?: string[]
  headerKeys?: string[]
  secretsEnc?: string
  enabled: boolean
  needsConfig?: boolean
  source: McpServerSource
  updatedAtMs: number
}

export interface StoredScopeState {
  directory?: string
  servers: Record<string, StoredMcpServerRecord>
}

export interface TrustedDirectoryRecord {
  realpath: string
  trustedAtMs: number
  optimizedAtMs?: number
}

export interface McpRegistryFile {
  version: 1
  globalServers: Record<string, StoredMcpServerRecord>
  scopes: Record<string, StoredScopeState>
  trustedDirectories: Record<string, TrustedDirectoryRecord>
}

export interface HydratedMcpServer {
  config: ParsedMcpServer
  source: McpServerSource
  envKeys: string[]
  headerKeys: string[]
  decryptError?: string
}

export interface HydratedRegistry {
  globalServers: Map<string, HydratedMcpServer>
  scopes: Map<
    string,
    {
      directory?: string
      trusted: boolean
      servers: Map<string, HydratedMcpServer>
    }
  >
  trustedDirectories: Record<string, TrustedDirectoryRecord>
  persistedCount: number
}

function emptyRegistry(): McpRegistryFile {
  return {
    version: 1,
    globalServers: {},
    scopes: {},
    trustedDirectories: {}
  }
}

function isValidRegistry(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  return (
    obj['version'] === 1 &&
    Boolean(obj['globalServers']) &&
    typeof obj['globalServers'] === 'object' &&
    !Array.isArray(obj['globalServers']) &&
    Boolean(obj['scopes']) &&
    typeof obj['scopes'] === 'object' &&
    !Array.isArray(obj['scopes']) &&
    Boolean(obj['trustedDirectories']) &&
    typeof obj['trustedDirectories'] === 'object' &&
    !Array.isArray(obj['trustedDirectories'])
  )
}

function resolveUserDataDir(): string {
  try {
    if (app && typeof app.getPath === 'function') {
      const dir = app.getPath('userData')
      if (dir) return dir
    }
  } catch {
    /* ignore in isolated tests */
  }
  return process.env['BOTARK_TEST_USER_DATA'] || join(tmpdir(), 'botark-mcp-test')
}

export function getMcpRegistryPath(): string {
  return join(resolveUserDataDir(), STORE_FILE)
}

function readRawRegistry(): McpRegistryFile {
  return readJsonFile<McpRegistryFile>(getMcpRegistryPath(), emptyRegistry(), isValidRegistry)
}

function writeRawRegistry(data: McpRegistryFile): void {
  writeJsonAtomic(getMcpRegistryPath(), data, 0o600)
}

export async function isMcpEncryptionAvailable(): Promise<boolean> {
  try {
    if (typeof safeStorage?.isAsyncEncryptionAvailable === 'function') {
      return await safeStorage.isAsyncEncryptionAvailable()
    }
    if (typeof safeStorage?.isEncryptionAvailable === 'function') {
      return safeStorage.isEncryptionAvailable()
    }
  } catch {
    /* unavailable */
  }
  return false
}

async function encryptSecrets(secrets: StoredMcpSecrets): Promise<string> {
  const available = await isMcpEncryptionAvailable()
  if (!available) {
    throw new Error('系统钥匙串加密（safeStorage）当前不可用，已拒绝明文保存 MCP 密钥（env/headers）')
  }
  const plaintext = JSON.stringify(secrets)
  if (typeof safeStorage.encryptStringAsync === 'function') {
    const buf = await safeStorage.encryptStringAsync(plaintext)
    return buf.toString('base64')
  }
  return safeStorage.encryptString(plaintext).toString('base64')
}

async function decryptSecrets(encBase64: string): Promise<StoredMcpSecrets> {
  const available = await isMcpEncryptionAvailable()
  if (!available) {
    throw new Error('系统钥匙串加密（safeStorage）当前不可用，无法解密 MCP 密钥')
  }
  const buf = Buffer.from(encBase64, 'base64')
  let plaintext: string
  if (typeof safeStorage.decryptStringAsync === 'function') {
    const out = await safeStorage.decryptStringAsync(buf)
    plaintext = out.result
  } else {
    plaintext = safeStorage.decryptString(buf)
  }
  const parsed = JSON.parse(plaintext) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('已加密的 MCP 密钥格式损坏')
  }
  return parsed as StoredMcpSecrets
}

function hasNonEmptyRecord(rec?: Record<string, string>): boolean {
  return Boolean(rec && Object.keys(rec).length > 0)
}

async function toStoredRecord(
  server: ParsedMcpServer,
  source: McpServerSource
): Promise<StoredMcpServerRecord> {
  const envKeys = hasNonEmptyRecord(server.env) ? Object.keys(server.env!) : undefined
  const headerKeys = hasNonEmptyRecord(server.headers) ? Object.keys(server.headers!) : undefined
  let secretsEnc: string | undefined
  if (envKeys || headerKeys) {
    secretsEnc = await encryptSecrets({
      ...(envKeys ? { env: server.env } : {}),
      ...(headerKeys ? { headers: server.headers } : {})
    })
  }
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(envKeys ? { envKeys } : {}),
    ...(headerKeys ? { headerKeys } : {}),
    ...(secretsEnc ? { secretsEnc } : {}),
    enabled: server.enabled,
    ...(server.needsConfig ? { needsConfig: true } : {}),
    source,
    updatedAtMs: Date.now()
  }
}

async function hydrateRecord(rec: StoredMcpServerRecord): Promise<HydratedMcpServer> {
  let secrets: StoredMcpSecrets = {}
  let decryptError: string | undefined
  if (rec.secretsEnc) {
    try {
      secrets = await decryptSecrets(rec.secretsEnc)
    } catch {
      decryptError = '无法解密已保存的密钥（env/headers），请重新编辑配置'
    }
  }
  return {
    config: {
      name: rec.name,
      transport: rec.transport,
      ...(rec.command !== undefined ? { command: rec.command } : {}),
      ...(rec.args !== undefined ? { args: rec.args } : {}),
      ...(secrets.env ? { env: secrets.env } : {}),
      ...(rec.cwd !== undefined ? { cwd: rec.cwd } : {}),
      ...(rec.url !== undefined ? { url: rec.url } : {}),
      ...(secrets.headers ? { headers: secrets.headers } : {}),
      enabled: rec.enabled,
      needsConfig: Boolean(rec.needsConfig) || Boolean(decryptError),
      unresolvedVars: []
    },
    source: rec.source,
    envKeys: rec.envKeys ?? (secrets.env ? Object.keys(secrets.env) : []),
    headerKeys: rec.headerKeys ?? (secrets.headers ? Object.keys(secrets.headers) : []),
    ...(decryptError ? { decryptError } : {})
  }
}

async function verifyTrustedDirectory(
  candidate: string | undefined,
  trustedMap: Record<string, TrustedDirectoryRecord>
): Promise<{ directory?: string; trusted: boolean }> {
  if (!candidate) return { directory: undefined, trusted: false }
  try {
    const resolved = await realpath(candidate)
    const info = await stat(resolved)
    if (!info.isDirectory()) return { directory: undefined, trusted: false }
    const rec = trustedMap[resolved] ?? trustedMap[candidate]
    const trusted = Boolean(rec && rec.realpath === resolved)
    return trusted ? { directory: resolved, trusted: true } : { directory: undefined, trusted: false }
  } catch {
    return { directory: undefined, trusted: false }
  }
}

export async function loadMcpRegistry(): Promise<HydratedRegistry> {
  return withStoreLock(async () => {
    const raw = readRawRegistry()
    const globalServers = new Map<string, HydratedMcpServer>()
    for (const [name, rec] of Object.entries(raw.globalServers)) {
      if (!rec || typeof rec !== 'object') continue
      globalServers.set(name, await hydrateRecord(rec))
    }

    const scopes = new Map<
      string,
      { directory?: string; trusted: boolean; servers: Map<string, HydratedMcpServer> }
    >()
    for (const [scopeId, storedScope] of Object.entries(raw.scopes)) {
      if (!storedScope || typeof storedScope !== 'object') continue
      const { directory, trusted } = await verifyTrustedDirectory(
        storedScope.directory,
        raw.trustedDirectories
      )
      const servers = new Map<string, HydratedMcpServer>()
      for (const [name, rec] of Object.entries(storedScope.servers ?? {})) {
        if (!rec || typeof rec !== 'object') continue
        servers.set(name, await hydrateRecord(rec))
      }
      scopes.set(scopeId, { directory, trusted, servers })
    }

    let persistedCount = globalServers.size
    for (const sc of scopes.values()) persistedCount += sc.servers.size

    return {
      globalServers,
      scopes,
      trustedDirectories: { ...raw.trustedDirectories },
      persistedCount
    }
  })
}

export async function savePersistedServer(args: {
  targetScope: McpConfigScope
  scopeId: string
  server: ParsedMcpServer
  source: McpServerSource
  previousName?: string
}): Promise<number> {
  const record = await toStoredRecord(args.server, args.source)
  return withStoreLock(async () => {
    const raw = readRawRegistry()
    if (args.targetScope === 'global' || args.scopeId === '__global__') {
      if (args.previousName && args.previousName !== args.server.name) {
        delete raw.globalServers[args.previousName]
      }
      raw.globalServers[args.server.name] = record
    } else {
      const existingScope = raw.scopes[args.scopeId] ?? { servers: {} }
      if (args.previousName && args.previousName !== args.server.name) {
        delete existingScope.servers[args.previousName]
      }
      existingScope.servers[args.server.name] = record
      raw.scopes[args.scopeId] = existingScope
    }
    writeRawRegistry(raw)
    return countPersisted(raw)
  })
}

export async function savePersistedServersBatch(args: {
  targetScope: McpConfigScope
  scopeId: string
  servers: Array<{ server: ParsedMcpServer; source: McpServerSource }>
}): Promise<number> {
  const records: Array<[string, StoredMcpServerRecord]> = []
  for (const item of args.servers) {
    records.push([item.server.name, await toStoredRecord(item.server, item.source)])
  }
  return withStoreLock(async () => {
    const raw = readRawRegistry()
    if (args.targetScope === 'global' || args.scopeId === '__global__') {
      for (const [name, rec] of records) {
        raw.globalServers[name] = rec
      }
    } else {
      const existingScope = raw.scopes[args.scopeId] ?? { servers: {} }
      for (const [name, rec] of records) {
        existingScope.servers[name] = rec
      }
      raw.scopes[args.scopeId] = existingScope
    }
    writeRawRegistry(raw)
    return countPersisted(raw)
  })
}

export async function removePersistedServer(args: {
  targetScope: McpConfigScope
  scopeId: string
  serverName: string
}): Promise<number> {
  return withStoreLock(async () => {
    const raw = readRawRegistry()
    if (args.targetScope === 'global' || args.scopeId === '__global__') {
      delete raw.globalServers[args.serverName]
    } else if (raw.scopes[args.scopeId]) {
      delete raw.scopes[args.scopeId]!.servers[args.serverName]
    }
    writeRawRegistry(raw)
    return countPersisted(raw)
  })
}

export async function saveScopeDirectory(args: {
  scopeId: string
  directory?: string
  optimizedAtMs?: number
}): Promise<void> {
  return withStoreLock(async () => {
    const raw = readRawRegistry()
    const existingScope = raw.scopes[args.scopeId] ?? { servers: {} }
    if (args.directory) {
      existingScope.directory = args.directory
      raw.scopes[args.scopeId] = existingScope
      const prevTrust = raw.trustedDirectories[args.directory]
      raw.trustedDirectories[args.directory] = {
        realpath: args.directory,
        trustedAtMs: prevTrust?.trustedAtMs ?? Date.now(),
        ...(args.optimizedAtMs !== undefined
          ? { optimizedAtMs: args.optimizedAtMs }
          : prevTrust?.optimizedAtMs !== undefined
            ? { optimizedAtMs: prevTrust.optimizedAtMs }
            : {})
      }
    } else {
      delete existingScope.directory
      raw.scopes[args.scopeId] = existingScope
    }
    writeRawRegistry(raw)
  })
}

export async function isPersistedDirectoryTrusted(realRoot: string): Promise<boolean> {
  return withStoreLock(async () => {
    const raw = readRawRegistry()
    const rec = raw.trustedDirectories[realRoot]
    return Boolean(rec && rec.realpath === realRoot)
  })
}

function countPersisted(raw: McpRegistryFile): number {
  let count = Object.keys(raw.globalServers).length
  for (const sc of Object.values(raw.scopes)) {
    count += Object.keys(sc.servers ?? {}).length
  }
  return count
}
