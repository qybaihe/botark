/**
 * Cue by Manus client (`api.manus.im` ConnectRPC & Manus REST v2 `api.manus.ai/v2`).
 *
 * Implements:
 * - Per-account headers (`x-client-id`, `x-product-name: manus-agents`, `Connect-Protocol-Version: 1`,
 *   `Authorization: Bearer ...` / `x-manus-api-key`)
 * - `ProviderIdentityGuard` pre/post account fingerprint check
 * - Single-flight 401 refresh retry (`forceRefreshCueAuth`)
 * - `CueQuotaMapper` clamping `used + reserved > limit` to `0`, separating `purchasedRemainingCredits`,
 *   and decoupling `quotaUnavailable` (401/403 on billing) from chat online status.
 */
import {
  CUE_CONNECT_BASE,
  cueFetcherForAccount,
  forceRefreshCueAuth,
  loadCueTokens
} from './cueAuth'
import { getCueMainAuth, type CueMainAuth } from './cueAuthStore'
import { getOrCreateCueDeviceId } from './cueDeviceId'

export interface CueAgentSummary {
  id: string
  name: string
  description?: string
  handle?: string
  avatarShape?: string
  avatarColor?: string
}

export interface CueQuotaView {
  accessAllowed: boolean
  limitCredits: number | null
  usedCredits: number | null
  reservedCredits: number | null
  weeklyRemainingCredits: number | null
  purchasedRemainingCredits: number | null
  remainingPercent: number | null
  windowStartMs: number | null
  windowEndMs: number | null
  quotaUnavailable?: boolean
}

export function mapCueMembershipQuota(raw: Record<string, unknown>): CueQuotaView {
  const membership =
    raw['membership'] && typeof raw['membership'] === 'object'
      ? (raw['membership'] as Record<string, unknown>)
      : {}
  const accessAllowed = membership['accessAllowed'] !== false
  const limit = typeof raw['limitCredits'] === 'number' ? raw['limitCredits'] : null
  const used = typeof raw['usedCredits'] === 'number' ? raw['usedCredits'] : 0
  const reserved = typeof raw['reservedCredits'] === 'number' ? raw['reservedCredits'] : 0
  const explicitWeekly =
    typeof raw['weeklyRemainingCredits'] === 'number' ? raw['weeklyRemainingCredits'] : null
  const computedRemaining =
    limit !== null ? Math.max(0, limit - used - reserved) : explicitWeekly
  const weeklyRemaining =
    explicitWeekly !== null && limit !== null
      ? Math.max(0, Math.min(explicitWeekly, limit - used - reserved))
      : computedRemaining
  const purchased =
    typeof raw['purchasedRemainingCredits'] === 'number'
      ? Math.max(0, raw['purchasedRemainingCredits'])
      : null
  const remainingPercent =
    limit && limit > 0 && weeklyRemaining !== null
      ? Math.max(0, Math.min(100, Math.round((weeklyRemaining / limit) * 100)))
      : null

  return {
    accessAllowed,
    limitCredits: limit,
    usedCredits: typeof raw['usedCredits'] === 'number' ? raw['usedCredits'] : null,
    reservedCredits: typeof raw['reservedCredits'] === 'number' ? raw['reservedCredits'] : null,
    weeklyRemainingCredits: weeklyRemaining,
    purchasedRemainingCredits: purchased,
    remainingPercent,
    windowStartMs: typeof raw['windowStartMs'] === 'number' ? raw['windowStartMs'] : null,
    windowEndMs: typeof raw['windowEndMs'] === 'number' ? raw['windowEndMs'] : null
  }
}

export function buildCueClientHeaders(auth: CueMainAuth): Record<string, string> {
  const deviceId = auth.deviceId || getOrCreateCueDeviceId(auth.accountId)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Connect-Protocol-Version': '1',
    'x-client-type': 'desktop',
    'x-client-version': '1.0.6',
    'x-client-id': deviceId,
    'x-product-name': 'manus-agents'
  }
  if (auth.accessToken) {
    headers['Authorization'] = `Bearer ${auth.accessToken}`
  }
  if (auth.apiKey) {
    headers['x-manus-api-key'] = auth.apiKey
    if (!headers['Authorization']) {
      headers['Authorization'] = `Bearer ${auth.apiKey}`
    }
  }
  if (auth.cookieHeader) {
    headers['Cookie'] = auth.cookieHeader
  }
  return headers
}

async function executeCueHttpOnce(
  auth: CueMainAuth,
  path: string,
  opts: {
    method?: 'GET' | 'POST'
    body?: unknown
    baseUrl?: string
    fetchImpl?: typeof fetch
  }
): Promise<{ status: number; ok: boolean; data: unknown }> {
  const base = (opts.baseUrl || auth.baseUrl || CUE_CONNECT_BASE).replace(/\/+$/, '')
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`
  const fetcher = cueFetcherForAccount(auth.accountId, opts.fetchImpl)
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const res = await fetcher(url, {
    method,
    headers: buildCueClientHeaders(auth),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: res.status, ok: res.ok, data: parsed }
}

export async function callCueApi(
  accountId: string,
  path: string,
  opts: {
    method?: 'GET' | 'POST'
    body?: unknown
    baseUrl?: string
    fetchImpl?: typeof fetch
  } = {}
): Promise<{ status: number; ok: boolean; data: unknown }> {
  let auth = await loadCueTokens(accountId)
  if (!auth) {
    return { status: 401, ok: false, data: { error: 'Not signed in to Cue' } }
  }
  const initialFingerprint = auth.accountFingerprint

  let result = await executeCueHttpOnce(auth, path, opts)
  if (result.status === 401 && auth.refreshToken) {
    const refreshed = await forceRefreshCueAuth(accountId, opts.baseUrl || auth.baseUrl, opts.fetchImpl)
    if (refreshed) {
      auth = refreshed
      result = await executeCueHttpOnce(auth, path, opts)
    }
  } else {
    // ProviderIdentityGuard: if another concurrent call already refreshed the token or switched account
    const latest = getCueMainAuth(accountId)
    if (result.status === 401 && latest && latest.accountFingerprint !== initialFingerprint) {
      result = await executeCueHttpOnce(latest, path, opts)
    }
  }

  return result
}

export async function fetchCueQuota(
  accountId: string,
  opts?: { baseUrl?: string; fetchImpl?: typeof fetch }
): Promise<CueQuotaView> {
  const res = await callCueApi(
    accountId,
    '/user.v1.SubscriptionService/GetAgentsMembership',
    {
      method: 'POST',
      body: {},
      baseUrl: opts?.baseUrl,
      fetchImpl: opts?.fetchImpl
    }
  )
  if (!res.ok) {
    // Decouple billing/quota 401/403 from chat online status (`dockyard-dsh` pattern)
    return {
      accessAllowed: true,
      limitCredits: null,
      usedCredits: null,
      reservedCredits: null,
      weeklyRemainingCredits: null,
      purchasedRemainingCredits: null,
      remainingPercent: null,
      windowStartMs: null,
      windowEndMs: null,
      quotaUnavailable: res.status === 401 || res.status === 403 || !res.ok
    }
  }
  const data = (res.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>
  return mapCueMembershipQuota(data)
}
