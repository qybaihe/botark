import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesAdapter } from '@adapters/hermes/HermesAdapter'
import { adapterRegistry } from '@adapters/registry'
import type { PlatformAdapter, SendReceipt } from '@adapters/types'
import type { Bot } from '@/types'
import { useBotStore } from './botStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const bot: Bot = {
  id: 'bot',
  name: 'Test Bot',
  emoji: '',
  description: '',
  platformId: 'hermes',
  groupId: 'g-work',
  accountIds: ['account-a', 'account-b'],
  activeAccountId: 'account-a',
  activeSessionId: 'initial',
  memory: [],
  notes: '',
  createdAt: 1,
  unread: 0
}

const row = (id: string) => ({ id, role: 'user', text: id, createdAt: 1 })
const hermesHistory = (id: string) => ({ ok: true, data: [row(id)] })
const grokHistory = (id: string) => ({ ok: true, data: { hydrated: [row(id)] } })
const store = useBotStore.getState

function mockHermesSend(sendMessage: PlatformAdapter['sendMessage']) {
  const adapter = new HermesAdapter()
  vi.spyOn(adapter, 'sendMessage').mockImplementation(sendMessage)
  vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)
}

describe('session navigation', () => {
  beforeEach(() => {
    useBotStore.setState({ bots: [bot], messages: {}, accounts: {}, replyingTo: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the most recently selected Hermes history when requests finish out of order', async () => {
    const first = deferred<ReturnType<typeof hermesHistory>>()
    const second = deferred<ReturnType<typeof hermesHistory>>()
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })

    const firstLoad = store().switchHermesSession(bot.id, 'session-a')
    const secondLoad = store().switchHermesSession(bot.id, 'session-b')
    second.resolve(hermesHistory('message-b'))
    await secondLoad
    first.resolve(hermesHistory('message-a'))
    await firstLoad

    expect(store().bots[0]?.activeSessionId).toBe('session-b')
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['message-b'])
  })

  it('keeps the latest request when the same Muse session is selected twice', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'meta-muse' }] })
    const first = deferred<ReturnType<typeof row>[]>()
    const second = deferred<ReturnType<typeof row>[]>()
    const loadSessionHistory = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { electron: { muse: { loadSessionHistory } } })

    const firstLoad = store().switchMuseSession(bot.id, 'session-a')
    const secondLoad = store().switchMuseSession(bot.id, 'session-a')
    second.resolve([row('fresh')])
    await secondLoad
    first.resolve([row('stale')])
    await firstLoad

    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['fresh'])
  })

  it('does not repopulate a fresh Antigravity chat with history from the previous session', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'antigravity' }] })
    const pending = deferred<{ ok: boolean; data: { messages: ReturnType<typeof row>[] } }>()
    vi.stubGlobal('window', { electron: { antigravity: { rpc: () => pending.promise } } })

    const loading = store().switchAntigravitySession(bot.id, 'previous')
    store().startNewAntigravitySession(bot.id)
    pending.resolve({ ok: true, data: { messages: [row('previous-message')] } })
    await loading

    expect(store().bots[0]?.activeSessionId).toBeUndefined()
    expect(store().messages[bot.id]).toEqual([])
  })

  it('does not let a pending Hermes creation undo a subsequent history selection', async () => {
    const pending = deferred<{ ok: boolean; data: { id: string } }>()
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hermesHistory('kept'))
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })

    const creating = store().startNewHermesSession(bot.id)
    await store().switchHermesSession(bot.id, 'existing')
    pending.resolve({ ok: true, data: { id: 'new' } })
    await creating

    expect(store().bots[0]?.activeSessionId).toBe('existing')
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['kept'])
  })

  it('ignores history from before an account switch, even after switching back', async () => {
    const pending = deferred<ReturnType<typeof hermesHistory>>()
    vi.stubGlobal('window', { electron: { hermes: { rpc: () => pending.promise } } })

    const loading = store().switchHermesSession(bot.id, 'session-a')
    store().setActiveAccount(bot.id, 'account-b')
    store().setActiveAccount(bot.id, 'account-a')
    pending.resolve(hermesHistory('stale'))
    await loading

    expect(store().messages[bot.id]).toBeUndefined()
  })

  it('ignores a Grok transcript from the first visit after returning to the same agent', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'grok', selectedAgentId: 'initial-agent' }] })
    const first = deferred<ReturnType<typeof grokHistory>>()
    const latest = deferred<ReturnType<typeof grokHistory>>()
    const rpc = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: false })
      .mockReturnValueOnce(latest.promise)
    vi.stubGlobal('window', { electron: { grok: { rpc } } })

    store().setSelectedAgent(bot.id, 'agent-a')
    store().setSelectedAgent(bot.id, 'agent-b')
    store().setSelectedAgent(bot.id, 'agent-a')
    latest.resolve(grokHistory('new-transcript'))
    await latest.promise
    first.resolve(grokHistory('stale-transcript'))
    await first.promise

    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['new-transcript'])
  })

  it('records a late send receipt without changing the session selected after that send', async () => {
    const receipt = deferred<SendReceipt>()
    mockHermesSend(() => receipt.promise)

    const sending = store().sendMessage(bot.id, 'Hi')
    await store().switchHermesSession(bot.id, 'selected')
    receipt.resolve({ messageId: 'remote', acceptedAt: 1, sessionId: 'old-send-session' })
    await sending

    expect(store().bots[0]?.activeSessionId).toBe('selected')
    expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
  })

  it('adopts a session assigned by the current send', async () => {
    mockHermesSend(async () => ({ messageId: 'remote', acceptedAt: 1, sessionId: 'assigned-by-platform' }))

    await store().sendMessage(bot.id, 'Hi')

    expect(store().bots[0]?.activeSessionId).toBe('assigned-by-platform')
    expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
  })

  it.each([
    { ok: false, status: 503, message: 'Gateway temporarily unavailable' },
    { ok: true, data: {} }
  ])('keeps the Hermes session and history when creation fails with %j', async (response) => {
    vi.stubGlobal('window', { electron: { hermes: { rpc: async () => response } } })
    const previous = { ...row('existing-message'), role: 'user' as const, botId: bot.id, accountId: bot.activeAccountId }
    useBotStore.setState({ messages: { [bot.id]: [previous] } })

    expect(await store().startNewHermesSession(bot.id)).toBe(false)
    expect(store().bots[0]?.activeSessionId).toBe('initial')
    expect(store().messages[bot.id]).toEqual([previous])
    expect(store().hermesSessionErrors[bot.id]).toBeTruthy()
  })

  it('gives each new legacy Hermes chat its own key without reusing a cached native session', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { sessionId: 'old-native-session', text: 'old reply' } })
      .mockResolvedValueOnce({ ok: false, status: 404, message: 'Not supported' })
      .mockResolvedValueOnce({ ok: true, data: { text: 'new reply' } })
      .mockResolvedValueOnce({ ok: false, status: 405, message: 'Not supported' })
      .mockResolvedValueOnce({ ok: true, data: { text: 'another reply' } })
    vi.stubGlobal('window', { electron: { hermes: { rpc, onEvent: () => () => undefined } } })
    vi.spyOn(adapterRegistry, 'get').mockReturnValue(new HermesAdapter())

    await store().sendMessage(bot.id, 'Old conversation')
    expect(store().bots[0]?.activeSessionId).toBe('old-native-session')
    expect(await store().startNewHermesSession(bot.id)).toBe(true)
    const firstKey = store().bots[0]?.hermesSessionKey
    expect(firstKey).toBeTruthy()
    expect(store().messages[bot.id]).toEqual([])
    await store().sendMessage(bot.id, 'First legacy chat')
    expect(rpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sessionId: undefined, sessionKey: firstKey
    }))

    expect(await store().startNewHermesSession(bot.id)).toBe(true)
    const secondKey = store().bots[0]?.hermesSessionKey
    expect(secondKey).toBeTruthy()
    expect(secondKey).not.toBe(firstKey)
    await store().sendMessage(bot.id, 'Second legacy chat')
    expect(rpc).toHaveBeenNthCalledWith(5, expect.objectContaining({
      sessionId: undefined, sessionKey: secondKey
    }))
  })
})
