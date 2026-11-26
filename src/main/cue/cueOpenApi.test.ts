import { afterEach, describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./cueAuth', () => ({ cueFetcherForAccount: (accountId: string) =>
  (url: URL, init: RequestInit) => request(accountId, url, init)
}))

import { runCueOpenApi, verifyCueApiKey } from './cueOpenApi'

afterEach(() => request.mockReset())

describe('Cue over the official Manus API', () => {
  it('authenticates each account without a fixed slot or credential cross-over', async () => {
    request.mockImplementation(async (account: string, url: URL, init: RequestInit) => {
      expect(url.origin).toBe('https://api.manus.ai')
      expect(new Headers(init.headers).get('x-manus-api-key')).toBe('fixture-key-' + account)
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      expect(init.redirect).toBe('error')
      return url.pathname === '/v2/user.me'
        ? Response.json({ ok: true, user_id: account, name: 'Test', email: account + '@example.test' })
        : Response.json({ ok: true, data: [{ id: account, task_id: 'task_' + account, nickname: 'Test Cue' }] })
    })
    const accounts = Array.from({ length: 12 }, (_, index) => 'cue-' + index)
    const identities = await Promise.all(accounts.map((id) => verifyCueApiKey(id, 'fixture-key-' + id)))
    expect(identities.map((identity) => identity.accountSlot)).toEqual(accounts)
    const roster = await runCueOpenApi({ accountId: accounts[11]!, op: 'listAgents' }, 'fixture-key-cue-11')
    expect(roster).toMatchObject({ ok: true, data: [{ id: 'agent-default' }, { id: 'cue-11', taskId: 'task_cue-11' }] })
  })

  it('uses the public send endpoint and only returns a reply to the current message', async () => {
    request
      .mockResolvedValueOnce(Response.json({ ok: true, messages: [{ id: 'previous' }] }))
      .mockResolvedValueOnce(Response.json({ ok: true, task_id: 'test-task' }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        messages: [
          { id: 'previous', type: 'assistant_message', assistant_message: { content: 'Old reply' } },
          { id: 'u1', type: 'user_message', user_message: { content: 'Fixture prompt' } },
          { id: 'a1', type: 'assistant_message', assistant_message: { content: 'Fixture reply' } },
          { id: 'done', type: 'status_update', status_update: { agent_status: 'stopped' } }
        ]
      }))
    const sent = await runCueOpenApi({
      accountId: 'cue-fixture', op: 'sendMessage', sessionId: 'test-task', text: 'Fixture prompt'
    }, 'fixture-key')
    expect(sent).toMatchObject({ ok: true, data: { afterMessageId: 'previous', sessionId: 'test-task', awaitReply: true } })
    const [, sendUrl, sendInit] = request.mock.calls[1]!
    expect(sendUrl.pathname).toBe('/v2/task.sendMessage')
    expect(JSON.parse(sendInit.body)).toEqual({ task_id: 'test-task', message: { content: 'Fixture prompt' } })
    const result = await runCueOpenApi({
      accountId: 'cue-fixture', op: 'watchUntilReply', sessionId: 'test-task',
      afterMessageId: 'previous', expectedUserText: 'Fixture prompt'
    }, 'fixture-key')
    expect(result).toEqual({ ok: true, data: { done: true, reply: { id: 'a1', text: 'Fixture reply' } } })
  })

  it('rejects an invalid key before handing back any user identity', async () => {
    request.mockResolvedValueOnce(Response.json({ ok: false }, { status: 401 }))
    await expect(verifyCueApiKey('cue-fixture', 'invalid-fixture')).rejects.toThrow('API Key')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('deduplicates overlapping pages and bounds cursor cycles with one deadline', async () => {
    const echo = { id: 'echo', type: 'user_message', user_message: { content: 'Fixture' } }
    request
      .mockResolvedValueOnce(Response.json({ ok: true, next_cursor: 'a', messages: [echo] }))
      .mockResolvedValueOnce(Response.json({ ok: true, next_cursor: 'b', messages: [echo] }))
      .mockResolvedValueOnce(Response.json({ ok: true, next_cursor: 'a', messages: [] }))
    const result = await runCueOpenApi({
      accountId: 'cue-fixture', op: 'watchUntilReply', sessionId: 'test-task', expectedUserText: 'Fixture'
    }, 'fixture-key')
    expect(result).toEqual({ ok: true, data: { done: false } })
    expect(request.mock.calls.map(([, url]) => url.searchParams.get('cursor'))).toEqual([null, 'a', 'b'])
    expect(new Set(request.mock.calls.map(([, , init]) => init.signal)).size).toBe(1)
  })

  it('sends only Authorization Bearer when asWebToken is true (no x-manus-api-key header conflict)', async () => {
    request.mockResolvedValueOnce(
      Response.json({
        ok: true,
        data: [{ id: 'agent-1', task_id: 'task-1', nickname: 'Web Agent' }]
      })
    )
    const res = await runCueOpenApi(
      { accountId: 'cue-web', op: 'listAgents' },
      'jwt.token.value',
      { asWebToken: true }
    )
    expect(res.ok).toBe(true)
    const [, reqUrl, reqInit] = request.mock.calls[0]!
    expect(reqUrl.pathname).toBe('/v2/agent.list')
    const headers = new Headers(reqInit.headers)
    expect(headers.get('authorization')).toBe('Bearer jwt.token.value')
    expect(headers.has('x-manus-api-key')).toBe(false)
    expect(headers.has('x-api-key')).toBe(false)
  })

  it('fetches paginated task history with tools and media in OpenAPI mode', async () => {
    request
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          next_cursor: 'p2',
          messages: [
            { id: 'u1', type: 'user_message', created_at: 1700000001, user_message: { content: '画个图表' } },
            { id: 't1', type: 'tool_call', tool_call: { name: 'python', title: '生成柱状图' } }
          ]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          messages: [
            {
              id: 'a1',
              type: 'assistant_message',
              created_at: 1700000005,
              assistant_message: {
                content: '图已生成',
                attachments: [{ id: 'f1', url: 'https://files.manuscdn.com/bar.png', filename: 'bar.png', mime_type: 'image/png' }]
              }
            }
          ]
        })
      )

    const hist = await runCueOpenApi(
      { accountId: 'cue-hist', op: 'getHistory', sessionId: 'task_hist', limit: 50 },
      'fixture-key'
    )
    expect(hist).toEqual({
      ok: true,
      data: {
        sessionId: 'task_hist',
        messages: [
          { id: 'u1', role: 'user', text: '画个图表', createdAtMs: 1700000001000 },
          {
            id: 'a1',
            role: 'bot',
            text: '图已生成',
            createdAtMs: 1700000005000,
            tools: [{ id: 't1', name: 'python', status: 'completed', summary: '生成柱状图' }],
            media: [{ kind: 'image', path: 'https://files.manuscdn.com/bar.png', name: 'bar.png', mimeType: 'image/png', imageId: 'f1' }]
          }
        ]
      }
    })
  })

  it('uploads attachments via file.upload + presigned PUT without leaking API key, and stops tasks via task.stop', async () => {
    request
      .mockResolvedValueOnce(
        Response.json({ ok: true, file_id: 'file_99', upload_url: 'https://uploads.manuscdn.com/put/99' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ok: true, messages: [] }))
      .mockResolvedValueOnce(Response.json({ ok: true, task_id: 'task_att' }))
      .mockResolvedValueOnce(Response.json({ ok: true }))

    const sent = await runCueOpenApi(
      {
        accountId: 'cue-att',
        op: 'sendMessage',
        sessionId: 'task_att',
        text: '请总结附件',
        attachments: [{ name: 'doc.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') }]
      },
      'fixture-key'
    )
    expect(sent.ok).toBe(true)
    const [, uploadUrl, uploadInit] = request.mock.calls[0]!
    expect(uploadUrl.pathname).toBe('/v2/file.upload')
    expect(JSON.parse(uploadInit.body)).toMatchObject({ filename: 'doc.txt', content_type: 'text/plain', size: 5 })
    const [, putUrl, putInit] = request.mock.calls[1]!
    expect(putUrl.href).toBe('https://uploads.manuscdn.com/put/99')
    expect(putInit.method).toBe('PUT')
    expect(new Headers(putInit.headers).has('x-manus-api-key')).toBe(false)
    const [, sendUrl, sendInit] = request.mock.calls[3]!
    expect(sendUrl.pathname).toBe('/v2/task.sendMessage')
    expect(JSON.parse(sendInit.body)).toEqual({
      task_id: 'task_att',
      message: { content: '请总结附件' },
      attachments: [{ file_id: 'file_99', filename: 'doc.txt' }]
    })

    const stopped = await runCueOpenApi(
      { accountId: 'cue-att', op: 'stopRun', sessionId: 'task_att' },
      'fixture-key'
    )
    expect(stopped.ok).toBe(true)
    const [, stopUrl, stopInit] = request.mock.calls[4]!
    expect(stopUrl.pathname).toBe('/v2/task.stop')
    expect(JSON.parse(stopInit.body)).toEqual({ task_id: 'task_att' })
  })

  it('emits live activity and stream updates during OpenAPI watchUntilReply polling', async () => {
    const events: unknown[] = []
    request.mockResolvedValueOnce(
      Response.json({
        ok: true,
        messages: [
          { id: 'u1', type: 'user_message', user_message: { content: '进度如何' } },
          { id: 't1', type: 'tool_call', tool_call: { name: 'search', title: '检索资料' } },
          { id: 'a1', type: 'assistant_message', assistant_message: { content: '正在整理结果…' } }
        ]
      })
    )
    const res = await runCueOpenApi(
      { accountId: 'cue-live', op: 'watchUntilReply', sessionId: 'task_live', expectedUserText: '进度如何' },
      'fixture-key',
      { onEvent: (ev) => events.push(ev), requestId: 'req_oa_1' }
    )
    expect(res).toEqual({ ok: true, data: { done: false } })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'activity', busy: true, activityText: '检索资料', requestId: 'req_oa_1' })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'stream',
        messageId: 'a1',
        text: '正在整理结果…',
        done: false,
        requestId: 'req_oa_1'
      })
    )
  })
})
