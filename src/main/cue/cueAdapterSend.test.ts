import { afterEach, expect, it, vi } from 'vitest'
import { CueAdapter } from '../../adapters/cue/CueAdapter'
import type { CueTurnEvent } from '../../adapters/cue/events'
import type { CueRpcRequest, CueRpcResponse } from '@shared/ipc'

afterEach(() => vi.unstubAllGlobals())

it('correlates immediate Cue acceptance and emits authoritative final replies with tools and media', async () => {
  let emit!: (event: CueTurnEvent) => void
  let finish!: (response: CueRpcResponse) => void
  const rpc = vi.fn(
    (_request: CueRpcRequest & { requestId?: string }) =>
      new Promise<CueRpcResponse>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('window', {
    electron: {
      cue: {
        onEvent: (listener: typeof emit) => {
          emit = listener
          return () => undefined
        },
        rpc
      }
    }
  })
  const adapter = new CueAdapter()
  const accepted = vi.fn()
  const listener = vi.fn()
  adapter.subscribe(listener)
  const accountId = 'fixture'
  const send = adapter.sendMessage({
    accountId,
    conversationId: 'bot',
    sessionId: 'session',
    text: 'Hello',
    attachments: [{ id: 'a1', name: 'pic.png', size: 4, mimeType: 'image/png', dataBase64: 'dGVzdA==' }],
    onAccepted: accepted
  })
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  expect(rpc.mock.calls[0]![0]).toMatchObject({
    op: 'sendMessage',
    attachments: [{ id: 'a1', name: 'pic.png', mimeType: 'image/png', dataBase64: 'dGVzdA==' }]
  })
  const requestId = rpc.mock.calls[0]![0].requestId!
  const echo = { type: 'accepted', accountId, requestId, sessionId: 'session' } as const
  emit({ ...echo, requestId: 'unrelated' })
  expect(accepted).not.toHaveBeenCalled()
  emit(echo)
  emit(echo)
  expect(accepted).toHaveBeenCalledOnce()
  finish({
    ok: true,
    data: {
      sessionId: 'session',
      replies: [
        {
          id: 'reply',
          text: 'Fixed',
          tools: [{ id: 't1', name: 'shell', status: 'completed' }],
          media: [{ kind: 'image', path: 'https://files.manuscdn.com/x.png', name: 'x.png' }]
        }
      ]
    }
  })
  await send
  expect(accepted).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'message',
      message: expect.objectContaining({
        id: 'reply',
        text: 'Fixed',
        authoritative: true,
        tools: [{ id: 't1', name: 'shell', status: 'completed' }],
        media: [{ kind: 'image', path: 'https://files.manuscdn.com/x.png', name: 'x.png' }]
      })
    })
  )
})

it('immediately triggers stopRun and aborts pending sendMessage when signal aborts', async () => {
  const rpc = vi.fn((req: CueRpcRequest & { requestId?: string }) => {
    if (req.op === 'stopRun') {
      return Promise.resolve({ ok: true, data: { stopped: true } } as CueRpcResponse)
    }
    return new Promise<CueRpcResponse>(() => {
      /* never resolves unless aborted */
    })
  })
  vi.stubGlobal('window', {
    electron: {
      cue: {
        onEvent: () => () => undefined,
        rpc
      }
    }
  })
  const adapter = new CueAdapter()
  const controller = new AbortController()
  const send = adapter.sendMessage({
    accountId: 'acc_abort',
    conversationId: 'bot_1',
    sessionId: 'sess_1',
    agentId: 'ag_1',
    text: 'Slow task',
    signal: controller.signal
  })
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  controller.abort()
  await expect(send).rejects.toThrow('Aborted')
  expect(rpc).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: 'acc_abort',
      op: 'stopRun',
      sessionId: 'sess_1',
      agentId: 'ag_1'
    })
  )
  expect(adapter.getStatus('acc_abort')).toBe('online')
})

it('settles cleanly on 499 user cancel without setting account error', async () => {
  const rpc = vi.fn(async (req: CueRpcRequest): Promise<CueRpcResponse> => {
    if (req.op === 'sendMessage') {
      return { ok: false, status: 499, code: 'cancelled', message: 'Cue 运行已停止' }
    }
    return { ok: true, data: { stopped: true } }
  })
  vi.stubGlobal('window', {
    electron: {
      cue: {
        onEvent: () => () => undefined,
        rpc
      }
    }
  })
  const adapter = new CueAdapter()
  const receipt = await adapter.sendMessage({
    accountId: 'acc_stop',
    conversationId: 'bot_stop',
    sessionId: 'sess_stop',
    text: 'Run'
  })
  expect(receipt.sessionId).toBe('sess_stop')
  expect(adapter.getStatus('acc_stop')).toBe('online')
})
