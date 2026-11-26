import type { CueAttachmentPayload, CueRpcRequest, CueRpcResponse } from '@shared/ipc'
import type { CueTurnEvent } from '../../adapters/cue/events'
import { cueFetcherForAccount } from './cueAuth'
import {
  extractCueEventMedia,
  mapCueToolEvent,
  mergeCueMediaLists,
  type CueMediaPart,
  type CueToolCall
} from './cueEventParsers'

const MANUS_API = 'https://api.manus.ai/v2/'
const IM_AGENT = 'agent-default'
const IM_TASK = 'agent-default-main_task'
const POLL_TIMEOUT_MS = 15_000
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export type CueOpenApiOptions = {
  asWebToken?: boolean
  signal?: AbortSignal
  beforeRequest?: () => void
  onEvent?: (event: CueTurnEvent) => void
  requestId?: string
}

export interface UploadedCueAttachment {
  file_id: string
  filename: string
  mime_type?: string
  size?: number
  file_url?: string
}

type Data = Record<string, unknown>

const activeOpenApiPolls = new Map<string, Set<AbortController>>()

function pollKey(accountId: string, sessionId?: string): string {
  return JSON.stringify([accountId, sessionId || '*'])
}

function registerPollController(accountId: string, sessionId: string, controller: AbortController): () => void {
  const keys = [pollKey(accountId, sessionId), pollKey(accountId)]
  for (const key of keys) {
    let set = activeOpenApiPolls.get(key)
    if (!set) {
      set = new Set()
      activeOpenApiPolls.set(key, set)
    }
    set.add(controller)
  }
  return () => {
    for (const key of keys) {
      const set = activeOpenApiPolls.get(key)
      if (!set) continue
      set.delete(controller)
      if (set.size === 0) activeOpenApiPolls.delete(key)
    }
  }
}

export function abortCueOpenApiPolls(accountId: string, sessionId?: string): number {
  const key = sessionId ? pollKey(accountId, sessionId) : pollKey(accountId)
  const set = activeOpenApiPolls.get(key)
  if (!set) return 0
  let count = 0
  for (const controller of [...set]) {
    controller.abort(new Error('Cue 运行已停止'))
    count += 1
  }
  return count
}

function object(data: unknown): Data {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Data) : {}
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value.trim())
    if (Number.isFinite(num)) {
      return num < 1e12 ? Math.round(num * 1000) : Math.round(num)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

async function request(
  accountId: string,
  apiKey: string,
  path: string,
  body?: unknown,
  opts?: CueOpenApiOptions
): Promise<CueRpcResponse> {
  const headers: Record<string, string> = opts?.asWebToken
    ? {
        Authorization: `Bearer ${apiKey}`,
        'x-product-name': 'manus-agents',
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    : {
        'x-manus-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
  const response = await cueFetcherForAccount(accountId, undefined, opts?.beforeRequest)(
    new URL(path, MANUS_API),
    {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: opts?.signal ?? AbortSignal.timeout(POLL_TIMEOUT_MS)
    }
  )
  const data = object(await response.json().catch(() => null))
  opts?.signal?.throwIfAborted()
  if (!response.ok || data.ok !== true) {
    const status = response.ok ? 502 : response.status
    const detail = string(data.message ?? data.error)
    const message =
      status === 401 || status === 403
        ? 'Manus 拒绝了 API Key，请在「Cue 账号」更新凭据'
        : detail
          ? `Manus API 请求失败（${status}）：${detail}`
          : `Manus API 请求失败（${status}）`
    return { ok: false, status, message }
  }
  return { ok: true, data }
}

/**
 * Upload one binary attachment via Manus API v2 `file.upload` (supports both
 * API key and Cue web Bearer token via `opts.asWebToken`).
 */
export async function uploadCueOpenApiAttachment(
  accountId: string,
  credential: string,
  attachment: CueAttachmentPayload,
  opts?: CueOpenApiOptions
): Promise<UploadedCueAttachment> {
  const filename = attachment.name?.trim() || 'attachment'
  const mimeType = attachment.mimeType?.trim() || 'application/octet-stream'
  if (!attachment.dataBase64) {
    throw new Error(`附件「${filename}」缺少内容，请重新选择后发送`)
  }
  const bytes = Buffer.from(attachment.dataBase64, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error(`附件「${filename}」内容为空，无法上传`)
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`附件「${filename}」超过 50 MB 上传上限`)
  }

  const initRes = await request(
    accountId,
    credential,
    'file.upload',
    {
      filename,
      content_type: mimeType,
      size: bytes.byteLength
    },
    { ...opts, signal: opts?.signal ?? AbortSignal.timeout(30_000) }
  )
  if (!initRes.ok) {
    throw new Error(`Cue 附件「${filename}」上传初始化失败：${initRes.message}`)
  }
  const root = object(initRes.data)
  const nested = object(root.data ?? root.file)
  const fileId = string(
    root.file_id ?? root.id ?? nested.file_id ?? nested.id
  )
  const uploadUrl = string(
    root.upload_url ?? root.uploadUrl ?? nested.upload_url ?? nested.uploadUrl
  )
  const fileUrl = string(
    root.file_url ?? root.fileUrl ?? root.url ?? nested.file_url ?? nested.fileUrl ?? nested.url
  )
  if (!fileId) {
    throw new Error(`Cue 附件「${filename}」上传未返回 file_id`)
  }

  if (uploadUrl) {
    let parsedUpload: URL
    try {
      parsedUpload = new URL(uploadUrl)
    } catch {
      throw new Error(`Cue 附件「${filename}」返回了无效的上传地址`)
    }
    if (parsedUpload.protocol !== 'https:' && parsedUpload.protocol !== 'http:') {
      throw new Error(`Cue 附件「${filename}」返回了不支持的上传协议`)
    }
    const putRes = await cueFetcherForAccount(accountId, undefined, opts?.beforeRequest)(
      parsedUpload,
      {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: bytes,
        redirect: 'error',
        signal: opts?.signal ?? AbortSignal.timeout(60_000)
      }
    )
    if (!putRes.ok) {
      throw new Error(`Cue 附件「${filename}」上传文件内容失败（HTTP ${putRes.status}）`)
    }
  }

  return {
    file_id: fileId,
    filename,
    mime_type: mimeType,
    size: bytes.byteLength,
    ...(fileUrl ? { file_url: fileUrl } : {})
  }
}

/**
 * Best-effort remote halt via Manus API v2 `task.stop` (works for both API Key
 * and Cue web Bearer token via `asWebToken: true`).
 */
export async function stopCueOpenApiTask(
  accountId: string,
  credential: string,
  taskId: string,
  opts?: CueOpenApiOptions
): Promise<CueRpcResponse> {
  abortCueOpenApiPolls(accountId, taskId)
  return request(accountId, credential, 'task.stop', { task_id: taskId }, opts)
}

export async function verifyCueApiKey(accountId: string, apiKey: string) {
  const profile = await request(accountId, apiKey, 'user.me')
  if (!profile.ok) throw new Error(profile.message)
  const data = object(profile.data)
  const userId = string(data.user_id)
  if (!userId) throw new Error('Manus 未返回账号身份，未保存凭据')
  const agents = await request(accountId, apiKey, 'agent.list')
  if (!agents.ok) throw new Error(agents.message)
  return { accountSlot: userId, handle: string(data.email), displayName: string(data.name) }
}

function readAgents(data: unknown) {
  const agents = object(data).data
  return [
    { id: IM_AGENT, taskId: IM_TASK, name: 'Cue' },
    ...(Array.isArray(agents)
      ? agents.flatMap((item) => {
          const agent = object(item)
          const id = string(agent.id)
          const taskId = string(agent.task_id)
          if (!id || id === IM_AGENT || !taskId) return []
          return [
            {
              id,
              taskId,
              name: string(agent.nickname) ?? 'Cue',
              description: string(agent.about)
            }
          ]
        })
      : [])
  ]
}

function taskMessages(data: unknown): Data[] {
  const messages = object(data).messages
  return Array.isArray(messages) ? messages.map(object) : []
}

async function resolveOpenApiTaskId(
  send: (path: string, body?: unknown) => Promise<CueRpcResponse>,
  sessionId?: string,
  agentId?: string
): Promise<{ taskId: string } | Extract<CueRpcResponse, { ok: false }>> {
  let taskId = sessionId?.trim() || IM_TASK
  if (!sessionId?.trim() && agentId && agentId !== IM_AGENT && !agentId.startsWith('cue_default_')) {
    const detail = await send(`agent.detail?${new URLSearchParams({ agent_id: agentId })}`)
    if (!detail.ok) return detail
    taskId = string(object(object(detail.data).data).task_id) || ''
    if (!taskId) return { ok: false, status: 502, message: 'Manus 未返回该 Cue Agent 的会话' }
  }
  return { taskId }
}

export async function runCueOpenApi(
  req: CueRpcRequest,
  apiKey: string,
  opts?: CueOpenApiOptions
): Promise<CueRpcResponse> {
  const send = (path: string, body?: unknown) => request(req.accountId, apiKey, path, body, opts)
  switch (req.op) {
    case 'health':
      return send('user.me')
    case 'listAgents': {
      const res = await send('agent.list')
      return res.ok ? { ok: true, data: readAgents(res.data) } : res
    }
    case 'sendMessage': {
      const resolved = await resolveOpenApiTaskId(send, req.sessionId, req.agentId)
      if ('ok' in resolved) return resolved
      const { taskId } = resolved
      const uploadedAttachments: UploadedCueAttachment[] = []
      if (req.attachments?.length) {
        for (const att of req.attachments) {
          uploadedAttachments.push(
            await uploadCueOpenApiAttachment(req.accountId, apiKey, att, opts)
          )
        }
      }
      const before = await send(
        `task.listMessages?${new URLSearchParams({ task_id: taskId, order: 'desc', limit: '1' })}`
      )
      if (!before.ok) return before
      const payload: Record<string, unknown> = {
        task_id: taskId,
        message: { content: req.text }
      }
      if (uploadedAttachments.length > 0) {
        payload.attachments = uploadedAttachments.map(({ file_id, filename }) => ({
          file_id,
          filename
        }))
      }
      const sent = await send('task.sendMessage', payload)
      if (!sent.ok) return sent
      return {
        ok: true,
        data: {
          sessionId: string(object(sent.data).task_id) ?? taskId,
          afterMessageId: string(taskMessages(before.data)[0]?.id),
          awaitReply: true
        }
      }
    }
    case 'stopRun': {
      const resolved = await resolveOpenApiTaskId(send, req.sessionId, req.agentId)
      if ('ok' in resolved) {
        abortCueOpenApiPolls(req.accountId, req.sessionId)
        return resolved
      }
      const stopped = await stopCueOpenApiTask(req.accountId, apiKey, resolved.taskId, opts)
      if (!stopped.ok && stopped.status === 404) {
        return { ok: true, data: { stopped: true, sessionId: resolved.taskId } }
      }
      return stopped
    }
    case 'watchUntilReply': {
      if (!req.sessionId) return { ok: false, status: 400, message: '缺少 Cue 会话' }
      const query = new URLSearchParams({ task_id: req.sessionId, order: 'asc', limit: '100' })
      if (req.afterMessageId) query.set('start_event_id', req.afterMessageId)
      let assistantReply:
        | { id: string; text: string; tools?: CueToolCall[]; media?: CueMediaPart[] }
        | undefined
      let receivedUserMessage = false
      const seenCursors = new Set<string>()
      const seenEvents = new Set<string>()
      const turnTools = new Map<string, CueToolCall>()
      let turnMedia: CueMediaPart[] = []
      const pollController = new AbortController()
      const unregister = registerPollController(req.accountId, req.sessionId, pollController)
      const timeoutTimer = setTimeout(() => pollController.abort(new Error('timeout')), POLL_TIMEOUT_MS)
      const onOuterAbort = () => pollController.abort(opts?.signal?.reason)
      opts?.signal?.addEventListener('abort', onOuterAbort, { once: true })
      const signal = pollController.signal

      const buildFinalReply = (
        base: { id: string; text: string } | undefined,
        markToolsDone: boolean
      ) => {
        if (!base && turnMedia.length === 0) return undefined
        const toolsList = [...turnTools.values()].map((tool) =>
          markToolsDone && tool.status === 'running' ? { ...tool, status: 'completed' as const } : tool
        )
        return {
          id: base?.id ?? 'cue_openapi_media',
          text: base?.text ?? '',
          ...(toolsList.length > 0 ? { tools: toolsList } : {}),
          ...(turnMedia.length > 0 ? { media: turnMedia } : {})
        }
      }

      try {
        for (let page = 0; page < 100; page += 1) {
          const res = await request(
            req.accountId,
            apiKey,
            `task.listMessages?${query}`,
            undefined,
            { ...opts, signal }
          )
          if (!res.ok) return res
          for (const event of taskMessages(res.data)) {
            if (req.afterMessageId && event.id === req.afterMessageId) continue
            const id = string(event.id)
            if (id) {
              if (seenEvents.has(id)) continue
              seenEvents.add(id)
            }
            if (event.type === 'user_message') {
              if (receivedUserMessage) {
                return { ok: true, data: { done: true, reply: buildFinalReply(assistantReply, true) } }
              }
              receivedUserMessage =
                req.expectedUserText === undefined ||
                object(event.user_message).content === req.expectedUserText
            }
            if (!receivedUserMessage) continue

            if (
              event.type === 'tool_call' ||
              event.type === 'tool_used' ||
              event.type === 'toolUsed' ||
              event.type === 'action'
            ) {
              const toolPayload = object(event.tool_call ?? event.tool_used ?? event.action ?? event)
              const mapped = mapCueToolEvent(toolPayload, 'running', id)
              if (mapped) {
                turnTools.set(mapped.id, mapped)
                opts?.onEvent?.({
                  type: 'activity',
                  accountId: req.accountId,
                  sessionId: req.sessionId,
                  agentId: req.agentId,
                  requestId: opts.requestId,
                  busy: true,
                  activityCode: 'toolUsed',
                  activityText: mapped.summary || mapped.name
                })
              }
            }

            if (event.type === 'assistant_message') {
              const msgObj = object(event.assistant_message)
              const text = string(msgObj.content) ?? ''
              const msgMedia = extractCueEventMedia(msgObj)
              if (msgMedia.length > 0) {
                turnMedia = mergeCueMediaLists(turnMedia, msgMedia)
              }
              if ((text || msgMedia.length > 0) && id) {
                assistantReply = { id, text }
                const toolsSnapshot = [...turnTools.values()]
                opts?.onEvent?.({
                  type: 'stream',
                  accountId: req.accountId,
                  sessionId: req.sessionId,
                  agentId: req.agentId,
                  conversationId: req.conversationId,
                  requestId: opts.requestId,
                  messageId: id,
                  text,
                  done: false,
                  ...(toolsSnapshot.length > 0 ? { tools: toolsSnapshot } : {}),
                  ...(turnMedia.length > 0 ? { media: turnMedia } : {})
                })
              }
            }
            const status = object(event.status_update).agent_status
            if (status === 'running') {
              opts?.onEvent?.({
                type: 'activity',
                accountId: req.accountId,
                sessionId: req.sessionId,
                agentId: req.agentId,
                requestId: opts.requestId,
                busy: true,
                activityCode: 'running',
                activityText: 'Cue 正在思考并执行…'
              })
            }
            if (event.type === 'error_message' || status === 'error') {
              return { ok: false, status: 502, message: 'Cue 执行出错，请在 Manus 中查看会话' }
            }
            if (status === 'waiting' || status === 'stopped') {
              const finalReply = buildFinalReply(
                assistantReply ??
                  (status === 'waiting'
                    ? {
                        id: id || 'cue-waiting',
                        text: 'Cue 正在等待输入或确认，请打开 Manus 查看。'
                      }
                    : undefined),
                true
              )
              return {
                ok: true,
                data: {
                  done: true,
                  reply: finalReply
                }
              }
            }
          }
          const cursor = string(object(res.data).next_cursor)
          if (!cursor || seenCursors.has(cursor)) break
          seenCursors.add(cursor)
          query.delete('start_event_id')
          query.set('cursor', cursor)
        }
      } catch (error) {
        if (signal.aborted) {
          const reason = signal.reason
          if (reason instanceof Error && reason.message === 'Cue 运行已停止') {
            return { ok: false, status: 499, code: 'cancelled', message: 'Cue 运行已停止' }
          }
          if (opts?.signal?.aborted) throw error
        } else {
          throw error
        }
      } finally {
        clearTimeout(timeoutTimer)
        opts?.signal?.removeEventListener('abort', onOuterAbort)
        unregister()
      }
      return { ok: true, data: { done: false } }
    }
    case 'listTasks':
      return send(
        `task.list?${new URLSearchParams({
          scope: 'agent_subtask',
          agent_id: req.agentId || IM_AGENT
        })}`
      )
    case 'getHistory': {
      const resolved = await resolveOpenApiTaskId(send, req.sessionId, req.agentId)
      if ('ok' in resolved) return resolved
      const { taskId } = resolved
      const limit = Math.max(1, Math.min(300, req.limit ?? 300))
      const pageLimit = Math.min(100, limit)
      const maxPages = Math.max(1, Math.min(20, Math.ceil(limit / pageLimit) + 2))
      const query = new URLSearchParams({
        task_id: taskId,
        order: 'asc',
        limit: String(pageLimit)
      })
      const seenCursors = new Set<string>()
      const seenEvents = new Set<string>()
      const messages: Array<{
        id: string
        role: 'user' | 'bot'
        text: string
        createdAtMs: number
        tools?: CueToolCall[]
        media?: CueMediaPart[]
      }> = []
      let pendingTools: CueToolCall[] = []
      for (let page = 0; page < maxPages; page += 1) {
        const res = await send(`task.listMessages?${query.toString()}`)
        if (!res.ok) return res
        for (const [idx, event] of taskMessages(res.data).entries()) {
          const id = string(event.id)
          if (id) {
            if (seenEvents.has(id)) continue
            seenEvents.add(id)
          }
          const ts = toEpochMs(
            event.created_at ?? event.createdAt ?? event.timestamp,
            page * 1_000 + idx
          )
          if (
            event.type === 'tool_call' ||
            event.type === 'tool_used' ||
            event.type === 'toolUsed' ||
            event.type === 'action'
          ) {
            const toolObj = object(event.tool_call ?? event.tool_used ?? event.action ?? event)
            const mapped = mapCueToolEvent(toolObj, 'completed', id)
            if (mapped && !pendingTools.some((item) => item.id === mapped.id)) {
              pendingTools.push(mapped)
            }
            continue
          }
          if (event.type === 'user_message') {
            pendingTools = []
            const msgObj = object(event.user_message)
            const text = string(msgObj.content) ?? ''
            const media = extractCueEventMedia(msgObj)
            if (!text && media.length === 0) continue
            messages.push({
              id: id || `cue_oa_u_${page}_${idx}`,
              role: 'user',
              text,
              createdAtMs: ts,
              ...(media.length > 0 ? { media } : {})
            })
            continue
          }
          if (event.type === 'assistant_message') {
            const msgObj = object(event.assistant_message)
            const text = string(msgObj.content) ?? ''
            const media = extractCueEventMedia(msgObj)
            if (!text && media.length === 0) continue
            const tools = pendingTools.length > 0 ? pendingTools : undefined
            pendingTools = []
            messages.push({
              id: id || `cue_oa_a_${page}_${idx}`,
              role: 'bot',
              text,
              createdAtMs: ts,
              ...(tools ? { tools } : {}),
              ...(media.length > 0 ? { media } : {})
            })
          }
        }
        if (messages.length >= limit) break
        const cursor = string(object(res.data).next_cursor)
        if (!cursor || seenCursors.has(cursor)) break
        seenCursors.add(cursor)
        query.set('cursor', cursor)
      }
      return {
        ok: true,
        data: {
          sessionId: taskId,
          messages: messages.slice(-limit)
        }
      }
    }
    case 'quota':
      return { ok: true, data: { quotaUnavailable: true } }
    case 'approve':
      return { ok: false, status: 400, message: '请在 Manus 中确认 Cue 操作' }
    case 'downloadMedia':
      return { ok: false, status: 400, message: '应通过媒体下载通道处理 Cue 附件' }
    case 'call':
      return { ok: false, status: 400, message: 'Manus API Key 模式下不支持此 Cue 桌面协议接口' }
  }
}
