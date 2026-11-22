/**
 * Sand client accessToken via official PKCE + poll login (Grok Bot.app 0.79.3 flow).
 * Supports both Cursor WorkOS Sand tokens and xAI Identity OAuth2 tokens, plus
 * `/auth/exchange_user_api_key` API-key exchange.
 *
 * Every network request routes through per-account `proxyFetch` (fail-closed if
 * proxy config is unreadable). Tokens persist exclusively via Electron `safeStorage`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import * as electronMod from 'electron'
import { app, BrowserWindow, safeStorage, type WebContents } from 'electron'
import { createMutex } from '@shared/proxyPool'
import {
  buildGoogleFallbackBannerScript,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText
} from '../googleOAuthUaGuard'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'
import { applyProxyToPartition, loadAccountProxyUrl } from '../muse/accountProxy'
import { proxyFetch } from '../proxyTransport'
import { partitionForAccount } from '../webContentsViewManager'

export const SAND_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const API = 'https://api2.cursor.sh'
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface SandTokens {
  accessToken: string
  refreshToken?: string
  authId?: string
  selectedTeamId?: string
  /** Optional xAI identity issuer (`https://auth.grok.com` / OAuth2 issuer) when using xAI auth. */
  xaiIssuer?: string
  /** Optional OAuth2 client_id extracted from xAI JWT `aud` or `client_id`. */
  xaiClientId?: string
  /** Explicit expiry timestamp in ms when provided by poll/refresh. */
  expiresAtMs?: number
  authKind?: 'cursor' | 'xai' | 'web'
}

export function grokFetcherForAccount(
  accountId: string,
  explicitFetch?: typeof fetch
): typeof fetch {
  if (explicitFetch) return explicitFetch
  return async (input, init) => {
    const proxyUrl = await loadAccountProxyUrl(accountId)
    return proxyFetch(proxyUrl, String(input), init)
  }
}

// ---------------- PKCE ----------------
export function createPkce(): { verifier: string; challenge: string; uuid: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, uuid: randomUUID() }
}

export function sandLoginUrl(challenge: string, uuid: string): string {
  const q = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'sand',
    supportsSelectedTeamLogin: 'true'
  })
  return `https://cursor.com/loginDeepControl?${q.toString()}`
}

// ---------------- JWT helpers ----------------
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const seg = token.split('.')[1]
    if (!seg) return null
    const parsed = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Decode JWT exp (seconds) without verifying. */
export function tokenExpMs(accessToken: string, fallbackExpiresAtMs?: number): number | null {
  const payload = decodeJwtPayload(accessToken)
  if (payload && typeof payload['exp'] === 'number') {
    return payload['exp'] * 1000
  }
  if (typeof fallbackExpiresAtMs === 'number' && Number.isFinite(fallbackExpiresAtMs) && fallbackExpiresAtMs > 0) {
    return fallbackExpiresAtMs
  }
  return null
}

function inferClientIdFromJwt(token: string): string | undefined {
  const p = decodeJwtPayload(token)
  if (!p) return undefined
  if (typeof p['client_id'] === 'string' && p['client_id']) return p['client_id']
  if (typeof p['azp'] === 'string' && p['azp']) return p['azp']
  if (typeof p['aud'] === 'string' && p['aud']) return p['aud']
  if (Array.isArray(p['aud']) && typeof p['aud'][0] === 'string') return p['aud'][0]
  return undefined
}

function inferSubjectFromJwt(token: string): string | undefined {
  const p = decodeJwtPayload(token)
  if (!p) return undefined
  if (typeof p['email'] === 'string' && p['email'].trim()) return p['email'].trim()
  if (typeof p['preferred_username'] === 'string' && p['preferred_username'].trim()) {
    return p['preferred_username'].trim()
  }
  if (typeof p['sub'] === 'string' && p['sub']) return p['sub']
  return undefined
}

export function extractAccountHandleFromJwt(token: string): string | undefined {
  return inferSubjectFromJwt(token)
}

/**
 * Extract `{ accessToken, accountSlot }` from a `WorkosCursorSessionToken` cookie value,
 * a full `Cookie:` header string, or a `Bearer eyJ...` JWT string.
 */
export function parseWorkosCookieOrToken(
  rawInput: string
): { accessToken: string; accountSlot?: string } | null {
  if (!rawInput || !rawInput.trim()) return null
  let value = rawInput
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^Cookie:\s*/i, '')
    .replace(/^Authorization:\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim()

  // Extract WorkosCursorSessionToken if full cookie string was pasted
  const cookieMatch = /(?:WorkosCursorSessionToken|workos_cursor_session_token)=([^;\s]+)/i.exec(
    value
  )
  if (cookieMatch?.[1]) {
    value = cookieMatch[1].trim()
  }

  try {
    value = decodeURIComponent(value)
  } catch {
    /* keep raw */
  }
  value = value.replace(/^['"]|['"]$/g, '').trim()

  const parts = value.split('::')
  if (parts.length >= 2) {
    const slot = parts[0]?.trim()
    const jwt = parts.slice(1).join('::').trim()
    if (jwt.startsWith('eyJ') && jwt.length > 40) {
      return {
        accessToken: jwt,
        accountSlot: extractAccountHandleFromJwt(jwt) ?? (slot || undefined)
      }
    }
  }
  if (value.startsWith('eyJ') && value.length > 40) {
    return {
      accessToken: value,
      accountSlot: extractAccountHandleFromJwt(value)
    }
  }
  return null
}

// ---------------- poll & parse ----------------
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function parseSandTokens(raw: unknown): SandTokens | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  // 0.79.3 xAI Identity branch: { xaiAccessToken, xaiRefreshToken, xaiAccessTokenExpiresAt, xaiIssuer, selectedTeamId? }
  if (typeof r['xaiAccessToken'] === 'string' && r['xaiAccessToken'].length > 0) {
    const xaiAccessToken = r['xaiAccessToken']
    const expiresSec =
      typeof r['xaiAccessTokenExpiresAt'] === 'number' ? r['xaiAccessTokenExpiresAt'] : undefined
    const expiresAtMs =
      typeof r['expiresAtMs'] === 'number'
        ? r['expiresAtMs']
        : expiresSec != null
          ? expiresSec * 1000
          : undefined
    const xaiIssuer = typeof r['xaiIssuer'] === 'string' ? r['xaiIssuer'] : undefined
    const xaiClientId =
      typeof r['xaiClientId'] === 'string'
        ? r['xaiClientId']
        : inferClientIdFromJwt(xaiAccessToken)
    const authId =
      typeof r['authId'] === 'string' ? r['authId'] : inferSubjectFromJwt(xaiAccessToken)
    return {
      accessToken: xaiAccessToken,
      refreshToken:
        typeof r['xaiRefreshToken'] === 'string'
          ? r['xaiRefreshToken']
          : typeof r['refreshToken'] === 'string'
            ? r['refreshToken']
            : undefined,
      authId,
      selectedTeamId:
        typeof r['selectedTeamId'] === 'string'
          ? r['selectedTeamId']
          : typeof r['selectedTeamId'] === 'number'
            ? String(r['selectedTeamId'])
            : undefined,
      xaiIssuer,
      xaiClientId,
      expiresAtMs,
      authKind: 'xai'
    }
  }

  // Standard Cursor Sand branch (or persisted SandTokens JSON)
  const accessToken =
    typeof r['accessToken'] === 'string'
      ? r['accessToken']
      : typeof r['access_token'] === 'string'
        ? r['access_token']
        : undefined
  if (!accessToken) return null
  const refreshToken =
    typeof r['refreshToken'] === 'string'
      ? r['refreshToken']
      : typeof r['refresh_token'] === 'string'
        ? r['refresh_token']
        : undefined
  const xaiIssuer = typeof r['xaiIssuer'] === 'string' ? r['xaiIssuer'] : undefined
  const xaiClientId = typeof r['xaiClientId'] === 'string' ? r['xaiClientId'] : undefined
  const authKind: SandTokens['authKind'] =
    r['authKind'] === 'xai' || r['authKind'] === 'web' || r['authKind'] === 'cursor'
      ? r['authKind']
      : xaiIssuer
        ? 'xai'
        : 'cursor'
  return {
    accessToken,
    refreshToken,
    authId:
      typeof r['authId'] === 'string' ? r['authId'] : inferSubjectFromJwt(accessToken),
    selectedTeamId:
      typeof r['selectedTeamId'] === 'string'
        ? r['selectedTeamId']
        : typeof r['selectedTeamId'] === 'number'
          ? String(r['selectedTeamId'])
          : undefined,
    xaiIssuer,
    xaiClientId,
    expiresAtMs: typeof r['expiresAtMs'] === 'number' ? r['expiresAtMs'] : undefined,
    authKind
  }
}

/**
 * Exchange a Cursor user API key for `{ accessToken, refreshToken }` via
 * `POST https://api2.cursor.sh/auth/exchange_user_api_key` (0.79.3 `xdn`).
 */
export async function exchangeSandUserApiKey(
  apiKey: string,
  opts: { accountId?: string; fetchImpl?: typeof fetch; apiBaseUrl?: string } = {}
): Promise<SandTokens | null> {
  const base = (opts.apiBaseUrl ?? API).replace(/\/$/, '')
  const doFetch =
    opts.fetchImpl ?? (opts.accountId ? grokFetcherForAccount(opts.accountId) : fetch)
  const res = await doFetch(`${base}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify({})
  })
  if (!res.ok) return null
  const body = await res.json().catch(() => null)
  return parseSandTokens(body)
}

export interface SandPollWake {
  wake: () => void
  wait: (ms: number) => Promise<void>
}

export function createSandPollWake(): SandPollWake {
  let pendingResolve: (() => void) | null = null
  let pendingWake = false
  return {
    wake() {
      if (pendingResolve) {
        const fn = pendingResolve
        pendingResolve = null
        fn()
      } else {
        pendingWake = true
      }
    },
    wait(ms: number) {
      if (pendingWake) {
        pendingWake = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingResolve === done) pendingResolve = null
          resolve()
        }, ms)
        const done = () => {
          clearTimeout(timer)
          pendingResolve = null
          resolve()
        }
        pendingResolve = done
      })
    }
  }
}

/**
 * Universal credential parser for Grok Bot:
 * 1. JSON (`{ accessToken, refreshToken }`, `{ access_token, refresh_token }`, `{ xaiAccessToken, ... }`)
 * 2. Cookie header / `WorkosCursorSessionToken=user_01...%3A%3AeyJ...` / `slot::eyJ...`
 * 3. `Bearer eyJ...` / raw JWT
 * 4. Cursor/Grok API key (`key_...` / `crsr_...`) exchanged via `/auth/exchange_user_api_key`
 */
export async function parseAnyGrokCredentialInput(
  rawInput: string,
  opts: {
    refreshToken?: string
    accountSlot?: string
    teamId?: string
    existing?: SandTokens | null
    accountId?: string
    fetchImpl?: typeof fetch
  } = {}
): Promise<SandTokens | null> {
  const trimmed = rawInput.trim()
  if (!trimmed) return null

  const fallbackRefresh = opts.refreshToken?.trim() || opts.existing?.refreshToken
  const fallbackTeam = opts.teamId?.trim() || opts.existing?.selectedTeamId

  // 1. JSON object or array
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsedJson = JSON.parse(trimmed) as unknown
      const candidate = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson
      const sand = parseSandTokens(candidate)
      if (sand?.accessToken) {
        return {
          ...sand,
          refreshToken: sand.refreshToken ?? fallbackRefresh,
          authId:
            extractAccountHandleFromJwt(sand.accessToken) ??
            sand.authId ??
            opts.accountSlot ??
            opts.existing?.authId,
          selectedTeamId: sand.selectedTeamId ?? fallbackTeam
        }
      }
      // Also support JSON cookie array from browser extensions: [{ name: "WorkosCursorSessionToken", value: "..." }]
      if (Array.isArray(parsedJson)) {
        for (const item of parsedJson) {
          if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>
            const name = String(rec['name'] ?? '')
            const val = String(rec['value'] ?? '')
            if (/workos.*session|cursor.*session/i.test(name) && val) {
              const fromCookie = parseWorkosCookieOrToken(val)
              if (fromCookie) {
                return {
                  accessToken: fromCookie.accessToken,
                  refreshToken: fallbackRefresh,
                  authId: fromCookie.accountSlot ?? opts.accountSlot ?? opts.existing?.authId,
                  selectedTeamId: fallbackTeam,
                  authKind: 'cursor'
                }
              }
            }
          }
        }
      }
    } catch {
      /* continue */
    }
  }

  // 2. Cookie / WorkOS token / Bearer JWT
  const cookieOrJwt = parseWorkosCookieOrToken(trimmed)
  if (cookieOrJwt) {
    return {
      accessToken: cookieOrJwt.accessToken,
      refreshToken: fallbackRefresh,
      authId: cookieOrJwt.accountSlot ?? opts.accountSlot ?? opts.existing?.authId,
      selectedTeamId: fallbackTeam,
      authKind: 'cursor'
    }
  }

  // 3. API key exchange (`key_...` / `crsr_...` / non-JWT token)
  const cleanKey = trimmed
    .replace(/^['"]|['"]$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  if (cleanKey && !cleanKey.startsWith('eyJ') && !/\s/.test(cleanKey)) {
    const exchanged = await exchangeSandUserApiKey(cleanKey, {
      accountId: opts.accountId,
      fetchImpl: opts.fetchImpl
    }).catch(() => null)
    if (exchanged?.accessToken) {
      return {
        ...exchanged,
        authId:
          extractAccountHandleFromJwt(exchanged.accessToken) ??
          exchanged.authId ??
          opts.accountSlot
      }
    }
  }

  return null
}

/**
 * Poll api2 /auth/poll until tokens appear.
 * 404 → keep waiting; backoff 1s * 1.2^n cap 6s, max 180 attempts;
 * `wake` immediately skips the current wait when the browser login page confirms!
 */
export async function pollSandAuth(
  uuid: string,
  verifier: string,
  opts: {
    accountId?: string
    isAborted?: () => boolean
    maxAttempts?: number
    fetchImpl?: typeof fetch
    wake?: SandPollWake
  } = {}
): Promise<SandTokens> {
  const max = opts.maxAttempts ?? 180
  const doFetch =
    opts.fetchImpl ?? (opts.accountId ? grokFetcherForAccount(opts.accountId) : fetch)
  let consecutiveErrors = 0
  for (let attempt = 0; attempt < max; attempt++) {
    if (opts.isAborted?.()) throw new Error('sand login aborted')
    const delay = Math.min(900 * Math.pow(1.18, attempt), 6000)
    if (attempt > 0) {
      if (opts.wake) await opts.wake.wait(delay)
      else await sleep(delay)
    }
    if (opts.isAborted?.()) throw new Error('sand login aborted')
    try {
      const url = `${API}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`
      const res = await doFetch(url, { method: 'GET', headers: { accept: 'application/json' } })
      if (res.status === 404) {
        consecutiveErrors = 0
        continue
      }
      if (!res.ok) {
        consecutiveErrors++
        if (consecutiveErrors >= 5) throw new Error(`auth/poll failed ${res.status} (x${consecutiveErrors})`)
        continue
      }
      consecutiveErrors = 0
      const tokens = parseSandTokens(await res.json())
      if (tokens) {
        return {
          ...tokens,
          authId: extractAccountHandleFromJwt(tokens.accessToken) ?? tokens.authId
        }
      }
    } catch (e) {
      if (opts.isAborted?.()) throw new Error('sand login aborted')
      consecutiveErrors++
      if (consecutiveErrors >= 5) throw e instanceof Error ? e : new Error(String(e))
    }
  }
  throw new Error('sand login timed out')
}

// ---------------- refresh ----------------
export interface RefreshResult {
  tokens?: SandTokens
  shouldLogout: boolean
}

export async function refreshSandToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  xaiMeta?: { issuer?: string; clientId?: string }
): Promise<RefreshResult> {
  // xAI Identity OAuth2 refresh branch (`POST ${issuer}/oauth2/token` URL-encoded)
  if (xaiMeta?.issuer) {
    const tokenUrl = new URL('/oauth2/token', `${xaiMeta.issuer.replace(/\/$/, '')}/`).toString()
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(xaiMeta.clientId ? { client_id: xaiMeta.clientId } : {})
    })
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: params.toString()
    })
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (errBody['error'] === 'invalid_grant' || res.status === 401) {
        return { shouldLogout: true }
      }
      return { shouldLogout: true }
    }
    if (!res.ok) throw new Error(`xAI oauth2/token refresh failed ${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    const accessToken =
      typeof body['access_token'] === 'string' ? body['access_token'] : undefined
    if (!accessToken) return { shouldLogout: true }
    const rotated =
      typeof body['refresh_token'] === 'string' ? body['refresh_token'] : refreshToken
    const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined
    return {
      shouldLogout: false,
      tokens: {
        accessToken,
        refreshToken: rotated,
        xaiIssuer: xaiMeta.issuer,
        xaiClientId: xaiMeta.clientId ?? inferClientIdFromJwt(accessToken),
        expiresAtMs: expiresIn != null ? Date.now() + expiresIn * 1000 : undefined,
        authKind: 'xai'
      }
    }
  }

  // Standard Cursor Sand OAuth refresh (`POST https://api2.cursor.sh/oauth/token`)
  const res = await fetchImpl(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: SAND_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  })
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { shouldLogout: true }
  }
  if (!res.ok) throw new Error(`oauth/token refresh failed ${res.status}`)
  const body = (await res.json()) as Record<string, unknown>
  const accessToken =
    typeof body['access_token'] === 'string'
      ? body['access_token']
      : (body['accessToken'] as string | undefined)
  if (!accessToken) return { shouldLogout: true }
  const rotated =
    typeof body['refresh_token'] === 'string'
      ? (body['refresh_token'] as string)
      : typeof body['refreshToken'] === 'string'
        ? (body['refreshToken'] as string)
        : refreshToken
  return {
    shouldLogout: false,
    tokens: {
      accessToken,
      refreshToken: rotated,
      selectedTeamId:
        typeof body['selectedTeamId'] === 'string' ? (body['selectedTeamId'] as string) : undefined,
      authKind: 'cursor'
    }
  }
}

// ---------------- persistence (safeStorage only; fail closed) ----------------
interface StoredEntry {
  /** base64 of safeStorage.encryptString(JSON.stringify(tokens)) */
  enc: string
  /** legacy marker — never written; migrated or deleted on load */
  plain?: boolean
}
type StoreFile = Record<string, StoredEntry>

function storePath(): string {
  return join(app.getPath('userData'), 'grok-sand-tokens.json')
}

function readFile(): StoreFile {
  return readJsonFile<StoreFile>(
    storePath(),
    {},
    (raw) => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
  )
}

function writeFile(store: StoreFile): void {
  writeJsonAtomic(storePath(), store)
}

/** persistSandTokens reads, awaits encryption, then writes: serialize it. */
const withTokenStoreLock = createMutex()

async function assertEncryptionAvailable(): Promise<void> {
  const available = await safeStorage.isAsyncEncryptionAvailable()
  if (!available) {
    throw new Error('safeStorage encryption unavailable; refusing to store Grok tokens in plaintext')
  }
}

/** Encrypt and write sand tokens. Throws if safeStorage cannot encrypt. */
export async function persistSandTokens(accountId: string, tokens: SandTokens): Promise<void> {
  await assertEncryptionAvailable()
  const enc = await safeStorage.encryptStringAsync(JSON.stringify(tokens))
  await withTokenStoreLock(() => {
    const store = readFile()
    store[accountId] = { enc: enc.toString('base64') }
    writeFile(store)
  })
}

const refreshInFlight = new Map<
  string,
  Promise<{ accessToken: string; selectedTeamId?: string } | null>
>()

function refreshAndPersist(
  accountId: string,
  tokens: SandTokens,
  fetchImpl?: typeof fetch
): Promise<{ accessToken: string; selectedTeamId?: string } | null> {
  const running = refreshInFlight.get(accountId)
  if (running) return running
  const doFetch = grokFetcherForAccount(accountId, fetchImpl)
  const run = (async () => {
    const result = await refreshSandToken(tokens.refreshToken!, doFetch, {
      issuer: tokens.xaiIssuer,
      clientId: tokens.xaiClientId
    })
    if (result.shouldLogout) {
      clearSandTokens(accountId)
      return null
    }
    if (!result.tokens) return null
    const merged: SandTokens = {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken ?? tokens.refreshToken,
      authId: tokens.authId,
      selectedTeamId: result.tokens.selectedTeamId ?? tokens.selectedTeamId,
      xaiIssuer: result.tokens.xaiIssuer ?? tokens.xaiIssuer,
      xaiClientId: result.tokens.xaiClientId ?? tokens.xaiClientId,
      expiresAtMs: result.tokens.expiresAtMs,
      authKind: result.tokens.authKind ?? tokens.authKind
    }
    await persistSandTokens(accountId, merged)
    return { accessToken: merged.accessToken, selectedTeamId: merged.selectedTeamId }
  })().finally(() => refreshInFlight.delete(accountId))
  refreshInFlight.set(accountId, run)
  return run
}

/**
 * Decrypt sand tokens for an account.
 * Migrates any legacy `plain` entries to encrypted form when encryption is available;
 * otherwise deletes them (fail closed — never return plaintext-on-disk tokens).
 */
export async function loadSandTokens(accountId: string): Promise<SandTokens | null> {
  const store = readFile()
  const entry = store[accountId]
  if (!entry?.enc) return null
  try {
    const buf = Buffer.from(entry.enc, 'base64')
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (entry.plain) {
      if (!available) {
        delete store[accountId]
        writeFile(store)
        return null
      }
      const tokens = parseSandTokens(JSON.parse(buf.toString('utf8')))
      if (!tokens) {
        delete store[accountId]
        writeFile(store)
        return null
      }
      const enc = await safeStorage.encryptStringAsync(JSON.stringify(tokens))
      store[accountId] = { enc: enc.toString('base64') }
      writeFile(store)
      return tokens
    }
    if (!available) return null
    const decrypted = await safeStorage.decryptStringAsync(buf)
    const tokens = parseSandTokens(JSON.parse(decrypted.result))
    if (tokens && decrypted.shouldReEncrypt) {
      try {
        const enc = await safeStorage.encryptStringAsync(JSON.stringify(tokens))
        store[accountId] = { enc: enc.toString('base64') }
        writeFile(store)
      } catch {
        /* keep old ciphertext */
      }
    }
    return tokens
  } catch {
    return null
  }
}

export function clearSandTokens(accountId: string): void {
  const store = readFile()
  if (store[accountId]) {
    delete store[accountId]
    writeFile(store)
  }
}

export function clearAllSandTokens(): void {
  writeFile({})
}

/** Account ids that currently have a persisted sand-token blob. */
export function listPersistedSandAccountIds(): string[] {
  return Object.keys(readFile())
}

/** Force an oauth/token refresh regardless of expiry. Clears tokens on logout. */
export async function forceRefreshSandAccessToken(
  accountId: string,
  fetchImpl?: typeof fetch
): Promise<{ accessToken: string; selectedTeamId?: string } | null> {
  const tokens = await loadSandTokens(accountId)
  if (!tokens?.refreshToken) return null
  return refreshAndPersist(accountId, tokens, fetchImpl)
}

/** Return a valid accessToken, refreshing when within 5min of expiry. */
export async function getValidSandAccessToken(
  accountId: string,
  fetchImpl?: typeof fetch
): Promise<{ accessToken: string; selectedTeamId?: string } | null> {
  const tokens = await loadSandTokens(accountId)
  if (!tokens?.accessToken) return null
  const expMs = tokenExpMs(tokens.accessToken, tokens.expiresAtMs)
  const needsRefresh = expMs != null && expMs - Date.now() < REFRESH_MARGIN_MS
  if (needsRefresh && tokens.refreshToken) {
    const refreshed = await refreshAndPersist(accountId, tokens, fetchImpl)
    if (refreshed) return refreshed
    if (!(await loadSandTokens(accountId))) return null
  }
  return { accessToken: tokens.accessToken, selectedTeamId: tokens.selectedTeamId }
}

// ---------------- interactive login window ----------------
const CONFIRM_SELECTORS = [
  'Yes, log in',
  'Yes, Log In',
  'Log in',
  'Confirm',
  'Authorize',
  'Continue'
]

const sandLoginWindows = new Map<string, BrowserWindow>()

export interface SandLoginResult {
  tokens: SandTokens
  clickedConfirm: boolean
}

/**
 * Open cursor.com/loginDeepControl in the account's standard partition and poll.
 * Applies per-account proxy before loading any URL (fail-closed on unreadable proxy).
 */
export async function runSandLogin(
  accountId: string,
  opts: {
    parent?: BrowserWindow
    autoConfirm?: boolean
    show?: boolean
    onNeedsInput?: (detail: string) => void
    maxAttempts?: number
  } = {}
): Promise<SandLoginResult> {
  const existing = sandLoginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) existing.close()

  // Enforce per-account proxy on the shared partition BEFORE opening the login window.
  await applyProxyToPartition(accountId)

  const { verifier, challenge, uuid } = createPkce()
  const url = sandLoginUrl(challenge, uuid)
  const partition = partitionForAccount(accountId)
  const ses = (electronMod as typeof import('electron')).session?.fromPartition?.(partition)
  installGoogleOAuthHeaderGuard(ses)

  const win = new BrowserWindow({
    width: 980,
    height: 760,
    show: opts.show ?? true,
    title: '使用 Grok Bot 登录（sand）',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    parent: opts.parent && !opts.parent.isDestroyed() ? opts.parent : undefined,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  sandLoginWindows.set(accountId, win)

  const childPopups = new Set<BrowserWindow>()
  const closeChildPopups = () => {
    for (const child of childPopups) {
      try {
        if (!child.isDestroyed()) child.close()
      } catch {
        /* ignore */
      }
    }
    childPopups.clear()
  }

  let closed = false
  let handedOffToBrowser = false
  const deepLinkScheme = /^(sand|grokbot|cursor):/i

  const guardDeepLinks = (wc: WebContents) => {
    const intercept = (event: Electron.Event, targetUrl: string) => {
      if (deepLinkScheme.test(targetUrl)) {
        event.preventDefault()
      }
    }
    wc.on('will-navigate', intercept)
    wc.on('will-redirect', intercept)
  }

  const maybeFallbackOnGoogleBlock = async (
    wc: WebContents,
    childWin?: BrowserWindow
  ): Promise<void> => {
    if (closed || handedOffToBrowser || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      const bodyText = (await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)) as string
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser && !closed) {
        handedOffToBrowser = true
        const openExternal = (electronMod as typeof import('electron')).shell?.openExternal
        if (typeof openExternal === 'function') {
          void openExternal(url)
        }
        opts.onNeedsInput?.('已自动在系统浏览器打开授权页，请完成登录后返回…')
        if (childWin && !childWin.isDestroyed()) {
          try {
            childWin.close()
          } catch {
            /* ignore */
          }
        }
        if (!win.isDestroyed()) {
          void win.webContents
            .executeJavaScript(
              buildGoogleFallbackBannerScript({
                title: '已自动切换至系统默认浏览器完成 Google 授权',
                detail: '请在系统浏览器中完成登录并确认授权，完成后 BotArk 将自动完成同步。'
              }),
              true
            )
            .catch(() => undefined)
        }
      }
    } catch {
      /* ignore */
    }
  }

  guardDeepLinks(win.webContents)

  win.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (deepLinkScheme.test(popupUrl)) {
      return { action: 'deny' }
    }
    if (popupUrl === 'about:blank' || /^https?:\/\//i.test(popupUrl)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          title: '安全授权',
          parent: win.isDestroyed() ? undefined : win,
          autoHideMenuBar: true,
          webPreferences: {
            partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      }
    }
    return { action: 'deny' }
  })

  win.webContents.on('did-create-window', (childWin) => {
    childPopups.add(childWin)
    guardDeepLinks(childWin.webContents)
    const onChildNav = () => {
      void maybeFallbackOnGoogleBlock(childWin.webContents, childWin)
    }
    childWin.webContents.on('did-finish-load', onChildNav)
    childWin.webContents.on('did-navigate', onChildNav)
    childWin.webContents.on('did-redirect-navigation', onChildNav)
    childWin.on('closed', () => {
      childPopups.delete(childWin)
    })
  })

  win.on('closed', () => {
    closed = true
    closeChildPopups()
    sandLoginWindows.delete(accountId)
  })

  await win.loadURL(url)

  let clickedConfirm = false
  const tryConfirmClick = async (): Promise<void> => {
    if (closed || win.isDestroyed() || !opts.autoConfirm) return
    try {
      const clicked = (await win.webContents.executeJavaScript(
        `(() => {
          const wanted = ${JSON.stringify(CONFIRM_SELECTORS)};
          const els = Array.from(document.querySelectorAll('button, a, [role=button], input[type=submit]'));
          for (const el of els) {
            const txt = (el.innerText || el.value || el.textContent || '').trim();
            if (wanted.some((w) => txt.toLowerCase() === w.toLowerCase() || txt.toLowerCase().includes('yes, log in'))) {
              el.click();
              return txt;
            }
          }
          return '';
        })()`,
        true
      )) as string
      if (clicked) clickedConfirm = true
    } catch {
      /* page not ready */
    }
  }

  win.webContents.on('did-finish-load', () => {
    void tryConfirmClick()
    void maybeFallbackOnGoogleBlock(win.webContents)
  })
  win.webContents.on('did-navigate', () => {
    void maybeFallbackOnGoogleBlock(win.webContents)
  })
  win.webContents.on('did-redirect-navigation', () => {
    void maybeFallbackOnGoogleBlock(win.webContents)
  })
  const confirmTimers = [1200, 2500, 4000, 6500].map((ms) => setTimeout(() => void tryConfirmClick(), ms))

  try {
    const tokens = await pollSandAuth(uuid, verifier, {
      accountId,
      isAborted: () => closed,
      maxAttempts: opts.maxAttempts
    })
    try {
      await persistSandTokens(accountId, tokens)
    } catch (error) {
      console.warn('[grok] safeStorage persist failed after sand login; memory-only session', error)
    }
    return { tokens, clickedConfirm }
  } finally {
    confirmTimers.forEach(clearTimeout)
    closeChildPopups()
    if (!win.isDestroyed()) win.close()
  }
}
