import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { WebContentsViewManager } from '../webContentsViewManager'
import { MuseSessionManager } from './museSessionManager'
import type { SubscriptionHandle } from '../muse-native/gateway'

const mocks = vi.hoisted(() => ({
  applyProxy: vi.fn(),
  getCookies: vi.fn(),
  removeCookie: vi.fn(),
  fetch: vi.fn(),
  partition: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: vi.fn(),
  Notification: { isSupported: () => false },
  session: { fromPartition: mocks.partition },
  shell: {}
}))
vi.mock('./accountProxy', () => ({
  applyProxyToPartition: mocks.applyProxy,
  createProxyAgent: vi.fn(),
  releaseProxyPoolAccount: vi.fn()
}))
vi.mock('../webContentsViewManager', () => ({
  partitionForAccount: (id: string) => `persist:${id}`,
  webViewId: (botId: string, accountId: string) => `${botId}:${accountId}`,
  WebContentsViewManager: vi.fn()
}))
vi.mock('../googleOAuthUaGuard', () => ({ installGoogleOAuthHeaderGuard: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function hatch(value: string) {
  return { name: 'hatch_sess', value, domain: 'muse.ai', path: '/', secure: true }
}

describe('Muse session lifecycle', () => {
  let manager: MuseSessionManager
  let cookies: EventEmitter
  let execute: ReturnType<typeof vi.fn>
  let clearPartition: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    cookies = Object.assign(new EventEmitter(), { get: mocks.getCookies, remove: mocks.removeCookie })
    mocks.applyProxy.mockResolvedValue(undefined)
    mocks.getCookies.mockResolvedValue([])
    mocks.partition.mockReturnValue({ cookies, fetch: mocks.fetch, getUserAgent: () => 'Chrome/136.0' })
    execute = vi.fn().mockResolvedValue({ ready: true, hook: 'dom' })
    clearPartition = vi.fn().mockResolvedValue(undefined)
    const view = { webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => 'https://muse.ai', setWindowOpenHandler: vi.fn(), executeJavaScript: execute
    }) }
    manager = new MuseSessionManager(
      { isDestroyed: () => true } as unknown as BrowserWindow,
      { getView: () => view, destroy: vi.fn(), clearPartition, setPinned: vi.fn() } as unknown as WebContentsViewManager
    )
  })

  afterEach(() => {
    manager.destroyAll()
    vi.unstubAllEnvs()
  })

  it('coalesces account initialization and refuses to recreate state after disposal', async () => {
    const pending = deferred<void>()
    mocks.applyProxy.mockReturnValueOnce(pending.promise)
    const first = manager.ensure('bot', 'account')
    const second = manager.ensure('bot', 'account')
    await vi.waitFor(() => expect(mocks.applyProxy).toHaveBeenCalledOnce())
    const results = Promise.allSettled([first, second])
    manager.destroyAccount('account')
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    pending.resolve()
    await Promise.resolve()
    expect(manager.getStatus('account')).toBeUndefined()
    expect(mocks.getCookies).not.toHaveBeenCalled()
  })

  it('holds new work during a proxy update and aborts any stale cookie read', async () => {
    const read = deferred<ReturnType<typeof hatch>[]>()
    mocks.getCookies.mockReturnValueOnce(read.promise)
    const ensure = manager.ensure('bot', 'account')
    await vi.waitFor(() => expect(mocks.getCookies).toHaveBeenCalledOnce())
    const outcome = expect(ensure).rejects.toThrow('proxy updated')
    const resume = manager.pauseAccountProxy('account')
    await outcome
    const replacement = manager.ensure('bot', 'account')
    read.resolve([hatch('old')])
    await Promise.resolve()
    expect(mocks.getCookies).toHaveBeenCalledOnce()
    resume()
    await expect(replacement).resolves.toMatchObject({ signedIn: false })
  })

  it('checks the replacement login after a slow 401 without clearing fresh cookies', async () => {
    vi.stubEnv('BOTHUB_MUSE_TRANSPORT', 'hook')
    const response = deferred<Response>()
    let cookie = hatch('old')
    mocks.getCookies.mockImplementation(async () => [cookie])
    mocks.fetch.mockReturnValueOnce(response.promise).mockResolvedValueOnce(new Response('{"ok":true}'))
    const login = manager.openLogin('bot', 'account')
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
    cookie = hatch('replacement')
    cookies.emit('changed', {}, cookie, 'explicit', false)
    response.resolve(new Response('', { status: 401 }))
    await expect(login).resolves.toMatchObject({ signedIn: true })
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/check'))).toHaveLength(2)
    expect(mocks.removeCookie).not.toHaveBeenCalled()
    expect(cookies.listenerCount('changed')).toBe(0)
  })

  it('waits for partition cleanup before a new session can read its cookies', async () => {
    await manager.ensure('bot', 'account')
    const clear = deferred<void>()
    clearPartition.mockReturnValueOnce(clear.promise)
    const signOut = manager.signOut('account')
    const replacement = manager.ensure('bot', 'account')
    await Promise.resolve()
    expect(mocks.getCookies).toHaveBeenCalledOnce()
    clear.resolve()
    await signOut
    await expect(replacement).resolves.toMatchObject({ signedIn: false })
    expect(mocks.getCookies).toHaveBeenCalledTimes(2)
  })

  it('deduplicates inspector subscriptions and discards a handle that opens after account disposal', async () => {
    await manager.ensure('bot', 'account')
    const opening = deferred<SubscriptionHandle>()
    const client = { gateway: { isReady: () => true, subscribe: vi.fn(() => opening.promise) } }
    const internals = manager as unknown as {
      native: { peek: (accountId: string) => unknown }
      ensureSubscription: (accountId: string, method: string, onEvent: () => Promise<unknown>) => void
    }
    vi.spyOn(internals.native, 'peek').mockReturnValue(client)
    const onEvent = vi.fn().mockResolvedValue(undefined)
    internals.ensureSubscription('account', 'tasks.subscribe', onEvent)
    internals.ensureSubscription('account', 'tasks.subscribe', onEvent)
    expect(client.gateway.subscribe).toHaveBeenCalledOnce()
    manager.destroyAccount('account')
    const cancel = vi.fn()
    opening.resolve({ cancel, ack: Promise.resolve({}), done: Promise.resolve() })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('disposed'))
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('keeps a newly allocated session separate from the selected direct session and rejects explicit DOM sends', async () => {
    vi.stubEnv('BOTHUB_MUSE_TRANSPORT', 'hook')
    mocks.getCookies.mockResolvedValue([hatch('signed-in')])
    await manager.ensure('direct-bot', 'account')
    type Internals = { sessions: Map<string, { botId: string; activeSessionId?: string }> }
    const session = (manager as unknown as Internals).sessions.get('account')!
    session.activeSessionId = 'direct-session'
    const rpc = vi.spyOn(manager, 'rpc').mockResolvedValue({ session_id: 'room-session' })
    await expect(manager.startSession('account')).resolves.toEqual({ sessionId: 'room-session' })
    expect(rpc).toHaveBeenCalledWith('account', 'session.start', { method: '/api/session/start', params: {} })
    expect(session.activeSessionId).toBe('direct-session')
    expect(session.botId).toBe('direct-bot')
    rpc.mockRestore()
    await expect(manager.rpc('account', 'chat.stream', { session_id: 'room-session', items: [] }, 'room-turn-1', 'send'))
      .rejects.toThrow('DOM fallback cannot send to an explicit session')
    expect(execute.mock.calls.some(([script]) => String(script).includes('await window.__bothubMuse.domSendChat'))).toBe(false)
    expect(session.activeSessionId).toBe('direct-session')
  })

  it('does not deliver room or unscoped watcher messages to the direct chat', async () => {
    await manager.ensure('direct-bot', 'account')
    const internals = manager as unknown as {
      sessions: Map<string, { activeSessionId?: string }>
      onChatWatchEvent(accountId: string, event: { name: string; payload: object }): void
    }
    internals.sessions.get('account')!.activeSessionId = 'direct'
    const listener = vi.fn()
    manager.onEvent(listener)
    for (const session_id of ['room', undefined, 'direct']) {
      internals.onChatWatchEvent('account', {
        name: 'message.assistant', payload: { session_id, message_id: 'message', display_text: 'Reply' }
      })
    }
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'stream', conversationId: 'direct-bot', sessionId: 'direct', text: 'Reply'
    }))
  })

  it('stops only the matching room send and ignores generic Stop and stale send IDs', async () => {
    vi.stubEnv('BOTHUB_MUSE_TRANSPORT', 'hook')
    await manager.ensure('direct-bot', 'account')
    execute.mockImplementation(async (script: string) => {
      if (script.includes('sendRequest("chat.stream"')) return new Promise<never>(() => undefined)
      return { ready: true, hook: 'sendRequest' }
    })
    const send = manager.rpc('account', 'chat.stream', { session_id: 'room-session' }, 'room-turn-1', 'room-send')
    await vi.waitFor(() => expect(execute.mock.calls.some(([script]) => String(script).includes('sendRequest("chat.stream"'))).toBe(true))
    await manager.cancelChat('account')
    await manager.cancelChat('account', 'direct-session')
    await manager.rpc('account', 'chat.stop_turn', undefined, undefined, 'old-send')
    expect(execute.mock.calls.some(([script]) => String(script).includes('sendRequest("chat.cancel"'))).toBe(false)
    const stopped = expect(send).rejects.toMatchObject({ name: 'AbortError' })
    await manager.rpc('account', 'chat.stop_turn', undefined, undefined, 'room-send')
    await stopped
    await vi.waitFor(() => expect(execute.mock.calls.filter(([script]) =>
      String(script).includes('sendRequest("chat.cancel", {"session_id":"room-session"}')
    )).toHaveLength(1))
  })
})
