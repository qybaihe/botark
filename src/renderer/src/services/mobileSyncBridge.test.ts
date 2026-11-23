import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesAdapter } from '@adapters/hermes/HermesAdapter'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterListener } from '@adapters/types'
import type { MobileRelayCommand, MobileWorkspaceSnapshot } from '@shared/mobileSync'
import { useBotStore } from '@/store/botStore'
import { startMobileSyncBridge } from './mobileSyncBridge'

let stop: (() => void) | undefined
let onAdapterEvent: AdapterListener
let onCommand: (command: MobileRelayCommand) => void
const accountId = 'snapshot-account'
const approval = { id: 'approval', status: 'pending', title: 'Fixture approval' }
const otherApproval = { id: 'other', status: 'pending', title: 'Other approval' }
const snapshots = vi.fn<(snapshot: MobileWorkspaceSnapshot) => void>()
const publishEvent = vi.fn()
let adapter: HermesAdapter

beforeEach(() => {
  vi.useFakeTimers()
  snapshots.mockClear()
  publishEvent.mockClear()
  useBotStore.setState({
    accounts: { [accountId]: { id: accountId, platformId: 'hermes', status: 'online', handle: '', displayName: 'Fixture' } },
    groups: [{ id: 'group', name: 'Fixture group' }], collapsedGroups: {}
  })
  const unsubscribe = () => undefined
  vi.stubGlobal('window', { electron: { mobileSync: {
    pushSnapshot: snapshots,
    pushEvent: publishEvent,
    onStateChanged: () => unsubscribe,
    onSendCommand: () => unsubscribe,
    onCommand: (listener: typeof onCommand) => { onCommand = listener; return unsubscribe }
  } } })
  adapter = new HermesAdapter()
  vi.spyOn(adapterRegistry, 'list').mockReturnValue([adapter])
  vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)
  vi.spyOn(adapter, 'subscribe').mockImplementation((listener) => { onAdapterEvent = listener; return unsubscribe })
  stop = startMobileSyncBridge()
})

afterEach(() => {
  stop?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mobile snapshots', () => {
  it('publishes collapse-only and approval-only changes, including a cleared approval list', async () => {
    useBotStore.getState().toggleGroup('group')
    await vi.advanceTimersByTimeAsync(180)
    expect(snapshots.mock.lastCall?.[0].groups[0]?.collapsed).toBe(true)

    onAdapterEvent({ type: 'approvals', accountId, pending: [approval] })
    await vi.advanceTimersByTimeAsync(180)
    expect(snapshots.mock.lastCall?.[0].approvals[accountId]).toMatchObject([approval])

    onAdapterEvent({ type: 'approvals', accountId, pending: [] })
    await vi.advanceTimersByTimeAsync(180)
    expect(snapshots.mock.lastCall?.[0].approvals[accountId]).toEqual([])
  })

  it('does not clear other pending approvals when the list refresh fails after a decision', async () => {
    onAdapterEvent({ type: 'approvals', accountId, pending: [approval, otherApproval] })
    vi.spyOn(adapter, 'decideApproval').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'listApprovals').mockRejectedValue(new Error('Fixture unavailable'))
    onCommand({ kind: 'decideApproval', accountId, platformId: 'hermes', approvalId: approval.id, decision: 'deny' })
    await vi.advanceTimersByTimeAsync(180)

    expect(snapshots.mock.lastCall?.[0].approvals[accountId]).toMatchObject([otherApproval])
  })

  it('resolves Muse workspace image paths into inline data URLs for paired mobile clients', async () => {
    stop?.()
    const previewWorkspaceFile = vi.fn().mockResolvedValue({
      path: 'workspace/assistant/dog.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      byteLength: 68
    })
    const unsubscribe = () => undefined
    vi.stubGlobal('window', {
      electron: {
        muse: { previewWorkspaceFile },
        mobileSync: {
          pushSnapshot: snapshots,
          pushEvent: publishEvent,
          onStateChanged: () => unsubscribe,
          onSendCommand: () => unsubscribe,
          onCommand: () => unsubscribe
        }
      }
    })
    useBotStore.setState({
      accounts: {
        acc_m1: { id: 'acc_m1', platformId: 'meta-muse', status: 'online', handle: '', displayName: 'Muse 1' }
      },
      bots: [
        {
          id: 'bot_m1',
          name: 'Muse 1',
          emoji: '🤖',
          description: '',
          platformId: 'meta-muse',
          groupId: 'group',
          accountIds: ['acc_m1'],
          activeAccountId: 'acc_m1',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        }
      ],
      messages: {
        bot_m1: [
          {
            id: 'msg_1',
            botId: 'bot_m1',
            accountId: 'acc_m1',
            role: 'bot',
            text: '画好啦，一只小狗。',
            createdAt: 2,
            media: [{ kind: 'image', path: 'workspace/assistant/dog.png', name: 'dog.png' }]
          }
        ]
      }
    })
    stop = startMobileSyncBridge()
    await vi.advanceTimersByTimeAsync(250)
    expect(previewWorkspaceFile).toHaveBeenCalledWith('acc_m1', 'workspace/assistant/dog.png')
    const latestMedia = snapshots.mock.lastCall?.[0].messages['bot_m1']?.[0]?.media?.[0]
    expect(latestMedia?.kind).toBe('image')
    expect(latestMedia?.path).toMatch(/^data:image\/png;base64,/)
  })

  it('does not call Muse previewWorkspaceFile for Hark or other non-Muse account media', async () => {
    stop?.()
    const previewWorkspaceFile = vi.fn()
    const unsubscribe = () => undefined
    vi.stubGlobal('window', {
      electron: {
        muse: { previewWorkspaceFile },
        mobileSync: {
          pushSnapshot: snapshots,
          pushEvent: publishEvent,
          onStateChanged: () => unsubscribe,
          onSendCommand: () => unsubscribe,
          onCommand: () => unsubscribe
        }
      }
    })
    useBotStore.setState({
      accounts: {
        acc_hark_1: { id: 'acc_hark_1', platformId: 'hark', status: 'online', handle: '', displayName: 'Qoder-2x' }
      },
      bots: [
        {
          id: 'bot_hark_1',
          name: 'Qoder-2x',
          emoji: '🤖',
          description: '',
          platformId: 'hark',
          groupId: 'group',
          accountIds: ['acc_hark_1'],
          activeAccountId: 'acc_hark_1',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        }
      ],
      messages: {
        bot_hark_1: [
          {
            id: 'msg_h1',
            botId: 'bot_hark_1',
            accountId: 'acc_hark_1',
            role: 'bot',
            text: 'Hark attachment',
            createdAt: 2,
            media: [{ kind: 'image', path: 'workspace/hark/chart.png', name: 'chart.png' }]
          }
        ]
      }
    })
    stop = startMobileSyncBridge()
    await vi.advanceTimersByTimeAsync(250)
    expect(previewWorkspaceFile).not.toHaveBeenCalled()
  })
})
