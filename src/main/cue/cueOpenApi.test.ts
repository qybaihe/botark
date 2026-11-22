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
})
