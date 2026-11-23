import { describe, expect, it, vi } from 'vitest'
import { computeSessionPathFallback, extractRequiredMethodPath, MuseNativeGateway } from './gateway'
import { MUSE_METHODS } from './methods'
import { extractStartedSessionId } from './sessions'

function makeGatewayWithResponder(
  responder: (req: { verb: string; path: string; body: Record<string, unknown> }) => {
    status: number
    body: unknown
  }
) {
  const gw = new MuseNativeGateway({
    fetch: vi.fn() as unknown as typeof fetch
  })
  const calls: Array<{ verb: string; path: string; body: Record<string, unknown> }> = []
  let nextId = 1n

  vi.spyOn(gw, 'connect').mockResolvedValue(undefined)
  vi.spyOn(gw as unknown as { send: (...args: unknown[]) => bigint }, 'send').mockImplementation(
    (_service: unknown, verb: unknown, path: unknown, bodyBytes: unknown) => {
      const id = nextId++
      const text = bodyBytes instanceof Uint8Array && bodyBytes.length ? new TextDecoder().decode(bodyBytes) : '{}'
      const parsedBody = JSON.parse(text) as Record<string, unknown>
      const req = { verb: String(verb), path: String(path), body: parsedBody }
      calls.push(req)
      const res = responder(req)
      queueMicrotask(() => {
        const streams = (gw as unknown as { streams: Map<bigint, { resolveUnary?: (v: unknown) => void; timer?: ReturnType<typeof setTimeout> }> }).streams
        const st = streams.get(id)
        if (!st) return
        streams.delete(id)
        if (st.timer) clearTimeout(st.timer)
        st.resolveUnary?.({
          status: res.status,
          body: new TextEncoder().encode(typeof res.body === 'string' ? res.body : JSON.stringify(res.body))
        })
      })
      return id
    }
  )

  return { gw, calls }
}

describe('Muse session.* method registry & path/body self-healing', () => {
  it('routes all session.* mutations and session.start to /api/session/*', () => {
    expect(MUSE_METHODS['session.start']).toEqual({ httpMethod: 'POST', path: '/api/session/start' })
    expect(MUSE_METHODS['session.archive']).toEqual({ httpMethod: 'POST', path: '/api/session/archive' })
    expect(MUSE_METHODS['session.unarchive']).toEqual({ httpMethod: 'POST', path: '/api/session/unarchive' })
    expect(MUSE_METHODS['session.pin']).toEqual({ httpMethod: 'POST', path: '/api/session/pin' })
    expect(MUSE_METHODS['session.unpin']).toEqual({ httpMethod: 'POST', path: '/api/session/unpin' })
    expect(MUSE_METHODS['session.rename']).toEqual({ httpMethod: 'POST', path: '/api/session/rename' })
    expect(MUSE_METHODS['session.delete']).toEqual({ httpMethod: 'POST', path: '/api/session/delete' })
  })

  it('extracts canonical daemon method/path and computes session prefix fallbacks', () => {
    const body = JSON.stringify({
      ok: false,
      error: {
        code: 'invalid_params',
        message: '`method` must be `/api/session/start`'
      }
    })
    expect(extractRequiredMethodPath(body)).toBe('/api/session/start')
    expect(extractRequiredMethodPath('{"message":"`method` must be `//evil.com/x`"}')).toBeNull()
    expect(extractRequiredMethodPath('{"message":"`method` must be `/api/../etc`"}')).toBeNull()
    expect(extractRequiredMethodPath('unrelated error')).toBeNull()

    expect(computeSessionPathFallback('/api/session/start')).toBe('/session/start')
    expect(computeSessionPathFallback('/session/start')).toBe('/api/session/start')
    expect(computeSessionPathFallback('/chat/stream')).toBeNull()
  })

  it('injects and caches required JSON body `method` when /api/session/start returns invalid_params', async () => {
    const { gw, calls } = makeGatewayWithResponder(({ path, body }) => {
      if (path === '/api/session/start' && body['method'] !== '/api/session/start') {
        return {
          status: 400,
          body: {
            ok: false,
            error: { code: 'invalid_params', message: '`method` must be `/api/session/start`' }
          }
        }
      }
      return { status: 200, body: { ok: true, result: { session_id: 'sess_1' } } }
    })

    const first = await gw.request('session.start', {})
    expect(extractStartedSessionId(first)).toBe('sess_1')
    expect(calls).toEqual([
      { verb: 'POST', path: '/api/session/start', body: {} },
      { verb: 'POST', path: '/api/session/start', body: { method: '/api/session/start' } }
    ])

    // Second call uses cached body method directly in 1 round-trip.
    const second = await gw.request('session.start', {})
    expect(extractStartedSessionId(second)).toBe('sess_1')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toEqual({
      verb: 'POST',
      path: '/api/session/start',
      body: { method: '/api/session/start' }
    })
  })

  it('handles 404 /api/session/* -> /session/* fallback AND subsequent 400 body method injection', async () => {
    const { gw, calls } = makeGatewayWithResponder(({ path, body }) => {
      if (path === '/api/session/start') {
        return { status: 404, body: 'Not Found' }
      }
      if (path === '/session/start' && body['method'] !== '/api/session/start') {
        return {
          status: 400,
          body: {
            ok: false,
            error: { code: 'invalid_params', message: '`method` must be `/api/session/start`' }
          }
        }
      }
      return { status: 200, body: { session: { id: 'sess_legacy_route' } } }
    })

    const res = await gw.request('session.start', {})
    expect(extractStartedSessionId(res)).toBe('sess_legacy_route')
    expect(calls).toEqual([
      { verb: 'POST', path: '/api/session/start', body: {} },
      { verb: 'POST', path: '/session/start', body: {} },
      { verb: 'POST', path: '/session/start', body: { method: '/api/session/start' } }
    ])

    // Subsequent call immediately hits cached `/session/start` + `{ method: '/api/session/start' }`.
    const res2 = await gw.request('session.start', {})
    expect(extractStartedSessionId(res2)).toBe('sess_legacy_route')
    expect(calls).toHaveLength(4)
    expect(calls[3]).toEqual({
      verb: 'POST',
      path: '/session/start',
      body: { method: '/api/session/start' }
    })
  })

  it('extracts started session ids from nested result/data/session/thread envelopes', () => {
    expect(extractStartedSessionId({ session_id: 's1' })).toBe('s1')
    expect(extractStartedSessionId({ result: { session: { id: 's2' } } })).toBe('s2')
    expect(extractStartedSessionId({ data: { thread: { thread_id: 's3' } } })).toBe('s3')
    expect(extractStartedSessionId({})).toBeNull()
  })
})
