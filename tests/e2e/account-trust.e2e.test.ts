import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHarness } from './harness/electronMock'
import { requireOrSkip, tryImportMain } from './harness/contractAdapters'

vi.mock('electron', async () => {
  const { getElectronMockModule } = await import('./harness/electronMock')
  return getElectronMockModule()
})

import {
  buildChromeClientHints,
  cleanChromeUserAgentForGoogle,
  installGoogleOAuthHeaderGuard,
  sanitizeGoogleRequestHeaders
} from '@main/googleOAuthUaGuard'
import {
  applyProxyToPartition,
  clearProxyConfig,
  importProxyPool,
  loadProxyConfig,
  ProxyConfigUnreadableError,
  saveProxyConfig
} from '@main/muse/accountProxy'
import { planPoolAssignment, releasePoolSlot } from '@shared/proxyPool'
import { cancelDotLogin, openDotLoginWindow } from '@main/dot/dotLogin'
import { importDotCredentialsFromRaw } from '@main/dot/dotClient'
import { cancelHarkLogin, openHarkLoginWindow } from '@main/hark/harkLogin'
import { getProfile, preparedSessionForAccount } from '@main/hark/harkClient'
import { openGrokLoginWindow } from '@main/grok/grokLogin'
import { openAntigravityLoginWindow } from '@main/antigravity/antigravityLogin'
import { partitionForAccount, WebContentsViewManager } from '@main/webContentsViewManager'
import { poolAccountIds, useBotStore } from '@/store/botStore'
import { startAdapterBridge } from '@/services/adapterBridge'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterEvent, AdapterListener, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'

describe('Area 1: Account Login Trust, Online Sync & Multi-Account Isolation', () => {
  beforeEach(() => {
    electronHarness.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterAll(() => {
    electronHarness.cleanup()
  })

  it('E2E-T1-A1-01: Google OAuth UA, Client Hints & JS Guard Across All Partitions', async (ctx) => {
    const ses = electronHarness.getSession('persist:bothub-account-acc_a1_01')
    installGoogleOAuthHeaderGuard(ses as unknown as Electron.Session)

    const googleHosts = [
      'https://accounts.google.com/o/oauth2/v2/auth',
      'https://oauth2.googleapis.com/token',
      'https://www.gstatic.com/_/mss/boq-identity/_/js/k=1',
      'https://lh3.googleusercontent.com/a/default',
      'https://www.youtube.com/signin'
    ]
    const rawHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BotArk/0.12.1 Chrome/136.0.0.0 Electron/45.2.1 Safari/537.36',
      'Sec-CH-UA': '"Electron";v="45", "Chromium";v="136"',
      'Sec-CH-UA-Full-Version-List': '"Electron";v="45.2.1"',
      'Sec-CH-UA-Platform': '"Electron"'
    }

    const gstaticHeaders = ses.simulateBeforeSendHeaders(googleHosts[2]!, rawHeaders)
    const googleApisHeaders = ses.simulateBeforeSendHeaders(googleHosts[1]!, rawHeaders)
    const googleAccountsHeaders = ses.simulateBeforeSendHeaders(googleHosts[0]!, rawHeaders)

    expect(googleAccountsHeaders['User-Agent']).not.toMatch(/Electron|BotArk|BotHub/i)
    expect(googleAccountsHeaders['Sec-CH-UA']).toContain('"Google Chrome"')

    const m1ExpandedHostsCovered =
      !gstaticHeaders['User-Agent']?.match(/Electron|BotArk/i) &&
      !googleApisHeaders['User-Agent']?.match(/Electron|BotArk/i) &&
      gstaticHeaders['Sec-CH-UA']?.includes('"Google Chrome"') &&
      googleAccountsHeaders['Sec-CH-UA-Platform'] !== '"Electron"'

    const hasJsGuard =
      ses.preloadScripts.length > 0 ||
      typeof (await import('@main/googleOAuthUaGuard') as Record<string, unknown>).buildGoogleNavigatorGuardScript === 'function' ||
      typeof (await import('@main/googleOAuthUaGuard') as Record<string, unknown>).installGoogleNavigatorGuard === 'function'

    requireOrSkip(
      ctx,
      'M1',
      Boolean(m1ExpandedHostsCovered && hasJsGuard),
      'installGoogleOAuthHeaderGuard must cover gstatic/googleapis/googleusercontent, normalize Sec-CH-UA-Platform, and attach Google-origin JS navigator guard'
    )

    // Verify all Google-family hosts are sanitized
    for (const url of googleHosts) {
      const h = ses.simulateBeforeSendHeaders(url, rawHeaders)
      expect(h['User-Agent']).not.toMatch(/Electron|BotArk|BotHub/i)
      expect(h['Sec-CH-UA']).toContain('"Google Chrome"')
      expect(h['Sec-CH-UA-Platform']).not.toBe('"Electron"')
    }

    // Verify WebContentsViewManager installs Google OAuth guard on account partition
    const hostWin = electronHarness.ensurePrimaryWindow()
    const mgr = new WebContentsViewManager(hostWin as unknown as Electron.BrowserWindow)
    mgr.create({ botId: 'b1', accountId: 'acc_wvm_1', url: 'https://accounts.google.com/' })
    const wvmSes = electronHarness.getSession(partitionForAccount('acc_wvm_1'))
    const wvmHeaders = wvmSes.simulateBeforeSendHeaders('https://accounts.google.com/ServiceLogin', rawHeaders)
    expect(wvmHeaders['User-Agent']).not.toMatch(/Electron|BotArk/i)
  })

  it('E2E-T1-A1-02: Cloudflare Turnstile & Non-Google Origin Non-Mutation + harkClient Runtime Headers', async (ctx) => {
    const harkAcc = 'acc_hark_turnstile_1'
    const harkSes = electronHarness.getSession(partitionForAccount(harkAcc))
    harkSes.fetchResponder = async () =>
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    void openHarkLoginWindow(harkAcc)
    await new Promise((r) => setTimeout(r, 20))

    // Capture harkClient outbound headers
    let capturedHarkHeaders: Record<string, string> = {}
    harkSes.fetchResponder = async (_url, init) => {
      capturedHarkHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ id: 'u1', email: 'u@hark.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    await getProfile(harkAcc)

    const globalUaStripped = harkSes.setUserAgentCalls.some((ua) => !/Electron\//i.test(ua))
    const hardcodedMacOnNonMac =
      process.platform !== 'darwin' &&
      (capturedHarkHeaders['Sec-Ch-Ua-Platform'] === '"macOS"' ||
        /Electron\/35\.1\.2/.test(capturedHarkHeaders['User-Agent'] ?? ''))

    requireOrSkip(
      ctx,
      'M1',
      !globalUaStripped && !hardcodedMacOnNonMac,
      'harkLogin must not strip Electron globally via ses.setUserAgent, and harkClient must use runtime OS/Chromium headers'
    )

    const rawHeaders = {
      'User-Agent': harkSes.getUserAgent(),
      'Sec-CH-UA': '"Chromium";v="136", "Electron";v="45"'
    }
    const turnstileHeaders = harkSes.simulateBeforeSendHeaders(
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      rawHeaders
    )
    const harkAppHeaders = harkSes.simulateBeforeSendHeaders('https://app.hark.com/login', rawHeaders)

    expect(turnstileHeaders['User-Agent']).toBe(rawHeaders['User-Agent'])
    expect(turnstileHeaders['Sec-CH-UA']).toBe(rawHeaders['Sec-CH-UA'])
    expect(harkAppHeaders['User-Agent']).toBe(rawHeaders['User-Agent'])
    expect(capturedHarkHeaders['User-Agent']).not.toContain('Electron/35.1.2')
    if (process.platform === 'win32') {
      expect(capturedHarkHeaders['Sec-Ch-Ua-Platform']).toBe('"Windows"')
    }
  })

  it('E2E-T1-A1-03: OAuth Popup window.opener Preservation', async (ctx) => {
    const harkAcc = 'acc_hark_popup'
    const harkSes = electronHarness.getSession(partitionForAccount(harkAcc))
    harkSes.fetchResponder = async () =>
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    void openHarkLoginWindow(harkAcc)
    await new Promise((r) => setTimeout(r, 20))
    const harkWin = electronHarness.sessions.size > 0
      ? (await import('./harness/electronMock')).MockBrowserWindow.getAllWindows().find((w) =>
          w.webContents.session.partition === partitionForAccount(harkAcc)
        )
      : undefined
    expect(harkWin).toBeDefined()

    const harkOpen = harkWin!.webContents.triggerWindowOpen('https://accounts.google.com/o/oauth2/v2/auth?client_id=test')

    const dotAcc = 'acc_dot_popup'
    void openDotLoginWindow(dotAcc)
    await new Promise((r) => setTimeout(r, 20))
    const { MockBrowserWindow } = await import('./harness/electronMock')
    const dotWin = MockBrowserWindow.getAllWindows().find(
      (w) => w.webContents.session.partition === partitionForAccount(dotAcc)
    )
    expect(dotWin).toBeDefined()
    const dotOpen = dotWin!.webContents.triggerWindowOpen('https://accounts.google.com/o/oauth2/v2/auth?client_id=dot')

    requireOrSkip(
      ctx,
      'M1',
      harkOpen.result.action === 'allow' && dotOpen.result.action === 'allow',
      'harkLogin and dotLogin setWindowOpenHandler must return { action: "allow" } for OAuth popups to preserve window.opener'
    )

    for (const opened of [harkOpen, dotOpen]) {
      expect(opened.result.action).toBe('allow')
      const prefs = opened.result.overrideBrowserWindowOptions?.webPreferences as Record<string, unknown>
      expect(prefs.sandbox).toBe(true)
      expect(prefs.contextIsolation).toBe(true)
      expect(prefs.nodeIntegration).toBe(false)
      expect(typeof prefs.partition).toBe('string')
    }
    expect(harkOpen.childWindow).toBeDefined()
    expect(dotOpen.childWindow).toBeDefined()

    await cancelHarkLogin(harkAcc)
    await cancelDotLogin(dotAcc)
  })

  it('E2E-T1-A1-04: Google Block & Passkey System-Browser Fallback Across Google-OAuth Platforms', async (ctx) => {
    const { MockBrowserWindow } = await import('./harness/electronMock')

    // 1. Verify Grok v0.12.1 Google block fallback triggers shell.openExternal
    const grokAcc = 'acc_grok_block_1'
    void openGrokLoginWindow(grokAcc)
    await new Promise((r) => setTimeout(r, 20))
    const grokWin = MockBrowserWindow.getAllWindows().find(
      (w) => w.webContents.session.partition === partitionForAccount(grokAcc)
    )
    expect(grokWin).toBeDefined()
    const grokPopup = grokWin!.webContents.triggerWindowOpen('https://accounts.google.com/v3/signin/rejected')
    expect(grokPopup.childWindow).toBeDefined()
    grokPopup.childWindow!.webContents.jsResponder = () => true
    await grokPopup.childWindow!.loadURL('https://accounts.google.com/v3/signin/rejected')
    await new Promise((r) => setTimeout(r, 20))
    expect(electronHarness.openExternalCalls.length).toBeGreaterThanOrEqual(1)

    // 2. Verify M1 extends Google block fallback across Antigravity / Dot / Hark
    electronHarness.openExternalCalls = []
    const agyAcc = 'acc_agy_block_1'
    const agySes = electronHarness.getSession(partitionForAccount(agyAcc))
    agySes.fetchResponder = async () =>
      new Response(JSON.stringify({}), { status: 401, headers: { 'content-type': 'application/json' } })
    void openAntigravityLoginWindow(agyAcc)
    await new Promise((r) => setTimeout(r, 20))
    const agyWin = MockBrowserWindow.getAllWindows().find(
      (w) => w.webContents.session.partition === partitionForAccount(agyAcc)
    )
    if (agyWin) {
      agyWin.webContents.jsResponder = () => true
      await agyWin.loadURL('https://accounts.google.com/v3/signin/rejected')
      await new Promise((r) => setTimeout(r, 20))
    }

    requireOrSkip(
      ctx,
      'M1',
      electronHarness.openExternalCalls.length > 0,
      'Google block ("此浏览器或应用可能不安全") system-browser fallback must be extended to Antigravity/Dot/Hark/Muse login windows'
    )
    expect(electronHarness.openExternalCalls[0]).toMatch(/^https?:\/\//i)
  })

  it('E2E-T1-A1-05: Non-Destructive Paste Import & cancelLogin', async (ctx) => {
    const dotAcc = 'acc_dot_safe_cancel'
    const dotSes = electronHarness.getSession(partitionForAccount(dotAcc))
    await importDotCredentialsFromRaw(dotAcc, JSON.stringify({ accessToken: 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImRvdEBleGFtcGxlLmNvbSJ9.sig' }))
    await cancelDotLogin(dotAcc)
    expect(dotSes.clearStorageDataCalls).toBe(0)

    const harkAcc = 'acc_hark_safe_cancel'
    const harkSes = electronHarness.getSession(partitionForAccount(harkAcc))
    await harkSes.cookies.set({ name: 'better-auth.session_token', value: 'valid-hark-token', url: 'https://app.hark.com' })
    harkSes.fetchResponder = async () =>
      new Response(JSON.stringify({ user: { id: 'u1', email: 'h@hark.com' }, session: { id: 's1', token: 't1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    await cancelHarkLogin(harkAcc)

    requireOrSkip(
      ctx,
      'M1',
      harkSes.clearStorageDataCalls === 0,
      'cancelHarkLogin must not call clearStorageData() when valid session credentials already exist'
    )
    const remaining = await harkSes.cookies.get({ name: 'better-auth.session_token' })
    expect(remaining.length).toBe(1)
  })

  it('E2E-T1-A1-06: Account Error statusDetail Visibility & Non-Hijacking Quick-Add', async (ctx) => {
    const settingsSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/settings/SettingsView.tsx'),
      'utf8'
    )
    const hasQuickAddBug = /grokAccounts\.find\(\s*\(a\)\s*=>\s*a\.status\s*===\s*'offline'\s*\|\|\s*a\.status\s*===\s*'error'\s*\)/.test(
      settingsSource
    )

    requireOrSkip(
      ctx,
      'M1',
      !hasQuickAddBug,
      'SettingsView.handleQuickAddGrokAccount must create a fresh account slot instead of hijacking offline/error accounts'
    )
    expect(settingsSource).toContain('statusDetail')
  })

  it('E2E-T1-A1-07: Generalized 1-to-1 Proxy Pool Auto-Assignment', async (ctx) => {
    const poolRes = poolAccountIds({
      acc_muse_1: { id: 'acc_muse_1', platformId: 'meta-muse' },
      acc_grok_1: { id: 'acc_grok_1', platformId: 'grok' },
      acc_dot_1: { id: 'acc_dot_1', platformId: 'dot' },
      acc_hark_1: { id: 'acc_hark_1', platformId: 'hark' }
    })

    requireOrSkip(
      ctx,
      'M1',
      poolRes.assignableIds.includes('acc_hark_1'),
      'poolAccountIds must generalize proxy pool auto-assignment across Hark (and Cue) in addition to Muse/Grok/Dot'
    )

    await importProxyPool('http://127.0.0.1:8001\nhttp://127.0.0.1:8002\nhttp://127.0.0.1:8003\nhttp://127.0.0.1:8004')
    const plan = planPoolAssignment(
      [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }],
      poolRes.assignableIds
    )
    const assignedSlots = plan.assigned.map((a) => a.slot.id)
    expect(new Set(assignedSlots).size).toBe(4)
  })

  it('E2E-T1-A1-08: Stale offline Account (Qoder-2x) Transitions to online Upon Chat Exchange', async (ctx) => {
    const botId = 'bot_qoder_2x'
    const accountId = 'acc_qoder_2x'
    const listeners = new Set<AdapterListener>()
    const emit = (ev: AdapterEvent) => {
      for (const l of listeners) l(ev)
    }

    const fakeAdapter: PlatformAdapter = {
      id: 'dot',
      name: 'Dot',
      listAccounts: async () => [],
      connect: async () => 'online',
      disconnect: async () => undefined,
      getStatus: () => 'online',
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onMessage: (listener) =>
        fakeAdapter.subscribe((ev) => {
          if (ev.type === 'message') listener(ev.message)
        }),
      sendMessage: async (msg: OutgoingMessage) => {
        msg.onAccepted?.()
        emit({
          type: 'message',
          message: {
            id: 'msg_qoder_reply',
            conversationId: msg.conversationId,
            accountId: msg.accountId,
            text: 'Reply from Qoder-2x',
            createdAt: Date.now()
          }
        })
        return { messageId: 'sent_qoder_1', acceptedAt: Date.now() }
      }
    }

    vi.spyOn(adapterRegistry, 'get').mockReturnValue(fakeAdapter)
    vi.spyOn(adapterRegistry, 'list').mockReturnValue([fakeAdapter])

    useBotStore.setState({
      bots: [
        {
          id: botId,
          name: 'Qoder-2x',
          emoji: '🤖',
          description: '',
          platformId: 'dot',
          groupId: 'grp_default',
          accountIds: [accountId],
          activeAccountId: accountId,
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        } as Bot
      ],
      accounts: {
        [accountId]: {
          id: accountId,
          platformId: 'dot',
          displayName: 'Qoder-2x',
          handle: 'qoder-2x@example.com',
          status: 'offline',
          statusDetail: '离线'
        }
      },
      messages: { [botId]: [] },
      selectedBotId: botId
    })

    const stopBridge = startAdapterBridge()
    try {
      await useBotStore.getState().sendMessage(botId, '你好 Qoder-2x')
      const updatedAccount = useBotStore.getState().accounts[accountId]
      requireOrSkip(
        ctx,
        'M1',
        updatedAccount?.status === 'online',
        'Successful chat send/reply must synchronize stale "offline" account status (e.g., Qoder-2x) to "online"'
      )
      expect(updatedAccount?.status).toBe('online')
      expect((useBotStore.getState().messages[botId] ?? []).some((m) => m.text === 'Reply from Qoder-2x')).toBe(true)
    } finally {
      stopBridge()
    }
  })

  it('E2E-T2-A1-01: installGoogleOAuthHeaderGuard Idempotency & Minimal Mock Safety', () => {
    const ses = electronHarness.getSession('persist:idempotent')
    installGoogleOAuthHeaderGuard(ses as unknown as Electron.Session)
    installGoogleOAuthHeaderGuard(ses as unknown as Electron.Session)
    installGoogleOAuthHeaderGuard(ses as unknown as Electron.Session)
    expect(ses.beforeSendHeadersListeners.length).toBe(1)

    expect(() => installGoogleOAuthHeaderGuard({} as unknown as Electron.Session)).not.toThrow()
    expect(() => installGoogleOAuthHeaderGuard(null)).not.toThrow()
  })

  it('E2E-T2-A1-02: Proxy Pool Exhaustion & Single-Slot Release', () => {
    const slots = [{ id: 'slot-1' }, { id: 'slot-2' }]
    const first = planPoolAssignment(slots, ['a1', 'a2', 'a3', 'a4'], (id) => id === 'a2')
    expect(first.assigned.map((x) => [x.accountId, x.slot.id])).toEqual([
      ['a1', 'slot-1'],
      ['a2', 'slot-2']
    ])

    const released = releasePoolSlot(first.pool, 'a1')
    expect(released.find((s) => s.id === 'slot-1')?.assignedAccountId).toBeUndefined()
    expect(released.find((s) => s.id === 'slot-2')?.assignedAccountId).toBe('a2')
  })

  it('E2E-T2-A1-03: Fail-Closed Proxy on Corrupt Ciphertext / Keychain Denial', async () => {
    const dir = electronHarness.userDataDir
    await writeFile(
      join(dir, 'muse-account-proxy.json'),
      JSON.stringify({ acc_corrupt: { enc: Buffer.from('BAD_DATA').toString('base64') } }),
      'utf8'
    )

    const ses = electronHarness.getSession(partitionForAccount('acc_corrupt'))
    const fetchSpy = vi.fn()
    ses.fetchResponder = fetchSpy

    await expect(applyProxyToPartition('acc_corrupt')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    await expect(preparedSessionForAccount('acc_corrupt')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    expect(ses.setProxyCalls.some((p) => p.proxyRules === 'http://127.0.0.1:9')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()

    await saveProxyConfig('acc_good_toggle', { mode: 'http', host: '127.0.0.1', port: 8888 })
    electronHarness.encryptionAvailable = false
    await expect(loadProxyConfig('acc_good_toggle')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    electronHarness.encryptionAvailable = true
    await clearProxyConfig('acc_good_toggle')
  })

  it('E2E-T2-A1-04: cancelLogin Clean-Abort When No Credentials Saved', async () => {
    const dotAcc = 'acc_dot_empty_cancel'
    const dotSes = electronHarness.getSession(partitionForAccount(dotAcc))
    void openDotLoginWindow(dotAcc)
    await new Promise((r) => setTimeout(r, 20))
    await cancelDotLogin(dotAcc)
    expect(dotSes.clearStorageDataCalls).toBeGreaterThanOrEqual(1)

    const harkAcc = 'acc_hark_empty_cancel'
    const harkSes = electronHarness.getSession(partitionForAccount(harkAcc))
    harkSes.fetchResponder = async () =>
      new Response(JSON.stringify({ user: null, session: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    void openHarkLoginWindow(harkAcc)
    await new Promise((r) => setTimeout(r, 20))
    await cancelHarkLogin(harkAcc)
    expect(harkSes.clearStorageDataCalls).toBeGreaterThanOrEqual(1)
  })

  it('E2E-T2-A1-05: Disallowed External Popup Isolation', async () => {
    const { MockBrowserWindow } = await import('./harness/electronMock')
    const dotAcc = 'acc_dot_external_popup'
    void openDotLoginWindow(dotAcc)
    await new Promise((r) => setTimeout(r, 20))
    const win = MockBrowserWindow.getAllWindows().find(
      (w) => w.webContents.session.partition === partitionForAccount(dotAcc)
    )
    expect(win).toBeDefined()

    const evilHttp = win!.webContents.triggerWindowOpen('https://evil-third-party.example/phish')
    expect(evilHttp.result.action).toBe('deny')
    expect(electronHarness.openExternalCalls).toContain('https://evil-third-party.example/phish')

    const countBefore = electronHarness.openExternalCalls.length
    const jsUrl = win!.webContents.triggerWindowOpen('javascript:alert(1)')
    expect(jsUrl.result.action).toBe('deny')
    expect(electronHarness.openExternalCalls.length).toBe(countBefore)

    await cancelDotLogin(dotAcc)
  })

  it('E2E-T2-A1-06: Header Case-Insensitivity & Missing Chrome Version Fallback', () => {
    const out = sanitizeGoogleRequestHeaders(
      {
        'user-agent': 'Mozilla/5.0 Electron/45.2.1 BotArk/0.12.1',
        'sec-ch-ua': '"Electron";v="45"',
        'sec-ch-ua-full-version-list': '"Electron";v="45.2.1"',
        'sec-ch-ua-platform': '"Windows"'
      },
      ''
    )
    expect(Object.keys(out).filter((k) => k.toLowerCase() === 'user-agent')).toHaveLength(1)
    expect(Object.keys(out).filter((k) => k.toLowerCase() === 'sec-ch-ua')).toHaveLength(1)
    expect(out['user-agent']).toContain('Chrome/136.0.0.0')
    expect(out['sec-ch-ua']).toContain('"Google Chrome";v="136"')

    const hints = buildChromeClientHints('')
    expect(hints.secChUa).toContain('"136"')
    expect(cleanChromeUserAgentForGoogle('BotArk/0.12.1 Electron/45.0.0', '')).toContain('Chrome/136.0.0.0')
  })
})
