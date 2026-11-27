/**
 * Muse Usage / quota via Next.js Server Action (HTTPS + hatch_* cookies).
 * Not Noise RPC. Never logs cookies or tokens.
 */
import type { FetchFn } from './controlPlane'

const ORIGIN = 'https://muse.ai'

/** Known id from docs/museai/QUOTA.md — may change on deploy; we rediscover. */
const FALLBACK_ACTION_ID = '409b972cbb33d3e372f4ca9d3c8332677217064f62'

export interface MuseQuotaTier {
  tierId: string
  name: string
  tierCode: string
  isPaid: boolean
  rank: number
}

export interface MuseQuotaUsage {
  state: string
  percentUsed: number
  resetsAt: number | null
  quotaStatus: string
}

export interface MuseSubscription {
  tier: MuseQuotaTier
  usage: MuseQuotaUsage
  statusSubtitle: string | null
  usageRowLabel: string | null
  usageRowValueLabel: string | null
  usageRowFooter: string | null
  billingSubtitle: string | null
  topupBalance: number | null
  topupTotal: number | null
  topupRowLabel: string | null
  topupRowValueLabel: string | null
  topupEligible: boolean | null
  entryPointCtaLabel: string | null
}

export interface MuseQuotaSnapshot {
  fetchedAt: number
  stale: boolean
  success: boolean
  subscription: MuseSubscription | null
  error?: string
}

export class MuseQuotaError extends Error {
  constructor(
    message: string,
    readonly code?: 'signed_out' | 'action_not_found' | 'parse' | 'http'
  ) {
    super(message)
    this.name = 'MuseQuotaError'
  }
}

type ActionCacheKey = object | string
const accountActionIds = new Map<string, string>()
const deploymentActionIds = new WeakMap<object, string>()

function actionCache(key: ActionCacheKey) {
  return typeof key === 'string'
    ? { read: () => accountActionIds.get(key), write: (id: string) => accountActionIds.set(key, id) }
    : { read: () => deploymentActionIds.get(key), write: (id: string) => deploymentActionIds.set(key, id) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Parse Next Server Action `text/x-component` multi-line body for subscription JSON. */
export function parseSubscriptionActionBody(text: string): { success: boolean; subscription: MuseSubscription | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let found: Record<string, unknown> | null = null
  for (const line of lines) {
    const jsonPart = line.includes(':') && /^\d+:/.test(line) ? line.slice(line.indexOf(':') + 1) : line
    try {
      const parsed = JSON.parse(jsonPart) as unknown
      const o = obj(parsed)
      if (o['subscription'] || (o['success'] === true && o['subscription'])) {
        found = o
        break
      }
      // Some flight rows nest under result
      const nested = obj(o['result'])
      if (nested['subscription']) {
        found = nested
        break
      }
    } catch {
      /* skip non-JSON rows */
    }
  }
  if (!found) throw new MuseQuotaError('subscription action: no subscription JSON in response', 'parse')
  return { success: found['success'] !== false, subscription: normalizeSubscription(found['subscription']) }
}

export function normalizeSubscription(raw: unknown): MuseSubscription | null {
  const s = obj(raw)
  if (!Object.keys(s).length) return null
  const tier = obj(s['tier'])
  const usage = obj(s['usage'])
  return {
    tier: {
      tierId: str(tier['tierId'] || tier['tier_id']),
      name: str(tier['name']) || 'Muse',
      tierCode: str(tier['tierCode'] || tier['tier_code']),
      isPaid: bool(tier['isPaid'] ?? tier['is_paid']) === true,
      rank: num(tier['rank']) ?? 0
    },
    usage: {
      state: str(usage['state']) || 'UNKNOWN',
      percentUsed: Math.max(0, Math.min(100, Math.round(num(usage['percentUsed'] ?? usage['percent_used']) ?? 0))),
      resetsAt: num(usage['resetsAt'] ?? usage['resets_at']),
      quotaStatus: str(usage['quotaStatus'] || usage['quota_status'])
    },
    statusSubtitle: str(s['statusSubtitle'] || s['status_subtitle']) || null,
    usageRowLabel: str(s['usageRowLabel'] || s['usage_row_label']) || null,
    usageRowValueLabel: str(s['usageRowValueLabel'] || s['usage_row_value_label']) || null,
    usageRowFooter: str(s['usageRowFooter'] || s['usage_row_footer']) || null,
    billingSubtitle: str(s['billingSubtitle'] || s['billing_subtitle']) || null,
    topupBalance: num(s['topupBalance'] ?? s['topup_balance']),
    topupTotal: num(s['topupTotal'] ?? s['topup_total']),
    topupRowLabel: str(s['topupRowLabel'] || s['topup_row_label']) || null,
    topupRowValueLabel: str(s['topupRowValueLabel'] || s['topup_row_value_label']) || null,
    topupEligible: bool(s['topupEligible'] ?? s['topup_eligible']),
    entryPointCtaLabel: str(s['entryPointCtaLabel'] || s['entry_point_cta_label']) || 'Upgrade'
  }
}

const ACTION_RE =
  /(?:createServerReference|\.\w+)\)?\(\s*["']([0-9a-f]{40,44})["'][\s\S]{0,280}?["'](?:fetchSubscriptionAction|getSubscriptionAction|fetchUsageAction)["']/i
const ACTION_RE_REV =
  /["'](?:fetchSubscriptionAction|getSubscriptionAction|fetchUsageAction)["'][\s\S]{0,280}?(?:createServerReference|\.\w+)\)?\(\s*["']([0-9a-f]{40,44})["']/i
const LOOSE_NEAR =
  /(?:fetchSubscriptionAction|getSubscriptionAction|fetchUsageAction)[\s\S]{0,200}?([0-9a-f]{40,44})|([0-9a-f]{40,44})[\s\S]{0,200}?(?:fetchSubscriptionAction|getSubscriptionAction|fetchUsageAction)/i

const DISCOVERY_CHUNK_LIMIT = 240
const DISCOVERY_CONCURRENCY = 8

export function extractActionIdFromSource(source: string): string | null {
  return (
    source.match(ACTION_RE)?.[1] ||
    source.match(ACTION_RE_REV)?.[1] ||
    source.match(LOOSE_NEAR)?.[1] ||
    source.match(LOOSE_NEAR)?.[2] ||
    null
  )
}

function extractBalancedJsonObject(text: string, braceStart: number, maxLen = 32_768): string | null {
  if (text[braceStart] !== '{') return null
  let depth = 0
  let inStr = false
  let escaped = false
  const end = Math.min(text.length, braceStart + maxLen)
  for (let i = braceStart; i < end; i++) {
    const ch = text[i]!
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(braceStart, i + 1)
    }
  }
  return null
}

function isUsableSubscription(sub: MuseSubscription | null): sub is MuseSubscription {
  return Boolean(sub && (sub.tier.tierId || sub.tier.tierCode || sub.usage.state !== 'UNKNOWN'))
}

/** Extract an embedded subscription object directly from HTML / Next.js RSC flight chunks if present. */
export function extractSubscriptionFromHtml(html: string): MuseSubscription | null {
  const tryScan = (source: string): MuseSubscription | null => {
    const re = /"subscription"\s*:\s*\{/g
    let m: RegExpExecArray | null
    let attempts = 0
    while ((m = re.exec(source)) !== null && attempts++ < 8) {
      const braceIdx = m.index + m[0].length - 1
      const rawObj = extractBalancedJsonObject(source, braceIdx)
      if (!rawObj) continue
      try {
        const sub = normalizeSubscription(JSON.parse(rawObj) as unknown)
        if (isUsableSubscription(sub)) return sub
      } catch {
        /* keep scanning */
      }
    }
    return null
  }
  const direct = tryScan(html)
  if (direct) return direct
  if (html.includes('\\"subscription\\"')) {
    const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    return tryScan(unescaped)
  }
  return null
}

function collectChunkUrlsFromHtml(html: string, seen: Set<string>, queue: string[]): void {
  const push = (rawPath: string) => {
    const url = rawPath.startsWith('http') ? rawPath : new URL(rawPath, ORIGIN).href
    if ((!url.includes('muse.ai') && !rawPath.startsWith('/')) || seen.has(url)) return
    seen.add(url)
    queue.push(url)
  }
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const src = m[1]!
    if (/\.js(\?|$)/.test(src)) push(src)
  }
  for (const m of html.matchAll(/\/_next\/static\/[^"'\\\s<>]+\.js/g)) {
    push(m[0])
  }
}

function collectNestedChunkUrls(js: string, seen: Set<string>, queue: string[]): void {
  for (const m of js.matchAll(/["']((?:\/_next\/)?static\/(?:immutable\/)?chunks\/[A-Za-z0-9._/-]+\.js)["']/g)) {
    const raw = m[1]!
    const normalized = raw.startsWith('/') ? raw : `/_next/${raw}`
    const url = `${ORIGIN}${normalized}`
    if (!seen.has(url) && seen.size < DISCOVERY_CHUNK_LIMIT * 2) {
      seen.add(url)
      queue.push(url)
    }
  }
}

async function discoverSubscriptionContext(
  fetchFn: FetchFn,
  signal?: AbortSignal
): Promise<{ actionId: string | null; inlineSubscription: MuseSubscription | null }> {
  const seenScripts = new Set<string>()
  const scriptQueue: string[] = []
  let inlineSubscription: MuseSubscription | null = null
  // Probe /settings, / and /chat so authenticated app chunks (including lazy Turbopack chunks) are queued.
  for (const pagePath of ['/settings', '/', '/chat']) {
    signal?.throwIfAborted()
    try {
      const res = await fetchFn(ORIGIN + pagePath, {
        method: 'GET',
        headers: { Accept: 'text/html', 'Accept-Language': 'en-US' }
      })
      if (!res.ok) continue
      const html = await res.text()
      if (!inlineSubscription) inlineSubscription = extractSubscriptionFromHtml(html)
      const fromHtml = extractActionIdFromSource(html)
      if (fromHtml) return { actionId: fromHtml, inlineSubscription }
      collectChunkUrlsFromHtml(html, seenScripts, scriptQueue)
    } catch {
      /* try next page */
    }
  }
  let scanned = 0
  while (scriptQueue.length > 0 && scanned < DISCOVERY_CHUNK_LIMIT) {
    signal?.throwIfAborted()
    const batch = scriptQueue.splice(0, Math.min(DISCOVERY_CONCURRENCY, DISCOVERY_CHUNK_LIMIT - scanned))
    scanned += batch.length
    const results = await Promise.all(
      batch.map(async (url): Promise<{ actionId: string | null; js: string | null }> => {
        try {
          const r = await fetchFn(url, { headers: { Accept: '*/*' } })
          if (!r.ok) return { actionId: null, js: null }
          const js = await r.text()
          return { actionId: extractActionIdFromSource(js), js }
        } catch {
          return { actionId: null, js: null }
        }
      })
    )
    for (const item of results) {
      if (item.actionId) return { actionId: item.actionId, inlineSubscription }
    }
    for (const item of results) {
      if (item.js) collectNestedChunkUrls(item.js, seenScripts, scriptQueue)
    }
  }
  return { actionId: null, inlineSubscription }
}

/** Best-effort: scrape muse.ai bundles for the current Server Action id. */
export async function discoverSubscriptionActionId(fetchFn: FetchFn, signal?: AbortSignal): Promise<string | null> {
  const { actionId } = await discoverSubscriptionContext(fetchFn, signal)
  return actionId
}

async function tryRestSubscriptionEndpoints(fetchFn: FetchFn, fetchedAt: number): Promise<MuseQuotaSnapshot | null> {
  for (const endpoint of ['/api/subscription', '/api/hatch/subscription', '/api/billing/subscription', '/api/hatch/usage', '/api/usage']) {
    try {
      const res = await fetchFn(ORIGIN + endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json', Origin: ORIGIN, Referer: ORIGIN + '/' }
      })
      if (!res.ok) continue
      const json = (await res.json()) as unknown
      const root = obj(json)
      const sub = normalizeSubscription(root['subscription'] ?? root['result'] ?? root)
      if (isUsableSubscription(sub)) {
        return { fetchedAt, stale: false, success: true, subscription: sub }
      }
    } catch {
      /* try next */
    }
  }
  return null
}

async function postAction(
  fetchFn: FetchFn,
  actionId: string,
  includeAgreement: boolean,
  allowEmptyArgsRetry = false
): Promise<{ status: number; text: string; allAuthRejected: boolean }> {
  const bodies = allowEmptyArgsRetry ? [JSON.stringify([{ includeAgreement }]), '[]'] : [JSON.stringify([{ includeAgreement }])]
  let last = { status: 0, text: '' }
  let sawNonAuthStatus = false
  let sawAuthStatus = false
  // Try `/` first (official muse.ai Settings modal posts Server Actions to `/`), then `/settings`.
  for (const body of bodies) {
    for (const actionPath of ['/', '/settings']) {
      const res = await fetchFn(ORIGIN + actionPath, {
        method: 'POST',
        headers: {
          Accept: 'text/x-component',
          'Content-Type': 'text/plain;charset=UTF-8',
          'Next-Action': actionId,
          Origin: ORIGIN,
          Referer: ORIGIN + actionPath
        },
        body
      })
      const text = await res.text()
      last = { status: res.status, text }
      if (res.status === 401 || res.status === 403) {
        sawAuthStatus = true
        continue
      }
      sawNonAuthStatus = true
      if (res.status >= 200 && res.status < 300 && looksLikeSubscription(text)) {
        return { ...last, allAuthRejected: false }
      }
    }
    if (last.status >= 200 && last.status < 300 && looksLikeSubscription(last.text)) break
  }
  return { ...last, allAuthRejected: sawAuthStatus && !sawNonAuthStatus }
}

function looksLikeSubscription(text: string): boolean {
  return /"subscription"\s*:/.test(text) || /"percentUsed"\s*:/.test(text)
}

/**
 * Fetch current subscription / usage for the account whose cookies the fetchFn carries.
 */
export async function fetchSubscription(
  fetchFn: FetchFn,
  opts: { includeAgreement?: boolean; rediscover?: boolean; accountId?: string; deployment?: string; signal?: AbortSignal } = {}
): Promise<MuseQuotaSnapshot> {
  const includeAgreement = opts.includeAgreement === true
  const fetchedAt = Date.now()
  const cache = actionCache(opts.accountId === undefined ? fetchFn : JSON.stringify([opts.accountId, opts.deployment ?? ORIGIN]))
  const cached = cache.read()
  const tryIds = new Set([cached ?? FALLBACK_ACTION_ID, FALLBACK_ACTION_ID])
  let lastStatus = 0
  let lastText = ''
  let lastAllAuthRejected = false
  let parseError: MuseQuotaError | undefined

  const tryAction = async (id: string, allowEmptyArgsRetry = false): Promise<MuseQuotaSnapshot | undefined> => {
    opts.signal?.throwIfAborted()
    const { status, text, allAuthRejected } = await postAction(fetchFn, id, includeAgreement, allowEmptyArgsRetry)
    opts.signal?.throwIfAborted()
    lastStatus = status
    lastText = text
    lastAllAuthRejected = allAuthRejected
    if (status === 401 && allAuthRejected) {
      throw new MuseQuotaError(`quota: not signed in (${status})`, 'signed_out')
    }
    if (status < 200 || status >= 300 || !looksLikeSubscription(text)) return
    try {
      const parsed = parseSubscriptionActionBody(text)
      if (parsed.success && parsed.subscription && (cache.read() === cached || cache.read() === id)) cache.write(id)
      return { fetchedAt, stale: false, success: parsed.success, subscription: parsed.subscription }
    } catch (error) {
      if (!(error instanceof MuseQuotaError) || error.code !== 'parse') throw error
      parseError = error
    }
  }

  for (const id of tryIds) {
    const snapshot = await tryAction(id)
    if (snapshot) return snapshot
  }
  let inlineSubscription: MuseSubscription | null = null
  if (opts.rediscover !== false) {
    const discovered = await discoverSubscriptionContext(fetchFn, opts.signal)
    opts.signal?.throwIfAborted()
    inlineSubscription = discovered.inlineSubscription
    if (discovered.actionId && !tryIds.has(discovered.actionId)) {
      const snapshot = await tryAction(discovered.actionId, true)
      if (snapshot) return snapshot
    }
  }

  const viaRest = await tryRestSubscriptionEndpoints(fetchFn, fetchedAt)
  opts.signal?.throwIfAborted()
  if (viaRest) return viaRest
  if (inlineSubscription) {
    return { fetchedAt, stale: false, success: true, subscription: inlineSubscription }
  }
  if (parseError) throw parseError
  if (lastAllAuthRejected && (lastStatus === 401 || lastStatus === 403)) {
    throw new MuseQuotaError(`quota: not signed in (${lastStatus})`, 'signed_out')
  }
  if (lastStatus === 404 || lastStatus === 400 || lastStatus === 409 || !looksLikeSubscription(lastText)) {
    throw new MuseQuotaError(
      `quota: fetchSubscriptionAction unavailable (HTTP ${lastStatus || 'n/a'})`,
      'action_not_found'
    )
  }
  throw new MuseQuotaError(`quota: HTTP ${lastStatus}`, 'http')
}

/** @deprecated Prefer invite.ts; kept for quota poll compatibility. */
export { fetchInviteSummary } from './invite'
