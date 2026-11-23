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
  sessionId?: string
  email?: string
  phoneNumber?: string
  pcId?: string
  isManus?: boolean
  icon?: string
  lastDisplayMessage?: string
  avatarShape?: string
  avatarColor?: string
}

export interface CueHistoryMessage {
  id: string
  role: 'user' | 'bot'
  text: string
  createdAtMs: number
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value)
    if (Number.isFinite(num)) {
      return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export function mapCueAgentItem(raw: unknown): CueAgentSummary | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const id = nonEmptyString(rec['id'] ?? rec['agentId'] ?? rec['agent_id'])
  if (!id) return null
  const name = nonEmptyString(rec['name'] ?? rec['nickname'] ?? rec['title']) ?? 'Cue'
  const sessionId = nonEmptyString(rec['sessionUid'] ?? rec['session_uid'] ?? rec['sessionId'] ?? rec['taskId'] ?? rec['task_id'])
  const email = nonEmptyString(rec['email'])
  const phoneNumber = nonEmptyString(rec['phoneNumber'] ?? rec['phone_number'])
  const pcId = nonEmptyString(rec['pcId'] ?? rec['pc_id'])
  const icon = nonEmptyString(rec['icon'])
  const lastDisplayMessage = nonEmptyString(rec['lastDisplayMessage'] ?? rec['last_display_message'])
  const isManus = typeof rec['isManus'] === 'boolean'
    ? rec['isManus']
    : typeof rec['is_manus'] === 'boolean'
      ? rec['is_manus']
      : undefined

  const metaParts = [email, phoneNumber].filter(Boolean)
  const explicitDesc = nonEmptyString(rec['description'] ?? rec['instruction'] ?? rec['about'])
  const description = explicitDesc ?? (metaParts.length > 0 ? metaParts.join(' · ') : lastDisplayMessage)

  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(email ? { email, handle: email } : {}),
    ...(phoneNumber ? { phoneNumber } : {}),
    ...(pcId ? { pcId } : {}),
    ...(icon ? { icon } : {}),
    ...(lastDisplayMessage ? { lastDisplayMessage } : {}),
    ...(isManus !== undefined ? { isManus } : {}),
    ...(nonEmptyString(rec['avatarShape']) ? { avatarShape: nonEmptyString(rec['avatarShape']) } : {}),
    ...(nonEmptyString(rec['avatarColor']) ? { avatarColor: nonEmptyString(rec['avatarColor']) } : {})
  }
}

export function mapCueMembershipQuota(raw: Record<string, unknown>): CueQuotaView {
  const membership =
    raw['membership'] && typeof raw['membership'] === 'object' && !Array.isArray(raw['membership'])
      ? (raw['membership'] as Record<string, unknown>)
      : {}
  const accessAllowed = (membership['accessAllowed'] ?? membership['access_allowed']) !== false
  const limit = toOptionalNumber(
    raw['limitCredits'] ?? raw['limit_credits'] ?? membership['limitCredits'] ?? membership['limit_credits']
  )
  const usedRaw = toOptionalNumber(
    raw['usedCredits'] ?? raw['used_credits'] ?? membership['usedCredits'] ?? membership['used_credits']
  )
  const reservedRaw = toOptionalNumber(
    raw['reservedCredits'] ??
      raw['reserved_credits'] ??
      membership['reservedCredits'] ??
      membership['reserved_credits']
  )
  const used = usedRaw ?? 0
  const reserved = reservedRaw ?? 0
  const explicitWeekly = toOptionalNumber(
    raw['weeklyRemainingCredits'] ??
      raw['weekly_remaining_credits'] ??
      raw['remainingCredits'] ??
      raw['remaining_credits'] ??
      raw['availableCredits'] ??
      raw['available_credits'] ??
      membership['weeklyRemainingCredits'] ??
      membership['weekly_remaining_credits'] ??
      membership['remainingCredits'] ??
      membership['remaining_credits']
  )
  const computedRemaining =
    limit !== null ? Math.max(0, limit - used - reserved) : explicitWeekly
  const weeklyRemaining =
    explicitWeekly !== null && limit !== null
      ? Math.max(0, Math.min(explicitWeekly, limit - used - reserved))
      : computedRemaining
  const purchasedRaw = toOptionalNumber(
    raw['purchasedRemainingCredits'] ??
      raw['purchased_remaining_credits'] ??
      membership['purchasedRemainingCredits'] ??
      membership['purchased_remaining_credits']
  )
  const purchased = purchasedRaw !== null ? Math.max(0, purchasedRaw) : null
  const remainingPercent =
    limit && limit > 0 && weeklyRemaining !== null
      ? Math.max(0, Math.min(100, Math.round((weeklyRemaining / limit) * 100)))
      : null

  return {
    accessAllowed,
    limitCredits: limit,
    usedCredits: usedRaw,
    reservedCredits: reservedRaw,
    weeklyRemainingCredits: weeklyRemaining,
    purchasedRemainingCredits: purchased,
    remainingPercent,
    windowStartMs: toOptionalNumber(
      raw['windowStartMs'] ??
        raw['window_start_ms'] ??
        membership['windowStartMs'] ??
        membership['window_start_ms']
    ),
    windowEndMs: toOptionalNumber(
      raw['windowEndMs'] ??
        raw['window_end_ms'] ??
        membership['windowEndMs'] ??
        membership['window_end_ms']
    )
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

function hasQuotaNumbers(q: CueQuotaView): boolean {
  return (
    q.limitCredits !== null ||
    q.weeklyRemainingCredits !== null ||
    q.purchasedRemainingCredits !== null
  )
}

export async function fetchCueQuota(
  accountId: string,
  opts?: { baseUrl?: string; fetchImpl?: typeof fetch }
): Promise<CueQuotaView> {
  const membershipRes = await callCueApi(
    accountId,
    '/user.v1.SubscriptionService/GetAgentsMembership',
    {
      method: 'POST',
      body: {},
      baseUrl: opts?.baseUrl,
      fetchImpl: opts?.fetchImpl
    }
  )

  const mappedMembership = membershipRes.ok
    ? mapCueMembershipQuota(asRecord(membershipRes.data) ?? {})
    : null

  if (mappedMembership && hasQuotaNumbers(mappedMembership)) {
    return mappedMembership
  }

  const creditsRes = await callCueApi(
    accountId,
    '/user.v1.SubscriptionService/GetAgentsAvailableCredits',
    {
      method: 'POST',
      body: {},
      baseUrl: opts?.baseUrl,
      fetchImpl: opts?.fetchImpl
    }
  )

  const mappedCredits = creditsRes.ok
    ? mapCueMembershipQuota(asRecord(creditsRes.data) ?? {})
    : null

  if (mappedMembership && mappedCredits && hasQuotaNumbers(mappedCredits)) {
    return {
      accessAllowed: mappedCredits.accessAllowed && mappedMembership.accessAllowed,
      limitCredits: mappedCredits.limitCredits ?? mappedMembership.limitCredits,
      usedCredits: mappedCredits.usedCredits ?? mappedMembership.usedCredits,
      reservedCredits: mappedCredits.reservedCredits ?? mappedMembership.reservedCredits,
      weeklyRemainingCredits:
        mappedCredits.weeklyRemainingCredits ?? mappedMembership.weeklyRemainingCredits,
      purchasedRemainingCredits:
        mappedCredits.purchasedRemainingCredits ?? mappedMembership.purchasedRemainingCredits,
      remainingPercent: mappedCredits.remainingPercent ?? mappedMembership.remainingPercent,
      windowStartMs: mappedCredits.windowStartMs ?? mappedMembership.windowStartMs,
      windowEndMs: mappedCredits.windowEndMs ?? mappedMembership.windowEndMs
    }
  }

  if (mappedCredits && hasQuotaNumbers(mappedCredits)) {
    return mappedCredits
  }

  if (mappedMembership) {
    return {
      ...mappedMembership,
      ...(!creditsRes.ok ? { quotaUnavailable: true } : {})
    }
  }

  if (mappedCredits) {
    return {
      ...mappedCredits,
      quotaUnavailable: true
    }
  }

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
    quotaUnavailable: true
  }
}

export async function fetchCueAgents(
  accountId: string,
  opts?: { limit?: number; baseUrl?: string; fetchImpl?: typeof fetch }
): Promise<{ ok: boolean; status: number; agents: CueAgentSummary[]; error?: string }> {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 50))
  const res = await callCueApi(accountId, '/agents.v1.AgentsService/ListAgents', {
    method: 'POST',
    body: { limit },
    baseUrl: opts?.baseUrl,
    fetchImpl: opts?.fetchImpl
  })
  if (!res.ok) {
    const rec = asRecord(res.data)
    return {
      ok: false,
      status: res.status,
      agents: [],
      error: nonEmptyString(rec?.['message']) ?? `Cue ListAgents failed (${res.status})`
    }
  }
  const rec = asRecord(res.data)
  const rawList = Array.isArray(res.data)
    ? res.data
    : Array.isArray(rec?.['agents'])
      ? (rec['agents'] as unknown[])
      : Array.isArray(rec?.['items'])
        ? (rec['items'] as unknown[])
        : []
  const agents: CueAgentSummary[] = []
  for (const item of rawList) {
    const mapped = mapCueAgentItem(item)
    if (mapped) agents.push(mapped)
  }
  return { ok: true, status: res.status, agents }
}

export async function fetchCueAgentById(
  accountId: string,
  agentId: string,
  opts?: { baseUrl?: string; fetchImpl?: typeof fetch }
): Promise<CueAgentSummary | null> {
  if (!agentId.trim()) return null
  const res = await callCueApi(accountId, '/agents.v1.AgentsService/GetAgent', {
    method: 'POST',
    body: { id: agentId },
    baseUrl: opts?.baseUrl,
    fetchImpl: opts?.fetchImpl
  })
  if (!res.ok) return null
  const rec = asRecord(res.data)
  return mapCueAgentItem(rec?.['agent'] ?? rec)
}

function readChatText(ev: Record<string, unknown>): string | undefined {
  const direct = nonEmptyString(ev['content'] ?? ev['text'])
  if (direct) return direct
  const contents = ev['contents']
  if (Array.isArray(contents)) {
    const parts = contents
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        const part = asRecord(item)
        if (!part) return ''
        return nonEmptyString(part['value'] ?? part['text'] ?? part['content']) ?? ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }
  return undefined
}

const CUE_HISTORY_CONTAINER_KEYS = [
  'events',
  'messages',
  'segments',
  'turns',
  'turn',
  'turnUserMessage',
  'blocks',
  'items',
  'item',
  'event',
  'group',
  'children',
  'data',
  'session',
  'page',
  'results'
] as const

function collectCueHistoryIntoMap(
  raw: unknown,
  byId: Map<string, CueHistoryMessage>,
  indexRef: { count: number }
): void {
  const rawItems: unknown[] = []
  const visited = new WeakSet<object>()
  const collectEvents = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 12) return
    if (visited.has(node)) return
    visited.add(node)
    if (Array.isArray(node)) {
      for (const item of node) collectEvents(item, depth + 1)
      return
    }
    const rec = asRecord(node)
    if (!rec) return
    if (rec['type'] === 'chat' || (rec['type'] === 'event' && asRecord(rec['event'])?.['type'] === 'chat')) {
      rawItems.push(rec['type'] === 'event' ? rec['event'] : rec)
      return
    }
    for (const key of CUE_HISTORY_CONTAINER_KEYS) {
      if (rec[key] !== undefined) collectEvents(rec[key], depth + 1)
    }
  }

  collectEvents(raw)

  for (const item of rawItems) {
    const ev = asRecord(item)
    if (!ev || ev['type'] !== 'chat') continue
    const sender = nonEmptyString(ev['sender'])?.toLowerCase()
    if (sender !== 'user' && sender !== 'assistant') continue
    const text = readChatText(ev)
    if (!text) continue
    indexRef.count += 1
    const id = nonEmptyString(ev['id']) ?? `cue_hist_${indexRef.count}`
    const createdAtMs = toEpochMs(ev['timestamp'] ?? ev['createdAt'] ?? ev['created_at'], indexRef.count)
    byId.set(id, {
      id,
      role: sender === 'user' ? 'user' : 'bot',
      text,
      createdAtMs
    })
  }
}

export function extractCueHistoryMessages(raw: unknown): CueHistoryMessage[] {
  const byId = new Map<string, CueHistoryMessage>()
  collectCueHistoryIntoMap(raw, byId, { count: 0 })
  return [...byId.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)
}

function getSessionViewPagination(raw: unknown): { hasMoreBefore: boolean; beforeCursor?: string } {
  const root = asRecord(raw)
  const page = asRecord(root?.['page'])
  const turnsRaw = Array.isArray(root?.['turns'])
    ? (root['turns'] as unknown[])
    : Array.isArray(page?.['turns'])
      ? (page['turns'] as unknown[])
      : null
  if (!turnsRaw || turnsRaw.length === 0) {
    return { hasMoreBefore: false }
  }
  const firstTurn = asRecord(turnsRaw[0])
  if (!firstTurn) return { hasMoreBefore: false }
  const prevId = nonEmptyString(firstTurn['prevId'] ?? firstTurn['prev_id'])
  if (!prevId) return { hasMoreBefore: false }

  const kind = nonEmptyString(firstTurn['kind'])
  let firstTurnId: string | undefined
  if (kind === 'events') {
    firstTurnId = nonEmptyString(firstTurn['userChatId'] ?? firstTurn['id'] ?? firstTurn['turnId'])
  } else {
    const innerTurn = asRecord(firstTurn['turn'])
    const turnUserMsg = asRecord(innerTurn?.['turnUserMessage'])
    firstTurnId = nonEmptyString(
      turnUserMsg?.['id'] ??
        innerTurn?.['turnUserMessageId'] ??
        innerTurn?.['id'] ??
        firstTurn['id'] ??
        firstTurn['turnId'] ??
        firstTurn['userChatId']
    )
  }
  return {
    hasMoreBefore: Boolean(firstTurnId),
    ...(firstTurnId ? { beforeCursor: firstTurnId } : {})
  }
}

export async function fetchCueSessionHistory(
  accountId: string,
  sessionId: string,
  opts?: { limit?: number; maxPages?: number; baseUrl?: string; fetchImpl?: typeof fetch }
): Promise<{ ok: boolean; status: number; messages: CueHistoryMessage[] }> {
  const limit = Math.max(1, Math.min(300, opts?.limit ?? 300))
  const maxPages = Math.max(1, Math.min(30, opts?.maxPages ?? 20))
  const byId = new Map<string, CueHistoryMessage>()
  const indexRef = { count: 0 }
  let anyOk = false
  let lastStatus = 200

  // Primary path: `/api/chat/getSessionView` (supports `before` turn pagination)
  const seenViewCursors = new Set<string>()
  let beforeCursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const qs = new URLSearchParams({
      sessionId,
      type: 'private',
      layout: 'events'
    })
    if (beforeCursor) {
      qs.set('before', beforeCursor)
    }
    const res = await callCueApi(accountId, `/api/chat/getSessionView?${qs.toString()}`, {
      method: 'GET',
      baseUrl: opts?.baseUrl,
      fetchImpl: opts?.fetchImpl
    })
    lastStatus = res.status
    if (!res.ok) break
    anyOk = true
    collectCueHistoryIntoMap(res.data, byId, indexRef)
    const next = getSessionViewPagination(res.data)
    if (!next.hasMoreBefore || !next.beforeCursor || seenViewCursors.has(next.beforeCursor)) {
      break
    }
    seenViewCursors.add(next.beforeCursor)
    beforeCursor = next.beforeCursor
  }

  // Fallback path: `/api/chat/getSessionV2` when getSessionView failed or yielded no messages
  if (!anyOk || byId.size === 0) {
    const seenV2Cursors = new Set<string>()
    let v2Cursor: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const qs = new URLSearchParams({
        sessionId,
        type: 'private',
        historyLimit: String(limit)
      })
      if (v2Cursor) {
        qs.set('historyCursor', v2Cursor)
        qs.set('historyDirection', 'before')
      }
      const res = await callCueApi(accountId, `/api/chat/getSessionV2?${qs.toString()}`, {
        method: 'GET',
        baseUrl: opts?.baseUrl,
        fetchImpl: opts?.fetchImpl
      })
      lastStatus = res.status
      if (!res.ok) break
      anyOk = true
      collectCueHistoryIntoMap(res.data, byId, indexRef)
      const root = asRecord(res.data)
      const sessionRec = asRecord(root?.['session'])
      const hasMoreBefore =
        root?.['hasMoreBefore'] !== false &&
        root?.['has_more_before'] !== false &&
        sessionRec?.['hasMoreBefore'] !== false
      const nextCursor = nonEmptyString(
        root?.['historyCursor'] ??
          root?.['nextCursor'] ??
          root?.['olderCursor'] ??
          sessionRec?.['historyCursor'] ??
          sessionRec?.['nextCursor'] ??
          sessionRec?.['olderCursor']
      )
      if (!hasMoreBefore || !nextCursor || seenV2Cursors.has(nextCursor)) {
        break
      }
      seenV2Cursors.add(nextCursor)
      v2Cursor = nextCursor
    }
  }

  return {
    ok: anyOk,
    status: lastStatus,
    messages: [...byId.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)
  }
}
