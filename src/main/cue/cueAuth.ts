/**
 * Cue by Manus (`cue.im` / `app.cue.im` / `api.manus.im` / `api.manus.ai`)
 * multi-account credential parser, `safeStorage` encrypted vault, fail-closed
 * per-account proxy fetcher, and single-flight token refresh.
 */
import { app, safeStorage, session as electronSession } from 'electron'
import { join } from 'node:path'
import { createMutex } from '@shared/proxyPool'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { proxyFetch } from '../proxyTransport'
import { partitionForAccount } from '../webContentsViewManager'
import {
  clearCueMainAuth,
  computeCueAccountFingerprint,
  getCueMainAuth,
  setCueMainAuth,
  type CueAuthKind,
  type CueMainAuth
} from './cueAuthStore'
import { getOrCreateCueDeviceId } from './cueDeviceId'

export const CUE_ORIGIN = 'https://cue.im'
export const CUE_WEB_ORIGIN = 'https://cue.im'
export const CUE_CONNECT_BASE = 'https://api.manus.im'
export const CUE_MANUS_API_BASE = 'https://api.manus.ai/v2'

type CueCookie = { name: string; value: string; domain?: string; path?: string }

export interface CueStoredTokens {
  accessToken?: string
  refreshToken?: string
  apiKey?: string
  cookieHeader?: string
  cookieNames?: string[]
  cookies?: CueCookie[]
  accountSlot?: string
  handle?: string
  displayName?: string
  baseUrl?: string
  authKind: CueAuthKind
  expiresAtMs?: number
}

type PersistedCueTokenMap = Record<string, { enc: string }>

const withVaultLock = createMutex()
const refreshInFlight = new WeakMap<CueMainAuth, Promise<CueMainAuth | null>>()
const credentialIdentities = new WeakMap<CueMainAuth, symbol>()
const accountRevisions = new Map<string, symbol>()
const signOuts = new Set<string>()
let defaultRevision = Symbol()
const mirroredAccounts = new Set<string>()

export function getCueCredentialRevision(accountId: string): symbol {
  return accountRevisions.get(accountId) ?? defaultRevision
}

export function cueCookieCaptureAllowed(accountId: string): boolean {
  return !signOuts.has(accountId)
}

export function cueCookieOrigin(domain: string | undefined): string | undefined {
  const host = (domain || 'cue.im').replace(/^\./, '').toLowerCase()
  if (/^(?:[a-z0-9-]+\.)*(?:cue\.im|manus\.im|manus\.ai)$/.test(host)) return `https://${host}`
  return undefined
}

export function selectCueSessionCookies<T extends CueCookie>(cookies: T[]): T[] {
  const originRank = (cookie: T): number => {
    const origin = cueCookieOrigin(cookie.domain)
    if (!origin) return 0
    const host = new URL(origin).hostname
    if (host === 'cue.im') return 4
    if (host.endsWith('.cue.im')) return 3
    if (host === 'manus.im' || host.endsWith('.manus.im')) return 2
    return 1
  }
  const nameRank = (name: string): number => name === 'cue_session_id' ? 2 : name === 'session_id' ? 1 : 0
  return cookies
    .filter((cookie) => cookie.value && looksLikeCueSessionCookie(cookie.name) && originRank(cookie))
    .sort((a, b) => originRank(b) - originRank(a) || nameRank(b.name) - nameRank(a.name) ||
      (a.path?.length ?? 1) - (b.path?.length ?? 1))
}

export function cueCookiesForOrigin<T extends CueCookie>(
  cookies: T[],
  origin: string | undefined
): T[] {
  const names = new Set<string>()
  return cookies.filter((cookie) => {
    if (cueCookieOrigin(cookie.domain) !== origin || names.has(cookie.name)) return false
    names.add(cookie.name)
    return true
  })
}

async function mirrorCuePartitionCookies(
  accountId: string,
  tokens: Pick<CueStoredTokens, 'accessToken' | 'cookies'>,
  opts?: { onlyManusMirror?: boolean }
): Promise<void> {
  const cookiesToSet: CueCookie[] = []
  if (tokens.cookies?.length) {
    for (const c of tokens.cookies) {
      const origin = cueCookieOrigin(c.domain)
      if (!origin || (opts?.onlyManusMirror && !origin.endsWith('manus.im'))) continue
      cookiesToSet.push(c)
    }
  }
  if (tokens.accessToken) {
    if (
      !opts?.onlyManusMirror &&
      !cookiesToSet.some((c) => cueCookieOrigin(c.domain)?.endsWith('cue.im') && c.name === 'cue_session_id')
    ) {
      cookiesToSet.push({ name: 'cue_session_id', value: tokens.accessToken, domain: '.cue.im', path: '/' })
    }
    if (!cookiesToSet.some((c) => cueCookieOrigin(c.domain)?.endsWith('manus.im') && c.name === 'session_id')) {
      cookiesToSet.push({ name: 'session_id', value: tokens.accessToken, domain: '.manus.im', path: '/' })
    }
  }
  if (cookiesToSet.length === 0) return

  try {
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    for (const c of cookiesToSet) {
      const domain = c.domain || '.cue.im'
      const url = cueCookieOrigin(domain)
      if (!url) continue
      await ses.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain,
        path: c.path || '/',
        secure: true,
        httpOnly: false
      })
    }
    mirroredAccounts.add(accountId)
    await ses.cookies.flushStore().catch(() => undefined)
  } catch {
    /* ignore in unit/mock environments without cookies store */
  }
}

function tokenStorePath(): string {
  return join(app.getPath('userData'), 'cue-tokens.json')
}

function assertEncryptionAvailable(): void {
  const syncAvail =
    typeof safeStorage.isEncryptionAvailable === 'function'
      ? safeStorage.isEncryptionAvailable()
      : true
  if (syncAvail === false) {
    throw new Error('safeStorage encryption is unavailable — refusing to store Cue credentials in plaintext')
  }
}

async function encryptPayload(plain: string): Promise<string> {
  assertEncryptionAvailable()
  const buf = safeStorage.encryptString(plain)
  return buf.toString('base64')
}

async function decryptPayload(encBase64: string): Promise<string> {
  assertEncryptionAvailable()
  const buf = Buffer.from(encBase64, 'base64')
  return safeStorage.decryptString(buf)
}

function readRawVault(): PersistedCueTokenMap {
  const raw = readJsonFile<Record<string, unknown>>(
    tokenStorePath(),
    {},
    (r) => Boolean(r) && typeof r === 'object' && !Array.isArray(r)
  )
  const out: PersistedCueTokenMap = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && typeof (v as { enc?: unknown }).enc === 'string') {
      out[k] = { enc: (v as { enc: string }).enc }
    }
  }
  return out
}

export function listSavedCueAccountIds(): string[] {
  return Object.keys(readRawVault())
}

export function cueFetcherForAccount(
  accountId: string,
  explicitFetch?: typeof fetch,
  beforeRequest?: () => void
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted()
    if (explicitFetch) {
      beforeRequest?.()
      return explicitFetch(input, init)
    }
    const proxyUrl = await loadAccountProxyUrl(accountId)
    init?.signal?.throwIfAborted()
    beforeRequest?.()
    return proxyFetch(proxyUrl, typeof input === 'string' ? input : input.toString(), init)
  }
}

export function decodeJwtClaims(token: string): {
  handle?: string
  displayName?: string
  expiresAtMs?: number
} {
  try {
    const parts = token.split('.')
    if (parts.length < 2 || !parts[1]) return {}
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const email = typeof payload['email'] === 'string' ? payload['email'] : undefined
    const name = typeof payload['name'] === 'string' ? payload['name'] : undefined
    const sub = typeof payload['sub'] === 'string' ? payload['sub'] : undefined
    const exp = typeof payload['exp'] === 'number' ? payload['exp'] * 1000 : undefined
    return {
      handle: email || name || sub,
      displayName: name || (email ? email.split('@')[0] : undefined) || sub,
      expiresAtMs: exp
    }
  } catch {
    return {}
  }
}

export function looksLikeCueSessionCookie(name: string): boolean {
  const n = name.trim()
  if (!n) return false
  return (
    n === 'session_id' ||
    n === 'cue_session' ||
    n === '__Secure-cue.session_token' ||
    n === '__Secure-better-auth.session_token' ||
    /^(?:cue|manus)[_.-]?(?:session|token|auth)/i.test(n)
  )
}

/**
 * Universal Cue credential parser supporting all 5 formats:
 * 1. Manus API Key (`x-manus-api-key: ...` or `sk-manus-...` or `manus-...` or `cue_...`)
 * 2. Bearer JWT / access token (`Bearer ...` or `eyJ...`)
 * 3. `Cookie:` header string (`Cookie: cue_session=...; ...` or `session_id=...`)
 * 4. JSON cookie array (`[{ name, value, domain }]`)
 * 5. JSON object (`{ accessToken, refreshToken, apiKey, sessionId, cookies, baseUrl, handle }`)
 */
export function parseAnyCueCredentialInput(rawInput: string): CueStoredTokens {
  const trimmed = (rawInput ?? '').trim()
  if (!trimmed) {
    throw new Error('Cue credential input cannot be empty')
  }

  // Format 4 & 5: JSON object or array
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      throw new Error(`Invalid Cue credential JSON: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (Array.isArray(parsed)) {
      const cookies: CueCookie[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        if (typeof rec['name'] === 'string' && typeof rec['value'] === 'string' && rec['name'].trim() && rec['value'].trim()) {
          cookies.push({
            name: rec['name'].trim(),
            value: rec['value'].trim(),
            domain: typeof rec['domain'] === 'string' ? rec['domain'] : '.cue.im',
            path: typeof rec['path'] === 'string' ? rec['path'] : '/'
          })
        }
      }
      if (cookies.length === 0) {
        throw new Error('Cookie array contains no valid { name, value } entries')
      }
      const primary = selectCueSessionCookies(cookies)[0]
      if (!primary) throw new Error('Cookie array contains no Cue session cookie')
      const scoped = cueCookiesForOrigin(selectCueSessionCookies(cookies), cueCookieOrigin(primary.domain))
      const cookieHeader = scoped.map((c) => `${c.name}=${c.value}`).join('; ')
      return {
        accessToken: primary.value,
        cookieHeader,
        cookieNames: scoped.map((c) => c.name),
        cookies,
        authKind: 'session'
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Cue credential JSON must be an object or cookie array')
    }
    const obj = parsed as Record<string, unknown>
    const accessToken =
      typeof obj['accessToken'] === 'string' && obj['accessToken'].trim()
        ? obj['accessToken'].trim()
        : typeof obj['access_token'] === 'string' && obj['access_token'].trim()
          ? obj['access_token'].trim()
          : typeof obj['sessionId'] === 'string' && obj['sessionId'].trim()
            ? obj['sessionId'].trim()
            : typeof obj['session_id'] === 'string' && obj['session_id'].trim()
              ? obj['session_id'].trim()
              : undefined
    const refreshToken =
      typeof obj['refreshToken'] === 'string' && obj['refreshToken'].trim()
        ? obj['refreshToken'].trim()
        : typeof obj['refresh_token'] === 'string' && obj['refresh_token'].trim()
          ? obj['refresh_token'].trim()
          : undefined
    const apiKey =
      typeof obj['apiKey'] === 'string' && obj['apiKey'].trim()
        ? obj['apiKey'].trim()
        : typeof obj['api_key'] === 'string' && obj['api_key'].trim()
          ? obj['api_key'].trim()
          : typeof obj['x-manus-api-key'] === 'string' && obj['x-manus-api-key'].trim()
            ? obj['x-manus-api-key'].trim()
            : undefined
    const cookieHeader =
      typeof obj['cookie'] === 'string' && obj['cookie'].trim()
        ? obj['cookie'].trim()
        : typeof obj['cookieHeader'] === 'string' && obj['cookieHeader'].trim()
          ? obj['cookieHeader'].trim()
          : undefined
    const baseUrl =
      typeof obj['baseUrl'] === 'string' && obj['baseUrl'].trim()
        ? obj['baseUrl'].trim()
        : undefined
    const handle =
      typeof obj['handle'] === 'string' && obj['handle'].trim()
        ? obj['handle'].trim()
        : typeof obj['accountSlot'] === 'string' && obj['accountSlot'].trim()
          ? obj['accountSlot'].trim()
          : typeof obj['email'] === 'string' && obj['email'].trim()
            ? obj['email'].trim()
            : undefined
    const displayName =
      typeof obj['displayName'] === 'string' && obj['displayName'].trim()
        ? obj['displayName'].trim()
        : undefined

    if (!accessToken && !refreshToken && !apiKey && !cookieHeader) {
      throw new Error('Cue credential JSON must include accessToken, refreshToken, apiKey, or cookie')
    }

    const jwtClaims = accessToken ? decodeJwtClaims(accessToken) : {}
    const authKind: CueAuthKind = accessToken ? 'oauth' : apiKey ? 'api-key' : 'session'
    return {
      accessToken,
      refreshToken,
      apiKey,
      cookieHeader,
      baseUrl,
      handle: handle || jwtClaims.handle,
      displayName: displayName || jwtClaims.displayName,
      accountSlot: handle || jwtClaims.handle,
      expiresAtMs:
        typeof obj['expiresAtMs'] === 'number'
          ? obj['expiresAtMs']
          : jwtClaims.expiresAtMs,
      authKind
    }
  }

  // Format 1: x-manus-api-key header or sk-manus-... / manus-... / cue_... API key
  const apiKeyHeaderMatch = trimmed.match(/^x-manus-api-key\s*:\s*(\S+)$/i)
  if (apiKeyHeaderMatch?.[1]) {
    const key = apiKeyHeaderMatch[1].trim()
    if (key.length < 8) throw new Error('Manus API key is too short')
    return {
      apiKey: key,
      authKind: 'api-key'
    }
  }
  if (/^(?:sk-manus-|manus-|cue_)[A-Za-z0-9._-]{8,}$/i.test(trimmed)) {
    return {
      apiKey: trimmed,
      authKind: 'api-key'
    }
  }

  // Format 3: Cookie header string (`Cookie: ...` or key=value pairs containing known session cookie)
  if (/^Cookie\s*:/i.test(trimmed) || (trimmed.includes('=') && /(?:cue_session|session_id|__Secure-)/i.test(trimmed))) {
    const rawCookie = trimmed.replace(/^Cookie\s*:\s*/i, '').trim()
    const cookies: Array<{ name: string; value: string; domain?: string; path?: string }> = []
    for (const part of rawCookie.split(/[;\n]+/)) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (name && value) {
        cookies.push({ name, value, domain: '.cue.im', path: '/' })
      }
    }
    if (cookies.length === 0) {
      throw new Error('No valid cookie pairs found in Cookie header')
    }
    const primary = cookies.find((c) => looksLikeCueSessionCookie(c.name)) ?? cookies[0]!
    return {
      accessToken: primary.value,
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      cookieNames: cookies.map((c) => c.name),
      cookies,
      authKind: 'session'
    }
  }

  // Format 2: Bearer token or raw JWT (`eyJ...`)
  if (/^Bearer\s+\S+/i.test(trimmed)) {
    const token = trimmed.replace(/^Bearer\s+/i, '').trim()
    if (token.length < 12 || /\s/.test(token)) {
      throw new Error('Invalid Bearer token')
    }
    const claims = decodeJwtClaims(token)
    return {
      accessToken: token,
      handle: claims.handle,
      displayName: claims.displayName,
      accountSlot: claims.handle,
      expiresAtMs: claims.expiresAtMs,
      authKind: 'oauth'
    }
  }

  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    const claims = decodeJwtClaims(trimmed)
    return {
      accessToken: trimmed,
      handle: claims.handle,
      displayName: claims.displayName,
      accountSlot: claims.handle,
      expiresAtMs: claims.expiresAtMs,
      authKind: 'oauth'
    }
  }

  throw new Error('Unrecognized Cue credential format (expected Bearer token, JWT, x-manus-api-key, Cookie, or JSON)')
}

async function saveCueTokens(
  accountId: string,
  tokens: CueStoredTokens,
  identity: symbol,
  shouldSave: () => boolean,
  skipPartitionCookieWrite?: boolean
): Promise<CueMainAuth | null> {
  if (!shouldSave()) return null
  const enc = await encryptPayload(JSON.stringify(tokens))
  if (!shouldSave()) return null
  const vault = readRawVault()
  vault[accountId] = { enc }
  const auth = resolveCueTokens(accountId, tokens)
  writeJsonAtomic(tokenStorePath(), vault)
  accountRevisions.set(accountId, Symbol())
  signOuts.delete(accountId)
  credentialIdentities.set(auth, identity)
  setCueMainAuth(auth)
  mirroredAccounts.delete(accountId)
  if (tokens.cookies?.length || tokens.accessToken) {
    await mirrorCuePartitionCookies(
      accountId,
      tokens,
      skipPartitionCookieWrite ? { onlyManusMirror: true } : undefined
    )
  }
  return auth
}

export async function persistCueTokens(
  accountId: string,
  tokens: CueStoredTokens,
  opts?: { skipPartitionCookieWrite?: boolean; shouldSave?: () => boolean }
): Promise<CueMainAuth> {
  return withVaultLock(async () => {
    const auth = await saveCueTokens(accountId, tokens, Symbol(), opts?.shouldSave ?? (() => true), opts?.skipPartitionCookieWrite)
    if (!auth) throw new Error('Cue sign-in attempt is no longer active')
    return auth
  })
}

function resolveCueTokens(accountId: string, tokens: CueStoredTokens): CueMainAuth {
  return {
    accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    apiKey: tokens.apiKey,
    cookieHeader: tokens.cookieHeader,
    cookieNames: tokens.cookieNames,
    accountSlot: tokens.accountSlot || tokens.handle,
    handle: tokens.handle || tokens.accountSlot,
    displayName: tokens.displayName || tokens.handle || tokens.accountSlot || 'Cue',
    baseUrl: tokens.baseUrl,
    deviceId: getOrCreateCueDeviceId(accountId),
    authKind: tokens.authKind ?? 'oauth',
    expiresAtMs: tokens.expiresAtMs,
    accountFingerprint: computeCueAccountFingerprint({
      accountId,
      accessToken: tokens.accessToken,
      apiKey: tokens.apiKey,
      cookieHeader: tokens.cookieHeader,
      handle: tokens.handle || tokens.accountSlot
    })
  }
}

async function loadCueTokensLocked(accountId: string): Promise<CueMainAuth | null> {
  const inMem = getCueMainAuth(accountId)
  if (inMem) return inMem
  const entry = readRawVault()[accountId]
  if (!entry?.enc) return null
  try {
    const plain = await decryptPayload(entry.enc)
    const parsed = JSON.parse(plain) as CueStoredTokens
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.accessToken && !parsed.apiKey && !parsed.cookieHeader && !parsed.refreshToken) {
      return null
    }
    const auth = resolveCueTokens(accountId, parsed)
    credentialIdentities.set(auth, Symbol())
    setCueMainAuth(auth)
    if (auth.accessToken && !mirroredAccounts.has(accountId)) {
      await mirrorCuePartitionCookies(accountId, parsed, { onlyManusMirror: true })
    }
    return auth
  } catch {
    return null
  }
}

export async function loadCueTokens(accountId: string): Promise<CueMainAuth | null> {
  return getCueMainAuth(accountId) ?? withVaultLock(() => loadCueTokensLocked(accountId))
}

export async function importCueCredentials(
  accountId: string,
  rawInput: string
): Promise<CueMainAuth> {
  const parsed = parseAnyCueCredentialInput(rawInput)
  return persistCueTokens(accountId, parsed)
}

export async function clearCueAccountAuth(accountId: string): Promise<void> {
  await withVaultLock(async () => {
    const vault = readRawVault()
    if (accountId === '*') {
      writeJsonAtomic(tokenStorePath(), {})
      clearCueMainAuth('*')
      for (const id of Object.keys(vault)) signOuts.add(id)
      accountRevisions.clear()
      defaultRevision = Symbol()
      mirroredAccounts.clear()
      return
    }
    delete vault[accountId]
    writeJsonAtomic(tokenStorePath(), vault)
    clearCueMainAuth(accountId)
    signOuts.add(accountId)
    accountRevisions.set(accountId, Symbol())
    mirroredAccounts.delete(accountId)
    try {
      const ses = electronSession.fromPartition(partitionForAccount(accountId))
      await ses.clearStorageData().catch(() => undefined)
    } catch {
      /* ignore */
    }
  })
}

export async function hasValidCueAuth(accountId: string): Promise<boolean> {
  const loaded = await loadCueTokens(accountId)
  if (loaded && Boolean(loaded.accessToken || loaded.apiKey || loaded.cookieHeader)) {
    return true
  }
  if (!cueCookieCaptureAllowed(accountId)) return false
  try {
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    const cookies = await ses.cookies.get({})
    return selectCueSessionCookies(cookies).length > 0
  } catch {
    return false
  }
}

export async function forceRefreshCueAuth(
  accountId: string,
  baseUrlOverride?: string,
  explicitFetch?: typeof fetch,
  original?: CueMainAuth
): Promise<CueMainAuth | null> {
  const snapshot = await withVaultLock(async () => {
    const current = await loadCueTokensLocked(accountId)
    if (!current) return null
    const identity = credentialIdentities.get(current)
    if (!identity || (original && credentialIdentities.get(original) !== identity)) return null
    const entry = readRawVault()[accountId]
    return { current, identity, revision: getCueCredentialRevision(accountId), ciphertext: entry?.enc }
  })
  if (!snapshot) return null
  const { current, identity, revision, ciphertext } = snapshot
  if (original && original !== current) return current
  if (!current.refreshToken) return null
  const existingFlight = refreshInFlight.get(current)
  if (existingFlight) return existingFlight

  const promise = (async (): Promise<CueMainAuth | null> => {
    const base = (baseUrlOverride || current.baseUrl || CUE_CONNECT_BASE).replace(/\/+$/, '')
    const fetcher = cueFetcherForAccount(accountId, explicitFetch, () => {
      if (getCueCredentialRevision(accountId) !== revision || getCueMainAuth(accountId) !== current) {
        throw new Error('Cue 账号在刷新前已更改')
      }
    })
    const res = await fetcher(`${base}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        refreshToken: current.refreshToken
      })
    })
    if (!res.ok) {
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new Error(`Cue token refresh rejected (${res.status})`)
      }
      throw new Error(`Cue token refresh failed (${res.status})`)
    }
    const data = (await res.json()) as Record<string, unknown>
    const nextAccess =
      (typeof data['access_token'] === 'string' && data['access_token'].trim()) ||
      (typeof data['accessToken'] === 'string' && data['accessToken'].trim()) ||
      ''
    if (!nextAccess) {
      throw new Error('Cue token refresh response missing access_token')
    }
    const nextRefresh =
      (typeof data['refresh_token'] === 'string' && data['refresh_token'].trim()) ||
      (typeof data['refreshToken'] === 'string' && data['refreshToken'].trim()) ||
      current.refreshToken
    const expiresInSec = typeof data['expires_in'] === 'number' ? data['expires_in'] : 3600
    return withVaultLock(() => {
      if (readRawVault()[accountId]?.enc !== ciphertext) return null
      return saveCueTokens(accountId, {
        accessToken: nextAccess,
        refreshToken: nextRefresh,
        apiKey: current.apiKey,
        cookieHeader: current.cookieHeader?.split('; ').map((cookie) =>
          cookie.endsWith(`=${current.accessToken}`) ? cookie.slice(0, cookie.indexOf('=') + 1) + nextAccess : cookie
        ).join('; '),
        cookieNames: current.cookieNames,
        accountSlot: current.accountSlot,
        handle: current.handle,
        displayName: current.displayName,
        baseUrl: current.baseUrl,
        authKind: current.authKind,
        expiresAtMs: Date.now() + expiresInSec * 1000
      }, identity, () => getCueCredentialRevision(accountId) === revision && getCueMainAuth(accountId) === current)
    })
  })()

  refreshInFlight.set(current, promise)
  try {
    return await promise
  } finally {
    refreshInFlight.delete(current)
  }
}

export function currentCueAuthForIdentity(original: CueMainAuth): CueMainAuth | undefined {
  const current = getCueMainAuth(original.accountId)
  const identity = credentialIdentities.get(original)
  return current && identity && credentialIdentities.get(current) === identity ? current : undefined
}

/**
 * Self-heal an expired browser-session Cue credential by recapturing a newer
 * session cookie from the account's isolated Electron partition (e.g. after the
 * user interacted with Cue inside WebSessionPane). Never crosses account identities.
 */
export async function tryRecaptureCueSessionCookie(
  original: CueMainAuth
): Promise<CueMainAuth | null> {
  if (original.authKind !== 'session' || original.refreshToken) return null
  if (currentCueAuthForIdentity(original) !== original) return null
  const identity = credentialIdentities.get(original)
  if (!identity) return null
  const accountId = original.accountId
  const revision = getCueCredentialRevision(accountId)
  if (!cueCookieCaptureAllowed(accountId)) return null
  try {
    if (typeof electronSession?.fromPartition !== 'function') return null
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    const cookies = await ses.cookies.get({})
    const sessionCookies = selectCueSessionCookies(cookies.filter((cookie) => cookie.domain))
    const primary = sessionCookies[0]
    if (!primary || !primary.value || primary.value === original.accessToken) return null
    const claims = decodeJwtClaims(primary.value)
    // Refuse to adopt a cookie belonging to a different Cue user identity.
    if (original.accountSlot && claims.handle && claims.handle !== original.accountSlot) {
      return null
    }
    const scoped = cueCookiesForOrigin(sessionCookies, cueCookieOrigin(primary.domain))
    return await withVaultLock(async () => {
      if (
        getCueCredentialRevision(accountId) !== revision ||
        getCueMainAuth(accountId) !== original ||
        currentCueAuthForIdentity(original) !== original
      ) {
        return null
      }
      return await saveCueTokens(
        accountId,
        {
          accessToken: primary.value,
          cookieHeader: scoped.map(({ name, value }) => `${name}=${value}`).join('; '),
          cookieNames: scoped.map(({ name }) => name),
          cookies: sessionCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || '.cue.im',
            path: c.path || '/'
          })),
          handle: claims.handle || original.handle,
          displayName: claims.displayName || original.displayName,
          accountSlot: original.accountSlot || claims.handle,
          baseUrl: original.baseUrl,
          expiresAtMs: claims.expiresAtMs,
          authKind: 'session'
        },
        identity,
        () =>
          getCueCredentialRevision(accountId) === revision &&
          getCueMainAuth(accountId) === original,
        true
      )
    })
  } catch {
    return null
  }
}
