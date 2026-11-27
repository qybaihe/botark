import { describe, expect, it, vi } from 'vitest'
import {
  createCursorChecksum,
  GrokConnectClient,
  GROK_SAND_CLIENT_VERSION,
  GROK_SERVICES,
  GROK_USER_MESSAGE_INITIATOR,
  sandUserAgent
} from './connectClient'

function encodeConnectFrame(flag: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(5)
  header[0] = flag
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

describe('GrokConnectClient (Sand 0.79.3 wire protocol)', () => {
  it('builds authentic Sand/0.79.3 User-Agent without fake Chrome/Electron suffixes', () => {
    const ua = sandUserAgent('darwin', '0.79.3')
    expect(ua).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.79.3 Safari/537.36'
    )
    expect(ua).not.toContain('Chrome/')
    expect(ua).not.toContain('Electron/')
  })

  it('generates valid x-cursor-checksum prefixed with obfuscated 6-byte timestamp', () => {
    const machineId = '8b1d4567-e89b-12d3-a456-426614174000'
    const checksum = createCursorChecksum(machineId, 1_762_000_000_000)
    expect(checksum.endsWith(machineId)).toBe(true)
    expect(checksum.slice(0, checksum.length - machineId.length)).toHaveLength(8)
  })

  it('sends Sand 0.79.3 headers, x-sand-box-namespace: prod, and valid SendGrokBotUserMessage enum', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({ dispatched: true, delivery: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })

    const client = new GrokConnectClient({
      fetchImpl: mockFetch as unknown as typeof fetch,
      auth: {
        accessToken: 'tok_redacted_test',
        machineId: 'machine-uuid-1',
        teamId: 'team-42'
      }
    })

    const res = await client.sendUserMessage({
      agentId: 'agent-1',
      messageId: 'msg-1',
      text: 'Hello Grok',
      sentAtMs: 1_762_000_000_000,
      attachmentPaths: ['att://alias-1']
    })

    expect(res['dispatched']).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      'https://api2.cursor.sh/aiserver.v1.GrokBotService/SendGrokBotUserMessage'
    )

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer tok_redacted_test')
    expect(headers['x-cursor-client-type']).toBe('sand')
    expect(headers['x-cursor-client-version']).toBe(GROK_SAND_CLIENT_VERSION)
    expect(headers['x-sand-box-namespace']).toBe('prod')
    expect(headers['x-cursor-team-id']).toBe('team-42')
    expect(headers['sec-fetch-site']).toBeUndefined()

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body['initiator']).toBe(GROK_USER_MESSAGE_INITIATOR.USER)
    expect(body['initiator']).not.toBe('composer')
    expect(body['attachment_paths']).toEqual(['att://alias-1'])
    expect(body['renders_mcp_elicitation_forms']).toBe(true)
    expect(body).not.toHaveProperty('rendered_card_kinds')
  })

  it('routes SandBoxService and AgentStoreService calls to their respective service paths', async () => {
    const urls: string[] = []
    const client = new GrokConnectClient({
      fetchImpl: (async (input: string | URL | Request) => {
        urls.push(String(input))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as typeof fetch,
      auth: { accessToken: 'tok_redacted_test', machineId: 'machine-1' }
    })

    await client.unary('GetSandBoxRunState', {}, 'sandbox')
    await client.unary(
      'ReadAgentStoreFile',
      { store_id: 's1', relative_path: 'doc.md' },
      'agentstore'
    )

    expect(urls).toEqual([
      `https://api2.cursor.sh/${GROK_SERVICES.sandbox}/GetSandBoxRunState`,
      `https://api2.cursor.sh/${GROK_SERVICES.agentstore}/ReadAgentStoreFile`
    ])
  })

  it('completes 3-step SINGLE_PUT attachment upload and returns attachment alias', async () => {
    const methods: string[] = []
    const client = new GrokConnectClient({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        methods.push(method)
        if (url.endsWith('/BeginGrokBotAttachmentUpload')) {
          return new Response(
            JSON.stringify({
              mode: 2,
              uploadToken: 'up_tok_1',
              put: {
                url: 'https://storage.cursor.sh/put-part-1',
                headers: { 'x-amz-acl': 'private' }
              }
            }),
            { status: 200 }
          )
        }
        if (url === 'https://storage.cursor.sh/put-part-1') {
          return new Response('', { status: 200, headers: { etag: '"etag-part-1"' } })
        }
        if (url.endsWith('/CompleteGrokBotAttachmentUpload')) {
          return new Response(
            JSON.stringify({
              alias: 'store://agent-1/uploads/diagram.png',
              fileName: 'diagram.png',
              sizeBytes: 4,
              contentType: 'image/png'
            }),
            { status: 200 }
          )
        }
        throw new Error(`Unexpected URL ${url}`)
      }) as typeof fetch,
      auth: { accessToken: 'tok_redacted_test', machineId: 'machine-1' }
    })

    const out = await client.uploadAttachment({
      agentId: 'agent-1',
      fileName: 'diagram.png',
      mimeType: 'image/png',
      bytes: Buffer.from([137, 80, 78, 71])
    })

    expect(out.alias).toBe('store://agent-1/uploads/diagram.png')
    expect(methods).toEqual(['POST', 'PUT', 'POST'])
  })

  it('streams Connect length-prefixed frames in watchTranscripts until end-of-stream', async () => {
    const f1 = encodeConnectFrame(0x00, {
      agentState: { agentId: 'agent-1', isRunning: true }
    })
    const f2 = encodeConnectFrame(0x00, {
      rows: {
        agentId: 'agent-1',
        entries: [{ seq: '5', entryKind: 'send-message', entryId: 'tbs0' }]
      }
    })
    const endFrame = encodeConnectFrame(0x02, {})
    const wire = Buffer.concat([f1, f2, endFrame])

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire.subarray(0, 11))
        controller.enqueue(wire.subarray(11))
        controller.close()
      }
    })

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.headers.get('content-type')).toBe('application/connect+json')
      const requestBytes = Buffer.from(await request.arrayBuffer())
      expect(requestBytes).toEqual(encodeConnectFrame(0, {
        cursors: [{ agent_id: 'agent-1', after_updated_seq: '4' }],
        include_unlisted_agents: true,
        inline_body_max_bytes: 262_144
      }))
      return new Response(stream, { status: 200 })
    })
    const client = new GrokConnectClient({
      fetchImpl,
      auth: { accessToken: 'tok_redacted_test', machineId: 'machine-1' }
    })

    const seen: Array<Record<string, unknown>> = []
    for await (const frame of client.watchTranscripts({
      cursors: [{ agent_id: 'agent-1', after_updated_seq: '4' }]
    })) {
      seen.push(frame)
    }

    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ agentState: { agentId: 'agent-1', isRunning: true } })
    expect((seen[1]!['rows'] as Record<string, unknown>)['agentId']).toBe('agent-1')
  })

  it.each(['break', 'trailer', 'abort'])('cancels the unread body before unlocking the reader on %s', async (mode) => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === 'break') controller.enqueue(encodeConnectFrame(0, { ping: {} }))
        if (mode === 'trailer') controller.enqueue(encodeConnectFrame(2, {}))
      },
      cancel
    })
    const client = new GrokConnectClient({ auth: { accessToken: 'fixture' }, fetchImpl: async () => new Response(stream) })
    const controller = new AbortController()
    const frames = client.watchTranscripts({ cursors: [] }, controller.signal)
    if (mode === 'abort') {
      const pending = frames.next()
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(stream.locked).toBe(true))
      controller.abort()
      await rejected
    } else if (mode === 'break') {
      for await (const _frame of frames) break
    } else {
      await expect(frames.next()).resolves.toMatchObject({ done: true })
    }
    expect(cancel).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
  })
})
