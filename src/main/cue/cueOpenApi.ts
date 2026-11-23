import type { CueRpcRequest, CueRpcResponse } from '@shared/ipc'
import { cueFetcherForAccount } from './cueAuth'

const MANUS_API = 'https://api.manus.ai/v2/'
const IM_AGENT = 'agent-default'
const IM_TASK = 'agent-default-main_task'

type Data = Record<string, unknown>

function object(data: unknown): Data {
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Data : {}
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

async function request(
  accountId: string,
  apiKey: string,
  path: string,
  body?: unknown,
  opts?: { asWebToken?: boolean }
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
  const response = await cueFetcherForAccount(accountId)(new URL(path, MANUS_API), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  })
  const data = object(await response.json().catch(() => null))
  if (!response.ok || data.ok !== true) {
    const status = response.ok ? 502 : response.status
    const message = status === 401 || status === 403
      ? 'Manus 拒绝了 API Key，请在「Cue 账号」更新凭据'
      : `Manus API 请求失败（${status}）`
    return { ok: false, status, message }
  }
  return { ok: true, data }
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
    ...(Array.isArray(agents) ? agents.flatMap((item) => {
      const agent = object(item)
      const id = string(agent.id)
      const taskId = string(agent.task_id)
      if (!id || id === IM_AGENT || !taskId) return []
      return [{
        id,
        taskId,
        name: string(agent.nickname) ?? 'Cue',
        description: string(agent.about)
      }]
    }) : [])
  ]
}

function taskMessages(data: unknown): Data[] {
  const messages = object(data).messages
  return Array.isArray(messages) ? messages.map(object) : []
}

export async function runCueOpenApi(
  req: CueRpcRequest,
  apiKey: string,
  opts?: { asWebToken?: boolean }
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
      const agentId = req.agentId
      let taskId = req.sessionId || IM_TASK
      if (!req.sessionId && agentId && agentId !== IM_AGENT && !agentId.startsWith('cue_default_')) {
        const detail = await send(`agent.detail?${new URLSearchParams({ agent_id: agentId })}`)
        if (!detail.ok) return detail
        taskId = string(object(object(detail.data).data).task_id) || ''
        if (!taskId) return { ok: false, status: 502, message: 'Manus 未返回该 Cue Agent 的会话' }
      }
      const before = await send(`task.listMessages?${new URLSearchParams({ task_id: taskId, order: 'desc', limit: '1' })}`)
      if (!before.ok) return before
      const sent = await send('task.sendMessage', { task_id: taskId, message: { content: req.text } })
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
    case 'watchUntilReply': {
      if (!req.sessionId) return { ok: false, status: 400, message: '缺少 Cue 会话' }
      const query = new URLSearchParams({ task_id: req.sessionId, order: 'asc', limit: '100' })
      if (req.afterMessageId) query.set('start_event_id', req.afterMessageId)
      let assistantReply: { id: string; text: string } | undefined
      let receivedUserMessage = false
      for (;;) {
        const res = await send(`task.listMessages?${query}`)
        if (!res.ok) return res
        for (const event of taskMessages(res.data)) {
          if (event.id === req.afterMessageId) continue
          if (event.type === 'user_message') {
            if (receivedUserMessage) return { ok: true, data: { done: true, reply: assistantReply } }
            receivedUserMessage = req.expectedUserText === undefined || object(event.user_message).content === req.expectedUserText
          }
          if (!receivedUserMessage) continue
          if (event.type === 'assistant_message') {
            const assistant = object(event.assistant_message)
            const text = string(assistant.content)
            const id = string(event.id)
            if (text && id) assistantReply = { id, text }
          }
          if (event.type === 'error_message') {
            return { ok: false, status: 502, message: 'Cue 执行出错，请在 Manus 中查看会话' }
          }
          const status = object(event.status_update).agent_status
          if (status === 'waiting' || status === 'stopped') {
            return {
              ok: true,
              data: {
                done: true,
                reply: assistantReply ?? (status === 'waiting'
                  ? { id: string(event.id) || 'cue-waiting', text: 'Cue 正在等待输入或确认，请打开 Manus 查看。' }
                  : undefined)
              }
            }
          }
          if (status === 'error') return { ok: false, status: 502, message: 'Cue 执行出错，请在 Manus 中查看会话' }
        }
        const cursor = string(object(res.data).next_cursor)
        if (!cursor || query.get('cursor') === cursor) return { ok: true, data: { done: false } }
        query.delete('start_event_id')
        query.set('cursor', cursor)
      }
    }
    case 'listTasks':
      return send(`task.list?${new URLSearchParams({
        scope: 'agent_subtask',
        agent_id: req.agentId || IM_AGENT
      })}`)
    case 'getHistory':
      return { ok: true, data: { messages: [] } }
    case 'quota':
      return { ok: true, data: { quotaUnavailable: true } }
    case 'approve':
      return { ok: false, status: 400, message: '请在 Manus 中确认 Cue 操作' }
    case 'call':
      return { ok: false, status: 400, message: 'Manus API Key 模式下不支持此 Cue 桌面协议接口' }
  }
}
