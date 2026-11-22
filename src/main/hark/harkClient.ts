/**
 * Hark Go REST + Real-time Sync (`/api/sync/conversation` SSE + `/api/sync/poll` fallback)
 * bound to an Electron session partition.
 *
 * Reverse-engineered from Hark.app (0.1.21) & frontend chunks `DD3Rh-3z.js`,
 * `j8yWSo31.js`, and `worker-Ce4znvdx.js`.
 * Never logs cookie values or tokens.
 */

import { randomUUID } from 'node:crypto'
import { session as electronSession, type Session } from 'electron'
import { applyProxyToPartition } from '../muse/accountProxy'
import { guessMediaMimeFromName, inferMediaMime } from '../mediaMime'
import { partitionForAccount } from '../webContentsViewManager'
import { HarkWatchRegistry } from './watchRegistry'

export const HARK_ORIGIN = 'https://app.hark.com'
export const HARK_API_BASE = `${HARK_ORIGIN}/api`
export const HARK_LOGIN_URL = `${HARK_ORIGIN}/login`
export const HARK_CLIENT_VERSION = '0.1.21'
const DEFAULT_HARK_CHROME_VERSION = '147.0.0.0'
const DEFAULT_HARK_ELECTRON_VERSION = '45.2.1'

export function buildHarkPlatformStrings(platform: NodeJS.Platform = process.platform): {
  osToken: string
  secChUaPlatform: '"Windows"' | '"macOS"' | '"Linux"'
} {
  if (platform === 'win32') {
    return { osToken: 'Windows NT 10.0; Win64; x64', secChUaPlatform: '"Windows"' }
  }
  if (platform === 'darwin') {
    return { osToken: 'Macintosh; Intel Mac OS X 10_15_7', secChUaPlatform: '"macOS"' }
  }
  return { osToken: 'X11; Linux x86_64', secChUaPlatform: '"Linux"' }
}

export function buildHarkUserAgent(
  opts: { platform?: NodeJS.Platform; chromeVersion?: string; electronVersion?: string } = {}
): string {
  const { osToken } = buildHarkPlatformStrings(opts.platform)
  const rawChrome = opts.chromeVersion ?? process.versions?.chrome
  const chromeVer =
    rawChrome && /^\d+(\.\d+)*$/.test(rawChrome) ? rawChrome : DEFAULT_HARK_CHROME_VERSION
  const rawElectron = opts.electronVersion ?? process.versions?.electron
  const electronVer =
    rawElectron && /^\d+(\.\d+)*$/.test(rawElectron) ? rawElectron : DEFAULT_HARK_ELECTRON_VERSION
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Hark/${HARK_CLIENT_VERSION} Chrome/${chromeVer} Electron/${electronVer} Safari/537.36`
}

export function buildHarkSecChUa(chromeVersion = process.versions?.chrome): string {
  const full =
    chromeVersion && /^\d+(\.\d+)*$/.test(chromeVersion)
      ? chromeVersion
      : DEFAULT_HARK_CHROME_VERSION
  const major = full.split('.')[0] || '147'
  return `"Chromium";v="${major}", "Not:A-Brand";v="24"`
}

export const HARK_USER_AGENT = buildHarkUserAgent()

export class HarkApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, bodyText: string) {
    let parsed: unknown = bodyText
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      /* keep text */
    }
    const message =
      typeof parsed === 'object' &&
      parsed &&
      typeof (parsed as { message?: unknown }).message === 'string'
        ? (parsed as { message: string }).message
        : typeof parsed === 'object' &&
            parsed &&
            typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `Hark API error ${status}`
    super(message)
    this.name = 'HarkApiError'
    this.status = status
    this.body = parsed
  }
}

export type HarkSessionUser = {
  id?: string
  email?: string | null
  name?: string | null
  image?: string | null
}

export type HarkAuthSession = {
  user?: HarkSessionUser | null
  session?: { id?: string; token?: string; expiresAt?: string } | null
} | null

function localeHeader(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

export function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function sessionForAccount(accountId: string): Session {
  return electronSession.fromPartition(partitionForAccount(accountId))
}

/**
 * Resolve the account's Electron session ONLY after enforcing per-account proxy
 * rules (fails closed with `ProxyConfigUnreadableError` + blackhole proxy if
 * `safeStorage` cannot decrypt a configured proxy).
 */
export async function preparedSessionForAccount(accountId: string): Promise<Session> {
  await applyProxyToPartition(accountId)
  return sessionForAccount(accountId)
}

export function buildHarkClientHeaders(
  extra?: Record<string, string>,
  opts: {
    platform?: NodeJS.Platform
    chromeVersion?: string
    electronVersion?: string
    locale?: string
    timezone?: string
  } = {}
): Record<string, string> {
  const { secChUaPlatform } = buildHarkPlatformStrings(opts.platform)
  return {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Origin: HARK_ORIGIN,
    Referer: `${HARK_ORIGIN}/`,
    'User-Agent': buildHarkUserAgent({
      platform: opts.platform,
      chromeVersion: opts.chromeVersion,
      electronVersion: opts.electronVersion
    }),
    'X-Hark-Locale': opts.locale ?? localeHeader(),
    'X-Hark-Timezone': opts.timezone ?? timezoneName(),
    'X-Hark-Client-Version': HARK_CLIENT_VERSION,
    'Sec-Ch-Ua': buildHarkSecChUa(opts.chromeVersion),
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': secChUaPlatform,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(extra ?? {})
  }
}

function harkClientHeaders(extra?: Record<string, string>): Record<string, string> {
  return buildHarkClientHeaders(extra)
}

const HARK_REQUEST_TIMEOUT_MS = 30_000

async function harkFetch(
  ses: Session,
  path: string,
  init: {
    method?: string
    query?: Record<string, string | undefined>
    body?: unknown
    signal?: AbortSignal
    interactive?: boolean
  } = {}
): Promise<unknown> {
  const url = new URL(path.startsWith('http') ? path : `${HARK_API_BASE}${path}`)
  if (init.query) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value != null && value !== '') url.searchParams.set(key, value)
    }
  }

  const headers = harkClientHeaders(
    init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined
  )
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET')
  const maxAttempts = method === 'GET' ? (init.interactive ? 2 : 3) : 1
  let lastErr: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 350 * attempt))
    }
    // Every attempt gets its own deadline; a stalled request used to leave
    // the bubble on "Sending" and the account `pending` until restart.
    const deadline = AbortSignal.timeout(init.interactive ? 12000 : HARK_REQUEST_TIMEOUT_MS)
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    try {
      const response = await ses.fetch(url.toString(), {
        method,
        credentials: 'include',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal
      })

      const text = await response.text()
      if (!response.ok) {
        const err = new HarkApiError(response.status, text || response.statusText)
        if (
          (response.status === 429 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504) &&
          attempt + 1 < maxAttempts
        ) {
          lastErr = err
          continue
        }
        throw err
      }
      if (!text) return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    } catch (err) {
      lastErr = err
      if (init.signal?.aborted || err instanceof HarkApiError) throw err
      // A write that timed out may already have landed: don't send it twice.
      if (deadline.aborted && method !== 'GET') throw new Error(`Hark ${method} ${url.pathname} timed out`)
      if (attempt + 1 >= maxAttempts) throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Hark request failed')
}

export async function callHarkApi(
  accountId: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    path: string
    query?: Record<string, string | undefined>
    body?: unknown
  }
): Promise<unknown> {
  const cleanPath = opts.path.startsWith('/') ? opts.path : `/${opts.path}`
  const ses = await preparedSessionForAccount(accountId)
  return harkFetch(ses, cleanPath, {
    method: opts.method,
    query: opts.query,
    body: opts.body
  })
}

export async function getAuthSession(accountId: string): Promise<HarkAuthSession> {
  const ses = await preparedSessionForAccount(accountId)
  const data = await harkFetch(ses, '/auth/get-session', { interactive: true })
  if (data == null) return null
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Hark returned an invalid session response')
  }
  const rec = data as Record<string, unknown>
  if (rec['user'] || rec['session']) {
    return data as HarkAuthSession
  }
  if (rec['data'] && typeof rec['data'] === 'object') {
    const inner = rec['data'] as Record<string, unknown>
    if (inner['user'] || inner['session']) {
      return inner as unknown as HarkAuthSession
    }
  }
  return data as HarkAuthSession
}

export function extractHandle(session: HarkAuthSession): {
  handle?: string
  displayName?: string
  userId?: string
} {
  const user = session && typeof session === 'object' ? session.user : null
  if (!user || typeof user !== 'object') return {}
  const email = typeof user.email === 'string' ? user.email : undefined
  const name = typeof user.name === 'string' ? user.name : undefined
  const userId = typeof user.id === 'string' ? user.id : undefined
  return { handle: email ?? name, displayName: name ?? email, userId }
}

/** Cookie names that indicate a signed-in Hark better-auth session. */
export function looksLikeSessionCookie(name: string): boolean {
  if (name === '__Secure-hark.state' || name === '__Secure-hark.region_flow') return false
  if (name.startsWith('__Secure-hark.')) return true
  if (/^better-auth\.session/i.test(name)) return true
  if (/hark.*session/i.test(name) && !/state|region/i.test(name)) return true
  return false
}

export async function listSessionCookieNames(accountId: string): Promise<string[]> {
  const ses = sessionForAccount(accountId)
  const cookies = await ses.cookies.get({})
  const names = new Set<string>()
  for (const c of cookies) {
    if (looksLikeSessionCookie(c.name)) names.add(c.name)
  }
  return [...names]
}

/**
 * Import Hark session cookies from a standard Cookie header string,
 * JSON cookie array, or raw `__Secure-hark.session_token` value.
 */
export async function importHarkCredentials(accountId: string, rawInput: string): Promise<boolean> {
  const trimmed = rawInput.trim().replace(/^Cookie:\s*/i, '')
  if (!trimmed) return false
  const ses = await preparedSessionForAccount(accountId)
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30
  const pairs: Array<{ name: string; value: string; domain?: string; path?: string }> = []

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        if (typeof rec.name === 'string' && typeof rec.value === 'string') {
          pairs.push({
            name: rec.name,
            value: rec.value,
            domain: typeof rec.domain === 'string' ? rec.domain : 'app.hark.com',
            path: typeof rec.path === 'string' ? rec.path : '/'
          })
        } else if (typeof rec.token === 'string' && rec.token.trim()) {
          pairs.push({ name: '__Secure-hark.session_token', value: rec.token.trim() })
          pairs.push({ name: '__Secure-better-auth.session_token', value: rec.token.trim() })
        }
      }
    } catch {
      /* fall through to key=value parsing */
    }
  }

  if (pairs.length === 0) {
    if (trimmed.includes('=')) {
      for (const segment of trimmed.split(/[;\n]+/)) {
        const idx = segment.indexOf('=')
        if (idx <= 0) continue
        const name = segment.slice(0, idx).trim()
        const value = segment.slice(idx + 1).trim()
        if (name && value) pairs.push({ name, value })
      }
    } else {
      pairs.push({ name: '__Secure-hark.session_token', value: trimmed })
      pairs.push({ name: '__Secure-better-auth.session_token', value: trimmed })
    }
  }

  if (pairs.length === 0) return false
  for (const c of pairs) {
    try {
      await ses.cookies.set({
        url: HARK_ORIGIN + (c.path?.startsWith('/') ? c.path : '/'),
        domain: c.domain || 'app.hark.com',
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: true,
        httpOnly: true,
        expirationDate: exp
      })
    } catch {
      /* ignore individual cookie errors */
    }
  }
  await ses.cookies.flushStore().catch(() => undefined)
  return true
}

export async function clearHarkAccount(accountId: string): Promise<void> {
  cancelHarkWatch(accountId)
  const ses = sessionForAccount(accountId)
  await ses
    .clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
    })
    .catch(() => undefined)
  await ses.cookies.flushStore().catch(() => undefined)
}

/**
 * Fetch the full conversation transcript via `/api/sync/poll?first=1`
 * (since `/conversations/main` only returns `{ conversationId }` metadata).
 */
export async function fetchConversationSnapshotSummary(
  accountId: string,
  conversationId: string
): Promise<HarkConversationSnapshotSummary> {
  const ses = await preparedSessionForAccount(accountId)
  const managerId = randomUUID()
  const syncState = new HarkConversationSyncState()
  const pollRes = (await harkFetch(ses, '/sync/poll', {
    method: 'GET',
    query: {
      conversationId,
      v: '2',
      manager: managerId,
      mode: 'in_tab',
      dial: 'initial',
      first: '1'
    }
  })) as { frames?: string[] } | null
  if (pollRes && Array.isArray(pollRes.frames)) {
    for (const frame of pollRes.frames) {
      syncState.applyFrame(frame)
    }
  }
  return {
    conversationId,
    messages: syncState.orderedMessages(),
    panels: syncState.extractPanels(),
    asks: syncState.extractAsks(),
    artifacts: syncState.extractArtifacts(),
    activeActivity: syncState.activeActivity,
    narration: syncState.narration
  }
}

export async function fetchConversationSnapshotMessages(
  accountId: string,
  conversationId: string
): Promise<HarkChatMessage[]> {
  const snap = await fetchConversationSnapshotSummary(accountId, conversationId)
  return snap.messages
}

export async function getProfile(accountId: string, interactive = false): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/profile', { interactive })
}

export async function listConversations(accountId: string): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/conversations')
}

export async function getMainConversation(
  accountId: string,
  timezone = timezoneName()
): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/conversations/main', {
    query: { timezone }
  })
}

export async function getConversationStatuses(accountId: string): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/conversations/status')
}

export interface HarkUploadedAttachment {
  attachment_id: string
  name: string
  media_type: string
  size: number
  path: string
  s3_key: string
  kind: 'file'
  text?: string
}

/**
 * 3-step file upload from `DD3Rh-3z.js`:
 * 1. `POST /api/files/upload/${conversationId}/presign` `{ filename, content_type, size }`
 * 2. `PUT <upload_url>` raw bytes
 * 3. `POST /api/files/${conversationId}/${attachment_id}/finalize` `{ s3_key, path }`
 */
export async function uploadHarkAttachment(
  accountId: string,
  conversationId: string,
  file: { name: string; mimeType: string; dataBase64: string }
): Promise<HarkUploadedAttachment> {
  const ses = await preparedSessionForAccount(accountId)
  const bytes = Buffer.from(file.dataBase64, 'base64')
  const contentType = file.mimeType || 'application/octet-stream'

  const presign = (await harkFetch(ses, `/files/upload/${encodeURIComponent(conversationId)}/presign`, {
    method: 'POST',
    body: {
      filename: file.name,
      content_type: contentType,
      size: bytes.byteLength
    }
  })) as Record<string, unknown>

  const uploadUrl = String(presign?.['upload_url'] ?? '')
  const attachmentId = String(presign?.['attachment_id'] ?? '')
  const s3Key = String(presign?.['s3_key'] ?? '')
  const path = String(presign?.['path'] ?? file.name)
  if (!uploadUrl || !attachmentId || !s3Key) {
    throw new Error('Hark presign returned incomplete metadata')
  }

  const putRes = await ses.fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': String(presign?.['content_type'] ?? contentType) },
    body: new Uint8Array(bytes)
  })
  if (!putRes.ok) {
    throw new Error(`Hark S3 upload failed (${putRes.status})`)
  }

  const finalized = (await harkFetch(
    ses,
    `/files/${encodeURIComponent(conversationId)}/${encodeURIComponent(attachmentId)}/finalize`,
    {
      method: 'POST',
      body: { s3_key: s3Key, path }
    }
  )) as Record<string, unknown>

  const finalPath = String(finalized?.['path'] ?? path)
  return {
    attachment_id: String(finalized?.['attachment_id'] ?? attachmentId),
    name: String(finalized?.['name'] ?? file.name),
    media_type: String(finalized?.['media_type'] ?? contentType),
    size: Number(finalized?.['size'] ?? bytes.byteLength),
    path: finalPath,
    s3_key: String(finalized?.['s3_key'] ?? s3Key),
    kind: 'file',
    text: `Path: ${finalPath}`
  }
}

function extractPresignedUrl(presigned: unknown, key: string): string {
  if (!presigned || typeof presigned !== 'object') return ''
  const rec = presigned as Record<string, unknown>
  for (const direct of ['url', 'download_url', 'downloadUrl', 'signedUrl', 'signed_url']) {
    if (typeof rec[direct] === 'string' && /^https?:\/\//i.test(rec[direct] as string)) {
      return rec[direct] as string
    }
  }
  const container = (rec['urls'] ?? rec['data'] ?? rec) as unknown
  if (Array.isArray(container)) {
    const first = container.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    if (typeof first === 'string') return first
  } else if (container && typeof container === 'object') {
    const map = container as Record<string, unknown>
    if (typeof map[key] === 'string' && /^https?:\/\//i.test(map[key] as string)) {
      return map[key] as string
    }
    const firstVal = Object.values(map).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v))
    if (typeof firstVal === 'string') return firstVal
  }
  return ''
}

export async function downloadHarkArtifact(
  accountId: string,
  opts: { url?: string; fileId?: string; name?: string }
): Promise<{
  dataBase64: string
  mimeType: string
  filename: string
  text?: string
}> {
  const ses = await preparedSessionForAccount(accountId)
  const reference = opts.url?.trim() || opts.fileId?.replace(/^(harkatt|harkfile):\/\//i, '').trim() || ''
  let targetUrl = reference.startsWith('/') ? new URL(reference, HARK_ORIGIN).toString() : reference
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = ''

  if (!targetUrl && opts.fileId) {
    const key = opts.fileId.replace(/^(harkatt|harkfile):\/\//i, '').trim()
    if (!/^https?:\/\//i.test(key)) {
      for (const endpoint of ['/images/presign', '/files/presign']) {
        if (targetUrl) break
        try {
          const presigned = await harkFetch(ses, endpoint, {
            method: 'POST',
            body: { keys: [key] }
          })
          const resolved = extractPresignedUrl(presigned, key)
          if (resolved) targetUrl = resolved
        } catch {
          /* try next presign endpoint */
        }
      }
      if (!targetUrl) {
        try {
          const presigned = await harkFetch(ses, '/files/download', {
            method: 'GET',
            query: { key }
          })
          const resolved = extractPresignedUrl(presigned, key)
          if (resolved) targetUrl = resolved
        } catch {
          /* fall through */
        }
      }
    }
  }

  if (!targetUrl) {
    throw new Error('Hark artifact URL or S3 key could not be resolved')
  }

  const res = await ses.fetch(targetUrl)
  if (!res.ok) {
    throw new Error(`Hark artifact download failed (${res.status})`)
  }
  const ab = await res.arrayBuffer()
  const buf = Buffer.from(ab)
  const filename = opts.name || targetUrl.split('?')[0]?.split('/').pop() || 'artifact'
  const contentType = inferMediaMime({
    headerMime: res.headers.get('content-type') ?? undefined,
    nameOrPath: filename,
    bytes: buf
  })
  const isText = /^(text\/|application\/(json|javascript|xml|x-yaml|csv|sql))/i.test(contentType) ||
    /\.(md|markdown|txt|json|csv|html|htm|py|ts|tsx|js|sh|yaml|yml|sql)$/i.test(filename)

  return {
    dataBase64: buf.toString('base64'),
    mimeType: contentType,
    filename,
    ...(isText ? { text: buf.toString('utf8') } : {})
  }
}

/**
 * Exact `wl.messages.sendMessage.mutate` payload from `DD3Rh-3z.js` (@97725):
 * `POST /api/messages/send?cid=<conversationId>`
 * `{ timezone, conversationId, message, idempotencyKey, responseMessageId, attachments? }`
 */
export async function sendMessage(
  accountId: string,
  conversationId: string,
  text: string,
  timezone = timezoneName(),
  attachments?: HarkUploadedAttachment[]
): Promise<{
  result: unknown
  idempotencyKey: string
  responseMessageId: string
}> {
  const ses = await preparedSessionForAccount(accountId)
  const idempotencyKey = randomUUID()
  const responseMessageId = randomUUID()
  const body: Record<string, unknown> = {
    timezone,
    conversationId,
    message: text,
    idempotencyKey,
    responseMessageId,
    ...(attachments && attachments.length > 0 ? { attachments } : {})
  }
  const result = await harkFetch(ses, '/messages/send', {
    method: 'POST',
    query: { cid: conversationId },
    body
  })
  return { result, idempotencyKey, responseMessageId }
}

export type HarkChatMessage = {
  id: string
  role: string
  content: string
  isStreaming?: boolean
  jobStatus?: string
  error?: string
  thought?: string
  narration?: string
  createdAt?: string | number | null
  toolCalls?: Array<{
    dispatchId: string
    name: string
    status: string
    url?: string
    screenshotKey?: string
    screenshotUrl?: string
    command?: string
    result?: string
  }>
  actions?: Array<{
    kind: string
    connector?: string
    label: string
    scopes?: string
  }>
  artifacts?: Array<{
    name?: string
    path: string
    s3Key?: string
    downloadUrl?: string
    mimeType?: string
    sizeBytes?: number
  }>
}

export interface HarkActivityPanel {
  dispatchId: string
  kind: string
  status: string
  title?: string
  url?: string
  liveViewUrl?: string
  screenshotKey?: string
  screenshotUrl?: string
  command?: string
}

export interface HarkPendingAsk {
  id: string
  dispatchId?: string
  requestId?: string
  displayHint?: string
  prompt?: string
  domain?: string
  status: string
  raw: Record<string, unknown>
}

export interface HarkConversationSnapshotSummary {
  conversationId: string
  messages: HarkChatMessage[]
  panels: HarkActivityPanel[]
  asks: HarkPendingAsk[]
  artifacts: Array<{
    name: string
    path: string
    s3Key?: string
    downloadUrl?: string
    mimeType?: string
    sizeBytes?: number
  }>
  activeActivity?: string | null
  narration?: string | null
}

/**
 * Real-time conversation state reducer (`worker-Ce4znvdx.js`).
 * Consumes `snapshot` and `patches` (`entry_add` / `message_add`, `message_update`,
 * `tool_add`, `tool_update`, `narration_update`, `active_activity_set`).
 */
export class HarkConversationSyncState {
  readonly messages = new Map<string, HarkChatMessage>()
  readonly windows = new Map<string, Record<string, unknown>>()
  readonly asks = new Map<string, Record<string, unknown>>()
  readonly order: string[] = []
  activeActivity: string | null = null
  narration: string | null = null

  applyFrame(rawFrame: string): boolean {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawFrame) as Record<string, unknown>
    } catch {
      return false
    }
    const type = parsed['type']
    if (type !== 'snapshot' && type !== 'patches') return false

    if (type === 'snapshot') {
      const data = (parsed['data'] ?? {}) as Record<string, unknown>
      this.messages.clear()
      this.windows.clear()
      this.asks.clear()
      this.order.length = 0
      this.activeActivity = typeof data['activeActivity'] === 'string' ? data['activeActivity'] : null
      this.narration = typeof data['narration'] === 'string' ? data['narration'] : null

      if (data['windows'] && typeof data['windows'] === 'object') {
        for (const [wid, wval] of Object.entries(data['windows'] as Record<string, unknown>)) {
          if (wval && typeof wval === 'object') {
            this.windows.set(wid, wval as Record<string, unknown>)
          }
        }
      }
      if (data['asks'] && typeof data['asks'] === 'object') {
        for (const [aid, aval] of Object.entries(data['asks'] as Record<string, unknown>)) {
          if (aval && typeof aval === 'object') {
            this.asks.set(aid, aval as Record<string, unknown>)
          }
        }
      }

      if (parsed['shape'] === 'records' && data['messages'] && typeof data['messages'] === 'object' && !Array.isArray(data['messages'])) {
        const msgMap = data['messages'] as Record<string, Record<string, unknown>>
        const log = Array.isArray(data['log']) ? (data['log'] as Array<Record<string, unknown>>) : []
        for (const entry of log) {
          const id = String(entry['id'] ?? '')
          if (!id) continue
          const m = msgMap[id]
          if (m) {
            this.messages.set(id, normalizeSyncMessage(id, m))
            this.order.push(id)
          }
        }
        for (const [id, m] of Object.entries(msgMap)) {
          if (!this.messages.has(id)) {
            this.messages.set(id, normalizeSyncMessage(id, m))
            this.order.push(id)
          }
        }
      } else {
        const list = extractMessages(data)
        for (const m of list) {
          this.messages.set(m.id, m)
          this.order.push(m.id)
        }
      }
      return true
    }

    // type === 'patches'
    const patches = Array.isArray(parsed['data']) ? (parsed['data'] as Array<Record<string, unknown>>) : []
    let changed = false
    for (const p of patches) {
      const op = String(p['op'] ?? '')
      if (op === 'entry_add' || op === 'message_add') {
        const entryKind = String(p['entry'] ?? 'message')
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const val = (p['value'] ?? {}) as Record<string, unknown>
        if (!id) continue
        if (entryKind === 'window') {
          this.windows.set(id, val)
          changed = true
          continue
        }
        if (entryKind === 'ask') {
          this.asks.set(id, val)
          changed = true
          continue
        }
        this.messages.set(id, normalizeSyncMessage(id, val))
        if (!this.order.includes(id)) this.order.push(id)
        changed = true
      } else if (op === 'window_update') {
        const id = String(p['id'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const prev = this.windows.get(id) ?? {}
        if (id) {
          this.windows.set(id, { ...prev, ...fields })
          changed = true
        }
      } else if (op === 'ask_update') {
        const id = String(p['id'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const prev = this.asks.get(id) ?? {}
        if (id) {
          this.asks.set(id, { ...prev, ...fields })
          changed = true
        }
      } else if (op === 'panel_add' || op === 'panel_update') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const w = this.windows.get(id)
        if (w) {
          const panels = Array.isArray(w['panels']) ? [...(w['panels'] as Record<string, unknown>[])] : []
          if (op === 'panel_add' && p['value'] && typeof p['value'] === 'object') {
            panels.push(p['value'] as Record<string, unknown>)
          } else if (op === 'panel_update') {
            const did = String(p['dispatchId'] ?? '')
            const fields = (p['fields'] ?? {}) as Record<string, unknown>
            const idx = panels.findIndex((pn) => String(pn['dispatchId'] ?? '') === did)
            if (idx >= 0) panels[idx] = { ...panels[idx]!, ...fields }
          }
          this.windows.set(id, { ...w, panels })
          changed = true
        }
      } else if (op === 'message_update') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const existing = this.messages.get(id)
        if (existing) {
          const patched = normalizeSyncMessage(id, fields)
          const nextContent =
            (typeof fields['content'] === 'string' && fields['content']) ||
            (typeof fields['text'] === 'string' && fields['text']) ||
            (fields['presentation'] ? patched.content : undefined)
          const terminalJob =
            typeof fields['jobStatus'] === 'string' &&
            /^(completed|cancelled|failed|interrupted|cost_capped)$/i.test(fields['jobStatus'])
          const nextStreaming =
            typeof fields['isStreaming'] === 'boolean'
              ? fields['isStreaming']
              : terminalJob
                ? false
                : existing.isStreaming
          const updated: HarkChatMessage = {
            ...existing,
            ...(nextContent !== undefined && (nextContent || !existing.content)
              ? { content: nextContent }
              : {}),
            ...(nextStreaming !== undefined ? { isStreaming: nextStreaming } : {}),
            ...(typeof fields['jobStatus'] === 'string' ? { jobStatus: fields['jobStatus'] } : {}),
            ...(typeof fields['error'] === 'string' ? { error: fields['error'] } : {}),
            ...(typeof fields['thought'] === 'string' ? { thought: fields['thought'] } : {}),
            ...(typeof fields['narration'] === 'string' ? { narration: fields['narration'] } : {}),
            ...(patched.actions?.length ? { actions: patched.actions } : {}),
            ...(patched.artifacts?.length
              ? {
                  artifacts: [
                    ...(existing.artifacts ?? []),
                    ...patched.artifacts.filter(
                      (a) => !(existing.artifacts ?? []).some((e) => (e.s3Key || e.path) === (a.s3Key || a.path))
                    )
                  ]
                }
              : {}),
            ...(patched.toolCalls?.length ? { toolCalls: patched.toolCalls } : {})
          }
          if (nextStreaming === false) {
            delete updated.thought
            delete updated.narration
          }
          this.messages.set(id, updated)
          changed = true
        } else if (id) {
          this.messages.set(id, normalizeSyncMessage(id, fields))
          if (!this.order.includes(id)) this.order.push(id)
          changed = true
        }
      } else if (op === 'tool_add') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const val = (p['value'] ?? {}) as Record<string, unknown>
        const existing = this.messages.get(id)
        if (existing) {
          const dispatchId = String(val['dispatchId'] ?? val['dispatch_id'] ?? '')
          const name = String(val['toolName'] ?? val['tool_name'] ?? val['type'] ?? 'tool')
          const status = String(val['status'] ?? 'running')
          const input = (val['input'] ?? {}) as Record<string, unknown>
          const progressMeta = ((val['progress'] as Record<string, unknown> | undefined)?.['metadata'] ?? {}) as Record<string, unknown>
          const prevTools = existing.toolCalls ?? []
          const extraArts = extractHarkArtifactsFromRaw(val)
          const nextArts = mergeHarkArtifacts(existing.artifacts, extraArts)
          if (dispatchId && !prevTools.some((t) => t.dispatchId === dispatchId)) {
            this.messages.set(id, {
              ...existing,
              ...(nextArts ? { artifacts: nextArts } : {}),
              toolCalls: [
                ...prevTools,
                {
                  dispatchId,
                  name,
                  status,
                  url: String(input['url'] ?? progressMeta['url'] ?? '') || undefined,
                  screenshotKey: String(val['screenshotKey'] ?? progressMeta['screenshot_key'] ?? '') || undefined,
                  screenshotUrl: String(val['screenshotUrl'] ?? progressMeta['screenshot_url'] ?? '') || undefined,
                  command: String(input['command'] ?? progressMeta['command'] ?? '') || undefined
                }
              ]
            })
            changed = true
          } else if (nextArts && nextArts !== existing.artifacts) {
            this.messages.set(id, { ...existing, artifacts: nextArts })
            changed = true
          }
        }
      } else if (op === 'tool_update') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const dispatchId = String(p['dispatchId'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const existing = this.messages.get(id)
        if (existing) {
          const extraArts = extractHarkArtifactsFromRaw(fields)
          const nextArts = mergeHarkArtifacts(existing.artifacts, extraArts)
          const hasToolMatch = Boolean(existing.toolCalls?.some((tc) => tc.dispatchId === dispatchId))
          if (hasToolMatch || (nextArts && nextArts !== existing.artifacts)) {
            this.messages.set(id, {
              ...existing,
              ...(nextArts ? { artifacts: nextArts } : {}),
              ...(existing.toolCalls
                ? {
                    toolCalls: existing.toolCalls.map((tc) =>
                      tc.dispatchId === dispatchId
                        ? {
                            ...tc,
                            status: String(fields['status'] ?? tc.status),
                            screenshotKey: String(fields['screenshotKey'] ?? tc.screenshotKey ?? '') || undefined,
                            screenshotUrl: String(fields['screenshotUrl'] ?? tc.screenshotUrl ?? '') || undefined
                          }
                        : tc
                    )
                  }
                : {})
            })
            changed = true
          }
        }
      } else if (op === 'narration_update') {
        this.narration = typeof p['value'] === 'string' ? p['value'] : null
        changed = true
      } else if (op === 'active_activity_set') {
        const v = p['value']
        this.activeActivity =
          typeof v === 'string'
            ? v
            : v && typeof v === 'object'
              ? String((v as Record<string, unknown>)['label'] ?? (v as Record<string, unknown>)['type'] ?? '')
              : null
        changed = true
      }
    }
    return changed
  }

  orderedMessages(): HarkChatMessage[] {
    return this.order.map((id) => this.messages.get(id)!).filter(Boolean)
  }

  extractPanels(): HarkActivityPanel[] {
    const out: HarkActivityPanel[] = []
    const pushPanel = (raw: Record<string, unknown>) => {
      const dispatchId = String(raw['dispatchId'] ?? raw['id'] ?? `panel_${out.length}`)
      if (out.some((x) => x.dispatchId === dispatchId)) return
      const screenshot = (raw['screenshot'] ?? {}) as Record<string, unknown>
      out.push({
        dispatchId,
        kind: String(raw['kind'] ?? raw['type'] ?? 'browser'),
        status: String(raw['status'] ?? 'active'),
        title: String(raw['title'] ?? raw['label'] ?? raw['objective'] ?? '') || undefined,
        url: String(raw['url'] ?? '') || undefined,
        liveViewUrl: String(raw['liveViewUrl'] ?? '') || undefined,
        screenshotKey: String(screenshot['key'] ?? raw['screenshotKey'] ?? '') || undefined,
        screenshotUrl: String(screenshot['downloadUrl'] ?? raw['previewUrl'] ?? '') || undefined,
        command: String(raw['command'] ?? '') || undefined
      })
    }
    for (const w of this.windows.values()) {
      const panels = Array.isArray(w['panels']) ? (w['panels'] as Record<string, unknown>[]) : []
      for (const p of panels) if (p && typeof p === 'object') pushPanel(p)
    }
    for (const m of this.messages.values()) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.screenshotKey || tc.screenshotUrl || tc.url || tc.command || /browser|computer|shell|coding/i.test(tc.name)) {
          out.push({
            dispatchId: tc.dispatchId,
            kind: tc.name,
            status: tc.status,
            url: tc.url,
            screenshotKey: tc.screenshotKey,
            screenshotUrl: tc.screenshotUrl,
            command: tc.command
          })
        }
      }
    }
    return out
  }

  extractAsks(): HarkPendingAsk[] {
    const out: HarkPendingAsk[] = []
    for (const [id, raw] of this.asks.entries()) {
      const req = (raw['request'] ?? raw['userInputRequest'] ?? raw) as Record<string, unknown>
      const status = String(raw['status'] ?? 'pending')
      out.push({
        id,
        dispatchId: String(raw['dispatchId'] ?? '') || undefined,
        requestId: String(req['requestId'] ?? id) || undefined,
        displayHint: String(req['displayHint'] ?? '') || undefined,
        prompt: String(req['prompt'] ?? req['title'] ?? req['message'] ?? '') || undefined,
        domain: String(req['domain'] ?? '') || undefined,
        status,
        raw
      })
    }
    return out
  }

  extractArtifacts(): HarkConversationSnapshotSummary['artifacts'] {
    const out: HarkConversationSnapshotSummary['artifacts'] = []
    const seen = new Set<string>()
    for (const m of this.messages.values()) {
      for (const a of m.artifacts ?? []) {
        const key = a.s3Key || a.path
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push({
          name: a.name || a.path.split('/').pop() || a.path,
          path: a.path,
          s3Key: a.s3Key,
          downloadUrl: a.downloadUrl,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes
        })
      }
    }
    return out
  }
}

function formatPresentationMarkdown(presRaw: unknown): string {
  if (!presRaw || typeof presRaw !== 'object') return ''
  const pres = presRaw as Record<string, unknown>
  const kind = String(pres['kind'] ?? '')

  if (kind === 'summary' && pres['summary'] && typeof pres['summary'] === 'object') {
    const s = pres['summary'] as Record<string, unknown>
    const title = typeof s['title'] === 'string' && s['title'].trim() ? `### ${s['title'].trim()}\n\n` : ''
    const md = typeof s['markdown'] === 'string' ? s['markdown'].trim() : ''
    return md ? `${title}${md}` : ''
  }

  if (
    (kind === 'document' || kind === 'markdown' || kind === 'article' || kind === 'report') &&
    (pres[kind] || pres['document'] || pres['markdown'])
  ) {
    const d = (pres[kind] ?? pres['document'] ?? pres) as Record<string, unknown>
    const title = typeof d['title'] === 'string' && d['title'].trim() ? `# ${d['title'].trim()}\n\n` : ''
    const md =
      typeof d['markdown'] === 'string'
        ? d['markdown'].trim()
        : typeof d['content'] === 'string'
          ? d['content'].trim()
          : typeof d['body'] === 'string'
            ? d['body'].trim()
            : ''
    return md ? `${title}${md}` : ''
  }

  if (kind === 'code' && pres['code'] && typeof pres['code'] === 'object') {
    const c = pres['code'] as Record<string, unknown>
    const lang = typeof c['language'] === 'string' ? c['language'].trim() : ''
    const src = typeof c['source'] === 'string' ? c['source'] : ''
    return src ? `\`\`\`${lang}\n${src}\n\`\`\`` : ''
  }

  if (kind === 'text_template' && pres['text_template'] && typeof pres['text_template'] === 'object') {
    const t = pres['text_template'] as Record<string, unknown>
    const title = typeof t['title'] === 'string' && t['title'].trim() ? `**${t['title'].trim()}**\n\n` : ''
    const body = typeof t['body'] === 'string' ? t['body'].trim() : ''
    return body ? `${title}${body}` : ''
  }

  if (kind === 'links' && Array.isArray(pres['links'])) {
    const lines: string[] = []
    for (const item of pres['links'] as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue
      const url = typeof item['url'] === 'string' ? item['url'].trim() : ''
      if (!url) continue
      const label =
        (typeof item['title'] === 'string' && item['title'].trim()) ||
        (typeof item['label'] === 'string' && item['label'].trim()) ||
        url
      lines.push(`- [${label}](${url})`)
    }
    return lines.join('\n')
  }

  if (kind === 'table' && pres['table'] && typeof pres['table'] === 'object') {
    const tbl = pres['table'] as Record<string, unknown>
    const cols = Array.isArray(tbl['columns']) ? (tbl['columns'] as unknown[]).map((c) => String(c ?? '')) : []
    const rows = Array.isArray(tbl['rows']) ? (tbl['rows'] as unknown[][]) : []
    if (cols.length > 0) {
      const title = typeof tbl['title'] === 'string' && tbl['title'].trim() ? `### ${tbl['title'].trim()}\n\n` : ''
      const header = `| ${cols.join(' | ')} |`
      const sep = `| ${cols.map(() => '---').join(' | ')} |`
      const body = rows
        .map((r) => `| ${(Array.isArray(r) ? r : []).map((cell) => String(cell ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
        .join('\n')
      return `${title}${header}\n${sep}${body ? `\n${body}` : ''}`
    }
  }

  return ''
}

type HarkArtifactItem = NonNullable<HarkChatMessage['artifacts']>[number]

function mergeHarkArtifacts(
  existing: HarkArtifactItem[] | undefined,
  incoming: HarkArtifactItem[]
): HarkArtifactItem[] | undefined {
  if (incoming.length === 0) return existing
  const out = [...(existing ?? [])]
  const seen = new Set(out.map((a) => a.s3Key || a.downloadUrl || a.path))
  let changed = false
  for (const item of incoming) {
    const key = item.s3Key || item.downloadUrl || item.path
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
    changed = true
  }
  return changed ? out : existing
}

function extractHarkArtifactsFromRaw(raw: Record<string, unknown>): HarkArtifactItem[] {
  const out: HarkArtifactItem[] = []
  const seen = new Set<string>()
  const push = (item: HarkArtifactItem) => {
    const key = item.s3Key || item.downloadUrl || item.path
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(item)
  }

  const pushEntry = (entry: unknown, defaultKindMime?: string) => {
    if (!entry) return
    if (typeof entry === 'string') {
      const s = entry.trim()
      if (!s) return
      const isHttp = /^https?:\/\//i.test(s)
      const name = s.split(/[?#]/, 1)[0]?.split('/').pop() || s
      push({
        name,
        path: s,
        s3Key: isHttp ? undefined : s,
        downloadUrl: isHttp ? s : undefined,
        mimeType: guessMediaMimeFromName(name) || defaultKindMime
      })
      return
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) return
    const o = entry as Record<string, unknown>
    const s3Key =
      (typeof o['s3Key'] === 'string' && o['s3Key']) ||
      (typeof o['s3_key'] === 'string' && o['s3_key']) ||
      (typeof o['key'] === 'string' && o['key']) ||
      (typeof o['imageKey'] === 'string' && o['imageKey']) ||
      (typeof o['videoKey'] === 'string' && o['videoKey']) ||
      undefined
    const downloadUrl =
      (typeof o['downloadUrl'] === 'string' && o['downloadUrl']) ||
      (typeof o['download_url'] === 'string' && o['download_url']) ||
      (typeof o['previewUrl'] === 'string' && o['previewUrl']) ||
      (typeof o['preview_url'] === 'string' && o['preview_url']) ||
      (typeof o['imageUrl'] === 'string' && o['imageUrl']) ||
      (typeof o['image_url'] === 'string' && o['image_url']) ||
      (typeof o['videoUrl'] === 'string' && o['videoUrl']) ||
      (typeof o['video_url'] === 'string' && o['video_url']) ||
      (typeof o['mediaUrl'] === 'string' && o['mediaUrl']) ||
      (typeof o['media_url'] === 'string' && o['media_url']) ||
      (typeof o['url'] === 'string' && /^https?:\/\//i.test(o['url']) ? o['url'] : undefined) ||
      undefined
    const rawPath =
      (typeof o['path'] === 'string' && o['path']) ||
      (typeof o['filePath'] === 'string' && o['filePath']) ||
      (typeof o['file_path'] === 'string' && o['file_path']) ||
      (typeof o['name'] === 'string' && o['name']) ||
      downloadUrl ||
      s3Key ||
      ''
    if (!rawPath && !s3Key && !downloadUrl) return
    const name =
      (typeof o['name'] === 'string' && o['name']) ||
      (typeof o['filename'] === 'string' && o['filename']) ||
      (typeof o['title'] === 'string' && o['title']) ||
      rawPath.split(/[?#]/, 1)[0]?.split('/').pop() ||
      'artifact'
    const rawMime =
      (typeof o['mediaType'] === 'string' && o['mediaType']) ||
      (typeof o['media_type'] === 'string' && o['media_type']) ||
      (typeof o['mimeType'] === 'string' && o['mimeType']) ||
      (typeof o['mime_type'] === 'string' && o['mime_type']) ||
      (typeof o['contentType'] === 'string' && o['contentType']) ||
      (typeof o['content_type'] === 'string' && o['content_type']) ||
      undefined
    const mimeType = rawMime || guessMediaMimeFromName(name || rawPath) || defaultKindMime
    const sizeBytes =
      typeof o['size'] === 'number'
        ? o['size']
        : typeof o['sizeBytes'] === 'number'
          ? o['sizeBytes']
          : typeof o['size_bytes'] === 'number'
            ? o['size_bytes']
            : undefined
    push({
      name,
      path: rawPath || s3Key || downloadUrl!,
      s3Key,
      downloadUrl,
      mimeType,
      sizeBytes
    })
  }

  const listKeys: Array<[string, string | undefined]> = [
    ['artifactKeys', undefined],
    ['artifact_keys', undefined],
    ['artifacts', undefined],
    ['attachments', undefined],
    ['files', undefined],
    ['media', undefined],
    ['imageStack', 'image/png'],
    ['image_stack', 'image/png'],
    ['images', 'image/png'],
    ['videos', 'video/mp4']
  ]
  for (const [k, defMime] of listKeys) {
    const val = raw[k]
    if (Array.isArray(val)) {
      for (const item of val) pushEntry(item, defMime)
    } else if (val && typeof val === 'object') {
      const objVal = val as Record<string, unknown>
      if (Array.isArray(objVal['items'])) {
        for (const item of objVal['items']) pushEntry(item, defMime)
      } else if (Array.isArray(objVal['images'])) {
        for (const item of objVal['images']) pushEntry(item, 'image/png')
      } else {
        pushEntry(objVal, defMime)
      }
    }
  }

  // Presentation media payloads (image / gallery / image_stack / video / audio / file / artifact)
  const pres = raw['presentation']
  if (pres && typeof pres === 'object' && !Array.isArray(pres)) {
    const p = pres as Record<string, unknown>
    const kind = String(p['kind'] ?? '').toLowerCase()
    const isMediaKind = /^(image|images|image_stack|gallery|video|audio|media|file|artifact)$/i.test(kind)
    const nested = p[kind] ?? (isMediaKind ? p : undefined)
    if (nested && typeof nested === 'object') {
      const defMime =
        kind.includes('image') || kind === 'gallery'
          ? 'image/png'
          : kind === 'video'
            ? 'video/mp4'
            : kind === 'audio'
              ? 'audio/mpeg'
              : undefined
      if (Array.isArray(nested)) {
        for (const item of nested) pushEntry(item, defMime)
      } else {
        const no = nested as Record<string, unknown>
        for (const sub of ['items', 'images', 'videos', 'files', 'media', 'artifacts']) {
          if (Array.isArray(no[sub])) {
            for (const item of no[sub] as unknown[]) {
              pushEntry(item, sub === 'videos' ? 'video/mp4' : sub === 'images' ? 'image/png' : defMime)
            }
          }
        }
        pushEntry(no, defMime)
      }
    }
  }

  return out
}

function normalizeSyncMessage(id: string, raw: Record<string, unknown>): HarkChatMessage {
  const rawContent =
    (typeof raw['content'] === 'string' && raw['content']) ||
    (typeof raw['text'] === 'string' && raw['text']) ||
    (typeof raw['message'] === 'string' && raw['message']) ||
    ''
  const presMarkdown = formatPresentationMarkdown(raw['presentation'])
  const content = rawContent.trim() ? rawContent : presMarkdown || rawContent

  const actionsRaw = Array.isArray(raw['actions']) ? (raw['actions'] as Record<string, unknown>[]) : []
  const actions = actionsRaw
    .map((a) => ({
      kind: String(a['kind'] ?? ''),
      connector: typeof a['connector'] === 'string' ? a['connector'] : undefined,
      label: String(a['label'] ?? a['connector'] ?? 'Connect'),
      scopes: typeof a['scopes'] === 'string' ? a['scopes'] : undefined
    }))
    .filter((a) => a.kind)

  const toolCallsRaw = Array.isArray(raw['toolCalls']) ? (raw['toolCalls'] as Record<string, unknown>[]) : []
  const toolCalls: NonNullable<HarkChatMessage['toolCalls']> = []
  let artifacts: HarkArtifactItem[] = []

  for (const tc of toolCallsRaw) {
    if (!tc || typeof tc !== 'object') continue
    const dispatchId = String(tc['dispatchId'] ?? tc['dispatch_id'] ?? '')
    const name = String(tc['toolName'] ?? tc['tool_name'] ?? tc['type'] ?? 'tool')
    const status = String(tc['status'] ?? 'completed')
    const input = (tc['input'] ?? {}) as Record<string, unknown>
    const progressMeta = ((tc['progress'] as Record<string, unknown> | undefined)?.['metadata'] ?? {}) as Record<
      string,
      unknown
    >
    toolCalls.push({
      dispatchId: dispatchId || `tc_${toolCalls.length}`,
      name,
      status,
      url: String(input['url'] ?? progressMeta['url'] ?? '') || undefined,
      screenshotKey: String(tc['screenshotKey'] ?? progressMeta['screenshot_key'] ?? '') || undefined,
      screenshotUrl: String(tc['screenshotUrl'] ?? progressMeta['screenshot_url'] ?? '') || undefined,
      command: String(input['command'] ?? progressMeta['command'] ?? '') || undefined,
      result: typeof tc['result'] === 'string' ? tc['result'].slice(0, 500) : undefined
    })

    artifacts = mergeHarkArtifacts(artifacts, extractHarkArtifactsFromRaw(tc)) ?? artifacts
  }

  // Message-level attachments, imageStack, images, videos, files, artifacts, presentation media
  artifacts = mergeHarkArtifacts(artifacts, extractHarkArtifactsFromRaw(raw)) ?? artifacts

  const aawRaw = Array.isArray(raw['agentActivityWindow']) ? (raw['agentActivityWindow'] as Record<string, unknown>[]) : []
  for (const p of aawRaw) {
    if (!p || typeof p !== 'object') continue
    const screenshot = (p['screenshot'] ?? {}) as Record<string, unknown>
    toolCalls.push({
      dispatchId: String(p['dispatchId'] ?? `aaw_${toolCalls.length}`),
      name: String(p['kind'] ?? 'browser'),
      status: String(p['status'] ?? 'completed'),
      url: typeof p['url'] === 'string' ? p['url'] : typeof p['liveViewUrl'] === 'string' ? p['liveViewUrl'] : undefined,
      screenshotKey: typeof screenshot['key'] === 'string' ? screenshot['key'] : undefined,
      screenshotUrl: typeof screenshot['downloadUrl'] === 'string' ? screenshot['downloadUrl'] : undefined,
      command: typeof p['command'] === 'string' ? p['command'] : undefined
    })
  }

  const jobStatus = typeof raw['jobStatus'] === 'string' ? raw['jobStatus'] : undefined
  const errorText = typeof raw['error'] === 'string' ? raw['error'] : undefined

  return {
    id,
    role: String(raw['role'] ?? raw['author'] ?? 'assistant'),
    content: content || (errorText ? `⚠️ ${errorText}` : ''),
    isStreaming: typeof raw['isStreaming'] === 'boolean' ? raw['isStreaming'] : undefined,
    ...(jobStatus ? { jobStatus } : {}),
    ...(errorText ? { error: errorText } : {}),
    thought: typeof raw['thought'] === 'string' ? raw['thought'] : undefined,
    narration: typeof raw['narration'] === 'string' ? raw['narration'] : undefined,
    createdAt: (raw['timestamp'] ?? raw['createdAt'] ?? raw['created_at'] ?? raw['createdAtMs'] ?? null) as
      | string
      | number
      | null,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(actions.length ? { actions } : {}),
    ...(artifacts.length ? { artifacts } : {})
  }
}

export function isHarkReplyDone(msg: HarkChatMessage): boolean {
  if (msg.isStreaming === true) {
    if (msg.jobStatus && /^(completed|cancelled|failed|interrupted|cost_capped)$/i.test(msg.jobStatus)) {
      return true
    }
    return false
  }
  const hasPayload =
    Boolean(msg.content.trim()) ||
    Boolean(msg.actions && msg.actions.length > 0) ||
    Boolean(msg.artifacts && msg.artifacts.length > 0) ||
    Boolean(msg.error) ||
    Boolean(
      msg.toolCalls &&
        msg.toolCalls.length > 0 &&
        msg.toolCalls.every((tc) => !/^(running|pending|active|started|waiting_for_input|awaiting_input)$/i.test(tc.status))
    )
  return hasPayload
}

export async function readHarkStream(
  ses: Session, conversationId: string, manager: string, dial: string, signal: AbortSignal,
  onFrame: (data: string) => void
): Promise<void> {
  const url = new URL(HARK_API_BASE + '/sync/conversation')
  url.search = new URLSearchParams({ conversationId, manager, dial, v: '2', mode: 'in_tab', ids: '1', beat: '5' }).toString()
  const response = await ses.fetch(url.toString(), { credentials: 'include', signal, headers: harkClientHeaders({
    Accept: 'text/event-stream', 'Cache-Control': 'no-cache'
  }) })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Hark project stream unavailable')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = 'message'
  let lines: string[] = []
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while (!signal.aborted && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line) {
          if (eventType === 'message' && lines.length) onFrame(lines.join('\n'))
          eventType = 'message'
          lines = []
        } else if (line.startsWith('event:')) eventType = line.slice(6).trim()
        else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart())
      }
    }
  } finally { reader.releaseLock() }
}

const activeHarkWatches = new HarkWatchRegistry()

export function registerHarkViewStop(accountId: string, stop: () => void): () => void {
  const token = activeHarkWatches.add(accountId, stop)
  return () => activeHarkWatches.remove(accountId, token)
}

/** Stop every reply watch of the account (stop-tool, pause, sign-out). */
export function cancelHarkWatch(accountId: string, conversationId?: string): void {
  if (conversationId) activeHarkWatches.cancelConversation(accountId, conversationId)
  else activeHarkWatches.cancelAll(accountId)
}

/**
 * Stream `/api/sync/conversation` SSE (or fallback `/api/sync/poll`) until the
 * assistant reply for `responseMessageId` (or any new assistant message) completes!
 */
export async function watchHarkConversationSync(
  accountId: string,
  conversationId: string,
  opts: {
    responseMessageId?: string
    afterMessageIds?: Set<string>
    timeoutMs?: number
    onUpdate?: (msg: HarkChatMessage, state: HarkConversationSyncState) => void
  } = {}
): Promise<{ reply: HarkChatMessage | null; messages: HarkChatMessage[] }> {
  const ses = await preparedSessionForAccount(accountId)
  const managerId = randomUUID()
  const timeoutMs = opts.timeoutMs ?? 90_000
  const deadline = Date.now() + timeoutMs
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const syncState = new HarkConversationSyncState()
  const afterIds = opts.afterMessageIds ?? new Set<string>()
  let lastReply: HarkChatMessage | null = null
  let finished = false

  // Do not cancel an earlier send's watch: that cut its reply short.
  const abortWatch = () => {
    finished = true
    ac.abort()
  }
  const watchToken = activeHarkWatches.add(accountId, abortWatch, opts.responseMessageId, conversationId)

  const hasPayloadOrActivity = (m?: HarkChatMessage): m is HarkChatMessage =>
    Boolean(
      m &&
        (m.content.trim() ||
          m.isStreaming ||
          m.thought ||
          m.narration ||
          m.toolCalls?.length ||
          m.actions?.length ||
          m.artifacts?.length ||
          m.error)
    )

  const checkState = (): boolean => {
    if (finished) return true
    const all = syncState.orderedMessages()
    const target = opts.responseMessageId ? syncState.messages.get(opts.responseMessageId) : undefined
    const claimed = activeHarkWatches.claimedByOthers(accountId, watchToken)
    const candidate =
      (hasPayloadOrActivity(target) ? target : undefined) ??
      [...all]
        .reverse()
        .find(
          (m) =>
            /assistant|bot|hark/i.test(m.role) &&
            !afterIds.has(m.id) &&
            !claimed.has(m.id) &&
            hasPayloadOrActivity(m)
        )

    if (candidate) {
      lastReply = candidate
      opts.onUpdate?.(candidate, syncState)
      if (isHarkReplyDone(candidate)) {
        finished = true
        ac.abort()
        return true
      }
    } else if (syncState.narration || syncState.activeActivity) {
      const dummyId = opts.responseMessageId || 'hark_thinking'
      opts.onUpdate?.(
        {
          id: dummyId,
          role: 'assistant',
          content: '',
          isStreaming: true
        },
        syncState
      )
    }
    return false
  }

  const runPollLoop = async (): Promise<void> => {
    let cursor: string | undefined
    let floor: string | undefined
    let first = true
    const pollMgr = randomUUID()
    while (Date.now() < deadline && !ac.signal.aborted && !finished) {
      try {
        const pollRes = (await harkFetch(ses, '/sync/poll', {
          method: 'GET',
          query: {
            conversationId,
            v: '2',
            manager: pollMgr,
            mode: 'in_tab',
            dial: 'initial',
            ...(first ? { first: '1' } : {}),
            ...(cursor ? { cursor } : {}),
            ...(floor ? { floor } : {})
          },
          signal: ac.signal
        })) as { frames?: string[]; cursor?: string; floor?: string } | null
        if (pollRes && Array.isArray(pollRes.frames)) {
          first = false
          if (pollRes.cursor) cursor = pollRes.cursor
          if (pollRes.floor) floor = pollRes.floor
          for (const frame of pollRes.frames) {
            if (syncState.applyFrame(frame) && checkState()) {
              return
            }
          }
        }
      } catch {
        /* ignore transient poll error */
      }
      if (finished || ac.signal.aborted) return
      await new Promise((r) => setTimeout(r, 1200))
    }
  }

  const runSseStream = async (): Promise<void> => {
    let dialMode = 'initial'
    while (Date.now() < deadline && !ac.signal.aborted && !finished) {
      try {
        const dial = dialMode
        dialMode = 'reconnect'
        await readHarkStream(ses, conversationId, managerId, dial, ac.signal, (frame) => {
          if (syncState.applyFrame(frame)) checkState()
        })
      } catch {
        /* aborted or transient disconnect — retry below if still active */
      }
      if (finished || ac.signal.aborted) return
      await new Promise((r) => setTimeout(r, 1200))
    }
  }

  try {
    await Promise.race([runSseStream(), runPollLoop()])
  } finally {
    finished = true
    ac.abort()
    clearTimeout(timer)
    const done = lastReply as HarkChatMessage | null
    if (done?.id) activeHarkWatches.markTaken(accountId, done.id)
    activeHarkWatches.remove(accountId, watchToken)
  }

  return { reply: lastReply, messages: syncState.orderedMessages() }
}

export function conversationIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const root = payload as Record<string, unknown>
  for (const key of ['id', 'conversationId', 'conversation_id'] as const) {
    const v = root[key]
    if (typeof v === 'string' && v) return v
  }
  const conv = root['conversation']
  if (conv && typeof conv === 'object') {
    const id = (conv as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  const main = root['main']
  if (main && typeof main === 'object') {
    const id = (main as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  return undefined
}

export function extractMessages(payload: unknown): HarkChatMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  let list: unknown[] = []
  if (Array.isArray(root['messages'])) list = root['messages'] as unknown[]
  else if (Array.isArray(root['items'])) list = root['items'] as unknown[]
  else if (root['conversation'] && typeof root['conversation'] === 'object') {
    const msgs = (root['conversation'] as { messages?: unknown }).messages
    if (Array.isArray(msgs)) list = msgs
  }
  const out: HarkChatMessage[] = []
  for (const item of list) {
    const raw = (item ?? {}) as Record<string, unknown>
    const id = String(raw['id'] ?? raw['messageId'] ?? raw['message_id'] ?? `${out.length}`)
    out.push(normalizeSyncMessage(id, raw))
  }
  return out
}
