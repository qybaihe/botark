import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterEvent, PlatformAdapter } from '@adapters/types'
import { startAdapterBridge } from '@/services/adapterBridge'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'

describe('Account status sync (Qoder-2x / Hark-*) & per-bot WebSession view pinning', () => {
  beforeEach(() => {
    useBotStore.setState({
      bots: [
        {
          id: 'bot_qoder_2x',
          name: 'Qoder-2x',
          emoji: '🤖',
          description: '',
          platformId: 'hark',
          groupId: 'g1',
          accountIds: ['acc_qoder_2x'],
          activeAccountId: 'acc_qoder_2x',
          activeSessionId: 'conv_qoder_1',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        } as Bot,
        {
          id: 'bot_hark_sci',
          name: 'Hark-科研助手',
          emoji: '🔬',
          description: '',
          platformId: 'hark',
          groupId: 'g1',
          accountIds: ['acc_hark_sci'],
          activeAccountId: 'acc_hark_sci',
          activeSessionId: 'conv_sci_1',
          memory: [],
          notes: '',
          createdAt: 2,
          unread: 0
        } as Bot
      ],
      accounts: {
        acc_qoder_2x: {
          id: 'acc_qoder_2x',
          platformId: 'hark',
          displayName: 'Qoder-2x',
          handle: 'qoder@hark.com',
          status: 'offline',
          statusDetail: '未登录 Hark'
        },
        acc_hark_sci: {
          id: 'acc_hark_sci',
          platformId: 'hark',
          displayName: 'Hark-科研助手',
          handle: 'sci@hark.com',
          status: 'offline'
        }
      },
      messages: {},
      selectedBotId: 'bot_qoder_2x',
      webSessionOpen: false,
      webSessionByBot: {}
    })
  })

  it('promotes stale offline Qoder-2x / Hark-* accounts to online on receiveMessage, applyHarkHistory, or streaming delta', () => {
    const store = useBotStore.getState()

    // 1. Live reply arrives for Qoder-2x while status is 'offline'
    store.receiveMessage({
      id: 'm_qoder_1',
      conversationId: 'bot_qoder_2x',
      accountId: 'acc_qoder_2x',
      text: '肠造口术后路线加好了，测试全过。',
      createdAt: Date.now()
    })
    expect(useBotStore.getState().accounts.acc_qoder_2x?.status).toBe('online')
    expect(useBotStore.getState().accounts.acc_qoder_2x?.statusDetail).toBeUndefined()

    // 2. Hark projectHistory sync arrives for Hark-科研助手 while status is 'offline'
    store.applyHarkHistory('bot_hark_sci', 'acc_hark_sci', 'conv_sci_1', [
      { id: 'h1', role: 'assistant', content: '外科护理学那篇引的 ESPEN 指南已更新', createdAt: Date.now() }
    ])
    expect(useBotStore.getState().accounts.acc_hark_sci?.status).toBe('online')
  })

  it('ignores another platform status event for a connected Hark account', () => {
    let museEvent: ((event: AdapterEvent) => void) | undefined
    const adapter = {
      id: 'meta-muse',
      subscribe: (listener: (event: AdapterEvent) => void) => {
        museEvent = listener
        return () => {}
      }
    } as PlatformAdapter
    const list = vi.spyOn(adapterRegistry, 'list').mockReturnValue([adapter])
    const stop = startAdapterBridge()
    try {
      useBotStore.getState().setAccountStatus('acc_qoder_2x', 'online')
      museEvent?.({ type: 'status', accountId: 'acc_qoder_2x', status: 'offline', detail: 'Muse preview unauthorized' })
      expect(useBotStore.getState().accounts.acc_qoder_2x?.status).toBe('online')
    } finally {
      stop()
      list.mockRestore()
    }
  })

  it('uses successfully refreshed Hark history as a live signal even for an empty session', () => {
    useBotStore.getState().applyHarkHistory('bot_hark_sci', 'acc_hark_sci', 'conv_sci_1', [])
    expect(useBotStore.getState().accounts.acc_hark_sci?.status).toBe('online')
    expect(useBotStore.getState().accounts.acc_qoder_2x?.status).toBe('offline')
  })

  it('restores the selected Bot view when rehydrating after a reload', () => {
    const current = useBotStore.getState()
    const restored = useBotStore.persist.getOptions().merge?.({
      selectedBotId: 'bot_qoder_2x',
      webSessionByBot: { bot_qoder_2x: true }
    }, current)
    expect(restored?.webSessionOpen).toBe(true)
  })

  it('pins and restores per-bot WebSession view choice when switching between bots and auto-connects offline accounts', async () => {
    const connectSpy = vi.fn(async () => 'online' as const)
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      id: 'hark',
      name: 'Hark',
      listAccounts: async () => [],
      connect: connectSpy,
      disconnect: async () => undefined,
      getStatus: () => 'online',
      subscribe: () => () => undefined,
      onMessage: () => () => undefined,
      sendMessage: async () => ({ messageId: 'm1', acceptedAt: 1 })
    } as unknown as PlatformAdapter)

    const store = useBotStore.getState()
    expect(useBotStore.getState().webSessionOpen).toBe(false)

    // User switches Qoder-2x to WebSession view (Image 2)
    store.toggleWebSession()
    expect(useBotStore.getState().webSessionOpen).toBe(true)
    expect(useBotStore.getState().webSessionByBot.bot_qoder_2x).toBe(true)

    // User switches to Hark-科研助手 (which defaults to native chat view: false)
    store.selectBot('bot_hark_sci')
    expect(useBotStore.getState().selectedBotId).toBe('bot_hark_sci')
    expect(useBotStore.getState().webSessionOpen).toBe(false)

    // User switches back to Qoder-2x -> MUST preserve WebSession view (true) instead of resetting to false!
    store.selectBot('bot_qoder_2x')
    expect(useBotStore.getState().selectedBotId).toBe('bot_qoder_2x')
    expect(useBotStore.getState().webSessionOpen).toBe(true)
    expect(connectSpy).toHaveBeenCalled()
  })
})
