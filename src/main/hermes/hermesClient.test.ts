import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  buildHermesUserContent,
  extractInlineDataUrlImages,
  mapApprovalDecisionToHermesChoice,
  mapHermesChoicesToDecisions,
  mapHermesTranscriptMessages,
  probeHermesServer,
  SseParser,
  streamNativeSessionTurn,
  streamOpenAICompatTurn
} from './hermesClient'
import { hermesHandleFromUrl, normalizeHermesBaseUrl, parseDotEnvText } from './hermesStore'

describe('hermesStore helpers', () => {
  it('normalizes Hermes API server URLs and preserves profile prefixes', () => {
    expect(normalizeHermesBaseUrl('127.0.0.1:8642')).toBe('http://127.0.0.1:8642')
    expect(normalizeHermesBaseUrl('http://127.0.0.1:8642/')).toBe('http://127.0.0.1:8642')
    expect(normalizeHermesBaseUrl('http://127.0.0.1:8642/v1')).toBe('http://127.0.0.1:8642')
    expect(normalizeHermesBaseUrl('http://127.0.0.1:8642/v1/chat/completions')).toBe('http://127.0.0.1:8642')
    expect(normalizeHermesBaseUrl('https://hermes.example.com/p/work/')).toBe('https://hermes.example.com/p/work')
    expect(normalizeHermesBaseUrl('https://hermes.example.com/p/work/v1')).toBe('https://hermes.example.com/p/work')
  })

  it('rejects empty or non-http(s) URLs', () => {
    expect(() => normalizeHermesBaseUrl('')).toThrow()
    expect(() => normalizeHermesBaseUrl('file:///etc/passwd')).toThrow()
    expect(() => normalizeHermesBaseUrl('ftp://127.0.0.1:21')).toThrow()
  })

  it('formats compact handles from URL + model', () => {
    expect(hermesHandleFromUrl('http://127.0.0.1:8642', 'hermes-agent')).toBe('127.0.0.1:8642')
    expect(hermesHandleFromUrl('https://box.dev/p/dev', 'nous-coder')).toBe('nous-coder @ box.dev/p/dev')
  })

  it('parses ~/.hermes/.env safely without shell execution', () => {
    const parsed = parseDotEnvText(`
      # comment
      API_SERVER_HOST=0.0.0.0
      export API_SERVER_PORT="9000"
      API_SERVER_KEY='secret-token-123'
      PLAIN=hello # inline comment
    `)
    expect(parsed).toEqual({
      API_SERVER_HOST: '0.0.0.0',
      API_SERVER_PORT: '9000',
      API_SERVER_KEY: 'secret-token-123',
      PLAIN: 'hello'
    })
  })
})

describe('hermesClient protocol helpers', () => {
  it.each([streamNativeSessionTurn, streamOpenAICompatTurn])(
    'reports an accepted turn only after a successful gateway response (%s)',
    async (stream) => {
      const onAccepted = vi.fn()
      const args = {
        accountId: 'fixture', baseUrl: 'http://127.0.0.1:8642', userContent: 'Hello',
        sessionId: 'session', sessionKey: 'fixture', controller: new AbortController(),
        callbacks: { onAccepted, onDelta: vi.fn() }
      }
      await expect(stream({ ...args, fetchImpl: async () => new Response('Rejected', { status: 401 }) }))
        .rejects.toMatchObject({ status: 401 })
      expect(onAccepted).not.toHaveBeenCalled()

      await stream({
        ...args,
        fetchImpl: async () => new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      })
      expect(onAccepted).toHaveBeenCalledTimes(1)
      expect(onAccepted.mock.invocationCallOrder[0]).toBeLessThan(args.callbacks.onDelta.mock.invocationCallOrder[0]!)
    }
  )

  it('builds plain text or multimodal image_url arrays for Hermes', () => {
    expect(buildHermesUserContent('  hello  ')).toBe('hello')
    const multimodal = buildHermesUserContent('inspect this', [
      { name: 'shot.png', mimeType: 'image/png', dataBase64: 'iVBORw0=' },
      { name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }
    ])
    expect(Array.isArray(multimodal)).toBe(true)
    expect(multimodal).toEqual([
      { type: 'text', text: 'inspect this\n\n[Attached files: notes.txt]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0=' } }
    ])
  })

  it('maps BotArk approval decisions to Hermes run approval choices', () => {
    expect(mapApprovalDecisionToHermesChoice('allow_once')).toBe('once')
    expect(mapApprovalDecisionToHermesChoice('allow_session')).toBe('session')
    expect(mapApprovalDecisionToHermesChoice('allow_always')).toBe('always')
    expect(mapApprovalDecisionToHermesChoice('deny')).toBe('deny')
    expect(mapApprovalDecisionToHermesChoice('deny_always')).toBe('deny')
    expect(mapHermesChoicesToDecisions(['once', 'session', 'deny'])).toEqual([
      'allow_once',
      'allow_session',
      'deny'
    ])
  })

  it('extracts inline data:image URLs into media parts', () => {
    const res = extractInlineDataUrlImages('Here is the chart:\n\n![chart](data:image/png;base64,AAAA==)\n\nDone.')
    expect(res.text).toBe('Here is the chart:\n\nDone.')
    expect(res.media).toEqual([
      {
        kind: 'image',
        path: 'data:image/png;base64,AAAA==',
        name: 'chart',
        mimeType: 'image/png'
      }
    ])
  })

  it('parses chunked SSE frames with keepalives and CRLF cleanly', () => {
    const parser = new SseParser()
    const f1 = parser.feed(': keepalive\r\n\r\nevent: assistant.del')
    expect(f1).toEqual([])
    const f2 = parser.feed('ta\r\ndata: {"delta":"Hel"}\r\n\r\nevent: tool.started\ndata: {"tool_name":"terminal"}\n\n')
    expect(f2).toEqual([
      { event: 'assistant.delta', data: '{"delta":"Hel"}' },
      { event: 'tool.started', data: '{"tool_name":"terminal"}' }
    ])
    const f3 = parser.feed('event: done\ndata: {}')
    expect(f3).toEqual([])
    expect(parser.flush()).toEqual([{ event: 'done', data: '{}' }])
  })

  it('maps Hermes session transcript rows including tool calls', () => {
    const msgs = mapHermesTranscriptMessages([
      { id: 1, role: 'user', content: 'check disk', timestamp: 1700000000 },
      {
        id: 2,
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', function: { name: 'terminal', arguments: '{"cmd":"df -h"}' } }],
        timestamp: 1700000001
      },
      { id: 3, role: 'tool', tool_call_id: 'tc_1', tool_name: 'terminal', content: '50% used', timestamp: 1700000002 },
      { id: 4, role: 'assistant', content: 'Disk is 50% full.', timestamp: 1700000003 }
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'check disk' })
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      text: 'Disk is 50% full.',
      tools: [{ id: 'tc_1', name: 'terminal', status: 'completed', summary: '{"cmd":"df -h"}' }]
    })
  })
})

describe('probeHermesServer', () => {
  it('succeeds against healthy authenticated Hermes API server', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization']
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok', platform: 'hermes-agent', version: '0.9.1' }), {
          status: 200
        })
      }
      if (auth !== 'Bearer top-secret') {
        return new Response(JSON.stringify({ error: { message: 'Invalid gateway API key' } }), { status: 401 })
      }
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({ object: 'list', data: [{ id: 'hermes-agent' }, { id: 'coder' }] }),
          { status: 200 }
        )
      }
      if (url.endsWith('/v1/capabilities')) {
        return new Response(
          JSON.stringify({
            platform: 'hermes-agent',
            model: 'hermes-agent',
            auth: { required: true },
            endpoints: { sessions: { method: 'GET', path: '/api/sessions' } }
          }),
          { status: 200 }
        )
      }
      return new Response('not found', { status: 404 })
    }

    const ok = await probeHermesServer({
      baseUrl: 'http://127.0.0.1:8642',
      apiKey: 'top-secret',
      fetchImpl: mockFetch
    })
    expect(ok).toMatchObject({
      reachable: true,
      authenticated: true,
      version: '0.9.1',
      models: ['hermes-agent', 'coder'],
      supportsSessions: true,
      requiresAuth: true
    })

    const badAuth = await probeHermesServer({
      baseUrl: 'http://127.0.0.1:8642',
      apiKey: 'wrong-key',
      fetchImpl: mockFetch
    })
    expect(badAuth.reachable).toBe(true)
    expect(badAuth.authenticated).toBe(false)
    expect(badAuth.requiresAuth).toBe(true)
  })
})

describe('hermesClient live HTTP/SSE streaming', () => {
  it('streams native session SSE events including deltas, tools, approvals and final reply', async () => {
    const server = createServer((req, res) => {
      expect(req.headers['authorization']).toBe('Bearer secret-key')
      expect(req.headers['x-hermes-session-key']).toBe('botark:bot1')
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-Hermes-Session-Id': 'sess_live_1'
      })
      res.write('event: run.started\ndata: {"run_id":"run_123","session_id":"sess_live_1"}\n\n')
      res.write('event: message.started\ndata: {"message":{"id":"m_1","role":"assistant"}}\n\n')
      res.write('event: tool.started\ndata: {"tool_name":"terminal","preview":"ls -la"}\n\n')
      res.write('event: approval.request\ndata: {"run_id":"run_123","request_id":"req_9","command":"rm -rf /tmp/test","choices":["once","deny"]}\n\n')
      res.write('event: tool.completed\ndata: {"tool_name":"terminal","preview":"ok"}\n\n')
      res.write('event: assistant.delta\ndata: {"message_id":"m_1","delta":"Hello "}\n\n')
      res.write('event: assistant.delta\ndata: {"message_id":"m_1","delta":"Hermes!"}\n\n')
      res.write('event: assistant.completed\ndata: {"message_id":"m_1","session_id":"sess_live_1","content":"Hello Hermes!"}\n\n')
      res.write('event: done\ndata: {}\n\n')
      res.end()
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    const deltas: string[] = []
    let sawApprovalTitle = ''
    try {
      const result = await streamNativeSessionTurn({
        accountId: 'acc_test',
        baseUrl: `http://127.0.0.1:${addr.port}`,
        apiKey: 'secret-key',
        sessionId: 'sess_live_1',
        sessionKey: 'botark:bot1',
        userContent: 'say hi',
        controller: new AbortController(),
        fetchImpl: fetch,
        callbacks: {
          onDelta: (d) => deltas.push(d.text),
          onApprovals: (list) => {
            if (list[0]) sawApprovalTitle = list[0].title
          }
        }
      })
      expect(result.messageId).toBe('hermes_m_1')
      expect(result.sessionId).toBe('sess_live_1')
      expect(result.text).toBe('Hello Hermes!')
      expect(result.tools).toEqual([
        { id: 'hermes_tool_1', name: 'terminal', status: 'completed', summary: 'ok' }
      ])
      expect(sawApprovalTitle).toContain('rm -rf /tmp/test')
      expect(deltas[deltas.length - 1]).toBe('Hello Hermes!')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('streams OpenAI-compatible /v1/chat/completions fallback cleanly', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-Hermes-Session-Id': 'sess_oai_1'
      })
      res.write('data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"Hi "}}]}\n\n')
      res.write('data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"from fallback"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    try {
      const result = await streamOpenAICompatTurn({
        accountId: 'acc_test',
        baseUrl: `http://127.0.0.1:${addr.port}`,
        sessionKey: 'botark:bot1',
        userContent: 'hi',
        controller: new AbortController(),
        fetchImpl: fetch,
        callbacks: {
          onDelta: () => undefined
        }
      })
      expect(result.messageId).toBe('hermes_chatcmpl_1')
      expect(result.sessionId).toBe('sess_oai_1')
      expect(result.text).toBe('Hi from fallback')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
