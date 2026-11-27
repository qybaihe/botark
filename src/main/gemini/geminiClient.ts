import { randomUUID } from 'node:crypto'
import type {
  GeminiBridge, GeminiChatRequest, GeminiChatResult, GeminiDraft, GeminiEvent, GeminiMessage,
  GeminiModel, GeminiUsage
} from '@shared/gemini'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { proxyFetch } from '../proxyTransport'
import { SseParser } from '../sseParser'
import {
  appendTurn, createSession, deleteSession, credentials, fallbackModels, getContents, resolveDraft,
  type Content, type ContentPart
} from './geminiStore'

type Account = ReturnType<typeof resolveDraft>
const runs = new Map<string, GeminiChatRequest & { controller: AbortController }>()
type Target = Parameters<GeminiBridge['cancelChat']>[1]

export function stopRun(accountId: string, target: Target) {
  for (const run of runs.values()) {
    if (run.accountId !== accountId) continue
    const matches = 'requestId' in target ? run.requestId === target.requestId :
      run.conversationId === target.conversationId && (!target.sessionId || run.sessionId === target.sessionId)
    if (matches) run.controller.abort()
  }
}
export function cancelAccountRuns(accountId: string) {
  for (const run of runs.values()) if (accountId === '*' || run.accountId === accountId) run.controller.abort()
}

async function request(proxy: string | undefined, account: Account, path: string, init: RequestInit) {
  const response = await proxyFetch(proxy, account.baseUrl + '/v1beta/' + path, {
    ...init, redirect: 'error',
    headers: { 'x-goog-api-key': account.apiKey, 'Content-Type': 'application/json', ...init.headers }
  }).catch(() => {
    init.signal?.throwIfAborted()
    throw new Error('Gemini 网络请求失败，请检查 API 地址与账号代理')
  })
  if (!response.ok) {
    await response.body?.cancel()
    // Custom endpoints can echo request headers. Never relay an upstream error body.
    throw new Error(`Gemini HTTP ${response.status}`)
  }
  return response
}

export async function verifyAndListModels(accountId: string, draft?: GeminiDraft): Promise<GeminiModel[]> {
  const account = resolveDraft(await credentials(accountId), draft)
  return listModels(accountId, account)
}

export async function listModels(accountId: string, account: Account): Promise<GeminiModel[]> {
  const proxy = await loadAccountProxyUrl(accountId)
  const models = new Map<string, GeminiModel>()
  const pages = new Set<string>()
  const signal = AbortSignal.timeout(30_000)
  let token = ''
  let hasMetadata = false
  do {
    if (pages.has(token)) throw new Error('Gemini returned a repeated model page')
    pages.add(token)
    const query = new URLSearchParams({ pageSize: '1000' })
    if (token) query.set('pageToken', token)
    const response = await request(proxy, account, 'models?' + query, { signal })
    const page = await response.json() as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[]; thinking?: boolean }[]
      nextPageToken?: string
    }
    for (const model of page.models ?? []) {
      if (!Array.isArray(model.supportedGenerationMethods)) continue
      hasMetadata = true
      const id = model.name?.replace(/^models\//, '')
      if (id && /^[\w.-]+$/.test(id) && model.supportedGenerationMethods.includes('generateContent')) {
        models.set(id, {
          id, label: model.displayName || id, thinking: model.thinking ?? /^gemini-(2\.5|3[.-])/.test(id)
        })
      }
    }
    token = page.nextPageToken || ''
  } while (token)
  if (hasMetadata && !models.size) throw new Error('此账号没有支持 generateContent 的模型')
  return hasMetadata ? [...models.values()] : fallbackModels
}

interface Grounding {
  searchEntryPoint?: { renderedContent?: string }
  groundingChunks?: { web?: { uri?: string; title?: string } }[]
  groundingSupports?: { segment?: { text?: string; endIndex?: number }; groundingChunkIndices?: number[] }[]
  webSearchQueries?: string[]
}
interface Frame {
  error?: { code?: number }
  candidates?: { content?: Content; finishReason?: string; groundingMetadata?: Grounding }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: GeminiUsage
}
function link(label: string, uri: string) {
  return `[${label.replace(/[\[\]\\\r\n]/g, ' ')}](${uri.replace(/[()\s]/g, encodeURIComponentEscaped)})`
}
function encodeURIComponentEscaped(char: string) {
  return '%' + char.charCodeAt(0).toString(16)
}

function groundedText(text: string, grounding: Grounding) {
  const chunks = grounding.groundingChunks ?? []
  const sources = new Map<number, { number: number; uri: string; label: string }>()
  for (const [index, { web }] of chunks.entries()) {
    if (!web?.uri || !URL.canParse(web.uri)) continue
    const url = new URL(web.uri)
    if (!['https:', 'http:'].includes(url.protocol)) continue
    sources.set(index, { number: sources.size + 1, uri: url.href, label: web.title || url.hostname })
  }
  const citations = new Map<number, Set<number>>()
  const bytes = grounding.groundingSupports?.length ? Buffer.from(text) : undefined
  for (const support of grounding.groundingSupports ?? []) {
    const segment = support.segment
    if (!segment?.text) continue
    // Google gives UTF-8 byte offsets. Some compatible servers send only segment text.
    const prefix = bytes?.subarray(0, segment.endIndex).toString() ?? ''
    const end = segment.endIndex !== undefined && prefix.endsWith(segment.text) ? prefix.length :
      text.includes(segment.text) ? text.indexOf(segment.text) + segment.text.length : -1
    if (end < 0) continue
    const refs = citations.get(end) ?? new Set()
    for (const index of support.groundingChunkIndices ?? []) if (sources.has(index)) refs.add(index)
    citations.set(end, refs)
  }
  for (const [end, indices] of [...citations].sort(([a], [b]) => b - a)) {
    const links = [...indices].map((i) => {
      const source = sources.get(i)!
      return link(String(source.number), source.uri)
    })
    if (links.length) text = text.slice(0, end) + ' ' + links.join(' ') + text.slice(end)
  }
  if (sources.size) text += '\n\n' + [...sources.values()].map((s) => link(s.number + '. ' + s.label, s.uri)).join('\n')
  if (!grounding.searchEntryPoint?.renderedContent && grounding.webSearchQueries?.length) {
    text += '\n\nGoogle Search · ' + grounding.webSearchQueries.map((q) =>
      link(q, 'https://www.google.com/search?' + new URLSearchParams({ q }))).join(' · ')
  }
  return text
}

function userContent(req: GeminiChatRequest): Content {
  const parts: ContentPart[] = req.text ? [{ text: req.text }] : []
  for (const file of req.attachments ?? []) {
    if (!file.dataBase64) throw new Error('Gemini attachment data is missing')
    let mimeType = file.mimeType
    if (/^text\/|^application\/(json|xml|javascript)$/.test(mimeType) ||
        (mimeType === 'application/octet-stream' && /\.(txt|md|csv|log|yaml|json|xml)$/i.test(file.name))) mimeType = 'text/plain'
    if (!/^(image\/|audio\/|text\/plain$|application\/pdf$)/.test(mimeType)) throw new Error('Gemini 不支持此附件类型')
    parts.push({ inlineData: { mimeType, data: file.dataBase64 } })
  }
  if (!parts.length) throw new Error('Gemini message is empty')
  return { role: 'user', parts }
}

export async function streamChat(req: GeminiChatRequest, emit: (event: GeminiEvent) => void): Promise<GeminiChatResult> {
  if (!req.requestId || !req.conversationId || runs.has(req.requestId)) throw new Error('Invalid Gemini run ID')
  for (const run of runs.values()) {
    if (run.accountId === req.accountId && (req.sessionId ? run.sessionId === req.sessionId :
      run.conversationId === req.conversationId)) throw new Error('Gemini 会话正在生成回复')
  }
  const controller = new AbortController()
  const run = { ...req, controller }
  runs.set(req.requestId, run)
  let allocated = false
  let committed = false
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)])
  try {
    const account = resolveDraft(await credentials(req.accountId))
    const proxy = await loadAccountProxyUrl(req.accountId)
    signal.throwIfAborted()
    const user = userContent(req)
    const history = req.sessionId ? getContents(req.accountId, req.sessionId) : []
    const body = JSON.stringify({
      contents: [...history, user],
      ...(account.systemInstruction ? { systemInstruction: { parts: [{ text: account.systemInstruction }] } } : {}),
      generationConfig: {
        temperature: account.temperature,
        ...(account.showThinking && account.models.find((m) => m.id === account.model)?.thinking
          ? { thinkingConfig: { includeThoughts: true } } : {})
      },
      ...(account.enableSearchGrounding ? { tools: [{ google_search: {} }] } : {})
    })
    const response = await request(proxy, account, `models/${account.model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal, headers: { Accept: 'text/event-stream' }, body
    })
    signal.throwIfAborted()
    if (!response.body) throw new Error('Gemini returned an empty stream')
    const sessionId = req.sessionId ?? createSession(req.accountId, req.text.trim().slice(0, 60) || req.attachments?.[0]?.name).id
    allocated = !req.sessionId
    run.sessionId = sessionId
    const ids = { sessionId, accountId: req.accountId, requestId: req.requestId }
    emit({ ...ids, type: 'accepted' })
    const createdAt = Date.now()
    const parts: ContentPart[] = []
    let text = ''
    let thought = ''
    let finishReason = ''
    let grounding: Grounding = {}
    let usage: GeminiUsage | undefined
    const handle = (data: string) => {
      if (!data || data === '[DONE]') return
      let frame: Frame
      try { frame = JSON.parse(data) } catch { throw new Error('Invalid Gemini SSE frame') }
      if (frame.error) throw new Error(`Gemini stream error (HTTP ${Number(frame.error.code) || 502})`)
      if (frame.promptFeedback?.blockReason) throw new Error('Gemini blocked this prompt')
      const candidate = frame.candidates?.[0]
      for (const part of candidate?.content?.parts ?? []) {
        // Preserve signed part boundaries when replaying the model's content.
        parts.push(part)
        if (part.thought) thought += part.text ?? ''
        else text += part.text ?? ''
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason
      if (candidate?.groundingMetadata) grounding = { ...grounding, ...candidate.groundingMetadata }
      if (frame.usageMetadata) usage = { ...usage, ...frame.usageMetadata }
      if (candidate) emit({ ...ids, type: 'progress', text: groundedText(text, grounding), thought: account.showThinking ? thought : undefined })
    }
    const reader = response.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    const parser = new SseParser()
    const decoder = new TextDecoder()
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        for (const frame of parser.frames(decoder.decode(chunk.value, { stream: true }))) handle(frame.data)
      }
      for (const frame of [...parser.feed(decoder.decode()), ...parser.flush()]) handle(frame.data)
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', cancel)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    if (!['STOP', 'MAX_TOKENS'].includes(finishReason) || !text.trim()) {
      throw new Error(finishReason ? 'Gemini 未返回可用的文本回复' : 'Gemini stream ended before completion')
    }
    const message: GeminiMessage = {
      id: req.requestId, role: 'bot', text: groundedText(text, grounding), createdAt: Date.now(), usage,
      ...(account.showThinking && thought ? { thought } : {}),
      ...(grounding.searchEntryPoint?.renderedContent ? { richWidgets: [{
        kind: 'google_search', widgetId: req.requestId + '_search', html: grounding.searchEntryPoint.renderedContent
      }] } : {})
    }
    appendTurn(req.accountId, sessionId, [
      { content: user, message: {
        id: req.userMessageId ?? randomUUID(), text: req.text, role: 'user', createdAt,
        attachments: req.attachments?.map(({ dataBase64: _payload, ...meta }) => meta)
      } },
      { content: { role: 'model', parts }, message }
    ])
    committed = true
    return { sessionId, message }
  } finally {
    controller.abort()
    runs.delete(req.requestId)
    if (allocated && !committed && run.sessionId) deleteSession(req.accountId, run.sessionId)
  }
}
