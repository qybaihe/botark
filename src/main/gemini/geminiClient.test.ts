import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeminiEvent } from '@shared/gemini'
import { proxyFetch } from '../proxyTransport'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import * as store from './geminiStore'
import { stopRun, streamChat, verifyAndListModels } from './geminiClient'

let dir: string
const secrets = new Map<string, string>()
vi.mock('electron', () => ({ app: { getPath: () => dir } }))
vi.mock('../securityVault', () => ({
  getVaultSecret: (k: string) => secrets.get(k), setVaultSecret: (k: string, v: string) => secrets.set(k, v),
  listVaultKeys: () => [...secrets.keys()]
}))
vi.mock('../muse/accountProxy', () => ({ loadAccountProxyUrl: vi.fn(async () => 'http://proxy.test') }))
vi.mock('../proxyTransport', () => ({ proxyFetch: vi.fn() }))
const fetch = vi.mocked(proxyFetch)
const req = { accountId: 'a', requestId: 'r', conversationId: 'chat', text: 'question' }
const events: GeminiEvent[] = []
const emit = (event: GeminiEvent) => { events.push(event) }
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\r\n\r\n'
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-stream-'))
  fetch.mockReset()
  events.length = 0
  await store.configure('a', { apiKey: 'secret', systemInstruction: 'brief', temperature: 0, showThinking: true, enableSearchGrounding: true })
})
afterEach(() => { store.closeHistory(); secrets.clear(); rmSync(dir, { recursive: true, force: true }) })
describe('model discovery', () => {
  it('uses the account proxy, key header, pagination and capability filter', async () => {
    fetch.mockResolvedValueOnce(Response.json({ models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/chat', displayName: 'Chat', thinking: true, supportedGenerationMethods: ['generateContent'] }] }))
    expect(await verifyAndListModels('a', { baseUrl: 'https://gateway.test/v1beta/', apiKey: 'draft' }))
      .toEqual([{ id: 'chat', label: 'Chat', thinking: true }])
    expect(loadAccountProxyUrl).toHaveBeenCalledWith('a')
    expect(fetch.mock.calls[0]).toMatchObject(['http://proxy.test', expect.stringContaining('https://gateway.test/v1beta/models?'),
      { headers: expect.objectContaining({ 'x-goog-api-key': 'draft' }), redirect: 'error' }])
    expect(fetch.mock.calls[1][1]).toContain('pageToken=next')
    expect((await store.credentials('a'))?.apiKey).toBe('secret')
  })
  it('falls back only for missing capability metadata', async () => {
    fetch.mockResolvedValueOnce(Response.json({ models: [{ name: 'models/unknown' }] }))
    expect(await verifyAndListModels('a')).toEqual(store.fallbackModels)
    fetch.mockResolvedValueOnce(Response.json({ models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }))
    await expect(verifyAndListModels('a')).rejects.toThrow('generateContent')
  })
})
it('decodes fragmented UTF-8 SSE, thinking, grounding and usage; replays signed multimodal content', async () => {
  const raw = ': keepalive\r\n\r\n' +
    frame({ candidates: [{ content: { parts: [{ text: 'summary', thought: true, thoughtSignature: 'sig' }] } }] }) +
    frame({ candidates: [{ content: { parts: [{ text: '你好' }] } }] }) +
    frame({ candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP', groundingMetadata: {
      searchEntryPoint: { renderedContent: '<div>Search suggestions</div>' },
      groundingChunks: [{ web: { uri: 'https://source.test/page', title: 'Source' } }],
      groundingSupports: [{ segment: { text: '你好', endIndex: 6 }, groundingChunkIndices: [0] }]
    } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } })
  fetch.mockResolvedValueOnce(new Response(new ReadableStream({
    start(ctrl) { for (const byte of new TextEncoder().encode(raw)) ctrl.enqueue(Uint8Array.of(byte)); ctrl.close() }
  })))
  const attachments = ['image/png', 'application/pdf', 'audio/wav', 'text/plain'].map((mimeType, i) =>
    ({ id: String(i), name: 'file', size: 1, mimeType, dataBase64: 'YQ==' }))
  const { sessionId, message } = await streamChat({ ...req, attachments }, emit)
  expect(events[0].type).toBe('accepted')
  expect(events).toContainEqual(expect.objectContaining({ type: 'progress', thought: 'summary', text: '你好' }))
  expect(message.text).toContain('你好 [1](https://source.test/page)!')
  expect(message.richWidgets).toMatchObject([{ kind: 'google_search', html: '<div>Search suggestions</div>' }])
  expect(message.usage?.totalTokenCount).toBe(5)
  const [, url, init] = fetch.mock.calls[0]
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  const body = JSON.parse(String(init?.body))
  expect(body).toMatchObject({ systemInstruction: { parts: [{ text: 'brief' }] }, tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, thinkingConfig: { includeThoughts: true } } })
  expect(body.contents[0].parts.slice(1)).toEqual(attachments.map(({ mimeType }) => ({ inlineData: { mimeType, data: 'YQ==' } })))
  expect(store.getHistory('a', sessionId)[0].attachments?.[0]).not.toHaveProperty('dataBase64')
  fetch.mockResolvedValueOnce(new Response(frame({ candidates: [{ content: { parts: [{ text: 'next' }] }, finishReason: 'STOP' }] })))
  await streamChat({ ...req, requestId: 'next', sessionId }, emit)
  const contents = JSON.parse(String(fetch.mock.calls[1][2]?.body)).contents
  expect(contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user'])
  expect(contents[0]).toEqual(body.contents[0])
  expect(contents[1].parts[0].thoughtSignature).toBe('sig')
  expect(contents[1].parts.at(-1).text).toBe('!')
})
it.each([401, 403, 429])('propagates HTTP %s without echoing upstream secrets or accepting the turn', async (status) => {
  fetch.mockImplementation(async () => new Response('secret echoed', { status }))
  for (const operation of [() => verifyAndListModels('a'), () => streamChat(req, emit)]) {
    await expect(operation()).rejects.toThrow(new RegExp('^Gemini HTTP ' + status + '$'))
  }
  expect(events).toEqual([])
  expect(store.listSessions('a')).toEqual([])
})
it('cancels the exact upstream request and discards incomplete history', async () => {
  const cancel = vi.fn()
  fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })))
  const result = streamChat(req, emit)
  await vi.waitFor(() => expect(events).toHaveLength(1))
  const signal = fetch.mock.calls[0][2]!.signal!
  stopRun('other', { requestId: 'r' })
  stopRun('a', { conversationId: 'other' })
  expect(signal.aborted).toBe(false)
  stopRun('a', { requestId: 'r' })
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(signal.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(store.listSessions('a')).toEqual([])
})
it('rejects malformed and prematurely closed streams and preserves existing history', async () => {
  const { id } = store.createSession('a')
  for (const wire of ['data: invalid\n\n', frame({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })]) {
    fetch.mockResolvedValueOnce(new Response(wire))
    await expect(streamChat({ ...req, sessionId: id }, emit)).rejects.toThrow()
    expect(store.getHistory('a', id)).toEqual([])
  }
})

it('stopping a room turn leaves a simultaneous private session running', async () => {
  const privateSession = store.createSession('a').id
  const roomSession = store.createSession('a').id
  let finish!: () => void
  fetch.mockImplementation(async (_proxy, _url, init) => {
    const room = String(init?.body).includes('room prompt')
    return new Response(new ReadableStream({
      start(stream) {
        if (!room) finish = () => {
          stream.enqueue(new TextEncoder().encode(frame({ candidates: [{ content: { parts: [{ text: 'private answer' }] },
            finishReason: 'STOP' }] })))
          stream.close()
        }
      }
    }))
  })
  const privateRun = streamChat({ ...req, sessionId: privateSession }, emit)
  const roomRun = streamChat({ ...req, sessionId: roomSession, conversationId: 'room-turn-x', requestId: 'room',
    text: 'room prompt' }, emit)
  await vi.waitFor(() => expect(events.filter((e) => e.type === 'accepted')).toHaveLength(2))
  await expect(streamChat({ ...req, sessionId: privateSession, requestId: 'duplicate' }, emit)).rejects.toThrow('会话')
  stopRun('a', { conversationId: 'room-turn-x', sessionId: roomSession })
  await expect(roomRun).rejects.toMatchObject({ name: 'AbortError' })
  finish()
  expect((await privateRun).message.text).toBe('private answer')
  expect(store.getHistory('a', roomSession)).toEqual([])
  expect(store.getHistory('a', privateSession)).toHaveLength(2)
})
