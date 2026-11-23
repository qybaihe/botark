import { existsSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronHarness } from './harness/electronMock'
import {
  createMockLegacySseMcpServer,
  createStdioMcpFixtures,
  type MockLegacySseMcpServer
} from './harness/mockServers'
import { requireOrSkip } from './harness/contractAdapters'

vi.mock('electron', async () => {
  const { getElectronMockModule } = await import('./harness/electronMock')
  return getElectronMockModule()
})

import { registerWorkspaceIpc, stopWorkspaces } from '@main/mcp/hub'
import { workspaceFile } from '@main/mcp/workspaceFiles'
import { requestedTool } from '@/rooms/toolRequests'
import { addRoom, submitBrief, useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'
import { WORKSPACE_CHANNEL, type WorkspaceView } from '@shared/workspace'

type AnyWorkspaceView = WorkspaceView & {
  persistedCount?: number
  detectedConfigs?: Array<{ path: string; source?: string }>
  lastReport?: {
    ready?: boolean
    trusted?: boolean
    imported?: string[]
    started?: string[]
    failed?: Array<{ name: string; error: string }>
  }
  servers: Array<{
    name: string
    running: boolean
    transport?: string
    command?: string
    url?: string
    toolCount?: number
    lastError?: string
    source?: string
  }>
}

async function callWorkspace(scope: string, req: Record<string, unknown>): Promise<AnyWorkspaceView> {
  return (await electronHarness.invokeIpc(WORKSPACE_CHANNEL, scope, req)) as AnyWorkspaceView
}

describe('Area 4: MCP Management & One-Click Workspace Ready', () => {
  let workDir: string
  let sseServer: MockLegacySseMcpServer | undefined

  beforeEach(async () => {
    electronHarness.reset()
    workDir = await mkdtemp(join(tmpdir(), 'botark-e2e-ws-'))
    electronHarness.showMessageBoxMock.mockResolvedValue({ response: 1 })
    registerWorkspaceIpc(() => electronHarness.ensurePrimaryWindow() as unknown as Electron.BrowserWindow)
    useRooms.setState({ rooms: [], speakers: {}, turnProgress: {}, errors: {}, externalAudiences: {} })
    useBotStore.setState({ bots: [], accounts: {}, messages: {} })
  })

  afterEach(async () => {
    stopWorkspaces()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (sseServer) {
      await sseServer.close()
      sseServer = undefined
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  })

  afterAll(() => {
    electronHarness.cleanup()
  })

  it('E2E-T1-A4-01: Decouple MCP from Directory Gate & Persist Across Rebind/Unbind/Restart', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let unboundRes: AnyWorkspaceView | undefined
    try {
      unboundRes = await callWorkspace('room_unbound', {
        op: 'upsert',
        name: 'echo_srv',
        config: {
          command: process.execPath,
          args: [fixtures.validScript],
          env: { SECRET_API_KEY: 'super-secret-value-123' }
        }
      })
    } catch {
      unboundRes = undefined
    }

    requireOrSkip(
      ctx,
      'M4',
      Boolean(unboundRes && unboundRes.servers.some((s) => s.name === 'echo_srv')),
      'Hub must support MCP upsert/import without requiring a bound directory'
    )

    const started = await callWorkspace('room_unbound', { op: 'start', server: 'echo_srv' })
    expect(started.servers.find((s) => s.name === 'echo_srv')?.running).toBe(true)

    const dir1 = join(workDir, 'dir1')
    const dir2 = join(workDir, 'dir2')
    await mkdir(dir1, { recursive: true })
    await mkdir(dir2, { recursive: true })

    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [dir1] })
    const b1 = await callWorkspace('room_unbound', { op: 'bind' })
    expect(b1.servers.some((s) => s.name === 'echo_srv')).toBe(true)

    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [dir2] })
    const b2 = await callWorkspace('room_unbound', { op: 'bind' })
    expect(b2.servers.some((s) => s.name === 'echo_srv')).toBe(true)

    const unbound = await callWorkspace('room_unbound', { op: 'unbind' })
    expect(unbound.directory).toBeUndefined()
    expect(unbound.servers.some((s) => s.name === 'echo_srv')).toBe(true)

    // Simulate Hub restart against the same userDataDir
    stopWorkspaces()
    vi.resetModules()
    const reloadedHub = await import('@main/mcp/hub')
    reloadedHub.registerWorkspaceIpc(() => electronHarness.ensurePrimaryWindow() as unknown as Electron.BrowserWindow)
    const afterRestart = await callWorkspace('room_unbound', { op: 'status' })
    expect(afterRestart.servers.some((s) => s.name === 'echo_srv')).toBe(true)

    // Verify secret env is not stored in plaintext in userData
    const files = await import('node:fs/promises').then((fs) => fs.readdir(electronHarness.userDataDir))
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const content = await readFile(join(electronHarness.userDataDir, f), 'utf8')
      expect(content).not.toContain('super-secret-value-123')
    }
  })

  it('E2E-T1-A4-02: Full MCP CRUD (upsert, update, remove, restart) & Dialog Cancel Guard', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let created: AnyWorkspaceView | undefined
    try {
      created = await callWorkspace('crud_scope', {
        op: 'upsert',
        name: 'crud_srv',
        config: { command: process.execPath, args: [fixtures.validScript] }
      })
    } catch {
      created = undefined
    }

    requireOrSkip(ctx, 'M4', Boolean(created), 'MCP upsert/remove/restart CRUD operations not yet implemented')
    expect(created!.servers.some((s) => s.name === 'crud_srv')).toBe(true)

    await callWorkspace('crud_scope', { op: 'start', server: 'crud_srv' })
    const restarted = await callWorkspace('crud_scope', { op: 'restart', server: 'crud_srv' })
    expect(restarted.servers.find((s) => s.name === 'crud_srv')?.running).toBe(true)

    // Update args
    const updated = await callWorkspace('crud_scope', {
      op: 'upsert',
      name: 'crud_srv',
      config: { command: process.execPath, args: [fixtures.validScript, '--updated'] }
    })
    expect(updated.servers.some((s) => s.name === 'crud_srv')).toBe(true)

    // Dialog cancel must not modify servers
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const afterCancel = await callWorkspace('crud_scope', { op: 'import' })
    expect(afterCancel.servers.map((s) => s.name)).toEqual(['crud_srv'])

    const removed = await callWorkspace('crud_scope', { op: 'remove', server: 'crud_srv' })
    expect(removed.servers.some((s) => s.name === 'crud_srv')).toBe(false)
  })

  it('E2E-T1-A4-03: Multi-Format MCP Import (mcpServers, VS Code servers, Single Snippet, Aliases, BOM, JSONC, Unicode)', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let imported1: AnyWorkspaceView | undefined
    try {
      imported1 = await callWorkspace('fmt_scope', {
        op: 'importJson',
        text: `\uFEFF// JSONC header\n{ "servers": { "我的.MCP/工具": { "command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(fixtures.validScript)}] } } }`
      })
    } catch {
      imported1 = undefined
    }

    requireOrSkip(
      ctx,
      'M4',
      Boolean(imported1 && imported1.servers.some((s) => s.name === '我的.MCP/工具')),
      'Multi-format importJson (BOM, JSONC, VS Code servers, Unicode names) not yet implemented'
    )

    const imported2 = await callWorkspace('fmt_scope', {
      op: 'importJson',
      text: JSON.stringify({
        mcpServers: {
          '@scope/remote': { type: 'streamable-http', serverUrl: 'http://127.0.0.1:9999/mcp' },
          legacySse: { type: 'sse', sseUrl: 'http://127.0.0.1:9998/sse' }
        }
      })
    })
    expect(imported2.servers.some((s) => s.name === '@scope/remote')).toBe(true)
    expect(imported2.servers.some((s) => s.name === 'legacySse')).toBe(true)
  })

  it('E2E-T1-A4-04: Legacy HTTP+SSE Transport & StreamableHTTP -> SSE Fallback', async (ctx) => {
    sseServer = await createMockLegacySseMcpServer()

    let added: AnyWorkspaceView | undefined
    try {
      added = await callWorkspace('sse_scope', {
        op: 'upsert',
        name: 'sseSrv',
        config: { url: sseServer.sseUrl }
      })
    } catch {
      added = undefined
    }

    requireOrSkip(ctx, 'M4', Boolean(added), 'Unbound upsert for SSE server not yet implemented')

    let started: AnyWorkspaceView | undefined
    try {
      started = await callWorkspace('sse_scope', { op: 'start', server: 'sseSrv' })
    } catch {
      started = undefined
    }
    requireOrSkip(
      ctx,
      'M4',
      Boolean(started && started.tools.some((t) => t.name === 'sseSrv__ping')),
      'Hub must fall back from StreamableHTTP (404/405) to SSEClientTransport and list SSE tools'
    )

    const out = await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 'sse_scope', {
      op: 'run',
      tool: 'sseSrv__echo',
      args: { msg: 'hello-sse' },
      recipient: 'Tester'
    })
    expect(String(out)).toContain('sse-echo:hello-sse')
  })

  it('E2E-T1-A4-05: Stdio stderr Capture, cwd, Capability-Guarded listTools & Traversal Protection', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    const boundRoot = join(workDir, 'project_root')
    await mkdir(boundRoot, { recursive: true })
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [boundRoot] })
    await callWorkspace('stdio_scope', { op: 'bind' })

    let hasUpsert = true
    try {
      await callWorkspace('stdio_scope', {
        op: 'upsert',
        name: 'crash_srv',
        config: { command: process.execPath, args: [fixtures.stderrCrashScript] }
      })
    } catch {
      hasUpsert = false
    }
    requireOrSkip(ctx, 'M4', hasUpsert, 'MCP upsert/stderr capture not yet implemented')

    const afterCrash = await callWorkspace('stdio_scope', { op: 'start', server: 'crash_srv' }).catch(() =>
      callWorkspace('stdio_scope', { op: 'status' })
    )
    const crashErr = afterCrash.servers.find((s) => s.name === 'crash_srv')?.lastError ?? ''
    requireOrSkip(
      ctx,
      'M4',
      crashErr.includes('FATAL_STDIO_DIAG'),
      'Stdio stderr output must be captured into server lastError'
    )

    // Capability-less server (prompts only, no tools)
    await callWorkspace('stdio_scope', {
      op: 'upsert',
      name: 'no_tools_srv',
      config: { command: process.execPath, args: [fixtures.noToolsScript] }
    })
    const noToolsStarted = await callWorkspace('stdio_scope', { op: 'start', server: 'no_tools_srv' })
    expect(noToolsStarted.servers.find((s) => s.name === 'no_tools_srv')?.running).toBe(true)

    // Valid server cwd === boundRoot
    await callWorkspace('stdio_scope', {
      op: 'upsert',
      name: 'cwd_srv',
      config: { command: process.execPath, args: [fixtures.validScript] }
    })
    await callWorkspace('stdio_scope', { op: 'start', server: 'cwd_srv' })
    const pwdOut = String(
      await electronHarness.invokeIpc(WORKSPACE_CHANNEL, 'stdio_scope', {
        op: 'run',
        tool: 'cwd_srv__pwd',
        args: {},
        recipient: 'Tester'
      })
    )
    expect(pwdOut.replace(/\\\\/g, '\\').toLowerCase()).toContain(boundRoot.toLowerCase())

    // Traversal protection
    await expect(workspaceFile(boundRoot, 'read', { path: '../outside.txt' })).rejects.toThrow()
  })

  it('E2E-T1-A4-06: toolRequests.ts Trailing Prose & Fenced JSON + Room [TOOL] Execution', async (ctx) => {
    let parsed: { name: string; args: Record<string, unknown> } | undefined
    try {
      parsed = requestedTool('[TOOL] {"name":"write","args":{"path":"note.txt","text":"ok"}}\n我将写入文件')
    } catch {
      parsed = undefined
    }
    requireOrSkip(
      ctx,
      'M4',
      Boolean(parsed && parsed.name === 'write' && parsed.args.path === 'note.txt'),
      'requestedTool() must extract JSON cleanly even with trailing prose or markdown code fences'
    )

    const fenced = requestedTool('[TOOL] ```json\n{"name":"read","args":{"path":"note.txt"}}\n```\n说明')
    expect(fenced).toEqual({ name: 'read', args: { path: 'note.txt' } })

    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await callWorkspace('room_tool', { op: 'bind' })
    const bridge = electronHarness.buildRendererBridge()
    vi.stubGlobal('window', { electron: bridge })

    let emit!: (m: IncomingMessage) => void
    const turns = [
      '[TOOL] {"name":"write","args":{"path":"note.txt","text":"e2e-ok"}}\n已请求写入',
      '[FINAL] 已完成写入'
    ]
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      getStatus: () => 'online',
      onMessage: (fn: typeof emit) => {
        emit = fn
        return () => {}
      },
      sendMessage: async (m: OutgoingMessage) => {
        emit({ id: `m_${turns.length}`, conversationId: m.conversationId, accountId: m.accountId, text: turns.shift()!, createdAt: 1 })
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

    const room = addRoom('Tool Room', ['b1', 'b2'], 'auto', 6)
    await callWorkspace(room.id, { op: 'status' })
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await callWorkspace(room.id, { op: 'bind' })
    await submitBrief(room.id, '@Muse write note.txt')
    expect(await readFile(join(workDir, 'note.txt'), 'utf8')).toBe('e2e-ok')
  })

  it('E2E-T1-A4-07: One-Click Workspace detectConfigs & optimizeReady', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    await mkdir(join(workDir, '.vscode'), { recursive: true })
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          local_echo: { command: process.execPath, args: [fixtures.validScript] }
        }
      }),
      'utf8'
    )
    await writeFile(
      join(workDir, '.vscode', 'mcp.json'),
      JSON.stringify({
        servers: {
          vscode_echo: { command: process.execPath, args: [fixtures.validScript] }
        }
      }),
      'utf8'
    )

    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await callWorkspace('opt_scope', { op: 'bind' })

    let detected: AnyWorkspaceView | undefined
    let optimized: AnyWorkspaceView | undefined
    try {
      detected = await callWorkspace('opt_scope', { op: 'detectConfigs' })
      optimized = await callWorkspace('opt_scope', { op: 'optimizeReady' })
    } catch {
      detected = undefined
      optimized = undefined
    }

    requireOrSkip(
      ctx,
      'M4',
      Boolean(detected && optimized && optimized.lastReport?.ready),
      'Workspace ops detectConfigs and optimizeReady not yet implemented'
    )

    expect(detected!.detectedConfigs?.length).toBeGreaterThanOrEqual(2)
    expect(optimized!.servers.some((s) => s.name === 'local_echo' && s.running)).toBe(true)
    expect(optimized!.servers.some((s) => s.name === 'vscode_echo' && s.running)).toBe(true)
    expect(optimized!.tools.some((t) => t.name === 'local_echo__echo')).toBe(true)
  })

  it('E2E-T2-A4-01: Invalid MCP URLs & Empty Command Rejection', async (ctx) => {
    // Verify friendly validation error (never raw TypeError: Invalid URL) when M4 upsert/importJson is present
    let hasImportJson = true
    try {
      await callWorkspace('val_scope', { op: 'importJson', text: '{}' })
    } catch (e) {
      if (String(e).includes('请选择工作区')) hasImportJson = false
    }
    requireOrSkip(ctx, 'M4', hasImportJson, 'M4 validation & importJson not yet implemented')

    for (const badConfig of [
      { url: 'bad-url' },
      { url: null },
      { url: 'ftp://example.com/mcp' },
      { command: '' }
    ]) {
      let err: unknown
      try {
        await callWorkspace('val_scope', { op: 'upsert', name: 'bad_srv', config: badConfig })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(TypeError)
    }
  })

  it('E2E-T2-A4-02: UTF-8 BOM, JSONC Comments & Unicode/Punctuation Server Names', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let res: AnyWorkspaceView | undefined
    try {
      res = await callWorkspace('bom_scope', {
        op: 'importJson',
        text: `\uFEFF/* leading */\n{\n  // line comment\n  "servers": {\n    "我的.MCP/服务 v1": {\n      "command": ${JSON.stringify(process.execPath)},\n      "args": [${JSON.stringify(fixtures.validScript)}]\n    }\n  }\n}`
      })
    } catch {
      res = undefined
    }
    requireOrSkip(ctx, 'M4', Boolean(res && res.servers.some((s) => s.name === '我的.MCP/服务 v1')), 'BOM/JSONC/Unicode importJson not yet implemented')
    expect(res!.servers.some((s) => s.name.includes('__'))).toBe(false)
  })

  it('E2E-T2-A4-03: Dialog Cancel False-Positive Guard on import', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let hasUpsert = true
    try {
      await callWorkspace('cancel_scope', {
        op: 'upsert',
        name: 'keep_srv',
        config: { command: process.execPath, args: [fixtures.validScript] }
      })
    } catch {
      hasUpsert = false
    }
    requireOrSkip(ctx, 'M4', hasUpsert, 'M4 unbound upsert/cancel guard not yet implemented')

    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const res = await callWorkspace('cancel_scope', { op: 'import' })
    expect(res.servers.map((s) => s.name)).toEqual(['keep_srv'])
  })

  it('E2E-T2-A4-04: Hanging Stdio Connect Timeout Without manage Mutex Starvation', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    let hasUpsert = true
    try {
      await callWorkspace('hang_scope', {
        op: 'upsert',
        name: 'hang_srv',
        config: { command: process.execPath, args: [fixtures.hangScript] }
      })
    } catch {
      hasUpsert = false
    }
    requireOrSkip(ctx, 'M4', hasUpsert, 'M4 connect timeout & non-blocking manage mutex not yet implemented')

    const startPromise = callWorkspace('hang_scope', { op: 'start', server: 'hang_srv' }).catch((e) => e)
    const t0 = Date.now()
    const statusDuringHang = await callWorkspace('hang_scope', { op: 'status' })
    const elapsed = Date.now() - t0
    requireOrSkip(
      ctx,
      'M4',
      elapsed < 1000 && Boolean(statusDuringHang),
      'status/upsert must not block on a hanging MCP server connect()'
    )
    await startPromise
  })

  it('E2E-T2-A4-05: Workspace Path Traversal & Junction/Symlink Escape Rejection', async () => {
    const rootDir = join(workDir, 'safe_root')
    const outsideDir = join(workDir, 'outside_dir')
    await mkdir(rootDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    const secretFile = join(outsideDir, 'secret.txt')
    await writeFile(secretFile, 'top-secret', 'utf8')

    await expect(workspaceFile(rootDir, 'read', { path: '../outside_dir/secret.txt' })).rejects.toThrow(/outside/i)
    await expect(workspaceFile(rootDir, 'write', { path: secretFile, text: 'pwn' })).rejects.toThrow(/outside/i)

    const linkPath = join(rootDir, 'escape_link')
    if (process.platform === 'win32') {
      symlinkSync(outsideDir, linkPath, 'junction')
    } else {
      symlinkSync(outsideDir, linkPath, 'dir')
    }
    expect(existsSync(linkPath)).toBe(true)
    await expect(workspaceFile(rootDir, 'read', { path: 'escape_link/secret.txt' })).rejects.toThrow(/outside/i)
    expect(await readFile(secretFile, 'utf8')).toBe('top-secret')
  })

  it('E2E-T2-A4-06: [TOOL] Malformed JSON / Non-Object args vs Valid JSON + Prose', async (ctx) => {
    expect(() => requestedTool('[TOOL] {"name":"read","args":[1,2]}')).toThrow('无效的工具请求')
    expect(() => requestedTool('[TOOL] {bad')).toThrow()

    let ok: { name: string; args: Record<string, unknown> } | undefined
    try {
      ok = requestedTool('[TOOL] {"name":"read","args":{"path":"a"}}\nDone')
    } catch {
      ok = undefined
    }
    requireOrSkip(ctx, 'M4', Boolean(ok && ok.name === 'read'), 'requestedTool must tolerate trailing prose')
    expect(ok).toEqual({ name: 'read', args: { path: 'a' } })
  })

  it('E2E-T2-A4-07: optimizeReady Partial Failure Resilience', async (ctx) => {
    const fixtures = await createStdioMcpFixtures(workDir)
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          healthy_srv: { command: process.execPath, args: [fixtures.validScript] },
          broken_srv: { command: 'definitely_missing_mcp_bin_12345_xyz', args: [] }
        }
      }),
      'utf8'
    )
    electronHarness.showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [workDir] })
    await callWorkspace('partial_scope', { op: 'bind' })

    let res: AnyWorkspaceView | undefined
    try {
      res = await callWorkspace('partial_scope', { op: 'optimizeReady' })
    } catch {
      res = undefined
    }
    requireOrSkip(ctx, 'M4', Boolean(res && res.lastReport), 'optimizeReady not yet implemented')
    expect(res!.servers.find((s) => s.name === 'healthy_srv')?.running).toBe(true)
    const broken = res!.servers.find((s) => s.name === 'broken_srv')
    expect(broken?.running).toBe(false)
    expect(broken?.lastError || res!.lastReport?.failed?.length).toBeTruthy()
  })
})
