import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DsBotMainEvent, DsBotRpcRequest, DsBotRpcResponse } from '@shared/ipc'
import type { AdapterEvent } from '../types'
import { DsBotAdapter } from './DsBotAdapter'

describe('DsBotAdapter', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  function installBridge(rpcImpl: (req: DsBotRpcRequest) => Promise<DsBotRpcResponse>) {
    const listeners = new Set<(event: DsBotMainEvent) => void>()
    const authStatus = vi.fn().mockResolvedValue({
      accountId: 'acc_ds1',
      signedIn: true,
      mode: 'relay',
      displayName: 'Home DS Bot',
      handle: 'HomeMac · relay.dsbot.app'
    })
    const clearAuth = vi.fn().mockResolvedValue({ accountId: 'acc_ds1', signedIn: false })
    const rpc = vi.fn(rpcImpl)
    ;(globalThis as { window?: unknown }).window = {
      electron: {
        dsBot: {
          authStatus,
          clearAuth,
          rpc,
          onEvent: (fn: (ev: DsBotMainEvent) => void) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          }
        }
      }
    }
    return {
      rpc,
      authStatus,
      clearAuth,
      emit: (ev: DsBotMainEvent) => {
        for (const fn of listeners) fn(ev)
      }
    }
  }

  it('connects, refreshes bots & groups, streams replies, and handles approvals', async () => {
    const bridge = installBridge(async (req) => {
      if (req.op === 'listTargets') {
        return {
          ok: true,
          data: [
            { id: 'bot:chief', rawId: 'chief', kind: 'bot', name: 'Chief', role: 'Lead', main: true },
            { id: 'room:dev', rawId: 'dev', kind: 'room', name: 'Dev Group', members: ['Chief', 'Coder'] }
          ]
        }
      }
      if (req.op === 'sendMessage') {
        bridge.emit({ type: 'accepted', accountId: req.accountId, requestId: req.requestId!, agentId: req.agentId })
        bridge.emit({
          type: 'stream',
          accountId: req.accountId,
          agentId: req.agentId,
          conversationId: req.botId,
          requestId: req.requestId,
          messageId: 'msg_1',
          text: 'Streaming chunk',
          done: false
        })
        bridge.emit({
          type: 'stream',
          accountId: req.accountId,
          agentId: req.agentId,
          conversationId: req.botId,
          requestId: req.requestId,
          messageId: 'msg_1',
          text: 'Streaming chunk done',
          done: true
        })
        return { ok: true, data: { messageId: 'msg_1', replyText: 'Streaming chunk done' } }
      }
      if (req.op === 'listWaiting') {
        return {
          ok: true,
          data: {
            approvals: [
              { id: 'apr_9', botName: 'Chief', tool: 'shell', reason: 'git status', answerable: true }
            ]
          }
        }
      }
      return { ok: true, data: { ok: true } }
    })

    const adapter = new DsBotAdapter()
    const events: AdapterEvent[] = []
    adapter.subscribe((e) => events.push(e))

    const status = await adapter.connect('acc_ds1')
    expect(status).toBe('online')
    expect(adapter.listCachedAgents('acc_ds1').map((a) => a.id)).toEqual(['bot:chief', 'room:dev'])

    let accepted = false
    const receipt = await adapter.sendMessage({
      accountId: 'acc_ds1',
      conversationId: 'bot_local_1',
      agentId: 'bot:chief',
      text: 'Hello',
      onAccepted: () => {
        accepted = true
      }
    })
    expect(accepted).toBe(true)
    expect(receipt.messageId).toBe('msg_1')
    expect(events.some((e) => e.type === 'message_delta' && e.text === 'Streaming chunk')).toBe(true)
    expect(events.some((e) => e.type === 'message' && e.message.text === 'Streaming chunk done')).toBe(true)

    const approvals = await adapter.listApprovals('acc_ds1')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.decisionOptions).toEqual(['allow_once', 'deny'])

    await adapter.decideApproval('acc_ds1', 'apr_9', 'allow_once')
    await adapter.decideApproval('acc_ds1', 'apr_9', 'deny')
    expect(bridge.rpc).toHaveBeenCalledWith({
      accountId: 'acc_ds1',
      op: 'decideApproval',
      approvalId: 'apr_9',
      choice: 'allow'
    })
    expect(bridge.rpc).toHaveBeenCalledWith({
      accountId: 'acc_ds1',
      op: 'decideApproval',
      approvalId: 'apr_9',
      choice: 'reject'
    })
  })
})
