import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GeminiChatRequest, GeminiEvent } from '@shared/gemini'
import type { AdapterEvent } from '../types'
import { GeminiAdapter } from './adapter'

const listeners = new Set<(event: GeminiEvent) => void>()
const api = {
  listAccounts: vi.fn(async () => ['a']), config: vi.fn(async () => ({ model: 'gemini-2.5-flash' })),
  verifyAndListModels: vi.fn(async () => []), getHistory: vi.fn(async () => []),
  onEvent: (fn: (event: GeminiEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
  streamChat: vi.fn(), cancelChat: vi.fn(async () => {})
}
const send = { accountId: 'a', conversationId: 'room-turn-1', text: 'hello' }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', { electron: { gemini: api } }) })
afterEach(() => { vi.unstubAllGlobals(); listeners.clear() })
it('connects, exposes history and delivers progressive and final room replies with one acceptance', async () => {
  const adapter = new GeminiAdapter()
  expect(await adapter.connect('a')).toBe('online')
  expect(await adapter.listAccounts()).toMatchObject([{ platformId: 'gemini', id: 'a' }])
  await adapter.getHistory('a', 's')
  expect(api.getHistory).toHaveBeenCalledWith('a', 's')
  const events: AdapterEvent[] = []
  adapter.subscribe((e) => events.push(e))
  api.streamChat.mockImplementationOnce(async (req: GeminiChatRequest) => {
    const ids = { accountId: 'a', requestId: req.requestId, sessionId: 's' }
    for (const fn of listeners) {
      fn({ ...ids, requestId: 'other', type: 'progress', text: 'wrong' })
      fn({ ...ids, type: 'accepted' })
      fn({ ...ids, type: 'progress', text: 'hello', thought: 'summary' })
    }
    return { sessionId: 's', message: { id: req.requestId, text: 'hello!', thought: 'summary', createdAt: 10 } }
  })
  const onAccepted = vi.fn()
  const receipt = await adapter.sendMessage({ ...send, onAccepted })
  expect(receipt.sessionId).toBe('s')
  expect(onAccepted).toHaveBeenCalledOnce()
  expect(events.filter((e) => e.type === 'message_delta')).toEqual([expect.objectContaining({
    conversationId: 'room-turn-1', text: 'hello', tools: [expect.objectContaining({ summary: 'summary', status: 'running' })]
  })])
  expect(events).toContainEqual(expect.objectContaining({ type: 'message', message: expect.objectContaining({ text: 'hello!', sessionId: 's' }) }))
  expect(adapter.getStatus('a')).toBe('online')
  expect(listeners.size).toBe(0)
  await adapter.disconnect('a')
  expect(adapter.getStatus('a')).toBe('offline')
})
it('cancels by request ID and never starts a pre-aborted send', async () => {
  const adapter = new GeminiAdapter()
  const controller = new AbortController()
  let reject!: (error: Error) => void
  api.streamChat.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const run = adapter.sendMessage({ ...send, signal: controller.signal })
  controller.abort()
  expect(api.cancelChat).toHaveBeenCalledWith('a', { requestId: api.streamChat.mock.lastCall![0].requestId })
  reject(new Error('IPC aborted'))
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  await expect(adapter.sendMessage({ ...send, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.streamChat).toHaveBeenCalledOnce()
  expect(listeners.size).toBe(0)
})
it.each([[401, 'error'], [403, 'error'], [429, 'online']])('reports HTTP %s with account status %s', async (code, status) => {
  const adapter = new GeminiAdapter()
  api.streamChat.mockRejectedValueOnce(new Error('Gemini HTTP ' + code))
  const onAccepted = vi.fn()
  await expect(adapter.sendMessage({ ...send, onAccepted })).rejects.toThrow(String(code))
  expect(onAccepted).not.toHaveBeenCalled()
  expect(adapter.getStatus('a')).toBe(status)
})
it('preserves delivery acknowledgement when a stream fails after acceptance', async () => {
  const adapter = new GeminiAdapter()
  api.streamChat.mockImplementationOnce(async (req: GeminiChatRequest) => {
    for (const fn of listeners) fn({ type: 'accepted', accountId: 'a', requestId: req.requestId, sessionId: 's' })
    throw new Error('stream ended early')
  })
  await expect(adapter.sendMessage(send)).rejects.toMatchObject({ code: 'no-reply' })
})
