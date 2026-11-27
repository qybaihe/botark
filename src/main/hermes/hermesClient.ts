import { SseParser as BaseSseParser, type ParsedSseFrame } from '../sseParser'
/**
 * Main-process HTTP & SSE client for Nous Research Hermes Agent (`hermes-agent`).
 *
 * Protocol coverage (verified against NousResearch/hermes-agent `gateway/platforms/api_server.py`):
 * - Health & discovery: `GET /health`, `GET /health/detailed`, `GET /v1/models`, `GET /v1/capabilities`
 * - Native sessions: `GET/POST /api/sessions`, `GET /api/sessions/{id}/messages`, `DELETE /api/sessions/{id}`
 * - Live streaming chat (primary): `POST /api/sessions/{id}/chat/stream` (SSE: `run.started`,
 *   `message.started`, `assistant.delta`, `assistant.commentary`, `tool.started`, `tool.completed`,
 *   `tool.failed`, `tool.progress`, `approval.request`, `assistant.completed`, `run.*`, `error`, `done`)
 * - Graceful fallback for older Hermes servers: `POST /v1/chat/completions` (`stream: true`)
 * - Live dangerous-command approvals: `POST /v1/runs/{run_id}/approval` (`once` | `session` | `always` | `deny`)
 * - Interrupt run: `POST /v1/runs/{run_id}/stop` + `AbortController`
 * - Skills, Toolsets & Scheduled Jobs: `GET /v1/skills`, `GET /v1/toolsets`, `GET/POST/DELETE /api/jobs`
 */
import type {
  HermesApprovalView,
  HermesCronJob,
  HermesSessionSummary,
  HermesSkillItem,
  HermesToolsetItem,
  MuseMediaPartView,
  MuseToolCallView
} from '@shared/ipc'
import { randomUUID } from 'node:crypto'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { proxyFetch } from '../proxyTransport'
import { getHermesAccount, normalizeHermesBaseUrl } from './hermesStore'

export class HermesApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message)
    this.name = 'HermesApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

export interface HermesAttachmentInput {
  name: string
  mimeType: string
  dataBase64: string
}

export interface HermesTranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
}

interface HermesApprovalRecord {
  approval: HermesApprovalView
  runId: string
  requestId?: string
}

interface HermesConnection {
  accountId: string
  baseUrl: string
  apiKey?: string
  fetchImpl?: typeof fetch
}

interface ActiveRunState {
  connection: HermesConnection
  controller: AbortController
  callbacks: HermesStreamCallbacks
  requestId?: string
  runId?: string
  sessionId?: string
  dispatched: boolean
  stopRequested?: boolean
  stopConfirmed?: boolean
  stopping?: Promise<void>
  approvals: Map<string, HermesApprovalRecord>
  decisions: Map<string, 'pending' | 'resolved'>
}

const activeRuns = new Map<string, ActiveRunState>()

function isLoopbackUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

async function fetchForAccount(
  accountId: string | undefined,
  url: string,
  init?: RequestInit,
  explicitFetch?: typeof fetch
): Promise<Response> {
  init?.signal?.throwIfAborted()
  const request: RequestInit = { ...init, redirect: 'error' }
  if (explicitFetch) return explicitFetch(url, request)
  const proxyUrl = accountId ? await loadAccountProxyUrl(accountId) : undefined
  return fetchHermesUrl(proxyUrl, url, request)
}

function fetchHermesUrl(proxyUrl: string | undefined, url: string, init?: RequestInit): Promise<Response> {
  init?.signal?.throwIfAborted()
  return !proxyUrl && isLoopbackUrl(url) ? fetch(url, init) : proxyFetch(proxyUrl, url, init)
}

function buildAuthHeaders(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra
  }
  if (apiKey?.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }
  return headers
}

async function readErrorMessage(res: Response): Promise<{ message: string; code?: string; body?: unknown }> {
  const text = await res.text().catch(() => '')
  if (!text) return { message: `Hermes HTTP ${res.status}` }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const errObj =
      parsed['error'] && typeof parsed['error'] === 'object'
        ? (parsed['error'] as Record<string, unknown>)
        : parsed
    const msg =
      (typeof errObj['message'] === 'string' && errObj['message']) ||
      (typeof parsed['error'] === 'string' && parsed['error']) ||
      (typeof parsed['detail'] === 'string' && parsed['detail']) ||
      `Hermes HTTP ${res.status}`
    const code = typeof errObj['code'] === 'string' ? errObj['code'] : undefined
    return { message: msg, code, body: parsed }
  } catch {
    return { message: text.slice(0, 300), body: text }
  }
}

async function hermesJsonRequest<T = unknown>(args: {
  accountId?: string
  baseUrl: string
  apiKey?: string
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<T> {
  const url = `${args.baseUrl}${args.path.startsWith('/') ? args.path : `/${args.path}`}`
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), args.timeoutMs ?? 20_000)
  const onExternalAbort = () => timeoutController.abort(args.signal?.reason)
  args.signal?.addEventListener('abort', onExternalAbort, { once: true })
  try {
    args.signal?.throwIfAborted()
    const headers = buildAuthHeaders(args.apiKey, {
      ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...args.headers
    })
    const res = await fetchForAccount(
      args.accountId,
      url,
      {
        method: args.method ?? 'GET',
        headers,
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: timeoutController.signal
      },
      args.fetchImpl
    )
    args.signal?.throwIfAborted()
    if (!res.ok) {
      const err = await readErrorMessage(res)
      throw new HermesApiError(err.message, res.status, err.code, err.body)
    }
    const text = await res.text()
    if (!text.trim()) return {} as T
    return JSON.parse(text) as T
  } catch (error) {
    args.signal?.throwIfAborted()
    if (error instanceof HermesApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HermesApiError('Hermes 请求超时或已取消', 0, 'aborted')
    }
    throw new HermesApiError(error instanceof Error ? error.message : String(error), 0, 'network')
  } finally {
    clearTimeout(timer)
    args.signal?.removeEventListener('abort', onExternalAbort)
  }
}

function requireAccount(accountId: string) {
  const acc = getHermesAccount(accountId)
  if (!acc) {
    throw new HermesApiError('Hermes 账号尚未配置', 401, 'not_configured')
  }
  return acc
}

// ---------------- Pure protocol helpers (exported for unit tests) ----------------

export function buildHermesUserContent(
  text: string,
  attachments?: HermesAttachmentInput[]
): string | Array<Record<string, unknown>> {
  const trimmed = (text ?? '').trim()
  const images = (attachments ?? []).filter(
    (a) => Boolean(a.dataBase64) && /^image\//i.test(a.mimeType || '')
  )
  const nonImages = (attachments ?? []).filter(
    (a) => Boolean(a.name) && !/^image\//i.test(a.mimeType || '')
  )
  const noteSuffix = nonImages.length
    ? `\n\n[Attached files: ${nonImages.map((f) => f.name).join(', ')}]`
    : ''
  const combinedText = `${trimmed}${noteSuffix}`.trim()
  if (images.length === 0) return combinedText
  const parts: Array<Record<string, unknown>> = []
  if (combinedText) {
    parts.push({ type: 'text', text: combinedText })
  }
  for (const img of images) {
    const mime = img.mimeType || 'image/png'
    const url = img.dataBase64.startsWith('data:')
      ? img.dataBase64
      : `data:${mime};base64,${img.dataBase64}`
    parts.push({
      type: 'image_url',
      image_url: { url }
    })
  }
  return parts
}

export function mapApprovalDecisionToHermesChoice(
  decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always'
): 'once' | 'session' | 'always' | 'deny' {
  switch (decision) {
    case 'allow_once':
      return 'once'
    case 'allow_session':
      return 'session'
    case 'allow_always':
      return 'always'
    case 'deny':
    case 'deny_always':
    default:
      return 'deny'
  }
}

export function mapHermesChoicesToDecisions(
  choices: unknown
): Array<'allow_once' | 'allow_session' | 'allow_always' | 'deny'> {
  if (!Array.isArray(choices) || choices.length === 0) {
    return ['allow_once', 'allow_session', 'allow_always', 'deny']
  }
  const out: Array<'allow_once' | 'allow_session' | 'allow_always' | 'deny'> = []
  for (const raw of choices) {
    const val = String(raw).toLowerCase()
    if (val === 'once' || val === 'allow_once' || val === 'approve') out.push('allow_once')
    else if (val === 'session' || val === 'allow_session') out.push('allow_session')
    else if (val === 'always' || val === 'allow_always' || val === 'permanent') out.push('allow_always')
    else if (val === 'deny' || val === 'reject') out.push('deny')
  }
  return out.length ? [...new Set(out)] : ['allow_once', 'allow_session', 'deny']
}

/**
 * Extract inline markdown/HTML media (`data:image/...`, `data:video/...`, `data:audio/...`,
 * plus `<video src="...">` / `<audio src="...">` tags) into BotArk `MuseMediaPartView[]`
 * while leaving clean prose.
 */
export function extractInlineDataUrlImages(markdown: string): {
  text: string
  media: MuseMediaPartView[]
} {
  if (
    !markdown ||
    (!markdown.includes('data:image/') &&
      !markdown.includes('data:video/') &&
      !markdown.includes('data:audio/') &&
      !/<(?:video|audio)\b/i.test(markdown))
  ) {
    return { text: markdown, media: [] }
  }
  const media: MuseMediaPartView[] = []
  const seen = new Set<string>()
  let idx = 0
  const dataUrlRe =
    /!\[([^\]]*)\]\((data:((?:image|video|audio)\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=]+)\)/g
  let cleaned = markdown.replace(dataUrlRe, (_match, alt: string, dataUrl: string, mime: string) => {
    if (seen.has(dataUrl)) return ''
    seen.add(dataUrl)
    idx += 1
    const isImg = mime.toLowerCase().startsWith('image/')
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || (isImg ? 'png' : 'mp4')
    media.push({
      kind: isImg ? 'image' : 'file',
      path: dataUrl,
      name: alt?.trim() || `${isImg ? 'hermes-image' : 'hermes-media'}-${idx}.${ext}`,
      mimeType: mime
    })
    return ''
  })

  // Also extract inline HTML <video src="..."> / <audio src="..."> tags
  const htmlAvRe = /<(video|audio)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:[\s\S]*?<\/\1>)?/gi
  cleaned = cleaned.replace(htmlAvRe, (_match, tag: string, src: string) => {
    const cleanSrc = src.trim()
    if (!cleanSrc || seen.has(cleanSrc)) return ''
    seen.add(cleanSrc)
    idx += 1
    const isVideo = tag.toLowerCase() === 'video'
    const mimeMatch = /^data:([^;]+);/i.exec(cleanSrc)
    const mime = mimeMatch?.[1] || (isVideo ? 'video/mp4' : 'audio/mpeg')
    const ext = isVideo ? 'mp4' : 'mp3'
    const name = cleanSrc.startsWith('data:')
      ? `hermes-${tag.toLowerCase()}-${idx}.${ext}`
      : cleanSrc.split(/[?#]/, 1)[0]?.split('/').pop() || `hermes-${tag.toLowerCase()}-${idx}.${ext}`
    media.push({
      kind: 'file',
      path: cleanSrc,
      name,
      mimeType: mime
    })
    return ''
  })

  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), media }
}

export type { ParsedSseFrame } from '../sseParser'
export class SseParser extends BaseSseParser {
  constructor() {
    super(() => new HermesApiError('Hermes SSE 帧超过大小限制', 502, 'sse_frame_too_large'))
  }
}

function parseTimestampMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : Math.round(raw * 1000)
  }
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw)
    if (Number.isFinite(num)) return num > 1e12 ? num : Math.round(num * 1000)
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallbackMs
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (typeof p['text'] === 'string') return p['text']
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function mapHermesTranscriptMessages(rawRows: unknown[]): HermesTranscriptMessage[] {
  const out: HermesTranscriptMessage[] = []
  let pendingTools: MuseToolCallView[] = []
  const now = Date.now()

  for (let i = 0; i < rawRows.length; i += 1) {
    const row = rawRows[i]
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const role = String(r['role'] ?? '').toLowerCase()
    const createdAt = parseTimestampMs(r['timestamp'], now - (rawRows.length - i) * 1000)

    if (role === 'tool') {
      const callId = String(r['tool_call_id'] ?? `tool_${i}`)
      const toolName = String(r['tool_name'] ?? 'tool')
      const rawOut = contentToText(r['content'])
      const existing = pendingTools.find((t) => t.id === callId)
      if (existing) {
        existing.status = 'completed'
        if (!existing.summary && rawOut) existing.summary = rawOut.slice(0, 140)
      } else {
        pendingTools.push({
          id: callId,
          name: toolName,
          status: 'completed',
          summary: rawOut ? rawOut.slice(0, 140) : undefined
        })
      }
      continue
    }

    if (role === 'user') {
      const text = contentToText(r['content']).trim()
      if (!text) continue
      pendingTools = []
      out.push({
        id: `hermes_${String(r['id'] ?? i)}`,
        role: 'user',
        text,
        createdAt
      })
      continue
    }

    if (role === 'assistant') {
      if (Array.isArray(r['tool_calls'])) {
        for (const tc of r['tool_calls'] as Array<Record<string, unknown>>) {
          const fn = (tc['function'] as Record<string, unknown> | undefined) ?? {}
          const id = String(tc['id'] ?? `tc_${pendingTools.length}`)
          const name = String(fn['name'] ?? tc['name'] ?? 'tool')
          const argsStr = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
          pendingTools.push({
            id,
            name,
            status: 'completed',
            summary: argsStr ? argsStr.slice(0, 140) : undefined
          })
        }
      }
      const rawText = contentToText(r['content']).trim()
      const { text, media } = extractInlineDataUrlImages(rawText)
      if (!text && media.length === 0 && pendingTools.length === 0) continue
      // If this is an intermediate tool-call-only assistant row, hold tools until the final reply row
      if (!text && media.length === 0 && Array.isArray(r['tool_calls']) && r['tool_calls'].length > 0) {
        continue
      }
      out.push({
        id: `hermes_${String(r['id'] ?? i)}`,
        role: 'assistant',
        text,
        createdAt,
        ...(pendingTools.length ? { tools: pendingTools } : {}),
        ...(media.length ? { media } : {})
      })
      pendingTools = []
    }
  }

  if (pendingTools.length > 0 && out.length > 0) {
    const last = out[out.length - 1]!
    if (last.role === 'assistant') {
      last.tools = [...(last.tools ?? []), ...pendingTools]
    }
  }

  return out
}

// ---------------- Probe & Discovery ----------------

export interface HermesProbeResult {
  reachable: boolean
  authenticated: boolean
  version?: string
  platform?: string
  models: string[]
  defaultModel: string
  supportsSessions: boolean
  requiresAuth: boolean
  error?: string
}

export async function probeHermesServer(args: {
  accountId?: string
  baseUrl: string
  apiKey?: string
  fetchImpl?: typeof fetch
}): Promise<HermesProbeResult> {
  const baseUrl = normalizeHermesBaseUrl(args.baseUrl)
  let version: string | undefined
  let platform: string | undefined
  let reachable = false
  let verified = false
  let models: string[] = []
  let requiresAuth = false
  let supportsSessions = false
  let errorMessage: string | undefined

  const authRejected = (error: unknown) => {
    if (!(error instanceof HermesApiError) || (error.status !== 401 && error.status !== 403)) return false
    reachable = true
    requiresAuth = true
    verified = false
    errorMessage = args.apiKey ? 'API Key 无效，请检查 Hermes 的 API_SERVER_KEY' : '该 Hermes 服务需要 API_SERVER_KEY 鉴权'
    return true
  }

  try {
    const health = await hermesJsonRequest<Record<string, unknown> | null>({
      accountId: args.accountId,
      baseUrl,
      path: '/health',
      timeoutMs: 8_000,
      fetchImpl: args.fetchImpl
    })
    reachable = true
    if (typeof health?.['version'] === 'string') version = health['version']
    if (typeof health?.['platform'] === 'string') platform = health['platform']
  } catch {
    // A reverse proxy can expose the authenticated endpoints without /health.
  }

  let modelsRejected = false
  try {
    const modelsRes = await hermesJsonRequest<Record<string, unknown> | null>({
      accountId: args.accountId,
      baseUrl,
      apiKey: args.apiKey,
      path: '/v1/models',
      timeoutMs: 10_000,
      fetchImpl: args.fetchImpl
    })
    reachable = true
    const data = modelsRes?.['data']
    if (Array.isArray(data) && (data.length > 0 || modelsRes?.['object'] === 'list') &&
      data.every((row) => row && typeof row.id === 'string' && row.id.trim())) {
      verified = true
      models = data.map((row) => row.id as string)
    }
  } catch (error) {
    modelsRejected = authRejected(error)
  }

  if (!modelsRejected) {
    try {
      const caps = await hermesJsonRequest<Record<string, unknown> | null>({
        accountId: args.accountId,
        baseUrl,
        apiKey: args.apiKey,
        path: '/v1/capabilities',
        timeoutMs: 8_000,
        fetchImpl: args.fetchImpl
      })
      reachable = true
      const auth = caps?.['auth'] as Record<string, unknown> | undefined
      if (caps && (caps['object'] === 'hermes.api_server.capabilities' ||
        (caps['platform'] === 'hermes-agent' && typeof auth?.['required'] === 'boolean'))) {
        requiresAuth = auth?.['required'] === true
        verified = !requiresAuth || Boolean(args.apiKey?.trim())
        if (!verified) errorMessage = '该 Hermes 服务需要 API_SERVER_KEY 鉴权'
        if (typeof caps['model'] === 'string' && caps['model'] && !models.includes(caps['model'])) {
          models.unshift(caps['model'])
        }
        const endpoints = (caps['endpoints'] as Record<string, { path?: unknown }> | undefined) ?? {}
        supportsSessions = Object.values(endpoints).some((endpoint) =>
          typeof endpoint?.path === 'string' && endpoint.path.startsWith('/api/sessions'))
      }
    } catch (error) {
      authRejected(error)
    }
  }

  return {
    reachable,
    authenticated: verified,
    version,
    platform,
    models: models.length || !verified ? models : ['hermes-agent'],
    defaultModel: models[0] || 'hermes-agent',
    supportsSessions,
    requiresAuth,
    ...(!verified && { error: errorMessage || (reachable
      ? 'Hermes 未返回可验证的 API 响应'
      : `无法连接到 ${baseUrl}（请确认已运行 hermes gateway 且启用 API_SERVER_ENABLED=true）`) })
  }
}

// ---------------- Control Plane APIs ----------------

export async function getHermesHealth(accountId: string): Promise<Record<string, unknown>> {
  const acc = requireAccount(accountId)
  try {
    return await hermesJsonRequest<Record<string, unknown>>({
      accountId,
      baseUrl: acc.baseUrl,
      apiKey: acc.apiKey,
      path: '/health/detailed',
      timeoutMs: 10_000
    })
  } catch {
    return hermesJsonRequest<Record<string, unknown>>({
      accountId,
      baseUrl: acc.baseUrl,
      apiKey: acc.apiKey,
      path: '/health',
      timeoutMs: 8_000
    })
  }
}

export async function listHermesModels(accountId: string): Promise<Array<{ id: string; root?: string; ownedBy?: string }>> {
  const acc = requireAccount(accountId)
  const res = await hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: '/v1/models',
    timeoutMs: 10_000
  })
  const rows = Array.isArray(res['data']) ? (res['data'] as Array<Record<string, unknown>>) : []
  return rows
    .map((m) => ({
      id: String(m['id'] ?? ''),
      root: typeof m['root'] === 'string' ? m['root'] : undefined,
      ownedBy: typeof m['owned_by'] === 'string' ? m['owned_by'] : undefined
    }))
    .filter((m) => Boolean(m.id))
}

export async function getHermesCapabilities(accountId: string): Promise<Record<string, unknown>> {
  const acc = requireAccount(accountId)
  return hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: '/v1/capabilities',
    timeoutMs: 10_000
  })
}

export async function listHermesSkills(accountId: string): Promise<HermesSkillItem[]> {
  const acc = requireAccount(accountId)
  const res = await hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: '/v1/skills',
    timeoutMs: 12_000
  })
  const rows = Array.isArray(res['data']) ? (res['data'] as Array<Record<string, unknown>>) : []
  return rows
    .map((s) => ({
      name: String(s['name'] ?? s['id'] ?? ''),
      description: typeof s['description'] === 'string' ? s['description'] : undefined,
      category: typeof s['category'] === 'string' ? s['category'] : undefined,
      enabled: typeof s['enabled'] === 'boolean' ? s['enabled'] : true
    }))
    .filter((s) => Boolean(s.name))
}

export async function listHermesToolsets(accountId: string): Promise<HermesToolsetItem[]> {
  const acc = requireAccount(accountId)
  const res = await hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: '/v1/toolsets',
    timeoutMs: 12_000
  })
  const rows = Array.isArray(res['data']) ? (res['data'] as Array<Record<string, unknown>>) : []
  return rows
    .map((t) => ({
      name: String(t['name'] ?? ''),
      label: typeof t['label'] === 'string' ? t['label'] : undefined,
      description: typeof t['description'] === 'string' ? t['description'] : undefined,
      enabled: Boolean(t['enabled']),
      configured: Boolean(t['configured']),
      tools: Array.isArray(t['tools']) ? t['tools'].map(String) : []
    }))
    .filter((t) => Boolean(t.name))
}

export async function listHermesJobs(accountId: string): Promise<HermesCronJob[]> {
  const acc = requireAccount(accountId)
  const res = await hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: '/api/jobs?include_disabled=true',
    timeoutMs: 10_000
  })
  const rows = Array.isArray(res['jobs'])
    ? (res['jobs'] as Array<Record<string, unknown>>)
    : Array.isArray(res['data'])
      ? (res['data'] as Array<Record<string, unknown>>)
      : []
  return rows
    .map((j) => ({
      id: String(j['id'] ?? j['job_id'] ?? ''),
      name: String(j['name'] ?? j['id'] ?? 'Scheduled job'),
      schedule: String(j['schedule'] ?? j['schedule_display'] ?? ''),
      prompt: typeof j['prompt'] === 'string' ? j['prompt'] : undefined,
      enabled: j['enabled'] !== false && j['state'] !== 'paused',
      paused: j['state'] === 'paused' || j['enabled'] === false,
      lastRunAt: (j['last_run_at'] as string | number | null | undefined) ?? null,
      nextRunAt: (j['next_run_at'] as string | number | null | undefined) ?? null
    }))
    .filter((j) => Boolean(j.id))
}

export async function toggleHermesJob(accountId: string, jobId: string, pause: boolean): Promise<unknown> {
  const acc = requireAccount(accountId)
  const cleanId = encodeURIComponent(jobId.trim())
  return hermesJsonRequest({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    method: 'POST',
    path: `/api/jobs/${cleanId}/${pause ? 'pause' : 'resume'}`,
    body: {}
  })
}

export async function runHermesJob(accountId: string, jobId: string): Promise<unknown> {
  const acc = requireAccount(accountId)
  const cleanId = encodeURIComponent(jobId.trim())
  return hermesJsonRequest({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    method: 'POST',
    path: `/api/jobs/${cleanId}/run`,
    body: {}
  })
}

export async function deleteHermesJob(accountId: string, jobId: string): Promise<unknown> {
  const acc = requireAccount(accountId)
  const cleanId = encodeURIComponent(jobId.trim())
  return hermesJsonRequest({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    method: 'DELETE',
    path: `/api/jobs/${cleanId}`
  })
}

// ---------------- Sessions ----------------

function mapSessionRow(row: Record<string, unknown>): HermesSessionSummary {
  return {
    id: String(row['id'] ?? ''),
    title: typeof row['title'] === 'string' ? row['title'] : null,
    model: typeof row['model'] === 'string' ? row['model'] : null,
    source: typeof row['source'] === 'string' ? row['source'] : null,
    startedAt: (row['started_at'] as string | number | null | undefined) ?? null,
    lastActive: (row['last_active'] as string | number | null | undefined) ?? null,
    preview: typeof row['preview'] === 'string' ? row['preview'] : null,
    messageCount: typeof row['message_count'] === 'number' ? row['message_count'] : undefined,
    toolCallCount: typeof row['tool_call_count'] === 'number' ? row['tool_call_count'] : undefined,
    pinned: Boolean(row['pinned']),
    archived: Boolean(row['archived'])
  }
}

export async function listHermesSessions(accountId: string, limit = 50): Promise<HermesSessionSummary[]> {
  const acc = requireAccount(accountId)
  const res = await hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: `/api/sessions?limit=${Math.max(1, Math.min(200, limit))}`,
    timeoutMs: 12_000
  })
  const rows = Array.isArray(res['data']) ? (res['data'] as Array<Record<string, unknown>>) : []
  return rows.map(mapSessionRow).filter((s) => Boolean(s.id))
}

export async function createHermesSession(
  accountId: string,
  opts?: { title?: string; model?: string }
): Promise<HermesSessionSummary> {
  const acc = requireAccount(accountId)
  return createSession({ accountId, baseUrl: acc.baseUrl, apiKey: acc.apiKey }, {
    title: opts?.title,
    model: opts?.model?.trim() || acc.model
  })
}

async function createSession(
  connection: HermesConnection,
  opts: { title?: string; model?: string; signal?: AbortSignal }
): Promise<HermesSessionSummary> {
  const payload: Record<string, unknown> = { source: 'api_server' }
  if (opts.title?.trim()) payload['title'] = opts.title.trim()
  const { model, signal } = opts
  if (model && model !== 'hermes-agent') payload['model'] = model
  const res = await hermesJsonRequest<Record<string, unknown>>({
    ...connection,
    method: 'POST',
    path: '/api/sessions',
    body: payload,
    signal,
    timeoutMs: 12_000
  })
  const session = (res['session'] as Record<string, unknown> | undefined) ?? res
  const mapped = mapSessionRow(session)
  if (!mapped.id) throw new HermesApiError('Hermes 返回的会话 ID 为空', 502)
  return mapped
}

export async function deleteHermesSession(accountId: string, sessionId: string): Promise<unknown> {
  const acc = requireAccount(accountId)
  return hermesJsonRequest({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    method: 'DELETE',
    path: `/api/sessions/${encodeURIComponent(sessionId)}`
  })
}

export async function getHermesSessionMessages(
  accountId: string,
  sessionId: string
): Promise<HermesTranscriptMessage[]> {
  const acc = requireAccount(accountId)
  const res = await hermesJsonRequest<Record<string, unknown>>({
    accountId,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    path: `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    timeoutMs: 15_000
  })
  const rows = Array.isArray(res['data'])
    ? res['data']
    : Array.isArray(res['messages'])
      ? res['messages']
      : []
  return mapHermesTranscriptMessages(rows)
}

// ---------------- Approvals & Run Control ----------------

export function listHermesApprovals(accountId: string): HermesApprovalView[] {
  const run = activeRuns.get(accountId)
  return run ? Array.from(run.approvals.values(), (item) => item.approval) : []
}

export async function decideHermesApproval(
  accountId: string,
  approvalId: string,
  decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always'
): Promise<void> {
  const run = activeRuns.get(accountId)
  const entry = run && Array.from(run.approvals).find(([, item]) => item.approval.id === approvalId)
  if (!run || !entry || run.stopRequested) {
    throw new HermesApiError('未找到对应的 Hermes 运行任务（审批可能已过期）', 409)
  }
  const [key, target] = entry
  if (run.decisions.has(key)) {
    throw new HermesApiError('Hermes 审批正在处理', 409, 'approval_in_progress')
  }
  run.decisions.set(key, 'pending')
  const choice = mapApprovalDecisionToHermesChoice(decision)
  try {
    await hermesJsonRequest({
      ...run.connection,
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(target.runId)}/approval`,
      body: { choice, ...(target.requestId ? { request_id: target.requestId } : {}) },
      timeoutMs: 12_000
    })
  } catch (error) {
    run.decisions.delete(key)
    throw error
  }
  run.decisions.set(key, 'resolved')
  run.approvals.delete(key)
  if (activeRuns.get(accountId) === run) run.callbacks.onApprovals?.(listHermesApprovals(accountId))
}

export async function stopHermesRun(accountId: string, requestId?: string): Promise<void> {
  const run = activeRuns.get(accountId)
  if (!run || (requestId && requestId !== run.requestId)) return
  if (run.stopConfirmed) return
  if (run.stopping) return run.stopping
  const runId = run.runId
  if (!runId) {
    run.controller.abort()
    if (run.dispatched) {
      throw new HermesApiError('Hermes 未提供运行 ID，无法确认远端已停止', 409, 'stop_unconfirmed')
    }
    return
  }
  run.stopRequested = true
  run.stopping = (async () => {
    const result = await hermesJsonRequest<{ status?: string; run_id?: string; stopped?: boolean } | null>({
      ...run.connection,
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(runId)}/stop`,
      body: {},
      timeoutMs: 5_000
    })
    const confirmed = result?.stopped === true ||
      ['stopping', 'stopped', 'cancelled', 'completed', 'failed', 'interrupted'].includes(result?.status ?? '')
    if (!confirmed || (result?.run_id && result.run_id !== runId)) {
      throw new HermesApiError('Hermes 未确认停止请求', 502, 'stop_unconfirmed')
    }
    run.stopConfirmed = true
    run.controller.abort()
  })()
  try {
    await run.stopping
  } finally {
    run.stopping = undefined
    run.stopRequested = false
  }
}

export function cancelAllHermesRuns(accountId: string): void {
  if (accountId === '*') {
    for (const [, run] of activeRuns) run.controller.abort()
    activeRuns.clear()
    return
  }
  const run = activeRuns.get(accountId)
  if (run) {
    run.controller.abort()
    activeRuns.delete(accountId)
  }
}

// ---------------- Streaming Chat (Native Session SSE + OpenAI Fallback) ----------------

export interface HermesStreamCallbacks {
  onAccepted?: (sessionId?: string) => void
  onDelta: (payload: {
    messageId: string
    sessionId?: string
    text: string
    tools?: MuseToolCallView[]
    media?: MuseMediaPartView[]
    done: boolean
  }) => void
  onActivity?: (activity: { code: string; text?: string; emoji?: string; busy: boolean }, sessionId?: string) => void
  onApprovals?: (pending: HermesApprovalView[], sessionId?: string) => void
}

export interface HermesSendResult {
  messageId: string
  sessionId?: string
  text: string
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
}

async function readHermesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  handle: (frame: ParsedSseFrame) => boolean
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true })
      for (const frame of parser.frames(chunk)) {
        if (handle(frame)) return
      }
      if (done) break
    }
    for (const frame of parser.flush()) {
      if (handle(frame)) return
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

class HermesStreamText {
  raw = ''
  private tail = ''
  private mediaStart?: number

  append(delta: string): void {
    const start = this.raw.length - this.tail.length
    this.raw += delta
    if (this.mediaStart !== undefined) return
    // Keep incomplete inline media out of IPC snapshots. Extract media once
    // from the authoritative final text, including tags split across deltas.
    const chunk = this.tail + delta
    const match = /!\[|<(?:video|audio)\b/i.exec(chunk)
    if (match) this.mediaStart = start + match.index
    this.tail = chunk.slice(-6)
  }

  preview(): string {
    if (this.mediaStart !== undefined) return this.raw.slice(0, this.mediaStart)
    return this.raw
  }
}

function streamRunState(accountId: string, controller: AbortController): ActiveRunState | undefined {
  const run = activeRuns.get(accountId)
  return run?.controller === controller ? run : undefined
}

function parseStreamEvent(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Some gateways send empty or non-JSON terminal markers.
  }
  return {}
}

function recordApproval(
  run: ActiveRunState | undefined,
  runId: string,
  event: Record<string, unknown>,
  callbacks: HermesStreamCallbacks
): void {
  if (!runId) return
  const requestId = typeof event['request_id'] === 'string' ? event['request_id']
    : typeof event['id'] === 'string' ? event['id'] : undefined
  const key = JSON.stringify([runId, requestId])
  if (run?.decisions.get(key) === 'resolved') return
  const payload = { ...(run?.approvals.get(key)?.approval.raw as Record<string, unknown> | undefined), ...event }
  const command = typeof payload['command'] === 'string' ? payload['command'] : ''
  const description = typeof payload['description'] === 'string' ? payload['description'] : ''
  const approval: HermesApprovalView = {
    id: requestId || runId,
    status: 'pending',
    title: command ? `Allow command: ${command}` : description || 'Hermes approval required',
    detail: command && description ? description : command || undefined,
    approvalType: 'hermes_command',
    decisionOptions: mapHermesChoicesToDecisions(payload['choices']),
    raw: payload
  }
  run?.approvals.set(key, { approval, runId, requestId })
  callbacks.onApprovals?.(run ? Array.from(run.approvals.values(), (item) => item.approval) : [approval])
  callbacks.onActivity?.({ code: 'approval', text: 'Waiting for command approval…', busy: true })
}

function streamFailure(payload: Record<string, unknown>): HermesApiError {
  const nestedError = payload['error'] as Record<string, unknown> | undefined
  const summary = [payload['message'], payload['error'], nestedError?.['message'], payload['turn_exit_reason']]
    .find((value): value is string => typeof value === 'string' && Boolean(value))
  return new HermesApiError(summary || 'Hermes run failed', 502, 'run_failed')
}

export async function streamNativeSessionTurn(args: {
  accountId: string
  baseUrl: string
  apiKey?: string
  sessionId: string
  sessionKey: string
  userContent: string | Array<Record<string, unknown>>
  model?: string
  controller: AbortController
  callbacks: HermesStreamCallbacks
  fetchImpl?: typeof fetch
}): Promise<HermesSendResult> {
  const url = `${args.baseUrl}/api/sessions/${encodeURIComponent(args.sessionId)}/chat/stream`
  const body: Record<string, unknown> = { message: args.userContent }
  if (args.model?.trim()) body['model'] = args.model.trim()
  const signal = args.controller.signal
  signal.throwIfAborted()
  const state = streamRunState(args.accountId, args.controller)
  if (state) {
    state.dispatched = true
    state.sessionId = args.sessionId
  }

  const res = await fetchForAccount(
    args.accountId,
    url,
    {
      method: 'POST',
      headers: buildAuthHeaders(args.apiKey, {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Hermes-Session-Key': args.sessionKey
      }),
      body: JSON.stringify(body),
      signal
    },
    args.fetchImpl
  )

  signal.throwIfAborted()
  if (!res.ok) {
    if (state) state.dispatched = false
    const err = await readErrorMessage(res)
    throw new HermesApiError(err.message, res.status, err.code, err.body)
  }

  if (!res.body) {
    throw new HermesApiError('Hermes 流式响应体为空', 502)
  }

  let messageId = `hermes_${randomUUID()}`
  let effectiveSessionId = res.headers.get('X-Hermes-Session-Id') || args.sessionId
  if (state) {
    state.sessionId = effectiveSessionId
    state.runId = res.headers.get('X-Hermes-Run-Id') || undefined
  }
  args.callbacks.onAccepted?.(effectiveSessionId)
  const accumulated = new HermesStreamText()
  let completedText: string | undefined
  let terminal = false
  const tools: MuseToolCallView[] = []

  const emitProgress = () => {
    args.callbacks.onDelta({
      messageId,
      sessionId: effectiveSessionId,
      text: accumulated.preview(),
      tools: tools.length ? tools.map((tool) => ({ ...tool })) : undefined,
      done: false
    })
  }

  await readHermesStream(res.body, signal, ({ event: eventName, data: rawData }) => {
    if (rawData === '[DONE]') {
      terminal = true
      return true
    }
    const payload = parseStreamEvent(rawData)

    const runId = typeof payload['run_id'] === 'string' ? payload['run_id'] : undefined
    if (runId && state) state.runId ??= runId
    if (typeof payload['session_id'] === 'string' && payload['session_id']) {
      effectiveSessionId = payload['session_id']
      if (state) state.sessionId = effectiveSessionId
    }

    const type = eventName && eventName !== 'message' ? eventName : String(payload['type'] ?? payload['event'] ?? '')

    switch (type) {
      case 'run.started':
        args.callbacks.onActivity?.({ code: 'thinking', text: 'Hermes is thinking…', busy: true })
        break
      case 'message.started': {
        const msgObj = payload['message'] as Record<string, unknown> | undefined
        if (typeof msgObj?.['id'] === 'string' && msgObj['id']) {
          messageId = `hermes_${msgObj['id']}`
        }
        break
      }
      case 'assistant.delta': {
        if (typeof payload['message_id'] === 'string' && payload['message_id']) {
          messageId = `hermes_${payload['message_id']}`
        }
        const delta = typeof payload['delta'] === 'string' ? payload['delta'] : ''
        if (delta) {
          accumulated.append(delta)
          emitProgress()
        }
        break
      }
      case 'assistant.commentary': {
        const commentary = typeof payload['text'] === 'string' ? payload['text'].trim() : ''
        if (commentary) {
          args.callbacks.onActivity?.({ code: 'working', text: commentary.slice(0, 120), busy: true })
        }
        break
      }
      case 'tool.started': {
        const name = String(payload['tool_name'] ?? 'tool')
        const preview = typeof payload['preview'] === 'string' ? payload['preview'] : undefined
        tools.push({
          id: `hermes_tool_${tools.length + 1}`,
          name,
          status: 'running',
          summary: preview
        })
        args.callbacks.onActivity?.({
          code: 'tool',
          text: preview ? `${name}: ${preview.slice(0, 80)}` : `Running ${name}…`,
          busy: true
        })
        emitProgress()
        break
      }
      case 'tool.progress': {
        const name = String(payload['tool_name'] ?? '_thinking')
        const delta = typeof payload['delta'] === 'string' ? payload['delta'].trim() : ''
        if (delta) {
          args.callbacks.onActivity?.({
            code: name === '_thinking' ? 'thinking' : 'tool',
            text: delta.slice(0, 120),
            busy: true
          })
        }
        break
      }
      case 'tool.completed':
      case 'tool.failed': {
        const name = String(payload['tool_name'] ?? 'tool')
        const preview = typeof payload['preview'] === 'string' ? payload['preview'] : undefined
        const failed = type === 'tool.failed'
        const target = [...tools].reverse().find((t) => t.name === name && t.status === 'running')
        if (target) {
          target.status = failed ? 'errored' : 'completed'
          if (preview) target.summary = preview
        } else {
          tools.push({
            id: `hermes_tool_${tools.length + 1}`,
            name,
            status: failed ? 'errored' : 'completed',
            summary: preview
          })
        }
        emitProgress()
        break
      }
      case 'approval.request': {
        recordApproval(state, runId || state?.runId || '', payload, args.callbacks)
        break
      }
      case 'assistant.completed': {
        if (typeof payload['message_id'] === 'string' && payload['message_id']) {
          messageId = `hermes_${payload['message_id']}`
        }
        if (payload['interrupted'] === true) throw new HermesApiError('Hermes 已取消运行', 0, 'aborted')
        if (payload['partial'] === true || payload['completed'] === false) throw streamFailure(payload)
        if (typeof payload['content'] === 'string') completedText = payload['content']
        break
      }
      case 'error':
      case 'run.failed':
        throw streamFailure(payload)
      case 'run.cancelled':
        throw new HermesApiError('Hermes 已取消运行', 0, 'aborted')
      case 'run.completed':
        if (typeof payload['message_id'] === 'string' && payload['message_id']) {
          messageId = `hermes_${payload['message_id']}`
        }
        terminal = true
        return true
      case 'done':
        terminal = true
        return true
      default:
        break
    }
    return false
  })

  signal.throwIfAborted()
  if (!terminal && completedText === undefined) {
    throw new HermesApiError('Hermes 流式连接在运行完成前关闭', 502, 'stream_incomplete')
  }
  const { text, media } = extractInlineDataUrlImages(completedText ?? accumulated.raw)
  const result = {
    messageId,
    sessionId: effectiveSessionId,
    text,
    tools: tools.length ? tools : undefined,
    media: media.length ? media : undefined
  }
  args.callbacks.onDelta({ ...result, done: true })
  return result
}

export async function streamOpenAICompatTurn(args: {
  accountId: string
  baseUrl: string
  apiKey?: string
  sessionId?: string
  sessionKey: string
  userContent: string | Array<Record<string, unknown>>
  model?: string
  controller: AbortController
  callbacks: HermesStreamCallbacks
  fetchImpl?: typeof fetch
}): Promise<HermesSendResult> {
  const url = `${args.baseUrl}/v1/chat/completions`
  const signal = args.controller.signal
  signal.throwIfAborted()
  const state = streamRunState(args.accountId, args.controller)
  if (state) state.dispatched = true
  const res = await fetchForAccount(
    args.accountId,
    url,
    {
      method: 'POST',
      headers: buildAuthHeaders(args.apiKey, {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Hermes-Session-Key': args.sessionKey,
        ...(args.sessionId ? { 'X-Hermes-Session-Id': args.sessionId } : {})
      }),
      body: JSON.stringify({
        model: args.model?.trim() || 'hermes-agent',
        stream: true,
        messages: [{ role: 'user', content: args.userContent }]
      }),
      signal
    },
    args.fetchImpl
  )

  signal.throwIfAborted()
  if (!res.ok) {
    if (state) state.dispatched = false
    const err = await readErrorMessage(res)
    throw new HermesApiError(err.message, res.status, err.code, err.body)
  }

  if (!res.body) throw new HermesApiError('Hermes OpenAI 流式响应体为空', 502)
  let effectiveSessionId = res.headers.get('X-Hermes-Session-Id') || args.sessionId
  if (state) {
    state.sessionId = effectiveSessionId
    state.runId = res.headers.get('X-Hermes-Run-Id') || undefined
  }
  args.callbacks.onAccepted?.(effectiveSessionId)
  const contentType = res.headers.get('content-type') || ''
  let messageId = `hermes_${randomUUID()}`

  // Non-streaming JSON fallback if server returned application/json
  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>
    signal.throwIfAborted()
    if (json['error']) throw streamFailure(json)
    if (typeof json['id'] === 'string' && json['id']) messageId = `hermes_${json['id']}`
    const choices = Array.isArray(json['choices']) ? (json['choices'] as Array<Record<string, unknown>>) : []
    const msg = (choices[0]?.['message'] as Record<string, unknown> | undefined) ?? {}
    const rawText = contentToText(msg['content'])
    const { text, media } = extractInlineDataUrlImages(rawText)
    args.callbacks.onDelta({ messageId, sessionId: effectiveSessionId, text, media: media.length ? media : undefined, done: true })
    return { messageId, sessionId: effectiveSessionId, text, media: media.length ? media : undefined }
  }

  const accumulated = new HermesStreamText()
  await readHermesStream(res.body, signal, ({ event, data }) => {
    if (data === '[DONE]') return true
    const parsed = parseStreamEvent(data)
    const type = event === 'message' ? parsed['type'] ?? parsed['event'] : event
    if (type === 'run.failed' || type === 'error' || parsed['error']) throw streamFailure(parsed)
    if (type === 'run.cancelled') throw new HermesApiError('Hermes 已取消运行', 0, 'aborted')
    if (typeof parsed['run_id'] === 'string' && state) state.runId ??= parsed['run_id']
    if (typeof parsed['session_id'] === 'string' && parsed['session_id']) {
      effectiveSessionId = parsed['session_id']
      if (state) state.sessionId = effectiveSessionId
    }
    if (type === 'approval.request') {
      const runId = typeof parsed['run_id'] === 'string' ? parsed['run_id'] : state?.runId
      recordApproval(state, runId || '', parsed, args.callbacks)
      return false
    }
    if (type === 'run.completed' || type === 'done') return true
    if (typeof parsed['id'] === 'string' && parsed['id']) messageId = `hermes_${parsed['id']}`
    const choices = Array.isArray(parsed['choices']) ? (parsed['choices'] as Array<Record<string, unknown>>) : []
    const delta = choices[0]?.['delta'] as Record<string, unknown> | undefined
    if (typeof delta?.['content'] === 'string' && delta['content']) {
      accumulated.append(delta['content'])
      args.callbacks.onDelta({ messageId, sessionId: effectiveSessionId, text: accumulated.preview(), done: false })
    }
    return typeof choices[0]?.['finish_reason'] === 'string' && Boolean(choices[0]['finish_reason'])
  })

  signal.throwIfAborted()
  const { text, media } = extractInlineDataUrlImages(accumulated.raw)
  const result = { messageId, sessionId: effectiveSessionId, text, media: media.length ? media : undefined }
  args.callbacks.onDelta({ ...result, done: true })
  return result
}

export async function sendHermesMessage(args: {
  accountId: string
  botId?: string
  requestId?: string
  sessionId?: string
  sessionKey?: string
  text: string
  model?: string
  attachments?: HermesAttachmentInput[]
  callbacks: HermesStreamCallbacks
  fetchImpl?: typeof fetch
}): Promise<HermesSendResult> {
  const acc = requireAccount(args.accountId)
  const userContent = buildHermesUserContent(args.text, args.attachments)
  if (!userContent || (Array.isArray(userContent) && userContent.length === 0)) {
    throw new HermesApiError('消息内容不能为空', 400)
  }

  // Cancel any stale in-flight stream on this account before starting a new one
  const prev = activeRuns.get(args.accountId)
  prev?.controller.abort()

  const controller = new AbortController()
  const signal = controller.signal
  const connection: HermesConnection = { accountId: args.accountId, baseUrl: acc.baseUrl, apiKey: acc.apiKey }
  const run: ActiveRunState = {
    connection, controller, callbacks: args.callbacks, requestId: args.requestId, sessionId: args.sessionId,
    dispatched: false, approvals: new Map(), decisions: new Map()
  }
  activeRuns.set(args.accountId, run)

  const sessionKey = `botark:${args.sessionKey || args.botId || args.accountId}`
  const model = args.model?.trim() || acc.model
  const sessionOptions = { title: args.text.trim().slice(0, 60) || 'BotArk Chat', model, signal }

  try {
    args.callbacks.onApprovals?.([], run.sessionId)
    args.callbacks.onActivity?.({ code: 'thinking', text: 'Connecting to Hermes…', busy: true }, run.sessionId)
    signal.throwIfAborted()
    if (args.fetchImpl) {
      connection.fetchImpl = args.fetchImpl
    } else {
      const proxyUrl = await loadAccountProxyUrl(args.accountId)
      connection.fetchImpl = (url, init) => fetchHermesUrl(proxyUrl, String(url), init)
    }
    signal.throwIfAborted()
    const streamOptions = {
      ...connection, sessionKey, userContent, model, controller,
      callbacks: {
        onAccepted: args.callbacks.onAccepted,
        onDelta: args.callbacks.onDelta,
        onActivity: (activity: Parameters<NonNullable<HermesStreamCallbacks['onActivity']>>[0]) =>
          args.callbacks.onActivity?.(activity, run.sessionId),
        onApprovals: (approvals: HermesApprovalView[]) => args.callbacks.onApprovals?.(approvals, run.sessionId)
      }
    }

    // Try native session API first (supports tool calls, approvals, persistent history & session switching).
    let sessionId = args.sessionId?.trim() || undefined
    let useLegacyOpenAI = false

    if (!sessionId) {
      try {
        const created = await createSession(connection, sessionOptions)
        sessionId = created.id
      } catch (error) {
        if (
          error instanceof HermesApiError &&
          (error.status === 404 || error.status === 405 || error.status === 501 || error.status === 503)
        ) {
          useLegacyOpenAI = true
        } else {
          throw error
        }
      }
    }

    if (!useLegacyOpenAI && sessionId) {
      try {
        return await streamNativeSessionTurn({ ...streamOptions, sessionId })
      } catch (error) {
        // If session was deleted server-side (404), recreate once; if endpoint unsupported (405/501), fallback to /v1/chat/completions
        if (error instanceof HermesApiError && error.code === 'session_not_found') {
          const recreated = await createSession(connection, sessionOptions)
          return await streamNativeSessionTurn({ ...streamOptions, sessionId: recreated.id })
        }
        if (!(error instanceof HermesApiError) || ![404, 405, 501].includes(error.status)) {
          throw error
        }
      }
    }

    return await streamOpenAICompatTurn({ ...streamOptions, sessionId })
  } finally {
    if (activeRuns.get(args.accountId) === run) {
      activeRuns.delete(args.accountId)
      if (run.approvals.size) args.callbacks.onApprovals?.([], run.sessionId)
      args.callbacks.onActivity?.({ code: 'idle', busy: false }, run.sessionId)
    }
  }
}
