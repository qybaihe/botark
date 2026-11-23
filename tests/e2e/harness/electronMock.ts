import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

export const DEFAULT_ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BotArk/0.12.1 Chrome/136.0.0.0 Electron/45.2.1 Safari/537.36'

export interface MockCookie {
  name: string
  value: string
  domain?: string
  path?: string
  url?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

export interface BeforeSendHeadersListener {
  urls?: string[]
  cb: (
    details: { url: string; requestHeaders: Record<string, string> },
    callback: (resp: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void
  ) => void
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export class MockCookieStore extends EventEmitter {
  items: MockCookie[] = []

  async get(filter?: { url?: string; name?: string; domain?: string }): Promise<MockCookie[]> {
    return this.items.filter((c) => {
      if (filter?.name && c.name !== filter.name) return false
      if (filter?.domain && c.domain !== filter.domain) return false
      if (filter?.url) {
        try {
          const host = new URL(filter.url).hostname
          const dom = (c.domain || '').replace(/^\./, '')
          if (dom && host !== dom && !host.endsWith(`.${dom}`)) return false
        } catch {
          /* ignore */
        }
      }
      return true
    })
  }

  async set(details: MockCookie): Promise<void> {
    const domain =
      details.domain ||
      (() => {
        try {
          return details.url ? new URL(details.url).hostname : 'localhost'
        } catch {
          return 'localhost'
        }
      })()
    const entry: MockCookie = { ...details, domain, path: details.path || '/' }
    const idx = this.items.findIndex((c) => c.name === entry.name && c.domain === entry.domain)
    if (idx >= 0) this.items[idx] = entry
    else this.items.push(entry)
    this.emit('changed', {}, entry, 'explicit', false)
  }

  async remove(url: string, name: string): Promise<void> {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      host = url
    }
    const removed = this.items.filter(
      (c) => c.name === name && (!c.domain || c.domain.replace(/^\./, '') === host)
    )
    this.items = this.items.filter((c) => !removed.includes(c))
    for (const c of removed) this.emit('changed', {}, c, 'explicit', true)
  }

  async flushStore(): Promise<void> {
    /* noop */
  }
}

export class MockSession {
  readonly partition: string
  userAgent: string = DEFAULT_ELECTRON_UA
  setUserAgentCalls: string[] = []
  setProxyCalls: Array<{ proxyRules?: string; mode?: string; proxyBypassRules?: string }> = []
  closeAllConnectionsCalls = 0
  clearStorageDataCalls = 0
  clearCacheCalls = 0
  preloadScripts: Array<Record<string, unknown>> = []
  readonly beforeSendHeadersListeners: BeforeSendHeadersListener[] = []
  readonly cookies = new MockCookieStore()
  fetchResponder?: (url: string, init?: RequestInit) => Promise<Response> | Response

  constructor(partition: string) {
    this.partition = partition
  }

  getUserAgent(): string {
    return this.userAgent
  }

  setUserAgent(ua: string): void {
    this.userAgent = ua
    this.setUserAgentCalls.push(ua)
  }

  async setProxy(cfg: { proxyRules?: string; mode?: string; proxyBypassRules?: string }): Promise<void> {
    this.setProxyCalls.push(cfg)
  }

  async closeAllConnections(): Promise<void> {
    this.closeAllConnectionsCalls++
  }

  async clearStorageData(): Promise<void> {
    this.clearStorageDataCalls++
    this.cookies.items = []
  }

  async clearCache(): Promise<void> {
    this.clearCacheCalls++
  }

  registerPreloadScript(script: Record<string, unknown>): string {
    const id = `preload_${this.preloadScripts.length + 1}`
    this.preloadScripts.push({ id, ...script })
    return id
  }

  getPreloadScripts(): Array<Record<string, unknown>> {
    return [...this.preloadScripts]
  }

  readonly webRequest = {
    onBeforeSendHeaders: (
      filterOrCb: { urls?: string[] } | BeforeSendHeadersListener['cb'],
      maybeCb?: BeforeSendHeadersListener['cb']
    ): void => {
      if (typeof filterOrCb === 'function') {
        this.beforeSendHeadersListeners.push({ cb: filterOrCb })
      } else if (maybeCb) {
        this.beforeSendHeadersListeners.push({ urls: filterOrCb.urls, cb: maybeCb })
      }
    }
  }

  simulateBeforeSendHeaders(url: string, initialHeaders: Record<string, string>): Record<string, string> {
    let headers = { ...initialHeaders }
    for (const listener of this.beforeSendHeadersListeners) {
      const matched =
        !listener.urls ||
        listener.urls.length === 0 ||
        listener.urls.some((pat) => wildcardToRegex(pat).test(url))
      if (!matched) continue
      listener.cb({ url, requestHeaders: headers }, (resp) => {
        if (resp?.requestHeaders) headers = resp.requestHeaders
      })
    }
    return headers
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (this.fetchResponder) {
      return await this.fetchResponder(url, init)
    }
    const parsed = new URL(url)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]') {
      return await globalThis.fetch(input, init)
    }
    throw new Error(`[offline-guard] Blocked real network fetch to ${url}`)
  }
}

export interface WindowOpenResult {
  action: 'allow' | 'deny'
  overrideBrowserWindowOptions?: Record<string, unknown>
}

export class MockWebContents extends EventEmitter {
  readonly id: number
  readonly mainFrame: { id: number }
  readonly session: MockSession
  userAgent: string
  setUserAgentCalls: string[] = []
  currentUrl = 'about:blank'
  loadURLCalls: string[] = []
  destroyed = false
  sentMessages: Array<{ channel: string; args: unknown[] }> = []
  windowOpenHandler?: (details: { url: string; frameName?: string; disposition?: string }) => WindowOpenResult
  jsResponder?: (script: string, url: string) => unknown

  private readonly ownerWindow: MockBrowserWindow

  constructor(id: number, ownerWindow: MockBrowserWindow, ses: MockSession) {
    super()
    this.id = id
    this.mainFrame = { id: id * 100 + 1 }
    this.ownerWindow = ownerWindow
    this.session = ses
    this.userAgent = ses.getUserAgent()
  }

  getUserAgent(): string {
    return this.userAgent
  }

  setUserAgent(ua: string): void {
    this.userAgent = ua
    this.setUserAgentCalls.push(ua)
  }

  getURL(): string {
    return this.currentUrl
  }

  isDestroyed(): boolean {
    return this.destroyed || this.ownerWindow.isDestroyed()
  }

  setBackgroundThrottling(_throttled: boolean): void {
    /* noop */
  }

  setWindowOpenHandler(
    handler: (details: { url: string; frameName?: string; disposition?: string }) => WindowOpenResult
  ): void {
    this.windowOpenHandler = handler
  }

  triggerWindowOpen(url: string): { result: WindowOpenResult; childWindow?: MockBrowserWindow } {
    if (!this.windowOpenHandler) return { result: { action: 'deny' } }
    const result = this.windowOpenHandler({ url, frameName: '', disposition: 'new-window' })
    if (result.action === 'allow') {
      const child = new MockBrowserWindow({
        ...(result.overrideBrowserWindowOptions ?? {}),
        webPreferences: {
          ...((result.overrideBrowserWindowOptions?.webPreferences as Record<string, unknown>) ?? {}),
          partition:
            ((result.overrideBrowserWindowOptions?.webPreferences as Record<string, unknown>)?.partition as string) ??
            this.session.partition
        }
      })
      child.webContents.currentUrl = url
      this.emit('did-create-window', child, { url })
      return { result, childWindow: child }
    }
    return { result }
  }

  async loadURL(url: string): Promise<void> {
    if (this.isDestroyed()) return
    this.currentUrl = url
    this.loadURLCalls.push(url)
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    this.emit('did-navigate', {}, url)
    this.emit('did-finish-load')
  }

  reload(): void {
    if (this.isDestroyed()) return
    this.emit('did-finish-load')
  }

  async executeJavaScript(script: string): Promise<unknown> {
    if (this.jsResponder) return this.jsResponder(script, this.currentUrl)
    return false
  }

  send(channel: string, ...args: unknown[]): void {
    this.sentMessages.push({ channel, args })
    electronHarness.dispatchWebContentsSend(channel, ...args)
  }

  close(): void {
    this.destroyed = true
    this.ownerWindow.close()
  }
}

export class MockBrowserWindow extends EventEmitter {
  static nextId = 1
  static allWindows: MockBrowserWindow[] = []

  static getAllWindows(): MockBrowserWindow[] {
    return MockBrowserWindow.allWindows.filter((w) => !w.isDestroyed())
  }

  static fromWebContents(wc: unknown): MockBrowserWindow | null {
    return MockBrowserWindow.allWindows.find((w) => w.webContents === wc) ?? null
  }

  readonly id: number
  readonly options: Record<string, unknown>
  readonly webContents: MockWebContents
  destroyed = false
  visible = true
  readonly contentView = {
    children: [] as unknown[],
    addChildView: (v: unknown) => {
      this.contentView.children.push(v)
    },
    removeChildView: (v: unknown) => {
      this.contentView.children = this.contentView.children.filter((x) => x !== v)
    }
  }

  constructor(options: Record<string, unknown> = {}) {
    super()
    this.id = MockBrowserWindow.nextId++
    this.options = options
    const webPrefs = (options.webPreferences as Record<string, unknown> | undefined) ?? {}
    const partition = typeof webPrefs.partition === 'string' ? webPrefs.partition : 'persist:default'
    const ses = electronHarness.getSession(partition)
    this.webContents = new MockWebContents(this.id, this, ses)
    MockBrowserWindow.allWindows.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  show(): void {
    this.visible = true
  }

  focus(): void {
    /* noop */
  }

  hide(): void {
    this.visible = false
  }

  loadURL(url: string): Promise<void> {
    return this.webContents.loadURL(url)
  }

  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
  }
}

export class MockWebContentsView extends EventEmitter {
  readonly webContents: MockWebContents
  bounds = { x: 0, y: 0, width: 0, height: 0 }

  constructor(options: Record<string, unknown> = {}) {
    super()
    const webPrefs = (options.webPreferences as Record<string, unknown> | undefined) ?? {}
    const partition = typeof webPrefs.partition === 'string' ? webPrefs.partition : 'persist:default'
    const ses = electronHarness.getSession(partition)
    const dummyWin = new MockBrowserWindow({ webPreferences: { partition } })
    this.webContents = dummyWin.webContents
  }

  setBackgroundColor(_color: string): void {
    /* noop */
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }
}

class ElectronHarness {
  userDataDir = ''
  private createdTempDirs: string[] = []
  encryptionAvailable = true
  sessions = new Map<string, MockSession>()
  ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>()
  ipcListeners = new Map<string, (...args: unknown[]) => void>()
  eventSubscribers = new Map<string, Set<(...args: unknown[]) => void>>()
  openExternalCalls: string[] = []
  primaryWindow?: MockBrowserWindow

  showOpenDialogMock = vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }))
  showMessageBoxMock = vi.fn(async () => ({ response: 1 }))
  showSaveDialogMock = vi.fn(async () => ({ canceled: true, filePath: undefined as string | undefined }))
  openExternalMock = vi.fn(async (url: string) => {
    this.openExternalCalls.push(url)
  })

  ensureUserDataDir(): string {
    if (!this.userDataDir) {
      this.userDataDir = mkdtempSync(join(tmpdir(), 'botark-e2e-userdata-'))
      this.createdTempDirs.push(this.userDataDir)
    }
    return this.userDataDir
  }

  getSession(partition: string): MockSession {
    let ses = this.sessions.get(partition)
    if (!ses) {
      ses = new MockSession(partition)
      this.sessions.set(partition, ses)
    }
    return ses
  }

  ensurePrimaryWindow(): MockBrowserWindow {
    if (!this.primaryWindow || this.primaryWindow.isDestroyed()) {
      this.primaryWindow = new MockBrowserWindow({ webPreferences: { partition: 'persist:main' } })
    }
    return this.primaryWindow
  }

  reset(opts: { userDataDir?: string; preserveIpcHandlers?: boolean } = {}): string {
    if (opts.userDataDir) {
      this.userDataDir = opts.userDataDir
    } else {
      this.userDataDir = mkdtempSync(join(tmpdir(), 'botark-e2e-userdata-'))
      this.createdTempDirs.push(this.userDataDir)
    }
    this.encryptionAvailable = true
    this.sessions.clear()
    for (const w of MockBrowserWindow.allWindows) {
      w.destroyed = true
      w.webContents.destroyed = true
    }
    MockBrowserWindow.allWindows = []
    this.primaryWindow = undefined
    if (!opts.preserveIpcHandlers) {
      this.ipcHandlers.clear()
      this.ipcListeners.clear()
    }
    this.eventSubscribers.clear()
    this.openExternalCalls = []
    this.showOpenDialogMock.mockReset()
    this.showOpenDialogMock.mockImplementation(async () => ({ canceled: true, filePaths: [] }))
    this.showMessageBoxMock.mockReset()
    this.showMessageBoxMock.mockImplementation(async () => ({ response: 1 }))
    this.showSaveDialogMock.mockReset()
    this.showSaveDialogMock.mockImplementation(async () => ({ canceled: true, filePath: undefined }))
    this.openExternalMock.mockReset()
    this.openExternalMock.mockImplementation(async (url: string) => {
      this.openExternalCalls.push(url)
    })
    return this.userDataDir
  }

  cleanup(): void {
    for (const dir of this.createdTempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    this.userDataDir = ''
  }

  dispatchWebContentsSend(channel: string, ...args: unknown[]): void {
    const subs = this.eventSubscribers.get(channel)
    if (!subs) return
    for (const fn of subs) {
      try {
        fn(...args)
      } catch {
        /* ignore */
      }
    }
  }

  onChannelEvent(channel: string, listener: (...args: unknown[]) => void): () => void {
    let set = this.eventSubscribers.get(channel)
    if (!set) {
      set = new Set()
      this.eventSubscribers.set(channel, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  async invokeIpc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    const handler = this.ipcHandlers.get(channel)
    if (!handler) {
      throw new Error(`No IPC handler registered for channel: ${channel}`)
    }
    const win = this.ensurePrimaryWindow()
    const event = {
      sender: win.webContents,
      senderFrame: win.webContents.mainFrame
    }
    return (await handler(event, ...args)) as T
  }

  buildRendererBridge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const subChannel = (channel: string) => (listener: (ev: unknown) => void) =>
      this.onChannelEvent(channel, listener)

    return {
      workspace: {
        manage: (scope: string, req: unknown) => this.invokeIpc('botark:workspace', scope, req),
        run: (scope: string, tool: string, args: Record<string, unknown>, recipient: string) =>
          this.invokeIpc('botark:workspace', scope, { op: 'run', tool, args, recipient })
      },
      grok: {
        openLogin: (req: unknown) => this.invokeIpc('bothub:grok:open-login', req),
        cancelLogin: (accountId: string) => this.invokeIpc('bothub:grok:cancel-login', accountId),
        setAccessToken: (req: unknown) => this.invokeIpc('bothub:grok:set-access-token', req),
        clearAuth: (accountId: string) => this.invokeIpc('bothub:grok:clear-auth', accountId),
        authStatus: (accountId: string) => this.invokeIpc('bothub:grok:auth-status', accountId),
        getSession: (accountId: string) => this.invokeIpc('bothub:grok:get-session', accountId),
        rpc: (req: unknown) => this.invokeIpc('bothub:grok:rpc', req),
        onEvent: subChannel('bothub:grok:event')
      },
      dot: {
        openLogin: (req: unknown) => this.invokeIpc('bothub:dot:open-login', req),
        cancelLogin: (accountId: string) => this.invokeIpc('bothub:dot:cancel-login', accountId),
        importCredentials: (req: unknown) => this.invokeIpc('bothub:dot:import-credentials', req),
        clearAuth: (accountId: string) => this.invokeIpc('bothub:dot:clear-auth', accountId),
        authStatus: (accountId: string) => this.invokeIpc('bothub:dot:auth-status', accountId),
        rpc: (req: unknown) => this.invokeIpc('bothub:dot:rpc', req),
        onEvent: subChannel('bothub:dot:event')
      },
      hark: {
        openLogin: (req: unknown) => this.invokeIpc('bothub:hark:open-login', req),
        cancelLogin: (accountId: string) => this.invokeIpc('bothub:hark:cancel-login', accountId),
        importCredentials: (req: unknown) => this.invokeIpc('bothub:hark:import-credentials', req),
        clearAuth: (accountId: string) => this.invokeIpc('bothub:hark:clear-auth', accountId),
        authStatus: (accountId: string) => this.invokeIpc('bothub:hark:auth-status', accountId),
        rpc: (req: unknown) => this.invokeIpc('bothub:hark:rpc', req),
        onEvent: subChannel('bothub:hark:event')
      },
      antigravity: {
        openLogin: (req: unknown) => this.invokeIpc('bothub:antigravity:open-login', req),
        cancelLogin: (accountId: string) => this.invokeIpc('bothub:antigravity:cancel-login', accountId),
        clearAuth: (accountId: string) => this.invokeIpc('bothub:antigravity:clear-auth', accountId),
        authStatus: (accountId: string) => this.invokeIpc('bothub:antigravity:auth-status', accountId),
        sendMessage: (req: unknown) => this.invokeIpc('bothub:antigravity:send-message', req),
        cancelRun: (accountId: string) => this.invokeIpc('bothub:antigravity:cancel-run', accountId),
        onEvent: subChannel('bothub:antigravity:event')
      },
      cue: {
        openLogin: (req: unknown) => this.invokeIpc('bothub:cue:open-login', req),
        cancelLogin: (accountId: string) => this.invokeIpc('bothub:cue:cancel-login', accountId),
        importCredentials: (req: unknown) => this.invokeIpc('bothub:cue:import-credentials', req),
        clearAuth: (accountId: string) => this.invokeIpc('bothub:cue:clear-auth', accountId),
        authStatus: (accountId: string) => this.invokeIpc('bothub:cue:auth-status', accountId),
        getSession: (accountId: string) => this.invokeIpc('bothub:cue:get-session', accountId),
        rpc: (req: unknown) => this.invokeIpc('bothub:cue:rpc', req),
        onEvent: subChannel('bothub:cue:event')
      },
      ...overrides
    }
  }
}

export const electronHarness = new ElectronHarness()

export function getElectronMockModule() {
  return {
    app: {
      getPath: (name: string) => {
        const base = electronHarness.ensureUserDataDir()
        if (name === 'userData' || name === 'appData') return base
        return join(base, name)
      },
      isPackaged: false,
      isReady: () => false,
      getVersion: () => '0.12.1',
      getName: () => 'BotArk'
    },
    safeStorage: {
      isEncryptionAvailable: () => electronHarness.encryptionAvailable,
      isAsyncEncryptionAvailable: async () => electronHarness.encryptionAvailable,
      encryptString: (plain: string) => {
        if (!electronHarness.encryptionAvailable) throw new Error('safeStorage unavailable')
        return Buffer.from(`enc-v1:${plain}`, 'utf8')
      },
      decryptString: (buf: Buffer) => {
        if (!electronHarness.encryptionAvailable) throw new Error('safeStorage unavailable')
        const raw = buf.toString('utf8')
        if (!raw.startsWith('enc-v1:')) throw new Error('Invalid ciphertext')
        return raw.slice('enc-v1:'.length)
      },
      encryptStringAsync: async (plain: string) => {
        if (!electronHarness.encryptionAvailable) throw new Error('safeStorage unavailable')
        return Buffer.from(`enc-v1:${plain}`, 'utf8')
      },
      decryptStringAsync: async (buf: Buffer) => {
        if (!electronHarness.encryptionAvailable) throw new Error('safeStorage unavailable')
        const raw = buf.toString('utf8')
        if (!raw.startsWith('enc-v1:')) throw new Error('Invalid ciphertext')
        return { result: raw.slice('enc-v1:'.length), shouldReEncrypt: false }
      }
    },
    session: {
      fromPartition: (partition: string) => electronHarness.getSession(partition)
    },
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown> | unknown) => {
        electronHarness.ipcHandlers.set(channel, fn)
      },
      removeHandler: (channel: string) => {
        electronHarness.ipcHandlers.delete(channel)
      },
      on: (channel: string, fn: (...args: unknown[]) => void) => {
        electronHarness.ipcListeners.set(channel, fn)
      },
      removeListener: (channel: string) => {
        electronHarness.ipcListeners.delete(channel)
      }
    },
    dialog: {
      showOpenDialog: electronHarness.showOpenDialogMock,
      showMessageBox: electronHarness.showMessageBoxMock,
      showSaveDialog: electronHarness.showSaveDialogMock
    },
    shell: {
      openExternal: electronHarness.openExternalMock
    },
    net: {
      fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)
    }
  }
}
