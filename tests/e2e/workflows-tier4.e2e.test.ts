import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { probeCueContracts, requireOrSkip } from './harness/contractAdapters'

vi.mock('electron', async () => {
  const { getElectronMockModule } = await import('./harness/electronMock')
  return getElectronMockModule()
})

import { registerWorkspaceIpc, stopWorkspaces } from '@main/mcp/hub'
import { applyProxyToPartition, clearProxyConfig, ProxyConfigUnreadableError, saveProxyConfig } from '@main/muse/accountProxy'
import { partitionForAccount } from '@main/webContentsViewManager'
import { planPoolAssignment } from '@shared/proxyPool'
import { WORKSPACE_CHANNEL, type WorkspaceView } from '@shared/workspace'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import { roomMarkdown } from '@/rooms/model'
import { addRoom, stopRoom, submitBrief, useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'

describe('Tier 4: Real-World End-to-End Application Workflows', () => {
  let workDir: string
  let cueServer: MockCueServer | undefined
  let sseServer: MockLegacySseMcpServer | undefined

  beforeEach(async () => {
    electronHarness.reset()
    workDir = await mkdtemp(join(tmpdir(), 'botark-e2e-t4-'))
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

  it('E2E-T4-01: Complete Dual-Cue Onboarding, Clean Auth & Two-Room Collaboration', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >
    const cancelCueLogin = cue.loginMod.cancelCueLogin as (id: string) => Promise<void>

    const slots = planPoolAssignment([{ id: 's1' }, { id: 's2' }], ['acc_t4_cue_1', 'acc_t4_cue_2'])
    expect(slots.assigned).toHaveLength(2)

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_t4_cue_1',
      credential: 'Bearer jwt_t4_alice_1234567890'
    })
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_t4_cue_2',
      credential: 'sk-manus-t4-bob-1234567890'
    })
    await cancelCueLogin('acc_t4_cue_1')
    await cancelCueLogin('acc_t4_cue_2')

    let emit!: (m: IncomingMessage) => void
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        const txt = m.accountId === 'acc_t4_cue_1' ? '初稿完成，请@Cue · Bob审阅' : '[FINAL]\n双 Cue 协作最终交付物'
        emit({ id: `m_${m.accountId}`, conversationId: m.conversationId, accountId: m.accountId, text: txt, createdAt: 1 })
        return { messageId: `r_${m.accountId}`, acceptedAt: 1, sessionId: `sess_${m.accountId}` }
      }
    } as unknown as PlatformAdapter)

    useBotStore.setState({
      bots: [
        { id: 'b_alice', name: 'Cue · Alice', platformId: 'cue' as Bot['platformId'], accountIds: ['acc_t4_cue_1'], activeAccountId: 'acc_t4_cue_1' } as Bot,
        { id: 'b_bob', name: 'Cue · Bob', platformId: 'cue' as Bot['platformId'], accountIds: ['acc_t4_cue_2'], activeAccountId: 'acc_t4_cue_2' } as Bot
      ],
      accounts: {
        acc_t4_cue_1: { id: 'acc_t4_cue_1', platformId: 'cue' as Bot['platformId'], displayName: 'Alice', handle: 'alice@cue.im', status: 'online' },
        acc_t4_cue_2: { id: 'acc_t4_cue_2', platformId: 'cue' as Bot['platformId'], displayName: 'Bob', handle: 'bob@cue.im', status: 'online' }
      },
      messages: { b_alice: [], b_bob: [] }
    })

    const room = addRoom('Cue Dual Launch', ['b_alice', 'b_bob'], 'auto', 6)
    await submitBrief(room.id, '请@Cue · Alice起草，然后@Cue · Bob定稿')
    const finished = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(finished.finalId).toBeDefined()
    expect(roomMarkdown(finished)).toContain('双 Cue 协作最终交付物')
    expect(useBotStore.getState().messages.b_alice).toEqual([])
    expect(useBotStore.getState().messages.b_bob).toEqual([])
  })

  it('E2E-T4-02: One-Click Workspace Optimize & Ready -> Immediate Tool-Assisted Collaboration', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    await mkdir(join(workDir, '.vscode'), { recursive: true })
    await writeFile(
      join(workDir, '.vscode', 'mcp.json'),
      `\uFEFF// VS Code MCP\n{ "servers": { "proj_echo": { "command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(fixtures.validScript)}] } } }`,
      'utf8'
    )
    await writeFile(join(workDir, 'notes.txt'), 'Project Context: BotArk v0.12.1', 'utf8')

    let optReady = false
    try {
      electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
      await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_ws', { op: 'bind' })
      const opt = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_ws', { op: 'optimizeReady' })) as WorkspaceView & {
        lastReport?: { ready?: boolean }
      }
      optReady = Boolean(opt?.lastReport?.ready)
    } catch {
      optReady = false
    }
    requireOrSkip(ctx, 'M4', optReady, 'One-click optimizeReady not yet implemented')

    vi.stubGlobal('window', { electron: electronHarness.buildRendererBridge() })
    let emit!: (m: IncomingMessage) => void
    const script = [
      '[TOOL] {"name":"read","args":{"path":"notes.txt"}}\n读取 notes.txt',
      '[TOOL] {"name":"proj_echo__echo","args":{"msg":"BotArk v0.12.1"}}\n调用本地 MCP',
      '[FINAL] 已阅读 notes.txt 并完成 MCP 验证'
    ]
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        emit({ id: `m_${script.length}`, conversationId: m.conversationId, accountId: m.accountId, text: script.shift()!, createdAt: 1 })
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

    const room = addRoom('T4 Ready Room', ['b1', 'b2'], 'auto', 8)
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, room.id, { op: 'bind' })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, room.id, { op: 'optimizeReady' })

    await submitBrief(room.id, '@Muse inspect notes.txt and echo')
    const after = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(after.finalId).toBeDefined()
    expect(after.messages.some((m) => m.author === 'Tool' && m.text.includes('Project Context: BotArk v0.12.1'))).toBe(true)
    expect(after.messages.some((m) => m.author === 'Tool' && m.text.includes('stdio:BotArk v0.12.1'))).toBe(true)
  })

  it('E2E-T4-03: Mid-Project Bot Reassignment (stopRoom -> moveMemberToRoom -> removeMember)', async (ctx) => {
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
        if (!release && m.accountId === 'CueA') {
          return new Promise((resolve) => {
            release = () => resolve({ messageId: 'stop', acceptedAt: 1 })
          })
        }
        emit({ id: `r_${m.accountId}`, conversationId: m.conversationId, accountId: m.accountId, text: `[FINAL] ${m.accountId} done`, createdAt: 1 })
        return Promise.resolve({ messageId: `r_${m.accountId}`, acceptedAt: 1 })
      }
    } as unknown as PlatformAdapter)

    useBotStore.setState({
      bots: ['CueA', 'CueB', 'Grok', 'Dot', 'Hark'].map(
        (n) => ({ id: n, name: n, platformId: 'dot', accountIds: [n], activeAccountId: n } as Bot)
      ),
      accounts: Object.fromEntries(
        ['CueA', 'CueB', 'Grok', 'Dot', 'Hark'].map((n) => [n, { id: n, platformId: 'dot', displayName: n, handle: n, status: 'online' }])
      )
    })

    const backend = addRoom('Backend', ['CueA', 'CueB', 'Grok'], 'auto', 4)
    const frontend = addRoom('Frontend', ['Dot', 'Hark'], 'auto', 4)

    const p = submitBrief(backend.id, '@CueA begin')
    await new Promise((r) => setTimeout(r, 15))
    requireOrSkip(ctx, 'M3', Boolean(seenSignal), 'AbortSignal on sendMessage not yet implemented')
    stopRoom(backend.id)
    expect(seenSignal!.aborted).toBe(true)
    release?.()
    await p

    expect(moveMemberToRoom!(backend.id, 'CueB', frontend.id).ok).toBe(true)
    expect(removeMember!(frontend.id, 'Hark').ok).toBe(true)
    expect(removeMember!(frontend.id, 'Dot').ok).toBe(true)
    expect(removeMember!(frontend.id, 'CueB').ok).toBe(false)
    expect(removeMember!(backend.id, 'Grok').ok).toBe(true)
    expect(removeMember!(backend.id, 'CueA').ok).toBe(false)

    await submitBrief(backend.id, '@CueA finish backend')
    await submitBrief(frontend.id, '@CueB finish frontend')
    expect(useRooms.getState().rooms.find((r) => r.id === backend.id)?.finalId).toBeDefined()
    expect(useRooms.getState().rooms.find((r) => r.id === frontend.id)?.finalId).toBeDefined()
  })

  it('E2E-T4-04: MCP Setup Without Directory + Broken Stdio Recovery + Restart Persistence', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    sseServer = await createMockLegacySseMcpServer()

    let imported: WorkspaceView | undefined
    try {
      imported = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', {
        op: 'importJson',
        text: `// JSONC\n{ "mcpServers": { "我的服务": { "command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(fixtures.hangScript)}] }, "sse_srv": { "url": ${JSON.stringify(sseServer.sseUrl)} } } }`
      })) as WorkspaceView
    } catch {
      imported = undefined
    }
    requireOrSkip(ctx, 'M4', Boolean(imported), 'M4 unbound importJson not yet implemented')

    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', { op: 'start', server: '我的服务' }).catch(() => undefined)
    const sseStarted = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', { op: 'start', server: 'sse_srv' })) as WorkspaceView
    expect(sseStarted.tools.some((t) => t.name === 'sse_srv__ping')).toBe(true)

    // Repair broken server via upsert + restart
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', {
      op: 'upsert',
      name: '我的服务',
      config: { command: process.execPath, args: [fixtures.validScript] }
    })
    const repaired = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', { op: 'restart', server: '我的服务' })) as WorkspaceView
    expect(repaired.servers.find((s) => s.name === '我的服务')?.running).toBe(true)

    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', { op: 'bind' })

    stopWorkspaces()
    vi.resetModules()
    const reloaded = await import('@main/mcp/hub')
    reloaded.registerWorkspaceIpc(() => electronHarness.ensurePrimaryWindow() as unknown as Electron.BrowserWindow)
    const afterRestart = (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 't4_rec', { op: 'status' })) as WorkspaceView
    expect(afterRestart.servers.some((s) => s.name === '我的服务')).toBe(true)
    expect(afterRestart.servers.some((s) => s.name === 'sse_srv')).toBe(true)
  })

  it('E2E-T4-05: 4-Platform Cross-Vendor Review Room (Antigravity + Grok + Dot + Cue)', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    void cue

    let emit!: (m: IncomingMessage) => void
    const sharedMock: PlatformAdapter = {
      id: 'dot',
      name: 'Multi',
      listAccounts: async () => [],
      connect: async () => 'online',
      disconnect: async () => {},
      getStatus: () => 'online',
      subscribe: () => () => {},
      onMessage: (fn) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        const relay: Record<string, string> = {
          acc_agy: 'Agy 完成架构检查，请@Grok 复核',
          acc_grok: 'Grok 复核完成，请@Dot 补充用例',
          acc_dot: 'Dot 用例已补充，请@Cue · Alice 定稿',
          acc_cue: '[FINAL]\n四平台联合审查结论已生成'
        }
        emit({ id: `m_${m.accountId}`, conversationId: m.conversationId, accountId: m.accountId, text: relay[m.accountId]!, createdAt: 1 })
        return { messageId: `r_${m.accountId}`, acceptedAt: 1, sessionId: `s_${m.accountId}` }
      }
    }
    vi.spyOn(adapterRegistry, 'get').mockReturnValue(sharedMock)

    useBotStore.setState({
      bots: [
        { id: 'b_agy', name: 'Antigravity', platformId: 'antigravity', accountIds: ['acc_agy'], activeAccountId: 'acc_agy' } as Bot,
        { id: 'b_grok', name: 'Grok', platformId: 'grok', accountIds: ['acc_grok'], activeAccountId: 'acc_grok' } as Bot,
        { id: 'b_dot', name: 'Dot', platformId: 'dot', accountIds: ['acc_dot'], activeAccountId: 'acc_dot' } as Bot,
        { id: 'b_cue', name: 'Cue · Alice', platformId: 'cue' as Bot['platformId'], accountIds: ['acc_cue'], activeAccountId: 'acc_cue' } as Bot
      ],
      accounts: {
        acc_agy: { id: 'acc_agy', platformId: 'antigravity', displayName: 'Agy', handle: 'a', status: 'online' },
        acc_grok: { id: 'acc_grok', platformId: 'grok', displayName: 'Grok', handle: 'g', status: 'online' },
        acc_dot: { id: 'acc_dot', platformId: 'dot', displayName: 'Dot', handle: 'd', status: 'online' },
        acc_cue: { id: 'acc_cue', platformId: 'cue' as Bot['platformId'], displayName: 'Alice', handle: 'c', status: 'online' }
      },
      messages: { b_agy: [], b_grok: [], b_dot: [], b_cue: [] }
    })

    const room = addRoom('Cross-Vendor Review', ['b_agy', 'b_grok', 'b_dot', 'b_cue'], 'auto', 8)
    await submitBrief(room.id, '请@Antigravity 开始四方联合审查')
    const out = useRooms.getState().rooms.find((r) => r.id === room.id)!
    expect(out.finalId).toBeDefined()
    expect(out.messages.map((m) => m.author)).toEqual(['User', 'Antigravity', 'Grok', 'Dot', 'Cue · Alice'])
    expect(useBotStore.getState().messages.b_dot).toEqual([])
  })

  it('E2E-T4-06: Adversarial Auth/Proxy Recovery During Multi-Account Operation', async (ctx) => {
    const cue = await probeCueContracts(ctx)
    cueServer = await createMockCueServer()
    const registerCueIpc = cue.ipcMod.registerCueIpc as () => void
    registerCueIpc()
    const CUE_CHANNELS = ((await import('@shared/ipc')) as Record<string, unknown>).CUE_CHANNELS as Record<
      string,
      string
    >
    const cancelCueLogin = cue.loginMod.cancelCueLogin as (id: string) => Promise<void>

    await electronHarness.invokeIpc(CUE_CHANNELS.openLogin, { accountId: 'acc_adv_1', openInBrowser: true })
    expect(electronHarness.openExternalCalls.length).toBeGreaterThanOrEqual(1)

    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_adv_1',
      credential: 'Cookie: cue_session=adv_sess_1234567890'
    })
    await cancelCueLogin('acc_adv_1')

    await saveProxyConfig('acc_adv_2', { mode: 'http', host: '127.0.0.1', port: 8222 })
    const proxyFile = join(electronHarness.userDataDir, 'muse-account-proxy.json')
    const raw = JSON.parse(await readFile(proxyFile, 'utf8')) as Record<string, { enc: string }>
    raw.acc_adv_2 = { enc: Buffer.from('CORRUPT_CIPHER').toString('base64') }
    await writeFile(proxyFile, JSON.stringify(raw), 'utf8')

    await expect(applyProxyToPartition('acc_adv_2')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    const ses2 = electronHarness.getSession(partitionForAccount('acc_adv_2'))
    expect(ses2.setProxyCalls.some((p) => p.proxyRules === 'http://127.0.0.1:9')).toBe(true)

    // Repair acc_adv_2 & finish
    await clearProxyConfig('acc_adv_2')
    await expect(applyProxyToPartition('acc_adv_2')).resolves.toBeUndefined()
    await electronHarness.invokeIpc(CUE_CHANNELS.importCredentials, {
      accountId: 'acc_adv_2',
      credential: JSON.stringify({ accessToken: 'tok_adv_2_1234567890', baseUrl: cueServer.url })
    })
    expect(((await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_adv_1')) as { signedIn: boolean }).signedIn).toBe(true)
    expect(((await electronHarness.invokeIpc(CUE_CHANNELS.authStatus, 'acc_adv_2')) as { signedIn: boolean }).signedIn).toBe(true)
  })
})
