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
})
