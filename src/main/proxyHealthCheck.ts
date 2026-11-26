/**
 * Proxy availability & latency probe routed through the exact `proxyFetch`
 * transport used by BotArk accounts (HTTP, HTTPS TLS ALPN, SOCKS5/5H, auth,
 * or direct system stack).
 */
import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { MuseProxyTestResult } from '@shared/ipc'
import { proxyFetch } from './proxyTransport'

const DEFAULT_PROBE_URLS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://www.gstatic.com/generate_204'
] as const

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_BATCH_CONCURRENCY = 5

export interface ProxyProbeOptions {
  /** Override probe target URLs (primarily for deterministic local unit tests). */
  probeUrls?: readonly string[]
  /** Per-attempt timeout in milliseconds (default 8000ms). */
  timeoutMs?: number
  /** Optional custom fetch implementation for tests. */
  fetchImpl?: (proxyUrl: string | undefined, url: string, init?: RequestInit) => Promise<Response>
}

export function parseCloudflareTrace(body: string): { exitIp?: string; country?: string } {
  let exitIp: string | undefined
  let country: string | undefined
  for (const rawLine of body.split(/\r?\n/)) {
    const eq = rawLine.indexOf('=')
    if (eq <= 0) continue
    const key = rawLine.slice(0, eq).trim()
    const value = rawLine.slice(eq + 1).trim()
    if (key === 'ip' && isIP(value) !== 0) {
      exitIp = value
    } else if (key === 'loc' && /^[A-Z]{2}$/.test(value)) {
      country = value
    }
  }
  return {
    ...(exitIp ? { exitIp } : {}),
    ...(country ? { country } : {})
  }
}

function extractErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return ''
  const rec = err as { code?: unknown; cause?: unknown }
  if (typeof rec.code === 'string' && rec.code) return rec.code
  if (rec.cause && typeof rec.cause === 'object') {
    const causeCode = (rec.cause as { code?: unknown }).code
    if (typeof causeCode === 'string' && causeCode) return causeCode
  }
  return ''
}

function collectErrorText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur; depth += 1) {
    if (cur instanceof Error) {
      if (cur.message) parts.push(cur.message)
      cur = cur.cause
    } else if (typeof cur === 'object') {
      const msg = (cur as { message?: unknown }).message
      if (typeof msg === 'string' && msg) parts.push(msg)
      cur = (cur as { cause?: unknown }).cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(' | ')
}

export function formatProxyProbeError(err: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  const code = extractErrorCode(err)
  const text = collectErrorText(err)
  if (/407|Proxy Authentication Required|proxy auth/i.test(text)) {
    return '代理鉴权失败（407），请检查用户名或密码'
  }
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
    /timed?\s*out|aborted/i.test(text)
  ) {
    const secs = Math.max(1, Math.round(timeoutMs / 1000))
    return `连接超时（超过 ${secs} 秒）`
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(text)) {
    return '代理拒绝连接（请确认主机与端口已启动）'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return '无法解析代理主机名'
  }
  if (code === 'ECONNRESET' || /ECONNRESET|socket hang up/i.test(text)) {
    return '代理连接被重置'
  }
  if (/ERR_TLS|CERT_|SSL|self[- ]signed|handshake/i.test(text)) {
    return '代理 TLS 握手失败'
  }
  if (/socks/i.test(text) && /auth|not allowed|rejected/i.test(text)) {
    return 'SOCKS5 代理鉴权失败，请检查用户名或密码'
  }
  return text.split(' | ')[0] || '代理连接失败'
}

function isFatalProxyFailure(err: unknown): boolean {
  const code = extractErrorCode(err)
  const text = collectErrorText(err)
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /407|Proxy Authentication Required|ECONNREFUSED|ENOTFOUND|socks.*auth/i.test(text)
  )
}

/**
 * Probe connectivity & latency for a normalized proxy URL (or `undefined` for direct/system).
 */
export async function probeProxyUrl(
  proxyUrl: string | undefined,
  opts?: ProxyProbeOptions
): Promise<MuseProxyTestResult> {
  const targets = opts?.probeUrls?.length ? opts.probeUrls : DEFAULT_PROBE_URLS
  const timeoutMs = Math.max(500, Math.min(30_000, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const fetcher =
    opts?.fetchImpl ??
    ((url: string | undefined, target: string, init?: RequestInit) => proxyFetch(url, target, init))

  let lastError = '代理连接失败'
  let lastStatus: number | undefined

  for (const targetUrl of targets) {
    const startedAt = performance.now()
    try {
      const response = await fetcher(proxyUrl, targetUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/plain, */*;q=0.1',
          'Cache-Control': 'no-cache'
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
      if (response.status === 407) {
        await response.body?.cancel().catch(() => undefined)
        return {
          ok: false,
          statusCode: 407,
          error: '代理鉴权失败（407），请检查用户名或密码',
          checkedAt: Date.now()
        }
      }
      if (response.status >= 200 && response.status < 400) {
        let trace: { exitIp?: string; country?: string } = {}
        if (response.status !== 204 && targetUrl.includes('trace')) {
          const text = await response.text().catch(() => '')
          trace = parseCloudflareTrace(text.slice(0, 2048))
        } else {
          await response.body?.cancel().catch(() => undefined)
        }
        return {
          ok: true,
          latencyMs,
          statusCode: response.status,
          ...trace,
          checkedAt: Date.now()
        }
      }
      await response.body?.cancel().catch(() => undefined)
      lastStatus = response.status
      lastError = `代理探测返回 HTTP ${response.status}`
    } catch (err) {
      lastError = formatProxyProbeError(err, timeoutMs)
      const isAuth407 = /407|Proxy Authentication Required|proxy auth/i.test(collectErrorText(err))
      if (isAuth407) lastStatus = 407
      if (isFatalProxyFailure(err)) {
        return {
          ok: false,
          ...(lastStatus ? { statusCode: lastStatus } : {}),
          error: lastError,
          checkedAt: Date.now()
        }
      }
    }
  }

  return {
    ok: false,
    ...(lastStatus ? { statusCode: lastStatus } : {}),
    error: lastError,
    checkedAt: Date.now()
  }
}

/**
 * Run async proxy checks with bounded concurrency so large pools finish quickly
 * without exhausting sockets or starving the event loop.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency = DEFAULT_BATCH_CONCURRENCY
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const runWorker = async () => {
    while (true) {
      const idx = nextIndex
      nextIndex += 1
      if (idx >= items.length) return
      results[idx] = await worker(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return results
}
