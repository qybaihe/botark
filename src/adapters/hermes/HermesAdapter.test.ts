import { afterEach, expect, it, vi } from 'vitest'
import type { HermesMainEvent, HermesRpcRequest } from '@shared/ipc'
import { HermesAdapter } from './HermesAdapter'

const message = { accountId: 'fixture', conversationId: 'bot', text: 'Hello' }
afterEach(() => vi.unstubAllGlobals())

it('does not mark an IPC or gateway rejection as accepted', async () => {
  vi.stubGlobal('window', { electron: { hermes: {
    onEvent: () => () => undefined,
    rpc: async () => ({ ok: false, status: 401, message: 'Fixture credentials rejected' })
  } } })
  const accepted = vi.fn()
  await expect(new HermesAdapter().sendMessage({ ...message, onAccepted: accepted })).rejects.toMatchObject({
    code: 'not-connected'
  })
  expect(accepted).not.toHaveBeenCalled()
})

it('correlates gateway acceptance by request ID before a stream failure', async () => {
  let emit!: (event: HermesMainEvent) => void
  vi.stubGlobal('window', { electron: { hermes: {
    onEvent: (listener: typeof emit) => { emit = listener; return () => undefined },
    rpc: async (request: Extract<HermesRpcRequest, { op: 'sendMessage' }>) => {
      emit({ type: 'accepted', accountId: request.accountId, requestId: 'different-request' })
      expect(accepted).not.toHaveBeenCalled()
      const event = { type: 'accepted', accountId: request.accountId, requestId: request.requestId! } as const
      emit(event)
      emit(event)
      return { ok: false, status: 502, message: 'Fixture stream disconnected' }
    }
  } } })
  const accepted = vi.fn()
  await expect(new HermesAdapter().sendMessage({ ...message, onAccepted: accepted })).rejects.toThrow('Fixture stream disconnected')
  expect(accepted).toHaveBeenCalledTimes(1)
})
