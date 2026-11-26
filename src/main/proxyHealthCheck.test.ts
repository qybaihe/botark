import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeProxyDispatchers } from './proxyTransport'
import {
  formatProxyProbeError,
  parseCloudflareTrace,
  probeProxyUrl,
  runWithConcurrency
} from './proxyHealthCheck'

let target: Server
let openProxy: Server
let authProxy: Server
let deadPort: number
let targetUrl: string
let openProxyUrl: string
let authProxyUrlBase: string

beforeAll(async () => {
  target = createServer((req, res) => {
    if (req.url === '/cdn-cgi/trace') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('fl=123\nip=203.0.113.42\nloc=JP\n')
      return
    }
    if (req.url === '/generate_204') {
      res.writeHead(204).end()
      return
    }
    if (req.url === '/slow') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) res.writeHead(204).end()
      }, 2_000)
      timer.unref()
      req.on('close', () => clearTimeout(timer))
      return
    }
    res.writeHead(503).end('unavailable')
  })
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`

  const forwardHttp = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const dest = new URL(req.url!)
    fetch(dest.toString(), { method: req.method, redirect: 'manual' })
      .then(async (upstream) => {
        const buf = Buffer.from(await upstream.arrayBuffer())
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'text/plain'
        })
        res.end(buf)
      })
      .catch((err) => {
        res.writeHead(502).end(String(err))
      })
  }

  openProxy = createServer((req, res) => forwardHttp(req, res))
  openProxy.listen(0, '127.0.0.1')
  await once(openProxy, 'listening')
  openProxyUrl = `http://127.0.0.1:${(openProxy.address() as AddressInfo).port}`

  authProxy = createServer((req, res) => {
    const expected = `Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`
    if (req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }).end('Proxy Auth Required')
      return
    }
    forwardHttp(req, res)
  })
  authProxy.listen(0, '127.0.0.1')
  await once(authProxy, 'listening')
  authProxyUrlBase = `127.0.0.1:${(authProxy.address() as AddressInfo).port}`

  // Allocate and immediately close an ephemeral port to test ECONNREFUSED deterministically.
  const temp = createServer()
  temp.listen(0, '127.0.0.1')
  await once(temp, 'listening')
  deadPort = (temp.address() as AddressInfo).port
  await new Promise<void>((resolve) => temp.close(() => resolve()))
})

afterAll(async () => {
  await closeProxyDispatchers()
  await Promise.all(
    [target, openProxy, authProxy].map((srv) => {
      srv.closeAllConnections?.()
      return new Promise<void>((resolve) => srv.close(() => resolve()))
    })
  )
})

describe('proxy availability & latency health check', () => {
  it('parses Cloudflare trace IPv4/IPv6 and ISO country codes safely', () => {
    expect(parseCloudflareTrace('ip=198.51.100.7\nloc=US\n')).toEqual({
      exitIp: '198.51.100.7',
      country: 'US'
    })
    expect(parseCloudflareTrace('ip=2001:db8::1\nloc=DE\n')).toEqual({
      exitIp: '2001:db8::1',
      country: 'DE'
    })
    expect(parseCloudflareTrace('ip=not-an-ip\nloc=invalid\n')).toEqual({})
  })

  it('measures latency and extracts exit IP / country through a real HTTP proxy', async () => {
    const result = await probeProxyUrl(openProxyUrl, {
      probeUrls: [`${targetUrl}/cdn-cgi/trace`]
    })
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(1)
    expect(result.statusCode).toBe(200)
    expect(result.exitIp).toBe('203.0.113.42')
    expect(result.country).toBe('JP')
  })

  it('reports 407 proxy auth errors clearly and succeeds with valid credentials', async () => {
    const failed = await probeProxyUrl(`http://alice:wrong@${authProxyUrlBase}`, {
      probeUrls: [`${targetUrl}/cdn-cgi/trace`, `${targetUrl}/generate_204`]
    })
    expect(failed.ok).toBe(false)
    expect(failed.statusCode).toBe(407)
    expect(failed.error).toContain('407')

    const passed = await probeProxyUrl(`http://alice:s3cr3t@${authProxyUrlBase}`, {
      probeUrls: [`${targetUrl}/cdn-cgi/trace`]
    })
    expect(passed.ok).toBe(true)
    expect(passed.country).toBe('JP')
  })

  it('falls back to secondary 204 probe when primary returns 503', async () => {
    const res = await probeProxyUrl(openProxyUrl, {
      probeUrls: [`${targetUrl}/fail`, `${targetUrl}/generate_204`]
    })
    expect(res.ok).toBe(true)
    expect(res.statusCode).toBe(204)
    expect(res.latencyMs).toBeGreaterThanOrEqual(1)
  })

  it('fails fast on connection refused and reports timeout cleanly', async () => {
    const refused = await probeProxyUrl(`http://127.0.0.1:${deadPort}`, {
      probeUrls: [`${targetUrl}/cdn-cgi/trace`, `${targetUrl}/generate_204`]
    })
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('拒绝连接')

    const timedOut = await probeProxyUrl(openProxyUrl, {
      probeUrls: [`${targetUrl}/slow`],
      timeoutMs: 500
    })
    expect(timedOut.ok).toBe(false)
    expect(timedOut.error).toContain('超时')
  })

  it('bounds concurrent batch workers and preserves item order', async () => {
    let active = 0
    let maxActive = 0
    const out = await runWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      async (n) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 15))
        active -= 1
        return n * 10
      },
      3
    )
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('formats common proxy transport errors concisely', () => {
    expect(formatProxyProbeError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toContain('解析')
    expect(formatProxyProbeError(new Error('ERR_TLS_CERT_ALTNAME_INVALID'))).toContain('TLS')
    const stub = vi.fn(async () => new Response(null, { status: 204 }))
    expect(stub).toBeDefined()
  })
})
