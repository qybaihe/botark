import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { BrowserWindow } from 'electron'
import type { WorkspaceRequest, WorkspaceView } from '@shared/workspace'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  confirm: vi.fn(),
  handle: vi.fn(),
  userDataDir: '',
  encryptionAvailable: true
}))

vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: { handle: mocks.handle },
  dialog: { showOpenDialog: mocks.open, showMessageBox: mocks.confirm },
  app: {
    getPath: () => mocks.userDataDir,
    isReady: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('invalid ciphertext')
      return s.slice(4)
    }
  }
}))

vi.mock('../hermes/hermesStore', () => ({
  getHermesAccount: () => ({ baseUrl: 'http://localhost:8080' }),
  listHermesAccountRecords: () => [],
  readLocalHermesEnv: () => ({
    baseUrl: 'http://127.0.0.1:8642',
    host: '127.0.0.1',
    port: 8642,
    hasApiKey: false
  })
}))

import { registerWorkspaceIpc, stopWorkspaces } from './hub'
import { getMcpRegistryPath } from './mcpStore'

const sender = { mainFrame: {} }
let root: string
let tempBase: string

const request = (scope: string, req: WorkspaceRequest): Promise<WorkspaceView> =>
  mocks.handle.mock.calls[0]![1]({ sender, senderFrame: sender.mainFrame }, scope, req)

const runTool = (
  scope: string,
  tool: string,
  args: Record<string, unknown>,
  recipient = 'Tester'
): Promise<string> =>
  mocks.handle.mock.calls[0]![1]({ sender, senderFrame: sender.mainFrame }, scope, {
    op: 'run',
    tool,
    args,
    recipient
  })

const sdkServerIndex = require.resolve('@modelcontextprotocol/sdk/server/index.js')
const sdkStdio = require.resolve('@modelcontextprotocol/sdk/server/stdio.js')
const sdkTypes = require.resolve('@modelcontextprotocol/sdk/types.js')

function stdioEchoScript(toolName = 'hello', extraInit = '') {
  return [
    `const { Server } = require(${JSON.stringify(sdkServerIndex)})`,
    `const { StdioServerTransport } = require(${JSON.stringify(sdkStdio)})`,
    `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkTypes)})`,
    extraInit,
    `const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}})`,
    `server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'${toolName}',inputSchema:{type:'object'}}]}))`,
    `server.setRequestHandler(CallToolRequestSchema, async (req) => ({content:[{type:'text',text:'ok:'+req.params.name}]}))`,
    'server.connect(new StdioServerTransport())'
  ]
    .filter(Boolean)
    .join('\n')
}

beforeEach(async () => {
  vi.clearAllMocks()
  tempBase = await realpath(await mkdtemp(join(tmpdir(), 'hub-fixture-')))
  root = join(tempBase, 'workspace')
  mocks.userDataDir = join(tempBase, 'userdata')
  mocks.encryptionAvailable = true
  await mkdir(root, { recursive: true })
  await mkdir(mocks.userDataDir, { recursive: true })
  mocks.open.mockResolvedValue({ canceled: false, filePaths: [root] })
  mocks.confirm.mockResolvedValue({ response: 1 })
  registerWorkspaceIpc(() => ({ webContents: sender } as unknown as BrowserWindow))
  await request('room', { op: 'bind' })
})

afterEach(async () => {
  stopWorkspaces()
  await rm(tempBase, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 }).catch(() => undefined)
})

describe('workspace MCP hub', () => {
  it('serves an authenticated loopback MCP client and requires approval for each write', async () => {
    const yaml = join(root, 'config.yaml')
    await writeFile(yaml, 'model: fixture\n')
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [yaml] })
    await request('room', { op: 'hermes', accountId: 'local' })
    const config = parse(await readFile(yaml, 'utf8'))
    expect(config.model).toBe('fixture')
    const { url, headers } = config.mcp_servers.botark_workspace
    expect((await fetch(url, { method: 'POST' })).status).toBe(403)
    const client = new Client({ name: 'fixture', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('patch')
      const call = { name: 'write', arguments: { path: 'draft.txt', text: 'accepted' } }
      mocks.confirm.mockResolvedValueOnce({ response: 0 })
      expect((await client.callTool(call)).isError).toBe(true)
      await expect(readFile(join(root, 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await client.callTool(call)).isError).toBeFalsy()
      expect(await readFile(join(root, 'draft.txt'), 'utf8')).toBe('accepted')

      const imported = join(root, 'mcp.json')
      await writeFile(imported, JSON.stringify({ mcpServers: { fixture: { url, headers } } }))
      mocks.open.mockResolvedValue({ canceled: false, filePaths: [root] })
      await request('other', { op: 'bind' })
      mocks.open.mockResolvedValue({ canceled: false, filePaths: [imported] })
      await request('other', { op: 'import' })
      expect((await request('other', { op: 'start', server: 'fixture' })).tools.map((t) => t.name)).toContain(
        'fixture__read'
      )
      expect((await request('other', { op: 'stop', server: 'fixture' })).tools.map((t) => t.name)).not.toContain(
        'fixture__read'
      )
    } finally {
      await client.close()
    }
  })

  it('starts and stops an imported stdio server using its actual MCP handshake', async () => {
    const file = join(root, 'fixture.json')
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { local: { command: process.execPath, args: ['-e', stdioEchoScript('hello')] } }
      })
    )
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [file] })
    await request('room', { op: 'import' })
    const started = await request('room', { op: 'start', server: 'local' })
    expect(started.tools.map((t) => t.name)).toContain('local__hello')
    const stopped = await request('room', { op: 'stop', server: 'local' })
    expect(stopped.servers).toMatchObject([{ name: 'local', running: false }])
  })

  it('allows full MCP CRUD, start, invoke, and persistence WITHOUT binding a directory and preserves servers on bind/unbind', async () => {
    const script = stdioEchoScript('ping')
    // 1. Add and start global MCP without any bound directory
    const added = await request('__global__', {
      op: 'upsert',
      autoStart: true,
      server: {
        name: 'global.mcp',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', script],
        env: { SECRET_ENV: 'TOP_SECRET_123' },
        targetScope: 'global'
      }
    })
    expect(added.directory).toBeUndefined()
    expect(added.servers[0]).toMatchObject({
      name: 'global.mcp',
      running: true,
      scope: 'global',
      envKeys: ['SECRET_ENV'],
      toolCount: 1
    })
    // Ensure plaintext secret is NEVER returned in WorkspaceView or persisted plaintext on disk
    expect(JSON.stringify(added)).not.toContain('TOP_SECRET_123')
    const diskText = await readFile(getMcpRegistryPath(), 'utf8')
    expect(diskText).not.toContain('TOP_SECRET_123')

    // 2. Unbound room sees global MCP tool and can invoke it without a directory
    const unboundStatus = await request('unbound-room', { op: 'status' })
    expect(unboundStatus.directory).toBeUndefined()
    expect(unboundStatus.tools.map((t) => t.name)).toContain('global_mcp__ping')
    expect(await runTool('unbound-room', 'global_mcp__ping', {})).toContain('ok:ping')

    // 3. Add scoped MCP to unbound room, then bind and unbind directory — servers must survive!
    await request('unbound-room', {
      op: 'upsert',
      server: {
        name: '@org/scoped tool',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', stdioEchoScript('pong')],
        targetScope: 'scope'
      }
    })
    const secondDir = join(tempBase, 'workspace-2')
    await mkdir(secondDir)
    const bound = await request('unbound-room', { op: 'bind', directory: secondDir })
    expect(bound.directory).toBe(secondDir)
    expect(bound.servers.map((s) => s.name)).toEqual(['global.mcp', '@org/scoped tool'])

    const unbound = await request('unbound-room', { op: 'unbind' })
    expect(unbound.directory).toBeUndefined()
    expect(unbound.servers.map((s) => s.name)).toEqual(['global.mcp', '@org/scoped tool'])

    // 4. Simulate app restart: stopWorkspaces() clears in-memory state, next status hydrates from disk
    stopWorkspaces()
    const rehydrated = await request('unbound-room', { op: 'status' })
    expect(rehydrated.servers.map((s) => s.name)).toEqual(['global.mcp', '@org/scoped tool'])
    expect(rehydrated.servers.find((s) => s.name === 'global.mcp')?.envKeys).toEqual(['SECRET_ENV'])
  })

  it('supports update (rename + keepExistingSecrets), restart, remove, import cancel, and JSONC importJson', async () => {
    await request('unbound', {
      op: 'upsert',
      server: {
        name: 's1',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', stdioEchoScript('v1')],
        env: { API_KEY: 'KEEP_ME_SECRET' }
      }
    })

    // Rename & keepExistingSecrets
    const updated = await request('unbound', {
      op: 'update',
      previousName: 's1',
      autoStart: true,
      server: {
        name: 's1-renamed',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', stdioEchoScript('v2')],
        keepExistingSecrets: true
      }
    })
    expect(updated.servers.map((s) => s.name)).toEqual(['s1-renamed'])
    expect(updated.servers[0]).toMatchObject({ running: true, envKeys: ['API_KEY'] })

    const restarted = await request('unbound', { op: 'restart', server: 's1-renamed' })
    expect(restarted.servers[0]?.running).toBe(true)

    const removed = await request('unbound', { op: 'remove', server: 's1-renamed' })
    expect(removed.servers).toEqual([])

    // Cancel import returns canceled: true & importedCount: 0
    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const canceled = await request('unbound', { op: 'import' })
    expect(canceled.canceled).toBe(true)
    expect(canceled.importedCount).toBe(0)

    // importJson with BOM + JSONC comments + VS Code `servers`
    const imported = await request('unbound', {
      op: 'importJson',
      autoStart: true,
      rawJson: `\uFEFF{\n// comment\n"servers": {\n"vs.tool": { "command": ${JSON.stringify(process.execPath)}, "args": ["-e", ${JSON.stringify(stdioEchoScript('vs'))}], },\n}\n}`
    })
    expect(imported.importedCount).toBe(1)
    expect(imported.tools.map((t) => t.name)).toContain('vs_tool__vs')
  })

  it('falls back from StreamableHTTP to legacy SSEClientTransport when transport is auto', async () => {
    const transports = new Map<string, SSEServerTransport>()
    const httpServer = createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'POST' && reqUrl.pathname === '/sse') {
        res.writeHead(405).end('Method Not Allowed')
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res)
        transports.set(transport.sessionId, transport)
        const mcpServer = new Server(
          { name: 'legacy-sse', version: '1' },
          { capabilities: { tools: {} } }
        )
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'sse_tool', inputSchema: { type: 'object' } }]
        }))
        res.on('close', () => {
          transports.delete(transport.sessionId)
          void mcpServer.close()
        })
        await mcpServer.connect(transport)
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/messages') {
        const sid = reqUrl.searchParams.get('sessionId') || ''
        const transport = transports.get(sid)
        if (!transport) {
          res.writeHead(404).end()
          return
        }
        await transport.handlePostMessage(req, res)
        return
      }
      res.writeHead(404).end()
    })

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const addr = httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    try {
      const view = await request('sse-room', {
        op: 'upsert',
        autoStart: true,
        server: {
          name: 'legacy-sse',
          transport: 'auto',
          url: `http://127.0.0.1:${port}/sse`
        }
      })
      expect(view.servers[0]).toMatchObject({
        name: 'legacy-sse',
        running: true,
        resolvedTransport: 'sse',
        toolCount: 1
      })
      expect(view.tools.map((t) => t.name)).toContain('legacy-sse__sse_tool')
    } finally {
      stopWorkspaces()
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  })

  it('captures stderr into lastError, guards tools-less servers, and avoids mutex deadlock on pending approval', async () => {
    // 1. Failing stdio server captures stderr into lastError
    await request('diag', {
      op: 'upsert',
      server: {
        name: 'broken',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', "process.stderr.write('BOOM_STDERR_REASON\\n'); process.exit(1)"]
      }
    })
    await expect(request('diag', { op: 'start', server: 'broken' })).rejects.toThrow()
    const afterFail = await request('diag', { op: 'status' })
    expect(afterFail.servers[0]?.lastError).toContain('BOOM_STDERR_REASON')

    // 2. Server without `tools` capability connects cleanly with 0 tools
    const promptsOnly = [
      "const { Server } = require('@modelcontextprotocol/sdk/server/index.js')",
      "const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')",
      "const server = new Server({name:'prompts-only',version:'1'}, {capabilities:{prompts:{}}})",
      'server.connect(new StdioServerTransport())'
    ].join('\n')
    const noToolsView = await request('diag', {
      op: 'upsert',
      autoStart: true,
      server: {
        name: 'prompts-only',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', promptsOnly]
      }
    })
    const promptsSrv = noToolsView.servers.find((s) => s.name === 'prompts-only')
    expect(promptsSrv?.running).toBe(true)
    expect(promptsSrv?.toolCount).toBe(0)

    // 3. Pending approval dialog on start does NOT deadlock concurrent status requests
    let releaseConfirm!: (v: { response: number }) => void
    mocks.confirm.mockImplementationOnce(
      () =>
        new Promise<{ response: number }>((resolve) => {
          releaseConfirm = resolve
        })
    )
    await request('diag', {
      op: 'upsert',
      server: {
        name: 'slow-approve',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', stdioEchoScript('ok')]
      }
    })
    const pendingStart = request('diag', { op: 'start', server: 'slow-approve' })
    const statusWhilePending = await request('diag', { op: 'status' })
    expect(statusWhilePending.servers.some((s) => s.name === 'slow-approve')).toBe(true)
    releaseConfirm({ response: 0 })
    await expect(pendingStart).rejects.toThrow(/取消/)
  })

  it('detectConfigs and optimizeReady discover, merge non-destructively, isolate failures, and return readiness report', async () => {
    // Pre-existing user server should NOT be overwritten by .mcp.json
    await request('opt-room', {
      op: 'upsert',
      server: {
        name: 'keep-me',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', stdioEchoScript('custom_kept')]
      }
    })

    // Create .mcp.json (valid + shadowed/existing), .vscode/mcp.json (valid + broken), .cursor/mcp.json (malformed)
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'keep-me': { command: 'echo', args: ['should-not-overwrite'] },
          'auto-ok': { command: process.execPath, args: ['-e', stdioEchoScript('auto_tool')] }
        }
      })
    )
    await mkdir(join(root, '.vscode'), { recursive: true })
    await writeFile(
      join(root, '.vscode', 'mcp.json'),
      `// VS Code JSONC\n{\n  "servers": {\n    "auto-ok": { "command": "echo", "args": ["shadowed"] },\n    "vs-broken": { "command": ${JSON.stringify(process.execPath)}, "args": ["-e", "process.stderr.write('VS_FAIL\\n'); process.exit(1)"] }\n  }\n}`
    )
    await mkdir(join(root, '.cursor'), { recursive: true })
    await writeFile(join(root, '.cursor', 'mcp.json'), '{ malformed json !!!')

    const detectedView = await request('opt-room', { op: 'bind', directory: root })
    expect(detectedView.detectedConfigs?.length).toBe(3)

    const readyView = await request('opt-room', {
      op: 'optimizeReady',
      directory: root,
      autoStart: true
    })

    expect(readyView.directory).toBe(root)
    expect(readyView.trusted).toBe(true)
    expect(readyView.lastReport).toBeDefined()
    expect(readyView.lastReport!.importedServers).toEqual(['auto-ok', 'vs-broken'])
    expect(readyView.lastReport!.skippedExisting).toEqual(['keep-me'])
    expect(readyView.lastReport!.skippedShadowed).toEqual(['auto-ok'])
    expect(readyView.lastReport!.malformedFiles).toHaveLength(1)
    expect(readyView.lastReport!.startedServers).toEqual(expect.arrayContaining(['keep-me', 'auto-ok']))
    expect(readyView.lastReport!.failedServers).toEqual([
      expect.objectContaining({ name: 'vs-broken' })
    ])
    expect(readyView.tools.map((t) => t.name)).toContain('auto-ok__auto_tool')
    expect(readyView.tools.map((t) => t.name)).toContain('keep-me__custom_kept')
    // Existing server command was preserved, not overwritten
    expect(readyView.servers.find((s) => s.name === 'keep-me')?.args).toEqual([
      '-e',
      stdioEchoScript('custom_kept')
    ])
  })
})
