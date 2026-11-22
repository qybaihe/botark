import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesAdapter } from '@adapters/hermes/HermesAdapter'
import { adapterRegistry } from '@adapters/registry'
import type { Bot, BotAccount } from '@/types'
import { useBotStore } from './botStore'

const bot: Bot = {
  id: 'bot', name: 'Fixture', emoji: '', description: '', platformId: 'hermes', groupId: 'g-work',
  accountIds: ['account'], activeAccountId: 'account', memory: [], notes: '', createdAt: 1, unread: 0
}
const account: BotAccount = {
  id: 'account', platformId: 'hermes', displayName: 'Fixture', handle: '', status: 'online'
}
const command = { botId: bot.id, clientMessageId: 'phone-message', text: ' Message ' }
const store = useBotStore.getState

describe('mobile delivery', () => {
  beforeEach(() => {
    useBotStore.setState({ bots: [bot], accounts: { [account.id]: account }, messages: {}, replyingTo: {} })
  })

  afterEach(() => vi.restoreAllMocks())

  it('queues once using the client ID and lets the adapter determine delivery', async () => {
    const adapter = new HermesAdapter()
    vi.spyOn(adapterRegistry, 'has').mockReturnValue(true)
    vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)
    let reject!: (error: Error) => void
    const send = vi.spyOn(adapter, 'sendMessage').mockReturnValue(new Promise((_, fail) => { reject = fail }))
    store().setReplyTarget(bot.id, { messageId: 'quoted-message', entryId: 'desktop-quote', quote: 'Old quote', role: 'bot' })

    expect(store().queueMobileMessage(command)).toEqual({ ok: true, messageId: 'phone-message' })
    expect(store().queueMobileMessage(command)).toEqual({ ok: true, messageId: 'phone-message' })
    expect(store().queueMobileMessage({ ...command, text: 'Conflicting text' })).toMatchObject({ status: 409 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0].replyToId).toBeUndefined()
    expect(store().replyingTo[bot.id]?.entryId).toBe('desktop-quote')
    expect(store().messages[bot.id]).toMatchObject([{ id: 'phone-message', text: 'Message', delivery: 'sending' }])

    reject(new Error('Platform disconnected before accepting'))
    await vi.waitFor(() => expect(store().messages[bot.id]?.[0]).toMatchObject({
      id: 'phone-message',
      delivery: 'failed',
      error: 'Platform disconnected before accepting'
    }))
  })

  it('rejects unknown bots and offline accounts without adding a message', () => {
    expect(store().queueMobileMessage({ ...command, botId: 'missing' })).toMatchObject({ status: 404 })
    useBotStore.setState({ accounts: { [account.id]: { ...account, status: 'offline' } } })
    expect(store().queueMobileMessage(command)).toMatchObject({ status: 409 })
    expect(store().messages).toEqual({})
  })
})
