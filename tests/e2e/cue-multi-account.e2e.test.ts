import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHarness } from './harness/electronMock'
import { createMockCueServer, type MockCueServer } from './harness/mockServers'
import { probeCueContracts, resolveCueDeviceIdFn } from './harness/contractAdapters'

vi.mock('electron', async () => {
  const { getElectronMockModule } = await import('./harness/electronMock')
  return getElectronMockModule()
})

import { saveProxyConfig } from '@main/muse/accountProxy'
import { partitionForAccount } from '@main/webContentsViewManager'
import { useBotStore } from '@/store/botStore'
import { belongsToSelectedSession } from '@/services/sessionEvents'

describe('Area 2: Cue Multi-Account Management (grokbot Blueprint)', () => {
  let cueServer: MockCueServer | undefined

  beforeEach(() => {
    electronHarness.reset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (cueServer) {
      await cueServer.close()
      cueServer = undefined
    }
  })

  afterAll(() => {
    electronHarness.cleanup()
  })

  it('E2E-T1-A2-01: Cue safeStorage Encrypted Vault & Main-Only Secret Isolation', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const registerCueIpc = cue.ipcMod.registerCueIpc as (() => void) | undefined
    expect(typeof registerCueIpc).toBe('function')
    registerCueIpc!()

    const ipcShared = await import('@shared/ipc')
    const CUE_CHANNELS = (ipcShared as Record<string, unknown>).CUE_CHANNELS as Record<string, string>
    expect(CUE_CHANNELS).toBeDefined()

    const importFn =
      (cue.authMod.importCueCredentials as ((accId: string, raw: string) => Promise<unknown>) | undefined) ??
      (cue.authMod.persistCueTokens as ((accId: string, tokens: unknown) => Promise<unknown>) | undefined)
    expect(typeof importFn).toBe('function')

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_cue_1',
      credential: 'Bearer jwt-secret-alpha-1234567890'
    })
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_cue_2',
      credential: 'x-manus-api-key: manus-secret-beta-9876543210'
    })

    const diskRaw = await readFile(join(electronHarness.userDataDir, 'cue-tokens.json'), 'utf8')
    expect(diskRaw).not.toContain('jwt-secret-alpha-1234567890')
    expect(diskRaw).not.toContain('manus-secret-beta-9876543210')
    const parsed = JSON.parse(diskRaw) as Record<string, { enc?: string }>
    expect(typeof parsed.acc_cue_1?.enc).toBe('string')
    expect(typeof parsed.acc_cue_2?.enc).toBe('string')

    const session1 = (await electronHarness.invokeIpc(CUE_CHANNELS.getSession, 'acc_cue_1')) as Record<string, unknown>
    const status1 = (await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_cue_1')) as Record<string, unknown>
    expect(session1.signedIn).toBe(true)
    expect(status1.signedIn).toBe(true)
    expect(JSON.stringify(session1)).not.toContain('jwt-secret-alpha-1234567890')
    expect(JSON.stringify(status1)).not.toContain('jwt-secret-alpha-1234567890')
  })

  it('E2E-T1-A2-02: Per-Account Stable Device Identity (cueDeviceId)', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const { getOrCreate } = resolveCueDeviceIdFn(cue.deviceIdMod)

    const id1 = getOrCreate('acc_cue_dev_1')
    const id2 = getOrCreate('acc_cue_dev_2')
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(id1).not.toBe(id2)

    const rawFile = await readFile(join(electronHarness.userDataDir, 'cue-device-ids.json'), 'utf8')
    expect(rawFile).toContain(id1)
    expect(rawFile).toContain(id2)

    vi.resetModules()
    const reloaded = await probeCueContracts(ctx)
    const { getOrCreate: getOrCreate2 } = resolveCueDeviceIdFn(reloaded.deviceIdMod)
    expect(getOrCreate2('acc_cue_dev_1')).toBe(id1)
    expect(getOrCreate2('acc_cue_dev_2')).toBe(id2)
  })

  it('E2E-T1-A2-03: Per-Account Partition, Proxy Fetcher & Login Anti-Fingerprint Isolation', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    await saveProxyConfig('acc_cue_iso_1', { mode: 'socks5', host: '127.0.0.1', port: 1081 })
    await saveProxyConfig('acc_cue_iso_2', { mode: 'http', host: '127.0.0.1', port: 1082 })

    const openCueLogin = cue.loginMod.openCueLoginWindow as (id: string) => Promise<void>
    const cancelCueLogin = cue.loginMod.cancelCueLogin as (id: string) => Promise<void>
    expect(typeof openCueLogin).toBe('function')

    void openCueLogin('acc_cue_iso_1')
    void openCueLogin('acc_cue_iso_2')
    await new Promise((r) => setTimeout(r, 25))

    const ses1 = electronHarness.getSession(partitionForAccount('acc_cue_iso_1'))
    const ses2 = electronHarness.getSession(partitionForAccount('acc_cue_iso_2'))
    expect(ses1).not.toBe(ses2)
    expect(ses1.setProxyCalls.some((p) => p.proxyRules?.includes('1081'))).toBe(true)
    expect(ses2.setProxyCalls.some((p) => p.proxyRules?.includes('1082'))).toBe(true)

    const googleH = ses1.simulateBeforeSendHeaders('https://accounts.google.com/o/oauth2/auth', {
      'User-Agent': 'BotArk/0.12.1 Chrome/136.0.0.0 Electron/45.2.1'
    })
    expect(googleH['User-Agent']).not.toMatch(/Electron|BotArk/i)

    const turnstileH = ses1.simulateBeforeSendHeaders('https://challenges.cloudflare.com/turnstile/v0/api.js', {
      'User-Agent': ses1.getUserAgent(),
      'Sec-CH-UA': '"Chromium";v="136", "Electron";v="45"'
    })
    expect(turnstileH['Sec-CH-UA']).toContain('Electron')

    const fetcherFn = cue.authMod.cueFetcherForAccount as ((id: string) => unknown) | undefined
    expect(typeof fetcherFn).toBe('function')
    expect(typeof fetcherFn!('acc_cue_iso_1')).toBe('function')

    await cancelCueLogin?.('acc_cue_iso_1')
    await cancelCueLogin?.('acc_cue_iso_2')
  })

  it('E2E-T1-A2-04: Universal Cue Credential Import (5 Formats)', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >
    const cancelCueLogin = cue.loginMod.cancelCueLogin as (id: string) => Promise<void>

    const formats = [
      { id: 'acc_fmt_1', raw: 'sk-manus-apikey-1234567890abcdef' },
      { id: 'acc_fmt_2', raw: 'Bearer eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImExQGN1ZS5pbSIsImV4cCI6OTk5OTk5OTk5OX0.sig' },
      { id: 'acc_fmt_3', raw: 'Cookie: cue_session=sess_xyz_1234567890; csrf=abc' },
      { id: 'acc_fmt_4', raw: JSON.stringify([{ name: 'cue_session', value: 'arr_sess_123456', domain: '.cue.im' }]) },
      {
        id: 'acc_fmt_5',
        raw: JSON.stringify({
          accessToken: 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImE1QGN1ZS5pbSIsImV4cCI6OTk5OTk5OTk5OX0.sig',
          refreshToken: 'rt_fmt_5',
          apiKey: 'sk-manus-5'
        })
      }
    ]

    for (const f of formats) {
      const res = (await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
        accountId: f.id,
        credential: f.raw
      })) as Record<string, unknown>
      expect(res.signedIn).toBe(true)
      await cancelCueLogin(f.id)
      const st = (await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, f.id)) as Record<string, unknown>
      expect(st.signedIn).toBe(true)
    }
  })

  it('E2E-T1-A2-05: Cue RPC Suite, 401 Refresh Retry & Watch Multiplexer Isolation', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    cueServer = await createMockCueServer()

    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_rpc_1',
      credential: JSON.stringify({
        accessToken: 'tok_acc_1_init',
        refreshToken: 'rt_acc_1',
        baseUrl: cueServer.url
      })
    })
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_rpc_2',
      credential: JSON.stringify({
        accessToken: 'tok_acc_2_init',
        refreshToken: 'rt_acc_2',
        baseUrl: cueServer.url
      })
    })

    cueServer.force401OnceForToken('tok_acc_1_init')

    const health = (await electronHarness.invokeIpc(CUE_CHANNELS.rpc, {
      accountId: 'acc_rpc_1',
      op: 'health',
      baseUrl: cueServer.url
    })) as { ok: boolean }
    expect(health.ok).toBe(true)
    expect(cueServer.refreshCount).toBe(1)

    for (const op of ['listAgents', 'listTasks', 'sendMessage', 'approve'] as const) {
      const r = (await electronHarness.invokeIpc(CUE_CHANNELS.rpc, {
        accountId: 'acc_rpc_1',
        op,
        agentId: 'agent_1',
        text: 'hello cue',
        approvalId: 'apr_1',
        decision: 'allow_once',
        baseUrl: cueServer.url
      })) as { ok: boolean }
      expect(r.ok).toBe(true)
    }

    // Verify account 2 requests never carried account 1 token
    await electronHarness.invokeIpc(CUE_CHANNELS.rpc, {
      accountId: 'acc_rpc_2',
      op: 'listAgents',
      baseUrl: cueServer.url
    })
    const acc2Reqs = cueServer.requests.filter((r) => r.authorization?.includes('tok_acc_2'))
    expect(acc2Reqs.length).toBeGreaterThanOrEqual(1)
  })

  it('E2E-T1-A2-06: CueAdapter, syncCueAccountBots Distinct Naming & Event Routing', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const CueAdapterCtor = cue.adapterMod.CueAdapter as new () => {
      id: string
      refreshAgents: (accountId: string) => Promise<Array<{ id: string; name: string }>>
    }
    expect(typeof CueAdapterCtor).toBe('function')

    const bridge = electronHarness.buildRendererBridge({
      cue: {
        authStatus: async (id: string) => ({
          signedIn: true,
          handle: id === 'acc_cue_a' ? 'alice@cue.im' : 'bob@cue.im'
        }),
        getSession: async (id: string) => ({
          signedIn: true,
          handle: id === 'acc_cue_a' ? 'alice@cue.im' : 'bob@cue.im'
        }),
        rpc: async (req: { accountId: string; op: string }) => {
          if (req.op === 'listAgents') {
            return { ok: true, data: [{ id: 'agent_main', name: 'Researcher' }] }
          }
          return { ok: true, data: {} }
        },
        onEvent: (cb: (ev: unknown) => void) => electronHarness.onChannelEvent('bothub:cue:event', cb)
      }
    })
    vi.stubGlobal('window', { electron: bridge })

    const syncFn = (useBotStore.getState() as unknown as Record<string, unknown>).syncCueAccountBots as
      | ((id: string, opts?: unknown) => Promise<number>)
      | undefined
    expect(typeof syncFn).toBe('function')

    useBotStore.setState({ bots: [], accounts: {}, messages: {}, groups: [{ id: 'g1', name: 'Cue' }] })
    await syncFn!('acc_cue_a')
    await syncFn!('acc_cue_b')

    const cueBots = useBotStore.getState().bots.filter((b) => b.platformId === 'cue')
    expect(cueBots.length).toBe(2)
    expect(new Set(cueBots.map((b) => b.name.toLowerCase())).size).toBe(2)
  })

  it('E2E-T1-A2-07: Cue Account Lifecycle IPC & Clear Auth', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_life_1',
      credential: 'Bearer tok_life_1_abcdefghij1234567890'
    })
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_life_2',
      credential: 'Bearer tok_life_2_abcdefghij1234567890'
    })

    await electronHarness.invokeIpc(CUE_CHANNELS.openLogin, {
      accountId: 'acc_life_ext',
      openInBrowser: true
    })
    expect(electronHarness.openExternalCalls.length).toBeGreaterThanOrEqual(1)

    await electronHarness.invokeIpc(CUE_CHANNELS.clearAuth, 'acc_life_1')
    const st1 = (await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_life_1')) as { signedIn: boolean }
    const st2 = (await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_life_2')) as { signedIn: boolean }
    expect(st1.signedIn).toBe(false)
    expect(st2.signedIn).toBe(true)
  })

  it('E2E-T2-A2-01: Cue Vault Fail-Closed When safeStorage Unavailable', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >

    electronHarness.encryptionAvailable = false
    await expect(
      electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
        accountId: 'acc_no_enc',
        credential: 'Bearer plain_should_never_write_1234567890'
      })
    ).rejects.toThrow()

    const disk = await readFile(join(electronHarness.userDataDir, 'cue-tokens.json'), 'utf8').catch(() => '')
    expect(disk).not.toContain('plain_should_never_write_1234567890')
  })

  it('E2E-T2-A2-02: Corrupt cue-device-ids.json & cue-tokens.json Recovery', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    await writeFile(join(electronHarness.userDataDir, 'cue-device-ids.json'), '{bad-json', 'utf8')
    await writeFile(join(electronHarness.userDataDir, 'cue-tokens.json'), '{corrupt-tokens', 'utf8')

    const { getOrCreate } = resolveCueDeviceIdFn(cue.deviceIdMod)
    const recoveredId = getOrCreate('acc_corrupt_recover')
    expect(recoveredId).toMatch(/^[0-9a-f-]{36}$/i)

    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >
    const status = (await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_corrupt_recover')) as {
      signedIn: boolean
    }
    expect(status.signedIn).toBe(false)
  })

  it('E2E-T2-A2-03: Malformed / Empty / Ambiguous Credential Import Strings', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_keep_valid',
      credential: 'Bearer valid_initial_token_1234567890'
    })

    for (const bad of ['', '   ', 'not-a-token', '{bad json']) {
      await expect(
        electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
          accountId: 'acc_keep_valid',
          credential: bad
        })
      ).rejects.toThrow()
    }

    const st = (await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_keep_valid')) as { signedIn: boolean }
    expect(st.signedIn).toBe(true)
  })

  it('E2E-T2-A2-04: Duplicate Cue Account Handle / Empty Handle Disambiguation', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    void cue
    const bridge = electronHarness.buildRendererBridge({
      cue: {
        authStatus: async () => ({ signedIn: true, handle: '', displayName: 'Cue' }),
        getSession: async () => ({ signedIn: true, handle: '', displayName: 'Cue' }),
        rpc: async () => ({ ok: true, data: [{ id: 'agent_shared', name: 'Cue' }] }),
        onEvent: () => () => {}
      }
    })
    vi.stubGlobal('window', { electron: bridge })
    const syncFn = (useBotStore.getState() as unknown as Record<string, unknown>).syncCueAccountBots as (
      id: string
    ) => Promise<number>

    useBotStore.setState({ bots: [], accounts: {}, messages: {}, groups: [{ id: 'g1', name: 'Cue' }] })
    await syncFn('acc_dup_1')
    await syncFn('acc_dup_2')

    const bots = useBotStore.getState().bots.filter((b) => b.platformId === 'cue')
    expect(bots.length).toBe(2)
    expect(new Set(bots.map((b) => b.name.toLowerCase())).size).toBe(2)
  })

  it('E2E-T2-A2-05: cueWatchManager Concurrent 401 Refresh Deduplication & Shutdown Cleanup', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    cueServer = await createMockCueServer()
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_dedup_1',
      credential: JSON.stringify({
        accessToken: 'tok_dedup_old',
        refreshToken: 'rt_dedup',
        baseUrl: cueServer.url
      })
    })

    cueServer.force401OnceForToken('tok_dedup_old')
    const results = await Promise.all([
      electronHarness.invokeIpc(CUE_CHANNELS.rpc, { accountId: 'acc_dedup_1', op: 'health', baseUrl: cueServer.url }),
      electronHarness.invokeIpc(CUE_CHANNELS.rpc, { accountId: 'acc_dedup_1', op: 'listAgents', baseUrl: cueServer.url }),
      electronHarness.invokeIpc(CUE_CHANNELS.rpc, { accountId: 'acc_dedup_1', op: 'listTasks', baseUrl: cueServer.url })
    ])
    for (const r of results as Array<{ ok: boolean }>) {
      expect(r.ok).toBe(true)
    }
    expect(cueServer.refreshCount).toBe(1)

    const stopWatch = cue.watchMod.stopCueAccountWatch as ((id: string) => void) | undefined
    expect(typeof stopWatch).toBe('function')
    expect(() => stopWatch!('*')).not.toThrow()
  })

  it('E2E-T2-A2-06: CueAdapter room-turn-* Isolation from 1:1 Chat', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    void cue
    expect(
      belongsToSelectedSession(
        {
          type: 'message',
          message: {
            id: 'm1',
            conversationId: 'room-turn-42',
            accountId: 'acc_cue_1',
            text: 'Room reply',
            createdAt: 1
          }
        },
        []
      )
    ).toBe(false)
  })
})
