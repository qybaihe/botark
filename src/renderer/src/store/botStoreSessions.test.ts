import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesAdapter } from '@adapters/hermes/HermesAdapter'
import { adapterRegistry } from '@adapters/registry'
import type { PlatformAdapter, PlatformId, SendReceipt } from '@adapters/types'
import type { Bot, BotAccount, ChatMediaPart, ChatMessage } from '@/types'
import { disambiguateGrokBotName, grokNamesForOtherAccounts, materializeAccounts, newCueBotName, syncedCueBotName, uniqueGroupName } from './botNaming'
import { cancelPlatformTurn, flushWorkspacePersistence, poolAccountIds, PROXY_POOL_PLATFORMS, proxyPoolArgsForAccounts, uniqueBotName, useBotStore } from './botStore'
import { SEND_HARD_TIMEOUT_MS, SEND_STILL_PENDING_TEXT, SEND_TIMEOUT_TEXT } from './delivery'
import {
  antigravityHistory, cueHistory, dotHistory, grokHistory, harkHistory, hermesHistory, mergeHydratedMessages,
  mergeIncomingReply, mergeReplyDelta, museHistory, sameChatMessage
} from './historyNormalizers'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
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
const hermesHistoryResponse = (id: string) => ({ ok: true, data: [row(id)] })
const grokHistoryResponse = (id: string) => ({ ok: true, data: { hydrated: [row(id)] } })
const store = useBotStore.getState

function mockHermesSend(sendMessage: PlatformAdapter['sendMessage']) {
  const adapter = new HermesAdapter()
  const send = vi.spyOn(adapter, 'sendMessage').mockImplementation(sendMessage)
  vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)
  return send
}

const chatMessage = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  ...row(id), role: 'user', botId: bot.id, accountId: bot.activeAccountId, ...patch
})
const connected = (platformId: PlatformId, id = bot.activeAccountId): BotAccount => ({
  id, platformId, displayName: id, handle: '', status: 'online'
})

describe('bot naming', () => {
  it('uses case-insensitive suffixes and keeps the group and bot whitespace rules', () => {
    const groups = [{ id: 'group-a', name: 'NEW SECTION' }, { id: 'group-b', name: ' New section 2 ' }]
    expect(uniqueGroupName(groups)).toBe('New section 2')
    expect(uniqueBotName([{ name: ' BOT ' }, { name: 'bot 2' }], '   ')).toBe('Bot 3')
  })

  it('qualifies cross-account Grok names against the current batch', () => {
    const bots: Bot[] = [
      { ...bot, platformId: 'grok', accountIds: ['other-account'], name: ' Editor ' },
      { ...bot, platformId: 'grok', name: 'Local' }
    ]
    const otherNames = grokNamesForOtherAccounts(bots, 'account-a')
    expect(disambiguateGrokBotName(bots, ' Local ', otherNames, 'work')).toBe('Local')
    expect(disambiguateGrokBotName(bots, 'Editor', otherNames, 'work')).toBe('Editor (work)')
    bots.push({ ...bot, platformId: 'grok', name: 'EDITOR (WORK)' })
    expect(disambiguateGrokBotName(bots, 'Editor', otherNames, 'work')).toBe('Editor (work) 2')
  })

  it('names new and upgraded Cue bots while preserving custom names', () => {
    const placeholder = { name: 'Cue · work', selectedAgentId: 'cue_default_account-a' }
    const agent = { id: 'editor', name: ' Editor ' }
    expect(newCueBotName([placeholder], ' Cue Bot ', 'work')).toBe('Cue · work 2')
    expect(syncedCueBotName([{ name: 'cue · editor (work)' }], placeholder, agent, 'work')).toBe('Cue · Editor (work) 2')
    expect(syncedCueBotName([], { ...placeholder, name: 'Custom' }, agent, 'work')).toBe('Custom')
  })

  it('reuses account partitions and assigns a platform name to unnamed drafts with a partition', () => {
    const existing = connected('dot', 'existing')
    const draft = { displayName: ' ', handle: ' ', accountId: existing.id }
    const result = materializeAccounts('dot', [
      { ...draft, key: 'first' },
      { ...draft, key: 'duplicate' },
      { ...draft, key: 'blank', accountId: undefined },
      { ...draft, key: 'new', accountId: 'partition', importKey: 'fingerprint' }
    ], { [existing.id]: existing })
    expect(result).toEqual({
      ids: ['existing', 'partition'],
      created: { partition: { id: 'partition', platformId: 'dot', displayName: 'Dot', handle: '', status: 'offline', importKey: 'fingerprint' } }
    })
  })

  it('preserves existing proxy slots during targeted assignment', () => {
    const accounts = { dot: connected('dot', 'dot'), muse: connected('meta-muse', 'muse'), hermes: connected('hermes', 'hermes') }
    expect([...PROXY_POOL_PLATFORMS]).toEqual(['meta-muse', 'grok', 'dot', 'hark', 'gemini', 'antigravity', 'cue'])
    expect(poolAccountIds(accounts)).toMatchObject({ assignableIds: ['muse', 'dot'], keepIds: ['dot', 'hermes'] })
    expect(proxyPoolArgsForAccounts(accounts, ['dot', 'new', 'dot', 'hermes'])).toEqual({
      accountIds: ['dot', 'new'], keepIds: ['muse', 'hermes']
    })
  })
})

describe('history normalizers', () => {
  const { id: botId, activeAccountId: accountId } = bot
  const media: ChatMediaPart[] = [{ kind: 'image', path: 'image' }]
  const tools: NonNullable<ChatMessage['tools']> = [{ id: 'tool', name: 'Search', status: 'completed' }]

  it('maps Hark content, narration, and tool calls with stable role-specific IDs', () => {
    const messages = harkHistory({ messages: [
      { id: 'ask', role: 'USER', content: '  question ', createdAt: 0 },
      { id: 'blank', role: 'assistant', content: ' ' },
      { id: 'reply', role: 'assistant', narration: 'Searching', media, createdAt: '2026-01-01T00:00:00Z',
        toolCalls: [{ dispatchId: 'tool', name: 'Search', status: 'failed' }] },
      { id: 'thought', role: 'assistant', thought: 'x'.repeat(145), createdAt: 1 }
    ] }, botId, accountId)
    expect(messages).toMatchObject([
      { id: 'hark_u_ask', role: 'user', text: 'question', createdAt: 0, delivery: 'sent' },
      { id: 'hark_reply', role: 'bot', text: '', media, createdAt: Date.UTC(2026, 0, 1),
        tools: [{ id: 'tool', name: 'Search', status: 'errored', summary: 'Searching' }] },
      { id: 'hark_thought', tools: [{ id: 'hark_thought_thought', name: 'Thinking', summary: 'x'.repeat(140) }] }
    ])
  })

  it('normalizes Dot prefixes and retains media-only rows', () => {
    const messages = dotHistory([
      { id: 'dot_dot_u_ask', role: 'user', text: ' question ', createdAtMs: 1 },
      { id: 'dot_u_dot_reply', role: 'bot', text: ' ', createdAtMs: 2, media },
      { id: 'blank', role: 'bot', text: ' ' }
    ], botId, accountId)
    expect(messages).toMatchObject([
      { id: 'dot_u_ask', role: 'user', text: 'question', createdAt: 1, delivery: 'sent' },
      { id: 'dot_reply', role: 'bot', text: '', createdAt: 2, media }
    ])
  })

  it('keeps Cue zero timestamps and filters invalid rows', () => {
    const messages = cueHistory([
      null,
      { id: 7, role: 'user', text: 'invalid' },
      { id: 'unknown-role', role: 'assistant', text: 'invalid' },
      { id: 'blank', role: 'bot', text: ' ' },
      { id: 'valid', role: 'user', text: ' question ', createdAtMs: 0 }
    ], botId, accountId, 'agent')
    expect(messages).toEqual([
      { id: 'valid', botId, accountId, agentId: 'agent', role: 'user', text: 'question', createdAt: 0, delivery: 'sent' }
    ])
  })

  it('distinguishes missing Grok history from an empty transcript and preserves row coercions', () => {
    expect(grokHistory({}, botId, accountId, 'agent')).toBeUndefined()
    expect(grokHistory({ hydrated: [] }, botId, accountId, 'agent')).toEqual([])
    expect(grokHistory({ hydrated: [{ role: 'user', text: false, createdAt: '20', media, tools: [] }] }, botId, accountId, 'agent')).toEqual([
      { id: 'grok_h_0', botId, accountId, agentId: 'agent', role: 'user', text: 'false', createdAt: 20,
        delivery: 'sent', media, tools: [] }
    ])
  })

  it('keeps the distinct Muse, Hermes, and Antigravity attachment fields', () => {
    const message = { id: 'reply', text: ' reply ', createdAt: 0, media, tools }
    expect(museHistory([{ ...message, role: 'bot', widgets: [] }], botId, accountId)).toMatchObject([
      { ...message, role: 'bot', widgets: [] }
    ])
    const rows = [{ ...message, role: 'assistant' }]
    expect(hermesHistory(rows, botId, accountId)).toMatchObject([{ ...message, role: 'bot' }])
    expect(antigravityHistory({ messages: rows }, botId, accountId)).toEqual([
      { id: 'reply', botId, accountId, role: 'bot', text: ' reply ', createdAt: 0, delivery: undefined, tools }
    ])
  })

  it('keeps an in-flight send ID and hydrates a live placeholder with a legacy Dot ID', () => {
    const pending = chatMessage('msg_pending', { text: ' question ', delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })
    const live = chatMessage('dot_dot_reply', { role: 'bot', text: '[消息内容较大…]', createdAt: 10, media })
    const otherAccount = chatMessage('other', { accountId: 'another-account' })
    const existing = [pending, live, otherAccount]
    const hydrated = [
      chatMessage('stored', { text: 'question', createdAt: 2, delivery: 'sent' }),
      chatMessage('dot_reply', { role: 'bot', text: 'hydrated reply', createdAt: 11 })
    ]
    expect(mergeHydratedMessages(existing, [])).toBe(existing)
    expect(mergeHydratedMessages(existing, hydrated, [pending, otherAccount])).toMatchObject([
      { id: 'msg_pending', text: 'question', createdAt: 2, delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT },
      { id: 'dot_reply', text: 'hydrated reply', createdAt: 10, media }
    ])
  })

  it('merges media by path and detects a shallowly identical final reply', () => {
    const previous = chatMessage('reply', { role: 'bot', text: 'streamed', media: [{ kind: 'file', path: 'image', name: 'Original' }] })
    const incoming = { id: 'reply', conversationId: botId, accountId, text: '[Message body omitted]', createdAt: 2,
      media: [{ kind: 'image' as const, path: 'image', name: 'Replacement', mimeType: 'image/png' }] }
    const reply = mergeIncomingReply(previous, incoming, bot, false)
    expect(reply).toMatchObject({ text: 'streamed', createdAt: 1, media: [
      { kind: 'image', path: 'image', name: 'Original', mimeType: 'image/png' }
    ] })
    const repeated = mergeIncomingReply(reply, incoming, bot, false)
    expect(repeated.media).toBe(reply.media)
    expect(sameChatMessage(reply, repeated)).toBe(true)
    const final = mergeIncomingReply(reply, { ...incoming, text: '' }, bot, true)
    expect(final.text).toBe('')
    expect(mergeReplyDelta(final, { text: 'late snapshot', media: incoming.media }, true)).toBe(final)
  })
})

describe('platform cancellation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['Gateway refused to stop', 'Gateway refused to stop'],
    ['', '未能确认停止 Hermes 运行']
  ])('rejects an unconfirmed Hermes stop with %j', async (message, expected) => {
    const rpc = vi.fn().mockResolvedValue({ ok: false, message })
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })
    await expect(cancelPlatformTurn(bot)).rejects.toThrow(expected)
    expect(rpc).toHaveBeenCalledExactlyOnceWith({ accountId: bot.activeAccountId, op: 'stopRun' })
  })

  it('passes the selected session to Muse and propagates its cancellation error', async () => {
    const cancelChat = vi.fn().mockRejectedValue(new Error('Muse cancel failed'))
    vi.stubGlobal('window', { electron: { muse: { cancelChat } } })
    await expect(cancelPlatformTurn({ ...bot, platformId: 'meta-muse' })).rejects.toThrow('Muse cancel failed')
    expect(cancelChat).toHaveBeenCalledExactlyOnceWith(bot.activeAccountId, bot.activeSessionId)
  })

  it('attempts both Hark cancellations even if one rejects', async () => {
    const rpc = vi.fn().mockRejectedValueOnce(new Error('Pause failed')).mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    await expect(cancelPlatformTurn({ ...bot, platformId: 'hark' })).resolves.toBeUndefined()
    expect(rpc.mock.calls.flat()).toEqual(['/messages/pause-agent', '/messages/stop-tool'].map((path) => ({
      accountId: bot.activeAccountId, op: 'call', method: 'POST', path, body: { conversationId: bot.activeSessionId }
    })))
  })

  it('ignores failed Grok, Dot, and Antigravity cancellation requests', async () => {
    const failure = new Error('Already stopped')
    const grok = vi.fn().mockRejectedValue(failure)
    const dot = vi.fn().mockRejectedValue(failure)
    const antigravity = vi.fn().mockRejectedValue(failure)
    vi.stubGlobal('window', { electron: {
      grok: { rpc: grok }, dot: { rpc: dot }, antigravity: { cancelRun: antigravity }
    } })
    await cancelPlatformTurn({ ...bot, platformId: 'grok' })
    expect(grok).not.toHaveBeenCalled()
    await expect(cancelPlatformTurn({ ...bot, platformId: 'grok', selectedAgentId: 'agent' })).resolves.toBeUndefined()
    await expect(cancelPlatformTurn({ ...bot, platformId: 'dot' })).resolves.toBeUndefined()
    await expect(cancelPlatformTurn({ ...bot, platformId: 'antigravity' })).resolves.toBeUndefined()
    expect(grok).toHaveBeenCalledExactlyOnceWith({
      accountId: bot.activeAccountId, op: 'call', method: 'InterruptGrokBotAgentRun',
      params: { agent_id: 'agent', reason: 'user_interrupt', session_id: bot.activeSessionId }
    })
    expect(dot).toHaveBeenCalledExactlyOnceWith({ accountId: bot.activeAccountId, op: 'cancelTurn' })
    expect(antigravity).toHaveBeenCalledExactlyOnceWith(bot.activeAccountId)
  })
})

describe('session navigation', () => {
  beforeEach(() => {
    useBotStore.setState({
      bots: [bot], messages: {}, accounts: {}, replyingTo: {}, typing: {}, activity: {},
      chatActionErrors: {}, hermesSessionErrors: {}, selectedBotId: bot.id
    })
  })

  afterEach(() => {
    flushWorkspacePersistence()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the selected Gemini transcript when an older history load completes late', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'gemini' }], messages: { [bot.id]: [chatMessage('previous')] } })
    const slow = deferred<ReturnType<typeof row>[]>()
    const getHistory = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce([row('latest')])
    const deleteSession = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { electron: { gemini: { getHistory, deleteSession } } })
    const first = store().switchGeminiSession(bot.id, 'old')
    await store().switchGeminiSession(bot.id, 'new')
    slow.resolve([row('stale')])
    await first
    expect(store().bots[0]?.activeSessionId).toBe('new')
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['latest'])
    await store().deleteGeminiSession(bot.id, 'new')
    expect(store().bots[0]?.activeSessionId).toBeUndefined()
    expect(store().messages[bot.id]).toEqual([])
  })

  it('drops observer snapshots from the previous Hark session or account', () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }] })
    const history = [{ id: 'visible', role: 'assistant', content: 'fixture' }]
    store().applyHarkHistory(bot.id, bot.activeAccountId, 'old', history)
    store().applyHarkHistory(bot.id, 'other', 'initial', history)
    expect(store().messages[bot.id]).toBeUndefined()
    store().applyHarkHistory(bot.id, bot.activeAccountId, 'initial', history)
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['hark_visible'])
  })

  it('keeps the selected Hark project when an earlier snapshot arrives late', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }] })
    const pending = deferred<unknown>()
    const rpc = vi.fn().mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, data: { conversationId: 'new', messages: [] } })
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    const first = store().switchHarkSession(bot.id, 'previous')
    await store().switchHarkSession(bot.id, 'new')
    pending.resolve({ ok: true, data: { conversationId: 'previous', messages: [row('stale')] } })
    await first
    expect(store().bots[0]?.activeSessionId).toBe('new')
    expect(store().messages[bot.id]).toEqual([])
  })

  it('keeps the most recently selected Hermes history when requests finish out of order', async () => {
    const first = deferred<ReturnType<typeof hermesHistoryResponse>>()
    const second = deferred<ReturnType<typeof hermesHistoryResponse>>()
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })

    const firstLoad = store().switchHermesSession(bot.id, 'session-a')
    const secondLoad = store().switchHermesSession(bot.id, 'session-b')
    second.resolve(hermesHistoryResponse('message-b'))
    await secondLoad
    first.resolve(hermesHistoryResponse('message-a'))
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

  it.each([
    () => Promise.reject(new Error('Muse request failed')),
    () => Promise.resolve({ sessionId: null }),
    () => Promise.resolve({ sessionId: '   ' })
  ])('keeps the current Muse transcript on a rejected or invalid session creation', async (startSession) => {
    const previous = [chatMessage('kept')]
    useBotStore.setState({ bots: [{ ...bot, platformId: 'meta-muse' }], messages: { [bot.id]: previous } })
    vi.stubGlobal('window', { electron: { muse: { startSession } } })
    await store().startNewMuseSession(bot.id)
    expect(store().bots[0]?.activeSessionId).toBe('initial')
    expect(store().messages[bot.id]).toBe(previous)
    expect(store().chatActionErrors[bot.id]).toMatch(/Muse (request failed|returned no session ID)/)
  })

  it('clears a pending quote, active typing and busy activity when switching sessions within one bot', async () => {
    const account = { ...connected('meta-muse'), status: 'busy' as const }
    useBotStore.setState({
      bots: [{ ...bot, platformId: 'meta-muse' }], accounts: { [account.id]: account },
      messages: { [bot.id]: [chatMessage('kept')] },
      typing: { [bot.id]: true },
      activity: { [account.id]: { code: 'work', text: 'Working', busy: true, emoji: null } }
    })
    store().setReplyTarget(bot.id, { messageId: 'kept', entryId: 'kept', quote: 'old quote', role: 'user' })
    vi.stubGlobal('window', { electron: { muse: { startSession: async () => ({ sessionId: 'new' }) } } })
    await store().startNewMuseSession(bot.id)

    expect(store().bots[0]?.activeSessionId).toBe('new')
    expect(store().messages[bot.id]).toEqual([])
    expect(store().replyingTo[bot.id]).toBeUndefined()
    expect(store().typing[bot.id]).toBeUndefined()
    expect(store().activity[account.id]).toBeUndefined()
    expect(store().accounts[account.id]?.status).toBe('online')
  })

  it.each(['meta-muse', 'hermes', 'antigravity'] as const)(
    'merges %s history with messages sent and streamed during a history load',
    async (platformId) => {
      const history = deferred<unknown>()
      const account = connected(platformId)
      useBotStore.setState({
        bots: [{ ...bot, platformId }], accounts: { [account.id]: account },
        messages: { [bot.id]: [chatMessage('old transcript')] }
      })
      vi.spyOn(adapterRegistry, 'get').mockReturnValue({
        sendMessage: async () => ({ acceptedAt: 10, messageId: 'sent', sessionId: 'selected' })
      } as unknown as PlatformAdapter)
      vi.stubGlobal('window', { electron: {
        muse: { loadSessionHistory: () => history.promise },
        hermes: { rpc: () => history.promise },
        antigravity: { rpc: () => history.promise }
      } })
      const load = platformId === 'meta-muse' ? store().switchMuseSession
        : platformId === 'hermes' ? store().switchHermesSession : store().switchAntigravitySession
      const loading = load(bot.id, 'selected')
      const now = Date.now()
      await store().sendMessage(bot.id, 'repeat')
      await store().sendMessage(bot.id, 'repeat')
      store().applyMessageDelta('streaming', bot.id, account.id, 'current streaming text')
      store().applyMessageDelta('local-answer', bot.id, account.id, 'final snapshot with a different ID')
      const rows = [
        { ...row('history'), createdAt: now - 1000 },
        { ...row('stored-user'), text: 'repeat', createdAt: now },
        { ...row('streaming'), role: platformId === 'meta-muse' ? 'bot' : 'assistant', text: 'stale', createdAt: now },
        { ...row('remote-answer'), role: platformId === 'meta-muse' ? 'bot' : 'assistant', text: 'final snapshot with a different ID', createdAt: now },
        { ...row('later-history'), createdAt: now + 20_000 }
      ]
      history.resolve(platformId === 'meta-muse' ? rows
        : { ok: true, data: platformId === 'hermes' ? rows : { messages: rows } })
      await loading
      const messages = store().messages[bot.id] ?? []
      expect(messages.map((message) => message.text)).toEqual([
        'history', 'repeat', 'repeat', 'current streaming text', 'final snapshot with a different ID', 'later-history'
      ])
      expect(messages.filter((message) => message.id === 'streaming')).toHaveLength(1)
      expect(messages.filter((message) => message.id === 'local-answer')).toHaveLength(1)
      expect(messages.filter((message) => message.text === 'repeat').map((message) => message.delivery)).toEqual(['sent', 'sent'])
    }
  )

  it('does not let a Cue history request block or replace history for a different agent', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const latest = deferred<unknown>()
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(latest.promise)
    const account = connected('cue')
    useBotStore.setState({ bots: [{ ...bot, platformId: 'cue', selectedAgentId: 'a', activeSessionId: undefined }], accounts: { [account.id]: account } })
    vi.stubGlobal('window', { electron: { cue: { rpc } } })
    const pending = store().hydrateCueBotHistory(bot.id)
    store().setSelectedAgent(bot.id, 'b')
    store().setSelectedAgent(bot.id, 'a')
    const response = (sessionId: string) => ({ ok: true, data: {
      sessionId, messages: [{ id: sessionId, text: sessionId, role: 'bot', createdAtMs: 1 }]
    } })
    latest.resolve(response('new-a'))
    await latest.promise
    second.resolve(response('old-b'))
    first.resolve(response('old-a'))
    await pending
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(store().bots[0]?.activeSessionId).toBe('new-a')
    expect(store().messages[bot.id]?.map((message) => message.id)).toEqual(['new-a'])
  })

  it('rejects a Hark snapshot that identifies a different session', async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'unrequested', messages: [] } })
    const messages = [chatMessage('kept')]
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }], messages: { [bot.id]: messages } })
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    await expect(store().switchHarkSession(bot.id, 'asked')).rejects.toThrow('Hark returned a different conversation')
    expect(store().bots[0]?.activeSessionId).toBe('initial')
    expect(store().messages[bot.id]).toBe(messages)
  })

  it('keeps a Hark project selection in flight when the account reconnects', async () => {
    const account = connected('hark')
    const project = deferred<unknown>()
    const rpc = vi.fn().mockReturnValueOnce(project.promise)
      .mockResolvedValue({ ok: true, data: { conversationId: 'incorrect-refresh', messages: [] } })
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      connect: async () => 'online'
    } as unknown as PlatformAdapter)
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    useBotStore.setState({
      bots: [{ ...bot, platformId: 'hark', activeSessionId: undefined }], accounts: { [account.id]: account }
    })
    const switching = store().switchHarkSession(bot.id, 'project')
    await store().connectAccount(account.id)
    project.resolve({ ok: true, data: { conversationId: 'project', messages: [] } })
    await switching
    expect(rpc).toHaveBeenCalledOnce()
    expect(store().bots[0]?.activeSessionId).toBe('project')
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
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hermesHistoryResponse('kept'))
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })

    const creating = store().startNewHermesSession(bot.id)
    await store().switchHermesSession(bot.id, 'existing')
    pending.resolve({ ok: true, data: { id: 'new' } })
    await creating

    expect(store().bots[0]?.activeSessionId).toBe('existing')
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['kept'])
  })

  it('ignores history from before an account switch, even after switching back', async () => {
    const pending = deferred<ReturnType<typeof hermesHistoryResponse>>()
    vi.stubGlobal('window', { electron: { hermes: { rpc: () => pending.promise } } })

    const loading = store().switchHermesSession(bot.id, 'session-a')
    store().setActiveAccount(bot.id, 'account-b')
    store().setActiveAccount(bot.id, 'account-a')
    pending.resolve(hermesHistoryResponse('stale'))
    await loading

    expect(store().messages[bot.id]).toBeUndefined()
  })

  it('ignores a Grok transcript from the first visit after returning to the same agent', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'grok', selectedAgentId: 'initial-agent' }] })
    const first = deferred<ReturnType<typeof grokHistoryResponse>>()
    const latest = deferred<ReturnType<typeof grokHistoryResponse>>()
    const rpc = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: false })
      .mockReturnValueOnce(latest.promise)
    vi.stubGlobal('window', { electron: { grok: { rpc } } })

    store().setSelectedAgent(bot.id, 'agent-a')
    store().setSelectedAgent(bot.id, 'agent-b')
    store().setSelectedAgent(bot.id, 'agent-a')
    latest.resolve(grokHistoryResponse('new-transcript'))
    await latest.promise
    first.resolve(grokHistoryResponse('stale-transcript'))
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

  it.each(['receipt', 'error'] as const)('holds delivery through timeout until a late %s settles', async (outcome) => {
    vi.useFakeTimers()
    const first = deferred<SendReceipt>()
    const retry = deferred<SendReceipt>()
    let oldAcceptance: (() => void) | undefined
    const sent = mockHermesSend((message) => {
      if (!oldAcceptance) {
        oldAcceptance = message.onAccepted
        return first.promise
      }
      return retry.promise
    })
    const sending = store().sendMessage(bot.id, 'Keep one transport open')
    const id = store().messages[bot.id]![0]!.id
    await vi.advanceTimersByTimeAsync(SEND_HARD_TIMEOUT_MS)
    await sending
    expect(store().messages[bot.id]?.[0]).toMatchObject({ delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })

    await store().retryMessage(bot.id, id)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(store().messages[bot.id]?.[0]).toMatchObject({ delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })
    if (outcome === 'receipt') {
      first.resolve({ messageId: 'first', acceptedAt: 2, sessionId: 'initial' })
      await first.promise
      expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
      await store().retryMessage(bot.id, id)
      expect(sent).toHaveBeenCalledTimes(1)
    } else {
      first.reject(new Error('transport went away'))
      await first.promise.catch(() => undefined)
      expect(store().messages[bot.id]?.[0]).toMatchObject({ delivery: 'no-reply', error: SEND_TIMEOUT_TEXT })
      const retrying = store().retryMessage(bot.id, id)
      oldAcceptance?.()
      expect(store().messages[bot.id]?.[0]?.delivery).toBe('sending')
      expect(sent).toHaveBeenCalledTimes(2)
      retry.resolve({ messageId: 'retry', acceptedAt: 3 })
      await retrying
      expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
    }
  })

  it('finishes removing a Cue account after its connect settles and discards the refresh already in flight', async () => {
    const connection = deferred<'online'>()
    const roster = deferred<unknown>()
    const account = connected('cue')
    const rpc = vi.fn().mockReturnValue(roster.promise)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const clearAuth = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      connect: () => connection.promise, disconnect
    } as unknown as PlatformAdapter)
    vi.stubGlobal('window', { electron: { cue: { rpc, clearAuth } } })
    useBotStore.setState({ bots: [{ ...bot, platformId: 'cue', accountIds: [account.id] }], accounts: { [account.id]: account } })
    const refresh = store().syncCueAccountBots(account.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith({ op: 'listAgents', accountId: account.id }))
    const connecting = store().connectAccount(account.id)
    const removing = store().removeBot(bot.id)
    roster.resolve({ ok: true, data: [{ id: 'agent', name: 'Agent' }] })
    expect(await refresh).toBe(0)
    expect(store().bots).toEqual([])
    expect(store().accounts[account.id]).toBeUndefined()
    connection.resolve('online')
    await Promise.all([connecting, removing])
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(account.id)
    expect(clearAuth).toHaveBeenCalledExactlyOnceWith(account.id)
    expect(store().bots).toEqual([])
  })

  it('does not recreate a deleted Cue bot from a shared account roster already loading', async () => {
    const account = connected('cue')
    const roster = deferred<unknown>()
    const first = { ...bot, platformId: 'cue' as const, accountIds: [account.id], selectedAgentId: 'gone' }
    useBotStore.setState({
      bots: [first, { ...first, id: 'kept', selectedAgentId: 'kept' }], accounts: { [account.id]: account }
    })
    const rpc = vi.fn().mockReturnValue(roster.promise)
    vi.stubGlobal('window', { electron: { cue: { rpc } } })
    const refresh = store().syncCueAccountBots(account.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled())
    await store().removeBot(first.id)
    roster.resolve({ ok: true, data: [{ id: 'gone' }, { id: 'kept' }] })
    expect(await refresh).toBe(0)
    expect(store().bots.map((item) => item.id)).toEqual(['kept'])
    expect(store().accounts[account.id]).toBeDefined()
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
