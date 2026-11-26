import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { PlatformAdapter } from '@adapters/types'
import type { CueMainEvent } from '@shared/ipc'
import { startAdapterBridge } from '@/services/adapterBridge'
import { useBotStore } from '@/store/botStore'
import { cancelPlatformTurn } from '@/store/platformCancel'
import { cueHistory } from '@/store/historyNormalizers'
import type { Bot } from '@/types'

describe('Cue login flow deduplication & WebSession reset on new bots', () => {
  let stopBridge: (() => void) | undefined
  let cueListener: ((event: CueMainEvent) => void) | undefined

  beforeEach(() => {
    cueListener = undefined
    useBotStore.setState({
      bots: [],
      accounts: {},
      messages: {},
      groups: [{ id: 'g1', name: 'Workspace' }],
      selectedBotId: null,
      webSessionOpen: false,
      webSessionByBot: {},
      webSessionTargetUrl: null
    })
  })

  afterEach(() => {
    stopBridge?.()
    stopBridge = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function setupCueEnvironment() {
    vi.stubGlobal('window', {
      electron: {
        cue: {
          authStatus: async () => ({
            signedIn: true,
            handle: 'alice@cue.im',
            displayName: 'alice'
          }),
          getSession: async () => ({
            signedIn: true,
            handle: 'alice@cue.im',
            displayName: 'alice'
          }),
          rpc: async (req: { op: string }) => {
            if (req.op === 'listAgents') {
              return { ok: true, data: [{ id: 'agent-default', name: 'Cue' }] }
            }
            return { ok: true, data: {} }
          },
          onEvent: (cb: (ev: CueMainEvent) => void) => {
            cueListener = cb
            return () => {
              if (cueListener === cb) cueListener = undefined
            }
          }
        }
      }
    })

    const stubCueAdapter = {
      id: 'cue',
      name: 'Cue',
      listAccounts: async () => [],
      connect: async () => 'online' as const,
      disconnect: async () => undefined,
      getStatus: () => 'online' as const,
      subscribe: () => () => undefined,
      onMessage: () => () => undefined,
      sendMessage: async () => ({ messageId: 'm1', acceptedAt: 1 })
    } as unknown as PlatformAdapter

    vi.spyOn(adapterRegistry, 'list').mockReturnValue([])
    vi.spyOn(adapterRegistry, 'get').mockImplementation((id) =>
      id === 'cue' ? stubCueAdapter : undefined
    )

    stopBridge = startAdapterBridge()
  }

  it('does not auto-create a duplicate Cue bot when auth completes before AddBotDialog NameStep finishes, and resets webSessionOpen on new bot creation', async () => {
    setupCueEnvironment()

    // Seed an existing bot currently open in WebSession view
    useBotStore.setState({
      bots: [
        {
          id: 'bot_prev',
          name: 'Previous Bot',
          emoji: '🤖',
          description: '',
          platformId: 'hark',
          groupId: 'g1',
          accountIds: ['acc_prev'],
          activeAccountId: 'acc_prev',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        }
      ],
      accounts: {
        acc_prev: {
          id: 'acc_prev',
          platformId: 'hark',
          displayName: 'Prev',
          handle: 'prev@hark.com',
          status: 'online'
        }
      },
      selectedBotId: 'bot_prev',
      webSessionOpen: true,
      webSessionByBot: { bot_prev: true }
    })

    const newAccId = 'acc_cue_new_1'

    // 1. User completes Cue login in AddBotDialog while NameStep is still open -> account not yet in botStore
    cueListener?.({
      type: 'auth',
      accountId: newAccId,
      signedIn: true,
      handle: 'alice@cue.im',
      displayName: 'alice'
    })
    await new Promise((r) => setTimeout(r, 20))

    // Must NOT create a premature Cue bot before the user finishes naming!
    expect(useBotStore.getState().bots.filter((b) => b.platformId === 'cue')).toHaveLength(0)

    // 2. User enters custom name and completes AddBotDialog.finish() -> addBot + connectAccount -> syncCueAccountBots
    const botId = useBotStore.getState().addBot({
      id: 'bot_cue_custom',
      platformId: 'cue',
      name: '我的 Cue',
      accounts: [{ key: newAccId, accountId: newAccId, displayName: '我的 Cue', handle: '' }]
    })
    await useBotStore.getState().syncCueAccountBots(newAccId)

    const cueBots = useBotStore.getState().bots.filter((b) => b.platformId === 'cue')
    expect(cueBots).toHaveLength(1)
    expect(cueBots[0]?.id).toBe(botId)
    expect(cueBots[0]?.name).toBe('我的 Cue')
    expect(cueBots[0]?.selectedAgentId).toBe('agent-default')

    // Newly added bot opens native chat instead of bleeding the previous bot's webSessionOpen state
    expect(useBotStore.getState().selectedBotId).toBe(botId)
    expect(useBotStore.getState().webSessionOpen).toBe(false)
    expect(useBotStore.getState().webSessionByBot.bot_prev).toBe(true)
  })

  it('updates a pre-created SettingsView Cue bot in-place on auth without duplicating it', async () => {
    setupCueEnvironment()

    const accId = 'acc_cue_settings_1'
    useBotStore.getState().addBot({
      id: 'bot_cue_settings',
      platformId: 'cue',
      name: 'Cue',
      accounts: [{ key: accId, accountId: accId, displayName: 'Cue', handle: '' }],
      background: true
    })

    cueListener?.({
      type: 'auth',
      accountId: accId,
      signedIn: true,
      handle: 'alice@cue.im',
      displayName: 'alice'
    })
    await new Promise((r) => setTimeout(r, 30))

    const cueBots = useBotStore.getState().bots.filter((b) => b.platformId === 'cue')
    expect(cueBots).toHaveLength(1)
    expect(cueBots[0]?.id).toBe('bot_cue_settings')
    expect(cueBots[0]?.name).toBe('Cue · alice@cue.im')
    expect(useBotStore.getState().accounts[accId]?.status).toBe('online')
  })

  it('still hydrates and merges older Cue messages when a local message already exists', async () => {
    setupCueEnvironment()

    const accId = 'acc_cue_hist_1'
    vi.stubGlobal('window', {
      electron: {
        cue: {
          authStatus: async () => ({
            signedIn: true,
            handle: 'alice@cue.im',
            displayName: 'alice'
          }),
          getSession: async () => ({
            signedIn: true,
            handle: 'alice@cue.im',
            displayName: 'alice'
          }),
          rpc: async (req: { op: string }) => {
            if (req.op === 'listAgents') {
              return {
                ok: true,
                data: [{ id: 'ag_real_1', name: '美国节点', sessionId: 'sess_real_1' }]
              }
            }
            if (req.op === 'getHistory') {
              return {
                ok: true,
                data: {
                  sessionId: 'sess_real_1',
                  messages: [
                    { id: 'old_u1', role: 'user', text: '之前的问题', createdAtMs: 1700000001000 },
                    { id: 'old_a1', role: 'bot', text: '之前的回复', createdAtMs: 1700000002000 },
                    { id: 'srv_11', role: 'user', text: '11', createdAtMs: 1700000100000 }
                  ]
                }
              }
            }
            return { ok: true, data: {} }
          },
          onEvent: (cb: (ev: CueMainEvent) => void) => {
            cueListener = cb
            return () => {
              if (cueListener === cb) cueListener = undefined
            }
          }
        }
      }
    })

    const botId = useBotStore.getState().addBot({
      id: 'bot_cue_hist',
      platformId: 'cue',
      name: '每日简报',
      accounts: [{ key: accId, accountId: accId, displayName: 'alice', handle: 'alice@cue.im' }]
    })
    useBotStore.setState((s) => ({
      messages: {
        ...s.messages,
        [botId]: [
          {
            id: 'msg_local_11',
            botId,
            accountId: accId,
            agentId: 'ag_real_1',
            role: 'user',
            text: '11',
            createdAt: 1700000105000,
            delivery: 'sent'
          }
        ]
      }
    }))

    await useBotStore.getState().syncCueAccountBots(accId)
    await new Promise((r) => setTimeout(r, 30))

    const msgs = useBotStore.getState().messages[botId] ?? []
    expect(msgs.map((m) => m.text)).toEqual(['之前的问题', '之前的回复', '11'])
  })

  it('wires cancelPlatformTurn to Cue stopRun and preserves tools & media in cueHistory', async () => {
    const rpc = vi.fn(async () => ({ ok: true, data: { stopped: true } }))
    vi.stubGlobal('window', { electron: { cue: { rpc } } })

    await cancelPlatformTurn({
      id: 'bot_cue_cancel',
      platformId: 'cue',
      activeAccountId: 'acc_cue_cancel',
      activeSessionId: 'sess_cue_cancel',
      selectedAgentId: 'ag_cue_cancel'
    } as Bot)

    expect(rpc).toHaveBeenCalledWith({
      accountId: 'acc_cue_cancel',
      op: 'stopRun',
      sessionId: 'sess_cue_cancel',
      agentId: 'ag_cue_cancel'
    })

    const normalized = cueHistory(
      [
        {
          id: 'm_rich',
          role: 'bot',
          text: '',
          createdAtMs: 1700000200000,
          tools: [{ id: 't1', name: 'browser', status: 'completed' }],
          media: [{ kind: 'image', path: 'https://files.manuscdn.com/img.png', name: 'img.png' }]
        }
      ],
      'bot_cue_cancel',
      'acc_cue_cancel',
      'ag_cue_cancel'
    )
    expect(normalized).toHaveLength(1)
    expect(normalized[0]?.tools).toEqual([{ id: 't1', name: 'browser', status: 'completed' }])
    expect(normalized[0]?.media).toEqual([
      { kind: 'image', path: 'https://files.manuscdn.com/img.png', name: 'img.png' }
    ])
  })
})
