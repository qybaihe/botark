import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { computeSessionPathFallback, extractRequiredMethodPath, MuseNativeGateway, requiresParamsEnvelope } from './gateway'
import { MUSE_METHODS } from './methods'
import { extractStartedSessionId } from './sessions'
import { CipherState } from './noise'
import { NoiseTransport, type InboundFrame } from './transport'

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

  it('keeps the winning route when both prefixes return a resource 404', async () => {
    const { gw, calls } = makeGatewayWithResponder(({ path, body }) => {
      if (path !== '/session/delete' || body['session_id'] === 'missing') return { status: 404, body: { ok: false } }
      return { status: 200, body: { ok: true } }
    })
    await gw.request('session.delete', { session_id: 'exists' })
    await expect(gw.request('session.delete', { session_id: 'missing' })).rejects.toMatchObject({ status: 404 })
    await gw.request('session.delete', { session_id: 'exists' })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/session/delete', '/session/delete', '/session/delete', '/api/session/delete', '/session/delete'
    ])
  })

  it('does not cache candidates that return an unsuccessful response body', async () => {
    const { gw, calls } = makeGatewayWithResponder(({ body }) => body['method'] === '/api/session/start'
      ? { status: 200, body: { ok: false } }
      : { status: 400, body: { error: '`method` must be `/api/session/start`' } })
    await gw.request('session.start')
    await gw.request('session.start')
    expect(calls.map((call) => call.body)).toEqual([{}, { method: '/api/session/start' }, {}, { method: '/api/session/start' }])
  })

  it('wraps and caches `{ method, params }` envelope when daemon returns `params` is required', async () => {
    expect(requiresParamsEnvelope('{"ok":false,"error":{"code":"invalid_params","message":"`params` is required"}}')).toBe(true)
    expect(requiresParamsEnvelope('unrelated error')).toBe(false)

    const { gw, calls } = makeGatewayWithResponder(({ path, body }) => {
      if (path === '/api/session/start' && body['method'] !== '/api/session/start') {
        return {
          status: 400,
          body: { ok: false, error: { code: 'invalid_params', message: '`method` must be `/api/session/start`' } }
        }
      }
      if (path === '/api/session/start' && (typeof body['params'] !== 'object' || body['params'] === null)) {
        return {
          status: 400,
          body: { ok: false, error: { code: 'invalid_params', message: '`params` is required' } }
        }
      }
      return { status: 200, body: { ok: true, result: { session_id: 'sess_enveloped' } } }
    })

    const first = await gw.request('session.start', {})
    expect(extractStartedSessionId(first)).toBe('sess_enveloped')
    expect(calls).toEqual([
      { verb: 'POST', path: '/api/session/start', body: {} },
      { verb: 'POST', path: '/api/session/start', body: { method: '/api/session/start' } },
      { verb: 'POST', path: '/api/session/start', body: { method: '/api/session/start', params: {} } }
    ])

    // Subsequent call immediately sends `{ method, params }` in 1 round-trip.
    const second = await gw.request('session.start', {})
    expect(extractStartedSessionId(second)).toBe('sess_enveloped')
    expect(calls).toHaveLength(4)
    expect(calls[3]).toEqual({
      verb: 'POST',
      path: '/api/session/start',
      body: { method: '/api/session/start', params: {} }
    })
  })

  it('moves flat request fields into `params` when a mutation requires the `{ method, params }` envelope', async () => {
    const { gw, calls } = makeGatewayWithResponder(({ body }) => {
      if (body['method'] !== '/api/session/rename') {
        return {
          status: 400,
          body: { ok: false, error: { code: 'invalid_params', message: '`method` must be `/api/session/rename`' } }
        }
      }
      if (typeof body['params'] !== 'object' || body['params'] === null) {
        return {
          status: 400,
          body: { ok: false, error: { code: 'invalid_params', message: '`params` is required' } }
        }
      }
      return { status: 200, body: { ok: true } }
    })

    await gw.request('session.rename', { session_id: 's1', title: 'Renamed' })
    expect(calls.at(-1)).toEqual({
      verb: 'POST',
      path: '/api/session/rename',
      body: { method: '/api/session/rename', params: { session_id: 's1', title: 'Renamed' } }
    })
  })
})

function wireGateway(gw: MuseNativeGateway) {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, terminate: vi.fn(), send: vi.fn() })
  const transport = new NoiseTransport(new CipherState(), new CipherState())
  const decrypt = vi.spyOn(transport, 'decrypt')
  const internals = gw as unknown as { ws: typeof ws; transport: NoiseTransport; onMessage: (ws: unknown, data: Buffer, binary: boolean) => void }
  internals.ws = ws
  internals.transport = transport
  gw.phase = 'ready'
  return {
    ws, transport,
    frame: (frame: InboundFrame) => {
      decrypt.mockReturnValueOnce(frame)
      internals.onMessage(ws, Buffer.alloc(0), true)
    }
  }
}

describe('Muse gateway lifecycle and response framing', () => {
  it('aborts credential work on disposal and does not reopen afterward', async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => undefined))
    const gw = new MuseNativeGateway({ fetch, keepAlive: true })
    const first = gw.connect()
    const second = gw.connect()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const signal = fetch.mock.calls[0]?.[1]?.signal
    gw.close()
    expect(signal?.aborted).toBe(true)
    await expect(first).rejects.toMatchObject({ code: 'closed' })
    await expect(second).rejects.toMatchObject({ code: 'closed' })
    await expect(gw.connect()).rejects.toMatchObject({ code: 'closed' })
    expect(gw.phase).toBe('idle')
  })

  it('invalidates pending proxy lookups before rebinding', async () => {
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('lease-vm')
      ? { status: 'assigned', vmId: 'test-instance', gatewayUrl: 'wss://test-instance.metaaivm.com/' }
      : { token: 'test-token', notary_token: 'notary' })))
    let finishLookup!: () => void
    const resolveAgent = vi.fn(() => new Promise<undefined>((resolve) => { finishLookup = () => resolve(undefined) }))
    const gw = new MuseNativeGateway({ fetch, resolveAgent })
    const connect = gw.connect()
    await vi.waitFor(() => expect(resolveAgent).toHaveBeenCalledOnce())
    gw.reconnectWithProxyAgent(undefined)
    await expect(connect).rejects.toMatchObject({ code: 'closed' })
    finishLookup()
    await Promise.resolve()
    expect(gw.phase).toBe('reconnecting')
    gw.close()
  })

  it('validates subscription status before emitting data or accepting the ACK and requests auth refresh', async () => {
    const gw = new MuseNativeGateway({ fetch: vi.fn() })
    const { frame, ws } = wireGateway(gw)
    const onEvent = vi.fn()
    const handle = await gw.subscribe('chat.subscribe', {}, onEvent)
    frame({ kind: 'response', streamId: 1n, status: 401, headers: [], endBody: true,
      body: Buffer.from('{"ok":true}\n{"type":"event","event":"agent.status"}\n') })
    await expect(handle.ack).rejects.toMatchObject({ status: 401 })
    await expect(handle.done).rejects.toMatchObject({ status: 401 })
    expect(onEvent).not.toHaveBeenCalled()
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect((gw as unknown as { forceRefresh: boolean }).forceRefresh).toBe(true)
    gw.close()
  })

  it('keeps the connection and unrelated streams live after an oversized encoded request', async () => {
    const gw = new MuseNativeGateway({ fetch: vi.fn() })
    const { frame, transport } = wireGateway(gw)
    const ongoing = await gw.subscribe('chat.subscribe', {}, vi.fn())
    await expect(gw.subscribe('chat.stream', { text: 'a'.repeat(65489 * 256 - 10) }, vi.fn()))
      .rejects.toMatchObject({ code: 'payload_too_large' })
    expect(transport.isDead()).toBe(false)
    expect(gw.isReady()).toBe(true)
    const next = await gw.subscribe('chat.stream', {}, vi.fn())
    frame({ kind: 'response', streamId: 1n, status: 200, headers: [], endBody: false, body: Buffer.from('{"ok":true}\n') })
    frame({ kind: 'response', streamId: 2n, status: 200, headers: [], endBody: true, body: Buffer.from('{"message_id":"ok"}') })
    await expect(ongoing.ack).resolves.toEqual({ ok: true })
    await expect(next.ack).resolves.toEqual({ message_id: 'ok' })
    gw.close()
  })

  it('terminates a capped binary stream as soon as it exceeds its receive budget', async () => {
    const gw = new MuseNativeGateway({ fetch: vi.fn() })
    const { frame, ws } = wireGateway(gw)
    const request = gw.requestBinary('fs.raw', { path: 'workspace/file.txt' }, 5000, 4)
    await Promise.resolve()
    frame({ kind: 'response', streamId: 1n, status: 200, headers: [], endBody: false, body: Buffer.from('abc') })
    frame({ kind: 'bodyChunk', streamId: 1n, endBody: false, data: Buffer.from('def') })
    const result = await request
    expect(Buffer.from(result.body).toString()).toBe('abcd')
    expect(result.truncated).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(2)
    expect(gw.isReady()).toBe(true)
    gw.close()
  })
})
