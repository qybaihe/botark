/**
 * Per-account BotHub client egress proxy (not a Muse RPC).
 * Persist via Electron safeStorage; apply to session partition + Noise WSS agent.
 */
import { join } from "node:path"
import { app, safeStorage, session as electronSession, type Session } from "electron"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { Agent } from "node:https"
import { partitionForAccount } from "../webContentsViewManager"
import { readJsonFile, writeJsonAtomic } from "../jsonFile"
import { ensureLocalProxyBridge } from "../localProxyBridge"
import { remoteDnsProxyUrl } from "../proxyUrl"
import { createMutex, planPoolAssignment, releasePoolSlot } from "@shared/proxyPool"

/** One lock for both proxy files: every change is read-modify-write across awaits. */
const withProxyStoreLock = createMutex()

export type MuseProxyMode = "direct" | "http" | "https" | "socks5" | "socks5h"

export interface MuseProxyConfig {
  mode: MuseProxyMode
  host?: string
  port?: number
  username?: string
  password?: string
}

interface StoredEntry {
  enc: string
}

type StoreFile = Record<string, StoredEntry>

function storePath(): string {
  return join(app.getPath("userData"), "muse-account-proxy.json")
}

function readStore(): StoreFile {
  return readJsonFile<StoreFile>(storePath(), {}, (raw) => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw))
}

function writeStore(store: StoreFile): void {
  writeJsonAtomic(storePath(), store)
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function formatHostForUrl(host: string): string {
  const clean = host.trim()
  if (clean.includes(":") && !clean.startsWith("[")) return `[${clean}]`
  return clean
}

function splitHostAndPort(
  hostPort: string,
  fallbackPort?: number
): { host: string; port: number; extraParts?: string[] } | null {
  const raw = hostPort.trim()
  if (!raw) return null

  if (raw.startsWith("[")) {
    const closeIdx = raw.indexOf("]")
    if (closeIdx <= 1) return null
    const host = raw.slice(0, closeIdx + 1)
    const rest = raw.slice(closeIdx + 1)
    if (!rest) {
      if (!fallbackPort) return null
      return { host, port: fallbackPort }
    }
    if (!rest.startsWith(":")) return null
    const afterColon = rest.slice(1).split(":")
    const port = Number(afterColon[0])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return {
      host,
      port,
      extraParts: afterColon.length > 1 ? afterColon.slice(1) : undefined
    }
  }

  const parts = raw.split(":")
  if (parts.length === 1) {
    if (!fallbackPort) return null
    const host = parts[0]!.trim()
    if (!host) return null
    return { host, port: fallbackPort }
  }

  // `host:port` or `host:port:username:password`
  const host = parts[0]!.trim()
  const port = Number(parts[1])
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    host,
    port,
    extraParts: parts.length > 2 ? parts.slice(2) : undefined
  }
}

function normalize(cfg: MuseProxyConfig | null | undefined): MuseProxyConfig {
  if (!cfg || cfg.mode === "direct") return { mode: "direct" }
  const rawHost = (cfg.host || "").trim()

  // If the user pasted a full URL (`https://user:pass@host:port`) or `host:port:user:pass`
  // into the single-account Host input, honor the scheme (`https` stays `https`) and credentials.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) || (!cfg.port && rawHost.includes(":"))) {
    const parsed = parseProxyLine(rawHost, cfg.mode)
    if (parsed && parsed.mode !== "direct" && parsed.host && parsed.port) {
      const explicitPort = Number(cfg.port)
      const validExplicitPort = Number.isInteger(explicitPort) && explicitPort >= 1 && explicitPort <= 65535
      return {
        mode: /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) ? parsed.mode : cfg.mode,
        host: parsed.host,
        port: /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) ? parsed.port : validExplicitPort ? explicitPort : parsed.port,
        username: cfg.username?.trim() || parsed.username || undefined,
        password: cfg.password || parsed.password || undefined
      }
    }
  }

  const host = rawHost
  const rawPort = cfg.port ?? (cfg.mode === "https" ? 443 : undefined)
  const port = Number(rawPort)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy host and port (1–65535) are required")
  }
  return {
    mode: cfg.mode,
    host,
    port,
    username: cfg.username?.trim() || undefined,
    password: cfg.password || undefined
  }
}

/** Public view never returns the password; only whether one is stored. */
export type MuseProxyView = {
  mode: MuseProxyMode
  host?: string
  port?: number
  username?: string
  hasPassword: boolean
}

/** A proxy is configured but cannot be read (keychain/safeStorage). Never go direct silently. */
export class ProxyConfigUnreadableError extends Error {
  constructor(detail?: string) {
    super(`代理配置无法读取（系统钥匙串/加密不可用${detail ? `：${detail}` : ""}），已阻止直连；请重新保存该账号的代理`)
    this.name = "ProxyConfigUnreadableError"
  }
}

/** Unreachable proxy used to block a partition whose real proxy cannot be read. */
const BLOCKING_PROXY_RULE = "http://127.0.0.1:9"

export async function loadProxyConfig(accountId: string): Promise<MuseProxyConfig> {
  const entry = readStore()[accountId]
  if (!entry?.enc) return { mode: "direct" }
  let available = false
  try {
    available = await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) throw new ProxyConfigUnreadableError()
  try {
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(entry.enc, "base64"))
    return normalize(JSON.parse(decrypted.result) as MuseProxyConfig)
  } catch (err) {
    throw new ProxyConfigUnreadableError(err instanceof Error ? err.message : undefined)
  }
}

export async function getProxyView(accountId: string): Promise<MuseProxyView> {
  const cfg = await loadProxyConfig(accountId)
  if (cfg.mode === "direct") return { mode: "direct", hasPassword: false }
  return {
    mode: cfg.mode,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    hasPassword: Boolean(cfg.password)
  }
}

export async function saveProxyConfig(accountId: string, input: MuseProxyConfig): Promise<MuseProxyView> {
  return withProxyStoreLock(() => saveProxyConfigUnlocked(accountId, input))
}

async function saveProxyConfigUnlocked(accountId: string, input: MuseProxyConfig): Promise<MuseProxyView> {
  const next = normalize(input)
  const store = readStore()
  if (next.mode === "direct") {
    delete store[accountId]
    writeStore(store)
    await applyProxyToPartition(accountId, next)
    return { mode: "direct", hasPassword: false }
  }
  // Keep previous password when UI sends empty password + has existing.
  if (!next.password) {
    const prev = await loadProxyConfig(accountId).catch(() => null)
    if (prev?.password) next.password = prev.password
  }
  const available = await safeStorage.isAsyncEncryptionAvailable()
  if (!available) {
    throw new Error("safeStorage encryption unavailable; refusing to store proxy credentials in plaintext")
  }
  const enc = await safeStorage.encryptStringAsync(JSON.stringify(next))
  store[accountId] = { enc: enc.toString("base64") }
  writeStore(store)
  await applyProxyToPartition(accountId, next)
  return {
    mode: next.mode,
    host: next.host,
    port: next.port,
    username: next.username,
    hasPassword: Boolean(next.password)
  }
}

export async function clearProxyConfig(accountId: string): Promise<void> {
  await withProxyStoreLock(() => {
    const store = readStore()
    delete store[accountId]
    writeStore(store)
  })
  await applyProxyToPartition(accountId, { mode: "direct" })
}

export function buildAccountProxyUrl(cfg: MuseProxyConfig): string | null {
  if (cfg.mode === "direct" || !cfg.host || !cfg.port) return null
  const auth =
    cfg.username && cfg.password
      ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
      : cfg.username
        ? `${encodeURIComponent(cfg.username)}@`
        : ""
  const host = formatHostForUrl(cfg.host)
  return `${cfg.mode}://${auth}${host}:${cfg.port}`
}

/**
 * Resolve the per-account proxy URL string (`http://...`, `https://...`, `socks5://...`, `socks5h://...`)
 * for Node-side `proxyFetch` / `proxyWsAgent` callers (Grok, Dot, Hermes, etc.).
 * Throws `ProxyConfigUnreadableError` if a proxy is configured on disk yet
 * `safeStorage` cannot decrypt it — never silently falls back to direct.
 */
export async function loadAccountProxyUrl(accountId: string): Promise<string | undefined> {
  const cfg = await loadProxyConfig(accountId)
  return buildAccountProxyUrl(cfg) ?? undefined
}

async function resolvePartitionProxyRules(cfg: MuseProxyConfig): Promise<string | null> {
  if (cfg.mode === "direct" || !cfg.host || !cfg.port) return null

  const hasAuth = Boolean(cfg.username || cfg.password)
  // Chromium's session.setProxy neither supports RFC 1929 SOCKS5 auth nor extracts
  // `user:pass@` from proxyRules, and HTTPS proxies need HTTP/1.1 ALPN CONNECT over TLS.
  // Route `https://` proxies and any authenticated proxy via a loopback-only local bridge.
  if (cfg.mode === "https" || hasAuth) {
    return ensureLocalProxyBridge({
      mode: cfg.mode,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password
    })
  }

  const host = formatHostForUrl(cfg.host)
  // Chromium's `socks5://` already performs remote DNS resolution on the SOCKS5 proxy,
  // whereas `socks5h://` is not a recognized scheme in Chromium's proxy string parser.
  const scheme = cfg.mode === "socks5h" ? "socks5" : cfg.mode
  return `${scheme}://${host}:${cfg.port}`
}

async function closePartitionConnections(ses: Electron.Session): Promise<void> {
  if (typeof ses.closeAllConnections === "function") {
    await ses.closeAllConnections().catch(() => undefined)
  }
}

const partitionProxies = new WeakMap<Session, {
  lock: ReturnType<typeof createMutex>
  applied?: string | null
}>()

export async function applyProxyToPartition(accountId: string, cfg?: MuseProxyConfig): Promise<void> {
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  let state = partitionProxies.get(ses)
  if (!state) {
    state = { lock: createMutex() }
    partitionProxies.set(ses, state)
  }
  const proxyState = state
  await proxyState.lock(async () => {
    const applyRules = async (rules: string | null): Promise<void> => {
      // Setting unchanged rules and closing the session would abort concurrent
      // requests and Hark's live response stream on this same partition.
      if (proxyState.applied === rules) return
      await ses.setProxy(rules
        ? { proxyRules: rules, proxyBypassRules: rules === BLOCKING_PROXY_RULE ? "" : "<local>" }
        : { mode: "system" })
      await closePartitionConnections(ses)
      proxyState.applied = rules
    }

    let rules: string | null
    try {
      rules = await resolvePartitionProxyRules(cfg ?? await loadProxyConfig(accountId))
    } catch (error) {
      // An unreadable or unusable configured proxy must not fall back to direct.
      await applyRules(BLOCKING_PROXY_RULE)
      throw error
    }
    await applyRules(rules)
  })
}

/** Node `ws` / HTTPS agent for Noise WSS (session.setProxy does not cover Node ws). */
export async function createProxyAgent(accountId: string): Promise<Agent | undefined> {
  const cfg = await loadProxyConfig(accountId)
  const url = buildAccountProxyUrl(cfg)
  if (!url) return undefined
  if (cfg.mode === "http" || cfg.mode === "https") return new HttpsProxyAgent(url) as unknown as Agent
  return new SocksProxyAgent(remoteDnsProxyUrl(url)) as unknown as Agent
}

export interface MuseProxyPoolItemView {
  id: string
  mode: Exclude<MuseProxyMode, "direct">
  host: string
  port: number
  username?: string
  hasPassword: boolean
  assignedAccountId?: string
}

interface StoredPoolItem {
  id: string
  enc: string
  assignedAccountId?: string
}

function poolStorePath(): string {
  return join(app.getPath("userData"), "muse-proxy-pool.json")
}

function readPoolStore(): StoredPoolItem[] {
  return readJsonFile<StoredPoolItem[]>(poolStorePath(), [], Array.isArray)
}

function writePoolStore(list: StoredPoolItem[]): void {
  writeJsonAtomic(poolStorePath(), list)
}

/** Parse one proxy line (`https://u:p@h:p`, `socks5://u:p@h:p`, `http://h:p`, `h:p:u:p`, `h:p`). */
export function parseProxyLine(
  line: string,
  defaultMode: Exclude<MuseProxyMode, "direct"> = "socks5"
): MuseProxyConfig | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null

  const schemeMatch = /^(https?|socks5h?|socks):\/\/(.+)$/i.exec(trimmed)
  if (schemeMatch) {
    const rawScheme = schemeMatch[1]!.toLowerCase()
    const mode: Exclude<MuseProxyMode, "direct"> =
      rawScheme === "https"
        ? "https"
        : rawScheme === "http"
          ? "http"
          : rawScheme === "socks5h"
            ? "socks5h"
            : "socks5"
    const rest = schemeMatch[2]!.replace(/[/?#].*$/, "")
    const atIdx = rest.lastIndexOf("@")
    const hostPortPart = atIdx >= 0 ? rest.slice(atIdx + 1) : rest
    const authPart = atIdx >= 0 ? rest.slice(0, atIdx) : ""
    const defaultPort = mode === "https" ? 443 : mode === "http" ? 80 : undefined
    const parsedHostPort = splitHostAndPort(hostPortPart, defaultPort)
    if (!parsedHostPort) return null

    let username: string | undefined
    let password: string | undefined
    if (authPart) {
      const cIdx = authPart.indexOf(":")
      if (cIdx >= 0) {
        username = safeDecodeURIComponent(authPart.slice(0, cIdx))
        password = safeDecodeURIComponent(authPart.slice(cIdx + 1))
      } else {
        username = safeDecodeURIComponent(authPart)
      }
    } else if (parsedHostPort.extraParts && parsedHostPort.extraParts.length > 0) {
      // Vendor format with scheme: `https://gate.provider.com:7000:user:pass`
      username = safeDecodeURIComponent(parsedHostPort.extraParts[0]?.trim() ?? "")
      password =
        parsedHostPort.extraParts.length > 1
          ? safeDecodeURIComponent(parsedHostPort.extraParts.slice(1).join(":"))
          : undefined
    }
    return {
      mode,
      host: parsedHostPort.host,
      port: parsedHostPort.port,
      username: username || undefined,
      password: password || undefined
    }
  }

  // `user:pass@host:port` without scheme
  if (trimmed.includes("@")) {
    const atIdx = trimmed.lastIndexOf("@")
    const authPart = trimmed.slice(0, atIdx)
    const hostPort = trimmed.slice(atIdx + 1)
    const parsedHostPort = splitHostAndPort(hostPort)
    if (!parsedHostPort) return null
    const cIdx = authPart.indexOf(":")
    const username = cIdx >= 0 ? safeDecodeURIComponent(authPart.slice(0, cIdx)).trim() : safeDecodeURIComponent(authPart).trim()
    const password = cIdx >= 0 ? safeDecodeURIComponent(authPart.slice(cIdx + 1)) : undefined
    return {
      mode: defaultMode,
      host: parsedHostPort.host,
      port: parsedHostPort.port,
      username: username || undefined,
      password: password || undefined
    }
  }

  // `host:port` or `host:port:user:pass` (including `[::1]:1080`)
  const parsedHostPort = splitHostAndPort(trimmed)
  if (parsedHostPort) {
    const username = parsedHostPort.extraParts?.[0]?.trim() || undefined
    const password =
      parsedHostPort.extraParts && parsedHostPort.extraParts.length > 1
        ? parsedHostPort.extraParts.slice(1).join(":")
        : undefined
    return {
      mode: defaultMode,
      host: parsedHostPort.host,
      port: parsedHostPort.port,
      username,
      password
    }
  }
  return null
}

async function decryptPoolItem(item: StoredPoolItem): Promise<MuseProxyConfig | null> {
  try {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (!available) return null
    const dec = await safeStorage.decryptStringAsync(Buffer.from(item.enc, "base64"))
    return normalize(JSON.parse(dec.result) as MuseProxyConfig)
  } catch {
    return null
  }
}

export async function listProxyPool(): Promise<MuseProxyPoolItemView[]> {
  const list = readPoolStore()
  const out: MuseProxyPoolItemView[] = []
  for (const item of list) {
    const cfg = await decryptPoolItem(item)
    if (!cfg || cfg.mode === "direct" || !cfg.host || !cfg.port) continue
    out.push({
      id: item.id,
      mode: cfg.mode,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      hasPassword: Boolean(cfg.password),
      assignedAccountId: item.assignedAccountId
    })
  }
  return out
}

export async function importProxyPool(
  rawText: string,
  defaultMode: Exclude<MuseProxyMode, "direct"> = "socks5"
): Promise<{ added: number; total: number; items: MuseProxyPoolItemView[] }> {
  const available = await safeStorage.isAsyncEncryptionAvailable()
  if (!available) {
    throw new Error("safeStorage encryption unavailable")
  }
  const added = await withProxyStoreLock(() => importIntoPoolUnlocked(rawText, defaultMode))
  const items = await listProxyPool()
  return { added, total: items.length, items }
}

async function importIntoPoolUnlocked(
  rawText: string,
  defaultMode: Exclude<MuseProxyMode, "direct">
): Promise<number> {
  const existing = readPoolStore()
  const existingConfigs = await Promise.all(existing.map(decryptPoolItem))
  const seenKeys = new Set(
    existingConfigs
      .filter((c): c is MuseProxyConfig => Boolean(c && c.host && c.port))
      .map((c) => `${c.mode}://${c.username || ""}@${c.host}:${c.port}`)
  )

  let added = 0
  for (const line of rawText.split(/\r?\n/)) {
    const parsed = parseProxyLine(line, defaultMode)
    if (!parsed || parsed.mode === "direct" || !parsed.host || !parsed.port) continue
    const key = `${parsed.mode}://${parsed.username || ""}@${parsed.host}:${parsed.port}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const enc = await safeStorage.encryptStringAsync(JSON.stringify(parsed))
    existing.push({
      id: `px_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      enc: enc.toString("base64")
    })
    added += 1
  }
  writePoolStore(existing)
  return added
}

export async function removeProxyPoolItem(id: string): Promise<MuseProxyPoolItemView[]> {
  await withProxyStoreLock(() => writePoolStore(readPoolStore().filter((x) => x.id !== id)))
  return listProxyPool()
}

export async function clearProxyPool(): Promise<MuseProxyPoolItemView[]> {
  await withProxyStoreLock(() => writePoolStore([]))
  return []
}

/**
 * Match 1 proxy from the pool to each accountId in `accountIds` (1-to-1).
 * Accounts that already have a pool proxy keep it; unassigned accounts get the
 * next free pool proxy (or stay on current setting if pool is smaller than accounts).
 */
export async function assignProxyPoolToAccounts(
  accountIds: string[],
  onAssigned?: (accountId: string) => Promise<void>,
  keep?: (accountId: string) => boolean
): Promise<{ assignedCount: number; items: MuseProxyPoolItemView[] }> {
  const configured = await withProxyStoreLock(async () => {
    const pool = readPoolStore()
    if (pool.length === 0 || accountIds.length === 0) return [] as string[]
    // Pool exhausted → the account keeps its current setting (no sharing).
    const plan = planPoolAssignment(pool, accountIds, keep)
    const done: string[] = []
    for (const { accountId, slot } of plan.assigned) {
      const cfg = await decryptPoolItem(slot)
      if (cfg && cfg.mode !== "direct") {
        await saveProxyConfigUnlocked(accountId, cfg)
        done.push(accountId)
      }
    }
    writePoolStore(plan.pool)
    return done
  })
  for (const accountId of configured) await onAssigned?.(accountId)
  return { assignedCount: configured.length, items: await listProxyPool() }
}

/** Give an account's pool proxy back (failed/cancelled login) and drop its config. */
export async function releaseProxyPoolAccount(accountId: string): Promise<void> {
  const held = await withProxyStoreLock(() => {
    const pool = readPoolStore()
    if (!pool.some((p) => p.assignedAccountId === accountId)) return false
    writePoolStore(releasePoolSlot(pool, accountId))
    return true
  })
  if (held) await clearProxyConfig(accountId)
}

/**
 * Apply every stored account proxy before any window or request runs.
 * Partitions start direct after a restart; Hark (no connect step) used to
 * stay direct until the proxy was saved again.
 */
export async function applyAllStoredProxies(log: (msg: string, err: unknown) => void = console.warn): Promise<void> {
  let ids: string[]
  try {
    ids = Object.keys(readStore())
  } catch (err) {
    log("[proxy] proxy store unreadable at startup", err)
    return
  }
  // Fail closed first (no decryption needed), so a slow keychain prompt
  // never lets the first requests out with the real IP.
  await Promise.all(
    ids.map((id) =>
      electronSession
        .fromPartition(partitionForAccount(id))
        .setProxy({ proxyRules: BLOCKING_PROXY_RULE, proxyBypassRules: "" })
        .catch((err: unknown) => log(`[proxy] ${id} not blocked`, err))
    )
  )
  await Promise.all(
    ids.map((id) => applyProxyToPartition(id).catch((err) => log(`[proxy] ${id} not applied`, err)))
  )
}
