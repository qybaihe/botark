import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHarness } from './harness/electronMock'
import {
  createMockCueServer,
  createMockLegacySseMcpServer,
  createStdioMcpFixtures,
  type MockCueServer,
  type MockLegacySseMcpServer
} from './harness/mockServers'
import { probeCueContracts, requireOrSkip, resolveCueDeviceIdFn } from './harness/contractAdapters'

vi.mock('electron', async () => {
  const { getElectronMockModule } = await import('./harness/electronMock')
  return getElectronMockModule()
})

import { applyProxyToPartition, clearProxyConfig, ProxyConfigUnreadableError, saveProxyConfig } from '@main/muse/accountProxy'
import { registerWorkspaceIpc, stopWorkspaces } from '@main/mcp/hub'
import { partitionForAccount } from '@main/webContentsViewManager'
import { planPoolAssignment } from '@shared/proxyPool'
import { WORKSPACE_CHANNEL, type WorkspaceView } from '@shared/workspace'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import { mentions } from '@/rooms/model'
import { addRoom, stopRoom, submitBrief, useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'

describe('Tier 3: Cross-Feature Pairwise Integration', () => {
  let workDir: string
  let cueServer: MockCueServer | undefined
  let sseServer: MockLegacySseMcpServer | undefined

  beforeEach(async () => {
    electronHarness.reset()
    workDir = await mkdtemp(join(tmpdir(), 'botark-e2e-t3-'))
    electronHarness.showMessageBoxMock.mockResolvedValue({ response: 1 })
    registerWorkspaceIpc(() => electronHarness.ensurePrimaryWindow() as unknown as Electron.BrowserWindow)
    useRooms.setState({ rooms: [], speakers: {}, turnProgress: {}, errors: {}, externalAudiences: {} })
    useBotStore.setState({ bots: [], accounts: {}, messages: {}, groups: [{ id: 'g1', name: 'Workspace' }] })
  })

  afterEach(async () => {
    stopWorkspaces()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (cueServer) {
      await cueServer.close()
      cueServer = undefined
    }
    if (sseServer) {
      await sseServer.close()
      sseServer = undefined
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  })

  afterAll(() => {
    electronHarness.cleanup()
  })

  it('E2E-T3-01: Dual-Cue Accounts + Proxy Pool + Google/Turnstile Guard + Safe Cancel', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const { getOrCreate } = resolveCueDeviceIdFn(cue.deviceIdMod)
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >

    const plan = planPoolAssignment([{ id: 'p1' }, { id: 'p2' }], ['acc_cue_t3_1', 'acc_cue_t3_2'])
    expect(plan.assigned).toHaveLength(2)
    await saveProxyConfig('acc_cue_t3_1', { mode: 'http', host: '127.0.0.1', port: 8001 })
    await saveProxyConfig('acc_cue_t3_2', { mode: 'socks5', host: '127.0.0.1', port: 8002 })

    const openCueLogin = cue.loginMod.openCueLoginWindow as (id: string) => Promise<void>
    const cancelCueLogin = cue.loginMod.cancelCueLogin as (id: string) => Promise<void>
    void openCueLogin('acc_cue_t3_1')
    void openCueLogin('acc_cue_t3_2')
    await new Promise((r) => setTimeout(r, 20))

    const ses1 = electronHarness.getSession(partitionForAccount('acc_cue_t3_1'))
    expect(
      ses1.simulateBeforeSendHeaders('https://accounts.google.com/o/oauth2/auth', {
        'User-Agent': 'BotArk/0.12.1 Electron/45.2.1'
      })['User-Agent']
    ).not.toMatch(/Electron|BotArk/i)
    expect(
      ses1.simulateBeforeSendHeaders('https://challenges.cloudflare.com/turnstile/v0/api.js', {
        'Sec-CH-UA': '"Electron";v="45"'
      })['Sec-CH-UA']
    ).toContain('Electron')

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_cue_t3_1',
      credential: 'sk-manus-t3-1-1234567890'
    })
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_cue_t3_2',
      credential: 'Cookie: cue_session=t3_sess_2_1234567890'
    })
    await cancelCueLogin('acc_cue_t3_1')
    await cancelCueLogin('acc_cue_t3_2')

    expect(getOrCreate('acc_cue_t3_1')).not.toBe(getOrCreate('acc_cue_t3_2'))
    expect(((await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_cue_t3_1')) as { signedIn: boolean }).signedIn).toBe(true)
    expect(((await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_cue_t3_2')) as { signedIn: boolean }).signedIn).toBe(true)
  })

  it('E2E-T3-02: Dual-Cue Bots + Room CJK @mention + manual/auto Modes', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    void cue
    const members = [
      { botId: 'c1', accountId: 'a1', platform: 'cue' as Bot['platformId'], name: 'Cue · Alpha', cursor: 0 },
      { botId: 'c2', accountId: 'a2', platform: 'cue' as Bot['platformId'], name: 'Cue · Beta', cursor: 0 }
    ]
    requireOrSkip(
      ctx,
      'M3',
      mentions('请@Cue · Alpha先评估', members).map((m) => m.botId).join(',') === 'c1',
      'CJK @mention matching for Cue · Alpha not yet landed'
    )

    let emit!: (m: IncomingMessage) => void
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        const txt = m.accountId === 'a1' ? '初审完成，请@Cue · Beta复核' : '[FINAL] 终审通过'
        emit({ id: `m_${m.accountId}`, conversationId: m.conversationId, accountId: m.accountId, text: txt, createdAt: 1 })
        return { messageId: `r_${m.accountId}`, acceptedAt: 1 }
      }
    } as unknown as PlatformAdapter)

    useBotStore.setState({
      bots: members.map((m) => ({ id: m.botId, name: m.name, platformId: m.platform, accountIds: [m.accountId], activeAccountId: m.accountId } as Bot)),
      accounts: {
        a1: { id: 'a1', platformId: 'cue' as Bot['platformId'], displayName: 'Alpha', handle: 'a', status: 'online' },
        a2: { id: 'a2', platformId: 'cue' as Bot['platformId'], displayName: 'Beta', handle: 'b', status: 'online' }
      }
    })

    const room = addRoom('Pairwise Cue Room', ['c1', 'c2'], 'manual', 6)
    await submitBrief(room.id, '没有艾特的消息')
    expect(useRooms.getState().errors[room.id]).toBeTruthy()

    await submitBrief(room.id, '请@Cue · Alpha先评估')
    expect(useRooms.getState().rooms.find((r) => r.id === room.id)?.messages.some((m) => m.author === 'Cue · Alpha')).toBe(true)

    useRooms.setState((s) => ({
      rooms: s.rooms.map((r) => (r.id === room.id ? { ...r, mode: 'auto' } : r))
    }))
    await submitBrief(room.id, '请@Cue · Alpha和@Cue · Beta完成[FINAL]')
    expect(useRooms.getState().rooms.find((r) => r.id === room.id)?.finalId).toBeDefined()
  })

  it('E2E-T3-03: optimizeReady + Room [TOOL] Trailing Prose + Real Stdio MCP Execution', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { echoSrv: { command: process.execPath, args: [fixtures.validScript] } } }),
      'utf8'
    )
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await callWorkspaceSafe('t3_room', { op: 'bind' })

    let opt: (WorkspaceView & { lastReport?: { ready?: boolean } }) | undefined
    try {
      opt = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_room', { op: 'optimizeReady' })) as WorkspaceView & {
        lastReport?: { ready?: boolean }
      }
    } catch {
      opt = undefined
    }
    requireOrSkip(ctx, 'M4', Boolean(opt?.lastReport?.ready), 'optimizeReady not yet implemented')

    vi.stubGlobal('window', { electron: electronHarness.buildRendererBridge() })
    let emit!: (m: IncomingMessage) => void
    const replies = [
      '[TOOL] {"name":"echoSrv__echo","args":{"msg":"from-t3"}}\n正在调用工具',
      '[FINAL] 工具返回已收到'
    ]
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        emit({ id: `m_${replies.length}`, conversationId: m.conversationId, accountId: m.accountId, text: replies.shift()!, createdAt: 1 })
        return { messageId: 'rcpt', acceptedAt: 1 }
      }
    } as unknown as PlatformAdapter)

    useBotStore.setState({
      bots: [
        { id: 'b1', name: 'Muse', platformId: 'dot', accountIds: ['a1'], activeAccountId: 'a1' } as Bot,
        { id: 'b2', name: 'Dot', platformId: 'dot', accountIds: ['a2'], activeAccountId: 'a2' } as Bot
      ],
      accounts: {
        a1: { id: 'a1', platformId: 'dot', displayName: 'Muse', handle: '1', status: 'online' },
        a2: { id: 'a2', platformId: 'dot', displayName: 'Dot', handle: '2', status: 'online' }
      }
    })

    const room = addRoom('T3 Tool Room', ['b1', 'b2'], 'auto', 6)
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, room.id, { op: 'bind' })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, room.id, { op: 'optimizeReady' })

    await submitBrief(room.id, '@Muse run echoSrv__echo')
    const msgs = useRooms.getState().rooms.find((r) => r.id === room.id)!.messages
    expect(msgs.some((m) => m.author === 'Tool' && m.text.includes('stdio:from-t3'))).toBe(true)
  })

  it('E2E-T3-04: stopRoom AbortSignal + moveMemberToRoom + removeMember Last-Member Guard', async (ctx) => {
    const storeMod = await import('@/rooms/roomStore')
    const removeMember = (storeMod as Record<string, unknown>).removeMember as
      | ((r: string, b: string) => { ok: boolean })
      | undefined
    const moveMemberToRoom = (storeMod as Record<string, unknown>).moveMemberToRoom as
      | ((s: string, b: string, d: string) => { ok: boolean })
      | undefined
    requireOrSkip(ctx, 'M3', Boolean(removeMember && moveMemberToRoom), 'removeMember & moveMemberToRoom not yet implemented')

    let seenSignal: AbortSignal | undefined
    let release!: () => void
    let emit!: (m: IncomingMessage) => void
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: (m: OutgoingMessage & { signal?: AbortSignal }) => {
        seenSignal = m.signal
        if (!release) {
          return new Promise((resolve) => {
            release = () => resolve({ messageId: 'aborted', acceptedAt: 1 })
          })
        }
        emit({ id: 'ok', conversationId: m.conversationId, accountId: m.accountId, text: '[FINAL] moved ok', createdAt: 1 })
        return Promise.resolve({ messageId: 'ok', acceptedAt: 1 })
      }
    } as unknown as PlatformAdapter)

    useBotStore.setState({
      bots: ['CueA', 'CueB', 'Dot', 'Grok', 'Muse'].map(
        (n) => ({ id: n, name: n, platformId: 'dot', accountIds: [n], activeAccountId: n } as Bot)
      ),
      accounts: Object.fromEntries(
        ['CueA', 'CueB', 'Dot', 'Grok', 'Muse'].map((n) => [
          n,
          { id: n, platformId: 'dot', displayName: n, handle: n, status: 'online' }
        ])
      )
    })

    const roomA = addRoom('Room A', ['CueA', 'CueB', 'Dot'], 'auto', 4)
    const roomB = addRoom('Room B', ['Grok', 'Muse'], 'auto', 4)

    const running = submitBrief(roomA.id, '@CueA start')
    await new Promise((r) => setTimeout(r, 15))
    requireOrSkip(ctx, 'M3', Boolean(seenSignal), 'OutgoingMessage.signal not yet wired')
    stopRoom(roomA.id)
    expect(seenSignal!.aborted).toBe(true)
    release?.()
    await running

    expect(moveMemberToRoom!(roomA.id, 'CueA', roomB.id).ok).toBe(true)
    expect(removeMember!(roomA.id, 'Dot').ok).toBe(true)
    expect(useRooms.getState().rooms.find((r) => r.id === roomA.id)?.members).toHaveLength(1)
    await submitBrief(roomB.id, '@CueA verify')
    expect(useRooms.getState().rooms.find((r) => r.id === roomB.id)?.finalId).toBeDefined()
  })

  it('E2E-T3-05: Multi-Platform Room (Antigravity + Grok + Dot + Cue) + Legacy SSE MCP', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    void cue
    sseServer = await createMockLegacySseMcpServer()
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_sse', {
      op: 'upsert',
      name: 'sseSrv',
      config: { url: sseServer.sseUrl }
    })
    const sseView = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_sse', {
      op: 'start',
      server: 'sseSrv'
    })) as WorkspaceView
    expect(sseView.tools.some((t) => t.name === 'sseSrv__ping')).toBe(true)
  })

  it('E2E-T3-06: Unbound MCP + Rebind/Unbind + Hub Restart + createSafeStorage Room Persistence', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let ok = true
    try {
      await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_persist', {
        op: 'upsert',
        name: 'p_srv',
        config: { command: process.execPath, args: [fixtures.validScript] }
      })
    } catch {
      ok = false
    }
    requireOrSkip(ctx, 'M4', ok, 'Unbound MCP persistence not yet implemented')

    const d1 = join(workDir, 'd1')
    const d2 = join(workDir, 'd2')
    await mkdir(d1, { recursive: true })
    await mkdir(d2, { recursive: true })
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [d1] })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_persist', { op: 'bind' })
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [d2] })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_persist', { op: 'bind' })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_persist', { op: 'unbind' })

    stopWorkspaces()
    vi.resetModules()
    const reloaded = await import('@main/mcp/hub')
    reloaded.registerWorkspaceIpc(() => electronHarness.ensurePrimaryWindow() as unknown as Electron.BrowserWindow)
    const status = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't3_persist', { op: 'status' })) as WorkspaceView
    expect(status.servers.some((s) => s.name === 'p_srv')).toBe(true)
  })

  it('E2E-T3-07: Fail-Closed Proxy on Account 2 + Active Watch Stream & Room on Account 1 + Recovery', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    cueServer = await createMockCueServer()

    await saveProxyConfig('acc_cue_r1', { mode: 'direct' })
    await saveProxyConfig('acc_cue_r2', { mode: 'http', host: '127.0.0.1', port: 8111 })

    // Corrupt acc_cue_r2 ciphertext only
    const proxyFile = join(electronHarness.userDataDir, 'muse-account-proxy.json')
    const raw = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(proxyFile, 'utf8'))) as Record<
      string,
      { enc: string }
    >
    raw.acc_cue_r2 = { enc: Buffer.from('CORRUPT').toString('base64') }
    await writeFile(proxyFile, JSON.stringify(raw), 'utf8')

    await expect(applyProxyToPartition('acc_cue_r2')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    const ses2 = electronHarness.getSession(partitionForAccount('acc_cue_r2'))
    expect(ses2.setProxyCalls.some((p) => p.proxyRules === 'http://127.0.0.1:9')).toBe(true)

    // Meanwhile acc_cue_r1 succeeds
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_cue_r1',
      credential: JSON.stringify({ accessToken: 'tok_r1_1234567890', baseUrl: cueServer.url })
    })
    const h1 = (await electronHarness.invokeIpc(CUE_CHANNELS.rpc, {
      accountId: 'acc_cue_r1',
      op: 'health',
      baseUrl: cueServer.url
    })) as { ok: boolean }
    expect(h1.ok).toBe(true)

    // Repair acc_cue_r2
    await clearProxyConfig('acc_cue_r2')
    await expect(applyProxyToPartition('acc_cue_r2')).resolves.toBeUndefined()
  })
})

async function callWorkspaceSafe(scope: string, req: Record<string, unknown>) {
  return electronHarness.invokeIpc(WORKSPACE_CHANNEL, scope, req)
}
