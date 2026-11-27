import { expect, it, vi } from 'vitest'
import type { GrokConnectClient } from './connectClient'
import { watchUntilReply } from './grokRpc'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { isReady: () => false }
}))

const scope = { accountId: 'account', agentId: 'agent', sessionId: 'session', timeoutMs: 1000 }
const wireScope = { agent_id: scope.agentId, session_id: scope.sessionId }
const rows = (entries: Record<string, unknown>[], overrides: Record<string, unknown> = {}) => ({
  rows: { ...wireScope, replay: true, entries, ...overrides }
})
const user = { entry_id: 'echo', seq: '8', client_nonce: 'nonce', request_id: 'turn', kind: 'message', content: 'Question' }
const reply = (id: string, seq: string, fields: Record<string, unknown> = {}) => ({
  entry_id: id, seq, kind: 'send-message', content: id, ...fields
})

it('waits for a delayed group file link after a Grok progress reply', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const progress = reply('progress', '9', { content: '好的，我来查阅资料，整理后发给大家。' })
  const deliverable = reply('deliverable', '10', {
    content: '[FINAL]\n[报告](https://example.test/report.pdf)'
  })
  const watchTranscripts = async function* (_params: unknown, signal: AbortSignal) {
    yield rows([user, progress])
    yield { agent_state: { ...wireScope, is_running: false } }
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 29_000)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
    if (!signal.aborted) yield rows([deliverable])
  }
  const listTranscriptEntries = async () => ({ entries: [user, progress] })
  const delivered = vi.fn()
  const result = watchUntilReply({ watchTranscripts, listTranscriptEntries } as unknown as GrokConnectClient, {
    ...scope, conversationId: 'room-turn-fixture', afterMessageId: 'nonce', timeoutMs: 90_000, signal: controller.signal
  }).then(delivered, () => undefined)
  try {
    await vi.advanceTimersByTimeAsync(5_000)
    expect(delivered).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(28_000)
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      messages: [
        expect.objectContaining({ messageId: 'grok_progress', text: progress.content }),
        expect.objectContaining({ messageId: 'grok_deliverable', text: deliverable.content })
      ]
    }))
  } finally {
    controller.abort()
    await result
    vi.useRealTimers()
  }
})

it('recovers a completed zero-cursor reply when the replay omits its user anchor', async () => {
  const listTranscriptEntries = vi.fn(async () => ({ entries: [user] }))
  const getSendStatus = vi.fn(async () => ({ echo_entry_id: 'echo' }))
  const watchTranscripts = vi.fn(async function* () {
    yield rows([reply('before', '7'), reply('answer', '9'), reply('another-turn', '10', { request_id: 'other' })])
  })
  const result = await watchUntilReply({ listTranscriptEntries, getSendStatus, watchTranscripts } as unknown as GrokConnectClient, {
    ...scope, afterUpdatedSeq: '0', afterMessageId: 'nonce', timeoutMs: 80
  })
  expect(result.messages.map((entry) => entry.messageId)).toEqual(['grok_answer'])
  expect(getSendStatus).toHaveBeenCalledWith({ agentId: 'agent', sessionId: 'session', messageId: 'nonce' }, expect.any(AbortSignal))
  expect(listTranscriptEntries).toHaveBeenCalledOnce()
})

it('ignores foreign rows, failures and state frames on a per-send watch', async () => {
  const watchTranscripts = vi.fn(async function* (_params: unknown, signal?: AbortSignal) {
    yield { turn_failed: { ...wireScope, session_id: 'foreign', summary: 'foreign session' } }
    yield { turn_failed: { ...wireScope, agent_id: 'foreign', summary: 'foreign agent' } }
    yield { turn_failed: { ...wireScope, message_id: 'another-send', summary: 'foreign send' } }
    yield rows([user, reply('wrong-row', '9')], { session_id: 'foreign' })
    yield rows([user, reply('wrong-entry', '9', { agent_id: 'foreign' }), reply('answer', '10')])
    yield { turn_failed: { ...wireScope, message_id: 'nonce', code: 'REFUSED', summary: 'actual failure' } }
    expect(signal?.aborted).toBe(false)
  })
  const result = await watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, { ...scope, afterMessageId: 'nonce' })
  expect(result.turnFailed).toEqual({ code: 'REFUSED', summary: 'actual failure' })
  expect(result.messages.map((entry) => entry.messageId)).toEqual(['grok_answer'])
  expect(watchTranscripts.mock.calls[0]?.[0]).toMatchObject({ includeUnlistedAgents: false })
  expect(watchTranscripts.mock.calls[0]?.[1]?.aborted).toBe(true)
})

it('returns a matching turn failure with an empty messages array', async () => {
  const watchTranscripts = async function* () {
    yield { turnFailed: { agentId: 'agent', sessionId: 'session', code: 'LIMIT', summary: 'quota' } }
  }
  await expect(watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, scope)).resolves.toMatchObject({
    messages: [], turnFailed: { code: 'LIMIT', summary: 'quota' }
  })
})

it('uses row order for zero-sequence replies when the exact anchor and assistant arrive together', async () => {
  const watchTranscripts = async function* () {
    yield rows([
      reply('previous', '0', { timestampMs: 100 }),
      { ...user, seq: '0', timestampMs: 101 },
      reply('answer', '0', { timestampMs: 101 })
    ])
  }
  const result = await watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, {
    ...scope, afterMessageId: 'nonce', timeoutMs: 60
  })
  expect(result.messages.map((entry) => entry.messageId)).toEqual(['grok_answer'])
})

it('stops the stream and rejects on renderer cancellation', async () => {
  const controller = new AbortController()
  const watchTranscripts = vi.fn(async function* (_params: unknown, signal?: AbortSignal) {
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
    yield rows([user, reply('too-late', '9')])
  })
  const watched = watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, { ...scope, signal: controller.signal })
  const rejected = expect(watched).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledOnce())
  controller.abort()
  await rejected
  expect(watchTranscripts.mock.calls[0]?.[1]?.aborted).toBe(true)
})

it.each(['direct-grok', 'room-turn-grok'])('recovers the current reply on a silent stream for %s', async (conversationId) => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const watchTranscripts = vi.fn(async function* (_params: unknown, signal: AbortSignal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  const listTranscriptEntries = vi.fn(async () => ({
    entries: [
      reply('older-reply', '7'),
      user,
      reply('answer', '9'),
      { ...user, entry_id: 'another-question', seq: '10', client_nonce: 'different', request_id: 'different' },
      reply('answer-to-another-question', '11')
    ]
  }))
  const delivered = vi.fn()
  const result = watchUntilReply({ watchTranscripts, listTranscriptEntries } as unknown as GrokConnectClient, {
    ...scope, conversationId, afterUpdatedSeq: '7', afterMessageId: 'nonce', timeoutMs: 60_000, signal: controller.signal
  }).then(delivered, () => undefined)
  try {
    await vi.advanceTimersByTimeAsync(8_000)
    expect(listTranscriptEntries).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent', sessionId: 'session', limit: 40 }), expect.any(AbortSignal)
    )
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      text: 'answer', messages: [expect.objectContaining({ messageId: 'grok_answer' })]
    }))
  } finally {
    controller.abort()
    await result
    vi.useRealTimers()
  }
})

it.each(['prompt', 'reply'])('uses history order when a zero-sequence %s was seen first', async (first) => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const started = Date.now()
  const currentPrompt = { ...user, seq: '0', timestampMs: 101 }
  const answer = reply('answer', '0', { timestampMs: 101 })
  const olderPrompt = { ...currentPrompt, entry_id: 'earlier', client_nonce: 'earlier-nonce', request_id: 'earlier-turn' }
  const watchTranscripts = async function* (_params: unknown, signal: AbortSignal) {
    yield rows([first === 'prompt' ? currentPrompt : answer])
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
  }
  const listTranscriptEntries = async () => Date.now() - started < 4_000
    ? { entries: [], hasMore: false }
    : { entries: [olderPrompt, reply('old', '0', { timestampMs: 101 }), currentPrompt, answer] }
  const delivered = vi.fn()
  const result = watchUntilReply({ watchTranscripts, listTranscriptEntries } as unknown as GrokConnectClient, {
    ...scope, afterMessageId: 'nonce', timeoutMs: 60_000, signal: controller.signal
  }).then(delivered, () => undefined)
  try {
    await vi.advanceTimersByTimeAsync(8_000)
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      messages: [expect.objectContaining({ messageId: 'grok_answer' })]
    }))
  } finally {
    controller.abort()
    await result
    vi.useRealTimers()
  }
})

it('keeps receiving live replies while a history request is slow', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const watchTranscripts = async function* (_params: unknown, signal: AbortSignal) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    if (!signal.aborted) yield rows([user, reply('live-reply', '9')])
  }
  const listTranscriptEntries = vi.fn(async (_req: unknown, signal: AbortSignal) => {
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    return { entries: [] }
  })
  const delivered = vi.fn()
  const result = watchUntilReply({ watchTranscripts, listTranscriptEntries } as unknown as GrokConnectClient, {
    ...scope, afterMessageId: 'nonce', timeoutMs: 60_000, signal: controller.signal
  }).then(delivered, () => undefined)
  try {
    await vi.advanceTimersByTimeAsync(8_000)
    expect(listTranscriptEntries).toHaveBeenCalledOnce()
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'live-reply' }))
  } finally {
    controller.abort()
    await result
    vi.useRealTimers()
  }
})

it('checks the next prompt across history pages before assigning an unidentified reply', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const watchTranscripts = async function* (_params: unknown, signal: AbortSignal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  const getSendStatus = async () => ({ echo_entry_id: 'echo' })
  const listTranscriptEntries = vi.fn(async ({ beforeSeq }: { beforeSeq?: string }) => beforeSeq
    ? { entries: [user, { ...user, entry_id: 'another-question', seq: '9', client_nonce: 'different', request_id: 'different' }], hasMore: false }
    : { entries: [reply('another-answers', '49')], nextBeforeSeq: '10' })
  const delivered = vi.fn()
  const result = watchUntilReply({ watchTranscripts, listTranscriptEntries, getSendStatus } as unknown as GrokConnectClient, {
    ...scope, afterUpdatedSeq: '7', afterMessageId: 'nonce', timeoutMs: 8_500, signal: controller.signal
  }).then(delivered, () => undefined)
  try {
    await vi.advanceTimersByTimeAsync(9_000)
    expect(listTranscriptEntries).toHaveBeenCalledWith(expect.objectContaining({ beforeSeq: '10' }), expect.any(AbortSignal))
    expect(delivered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messages: [] }))
  } finally {
    controller.abort()
    await result
    vi.useRealTimers()
  }
})
