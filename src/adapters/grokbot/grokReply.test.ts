import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractReplyText, GrokBotAdapter } from './GrokBotAdapter'
import type { GrokRequest } from './grokRequests'

const page = (...entries: Array<Record<string, unknown>>) => ({ entries })

describe('extractReplyText', () => {
  it('returns the answer that follows the sent message', () => {
    const p = page(
      { id: 'u1', role: 'user', text: 'old q' },
      { id: 'a1', role: 'assistant', text: 'old answer' },
      { id: 'u2', role: 'user', text: 'new q' },
      { id: 'a2', role: 'assistant', text: 'new answer' }
    )
    expect(extractReplyText(p, 'u2')).toBe('new answer')
  })

  it('does not return the previous answer while the new one is pending', () => {
    const p = page(
      { id: 'a1', role: 'assistant', text: 'old answer' },
      { id: 'u2', role: 'user', text: 'new q' }
    )
    expect(extractReplyText(p, 'u2')).toBe('')
  })

  it('needs the sent message on the page', () => {
    expect(extractReplyText(page({ id: 'a1', role: 'assistant', text: 'old answer' }), 'u2')).toBe('')
  })

  it('does not attach an unlabelled reply after a later user prompt to an earlier turn', () => {
    const p = page(
      { id: 'u1', role: 'user', text: 'room prompt' },
      { id: 'u2', role: 'user', text: 'direct prompt' },
      { id: 'a2', role: 'assistant', text: 'direct reply' }
    )
    expect(extractReplyText(p, 'u1')).toBe('')
    expect(extractReplyText(p, 'u2')).toBe('direct reply')
  })

  it('without an anchor returns the newest assistant text', () => {
    expect(extractReplyText(page({ id: 'a1', role: 'assistant', text: 'hi' }))).toBe('hi')
  })

  it('never echoes user prompts, unknown senders, or an assistant from a different identified turn', () => {
    const p = page(
      { id: 'question', kind: 'message', client_nonce: 'nonce', request_id: 'turn-1', text: 'Current prompt' },
      { id: 'newer-echo', kind: 'send-message', sender: { type: 'user' }, text: 'Another prompt' },
      { id: 'unknown', text: 'Unknown' },
      { id: 'other', kind: 'send-message', request_id: 'turn-2', text: 'Other reply' }
    )
    expect(extractReplyText(p, 'nonce')).toBe('')
  })

  it('prefers chronological normalized rows and the user client nonce', () => {
    expect(extractReplyText({
      entries: [{ role: 'assistant', id: 'raw', text: 'stale raw reply' }],
      hydrated: [
        { id: 'echo', role: 'user', clientNonce: 'nonce', text: 'question' },
        { id: 'grok_answer', role: 'bot', text: 'normalized answer' },
        { id: 'grok_partial', role: 'bot', text: 'unfinished', isStreaming: true }
      ]
    }, 'nonce')).toBe('normalized answer')
  })
})

afterEach(() => vi.unstubAllGlobals())

const message = { accountId: 'grok-test', conversationId: 'room-turn-grok-fixture', agentId: 'agent', sessionId: 'session', text: 'my prompt' }

function setupGrok(rpc: (request: GrokRequest) => Promise<unknown>) {
  vi.stubGlobal('window', { electron: { grok: { onEvent: () => () => undefined, rpc } } })
  const adapter = new GrokBotAdapter()
  adapter.setAuth({ accountId: message.accountId, signedIn: true })
  return adapter
}

it('falls back to normalized assistant entries after the exact sent-message anchor', async () => {
  let sentId: string | undefined
  const rpc = vi.fn(async (req: GrokRequest) => {
    if (req.op === 'listAgents') return { ok: true, data: { agents: [{ id: 'agent' }] } }
    if (req.op === 'sendUserMessage') sentId = req.messageId
    if (req.op === 'watchUntilReply') return { ok: true, data: { messages: [] } }
    if (req.op === 'listTranscriptEntries' && !req.watermarkOnly) return { ok: true, data: {
      entries: [{ id: 'wrong', kind: 'message', text: 'echo' }],
      hydrated: [
        { id: 'older-answer', role: 'bot', text: 'stale' },
        { id: 'user-entry', clientNonce: sentId, role: 'user', text: message.text },
        { id: 'grok_answer', role: 'bot', text: 'right answer' },
        { id: 'later-echo', role: 'user', text: 'unrelated prompt' }
      ]
    } }
    return { ok: true, data: {} }
  })
  const adapter = setupGrok(rpc)
  const received = vi.fn()
  adapter.onMessage(received)
  await expect(adapter.sendMessage(message)).resolves.not.toHaveProperty('noReply')
  expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'grok_answer', text: 'right answer' }))
})

it('surfaces turnFailed without polling when messages is empty', async () => {
  const rpc = vi.fn(async (req: GrokRequest) => ({ ok: true, data: req.op === 'watchUntilReply'
    ? { messages: [], text: '', turnFailed: { code: 'RATE_LIMIT', summary: 'Quota exceeded' } }
    : {} }))
  const adapter = setupGrok(rpc)
  const accepted = vi.fn()
  await expect(adapter.sendMessage({ ...message, onAccepted: accepted })).rejects.toMatchObject({ code: 'no-reply', message: 'Quota exceeded' })
  expect(accepted).toHaveBeenCalledOnce()
  expect(rpc.mock.calls.filter(([req]) => req.op === 'listTranscriptEntries')).toHaveLength(1)
})

it.each(['sendUserMessage', 'watchUntilReply'] as const)('propagates Stop to the main process during %s', async (stage) => {
  const controller = new AbortController()
  const rpc = vi.fn(async (req: GrokRequest) => {
    if (req.op === stage) return new Promise(() => undefined)
    return { ok: true, data: {} }
  })
  const adapter = setupGrok(rpc)
  const sending = adapter.sendMessage({ ...message, signal: controller.signal })
  const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(rpc.mock.calls.at(-1)?.[0].op).toBe(stage))
  const requestId = rpc.mock.calls.at(-1)?.[0].requestId
  controller.abort()
  await rejected
  expect(requestId).toEqual(expect.any(String))
  expect(rpc.mock.calls.at(-1)?.[0]).toEqual({ accountId: message.accountId, op: 'cancelRequest', requestId })
})
