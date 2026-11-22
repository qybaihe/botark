import { createServer, type Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { parseDocument } from 'yaml'
import {
  WORKSPACE_CHANNEL,
  type DetectedMcpConfig,
  type McpConfigScope,
  type McpServerConfigInput,
  type McpServerSource,
  type McpTransportType,
  type WorkspaceOptimizeReport,
  type WorkspaceRequest,
  type WorkspaceServerView,
  type WorkspaceTool,
  type WorkspaceView
} from '@shared/workspace'
import { createMutex } from '@shared/proxyPool'
import * as hermesStore from '../hermes/hermesStore'
import { proxyFetch } from '../proxyTransport'
import {
  allocateToolPrefix,
  normalizeServerInput,
  parseHermesYamlMcpServers,
  parseMcpConfigObject,
  parseMcpConfigText,
  type ParsedMcpServer
} from './configParser'
import {
  isPersistedDirectoryTrusted,
  loadMcpRegistry,
  removePersistedServer,
  savePersistedServer,
  savePersistedServersBatch,
  saveScopeDirectory
} from './mcpStore'
import { fileTools, workspaceFile } from './workspaceFiles'

const GLOBAL_SCOPE = '__global__'
const CONNECT_TIMEOUT_MS = process.env['VITEST'] ? 2_500 : 12_000
const LIST_TOOLS_TIMEOUT_MS = process.env['VITEST'] ? 4_000 : 15_000
const STDERR_RING_LIMIT = 4096

interface External {
  config: ParsedMcpServer
  source: McpServerSource
  envKeys: string[]
  headerKeys: string[]
  client?: Client
  resolvedTransport?: McpTransportType
  tools: WorkspaceTool[]
  lastError?: string
  generation: number
}

interface Binding {
  root?: string
  trusted: boolean
  servers: Map<string, External>
  endpoint?: { server: HttpServer; url: string; token: string }
  lastReport?: WorkspaceOptimizeReport
}

const globalServers = new Map<string, External>()
const scopes = new Map<string, Binding>()
const inFlightConnects = new Map<string, AbortController>()
const withStateLock = createMutex()
let hydrated = false
let persistedCount = 0

function flightKey(ownerScope: McpConfigScope, scopeId: string, name: string): string {
  return `${ownerScope === 'global' ? GLOBAL_SCOPE : scopeId}:${name}`
}

function getOrCreateBinding(scopeId: string): Binding {
  let b = scopes.get(scopeId)
  if (!b) {
    b = { trusted: false, servers: new Map() }
    scopes.set(scopeId, b)
  }
  return b
}

function createExternal(
  config: ParsedMcpServer,
  source: McpServerSource,
  envKeys?: string[],
  headerKeys?: string[],
  lastError?: string
): External {
  return {
    config,
    source,
    envKeys: envKeys ?? (config.env ? Object.keys(config.env) : []),
    headerKeys: headerKeys ?? (config.headers ? Object.keys(config.headers) : []),
    tools: [],
    lastError,
    generation: 0
  }
}

async function ensureHydrated(): Promise<void> {
  if (hydrated) return
  await withStateLock(async () => {
    if (hydrated) return
    const reg = await loadMcpRegistry()
    persistedCount = reg.persistedCount
    for (const [name, item] of reg.globalServers) {
      if (!globalServers.has(name)) {
        globalServers.set(
          name,
          createExternal(item.config, item.source, item.envKeys, item.headerKeys, item.decryptError)
        )
      }
    }
    for (const [scopeId, stored] of reg.scopes) {
      const binding = getOrCreateBinding(scopeId)
      if (!binding.root && stored.directory) {
        binding.root = stored.directory
        binding.trusted = stored.trusted
      }
      for (const [name, item] of stored.servers) {
        if (!binding.servers.has(name)) {
          binding.servers.set(
            name,
            createExternal(item.config, item.source, item.envKeys, item.headerKeys, item.decryptError)
          )
        }
      }
    }
    hydrated = true
  })
}

interface EffectiveEntry {
  name: string
  prefix: string
  ext: External
  ownerScope: McpConfigScope
}

function effectiveEntries(scopeId: string, binding?: Binding): EffectiveEntry[] {
  const usedPrefixes = new Set<string>()
  const entries: EffectiveEntry[] = []

  if (scopeId === GLOBAL_SCOPE) {
    for (const [name, ext] of globalServers) {
      entries.push({
        name,
        prefix: allocateToolPrefix(name, usedPrefixes),
        ext,
        ownerScope: 'global'
      })
    }
    return entries
  }

  for (const [name, ext] of globalServers) {
    if (binding?.servers.has(name)) continue
    entries.push({
      name,
      prefix: allocateToolPrefix(name, usedPrefixes),
      ext,
      ownerScope: 'global'
    })
  }
  if (binding) {
    for (const [name, ext] of binding.servers) {
      entries.push({
        name,
        prefix: allocateToolPrefix(name, usedPrefixes),
        ext,
        ownerScope: 'scope'
      })
    }
  }
  return entries
}

function resolveTargetOwner(
  scopeId: string,
  requestedTarget?: McpConfigScope
): McpConfigScope {
  if (scopeId === GLOBAL_SCOPE) return 'global'
  return requestedTarget === 'global' ? 'global' : 'scope'
}

function findServerEntry(
  scopeId: string,
  name: string,
  requestedTarget?: McpConfigScope
): { ext: External; ownerScope: McpConfigScope; map: Map<string, External> } | undefined {
  if (scopeId === GLOBAL_SCOPE || requestedTarget === 'global') {
    const ext = globalServers.get(name)
    return ext ? { ext, ownerScope: 'global', map: globalServers } : undefined
  }
  const binding = scopes.get(scopeId)
  if (requestedTarget === 'scope') {
    const ext = binding?.servers.get(name)
    return ext && binding ? { ext, ownerScope: 'scope', map: binding.servers } : undefined
  }
  const scoped = binding?.servers.get(name)
  if (scoped && binding) return { ext: scoped, ownerScope: 'scope', map: binding.servers }
  const global = globalServers.get(name)
  return global ? { ext: global, ownerScope: 'global', map: globalServers } : undefined
}

function toServerView(entry: EffectiveEntry): WorkspaceServerView {
  const { name, ext, ownerScope } = entry
  return {
    name,
    running: !!ext.client,
    enabled: ext.config.enabled,
    ...(ext.config.needsConfig ? { needsConfig: true } : {}),
    transport: ext.config.transport,
    ...(ext.resolvedTransport ? { resolvedTransport: ext.resolvedTransport } : {}),
    ...(ext.config.command !== undefined ? { command: ext.config.command } : {}),
    ...(ext.config.args !== undefined ? { args: ext.config.args } : {}),
    ...(ext.config.url !== undefined ? { url: ext.config.url } : {}),
    ...(ext.config.cwd !== undefined ? { cwd: ext.config.cwd } : {}),
    ...(ext.envKeys.length ? { envKeys: [...ext.envKeys] } : {}),
    ...(ext.headerKeys.length ? { headerKeys: [...ext.headerKeys] } : {}),
    toolCount: ext.tools.length,
    ...(ext.lastError ? { lastError: ext.lastError } : {}),
    source: ext.source,
    scope: ownerScope
  }
}

function view(
  scopeId: string,
  binding?: Binding,
  extras?: Partial<Pick<WorkspaceView, 'detectedConfigs' | 'lastReport' | 'canceled' | 'importedCount'>>
): WorkspaceView {
  const entries = effectiveEntries(scopeId, binding)
  const externalTools: WorkspaceTool[] = entries.flatMap((entry) =>
    entry.ext.tools.map((t) => ({ ...t, name: `${entry.prefix}__${t.name}` }))
  )
  const tools = binding?.root ? [...fileTools, ...externalTools] : externalTools
  return {
    ...(binding?.root ? { directory: binding.root, trusted: binding.trusted } : {}),
    persistedCount,
    servers: entries.map(toServerView),
    tools,
    ...(extras?.detectedConfigs !== undefined ? { detectedConfigs: extras.detectedConfigs } : {}),
    ...(extras?.lastReport !== undefined || binding?.lastReport !== undefined
      ? { lastReport: extras?.lastReport ?? binding?.lastReport }
      : {}),
    ...(extras?.canceled !== undefined ? { canceled: extras.canceled } : {}),
    ...(extras?.importedCount !== undefined ? { importedCount: extras.importedCount } : {})
  }
}

async function approve(win: BrowserWindow, message: string, detail: string) {
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    message,
    detail,
    buttons: ['取消', '允许一次'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (choice.response !== 1) throw new Error('用户已取消本次操作')
}

async function invoke(
  win: BrowserWindow,
  scopeId: string,
  tool: string,
  args: Record<string, unknown>,
  recipient: string
): Promise<string> {
  await ensureHydrated()
  const binding = scopes.get(scopeId)
  const snapshot = view(scopeId, binding)
  if (!snapshot.tools.some((t) => t.name === tool)) throw new Error('工具不可用')

  const separator = tool.indexOf('__')
  if (separator < 0) {
    if (!binding?.root) throw new Error('请选择工作区')
    const boundRoot = binding.root
    await approve(
      win,
      `${recipient} 请求使用 ${tool}`,
      `目录：${boundRoot}\n参数：${JSON.stringify(args, null, 2)}`
    )
    const current = scopes.get(scopeId)
    if (current !== binding || current?.root !== boundRoot) throw new Error('目录授权已变更')
    return workspaceFile(boundRoot, tool, args)
  }

  const prefix = tool.slice(0, separator)
  const remoteTool = tool.slice(separator + 2)
  const entry = effectiveEntries(scopeId, binding).find((e) => e.prefix === prefix)
  if (!entry) throw new Error('工具不可用')
  const clientAtStart = entry.ext.client
  if (!clientAtStart) throw new Error('MCP 服务已停止')

  await approve(
    win,
    `${recipient} 请求使用 ${tool}`,
    `服务：${entry.name}\n目录：${binding?.root ?? '未绑定工作区（仅 MCP 工具）'}\n参数：${JSON.stringify(args, null, 2)}`
  )
  if (entry.ext.client !== clientAtStart) throw new Error('MCP 服务已停止')

  const result = await clientAtStart.callTool({ name: remoteTool, arguments: args })
  const text = JSON.stringify(result.content ?? result)
  return text.length > 96000 ? text.slice(0, 96000) + '\n… (result truncated)' : text
}

class StderrRingBuffer {
  private buf = ''
  append(chunk: Buffer | string) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (!s) return
    this.buf += s
    if (this.buf.length > STDERR_RING_LIMIT) {
      this.buf = this.buf.slice(this.buf.length - STDERR_RING_LIMIT)
    }
  }
  text(): string {
    return this.buf.trim()
  }
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function createFetchForUrl(rawUrl: string): typeof fetch {
  if (isLoopbackUrl(rawUrl)) return fetch
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    return proxyFetch(undefined, target, init)
  }) as typeof fetch
}

function shouldFallbackToSse(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) return false
    return err.code === 400 || err.code === 404 || err.code === 405 || err.code === 406 || err.code === 501 || err.code === -1
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/\b(401|403|unauthorized|forbidden)\b/i.test(msg)) return false
  return /\b(400|404|405|406|501)\b|content-type|text\/event-stream|invalid content type/i.test(msg)
}

function formatMcpError(err: unknown, stderrText?: string): string {
  const base = err instanceof Error ? err.message : String(err)
  const tail = stderrText?.trim()
  if (!tail) return base
  if (base.includes(tail)) return base
  return `${base}\n[stderr] ${tail}`
}

async function safeCloseClient(client: Client | undefined): Promise<void> {
  if (!client) return
  try {
    await client.close()
  } catch {
    /* preserve primary error */
  }
}

function describeServerTarget(config: ParsedMcpServer): string {
  if (config.command) {
    return `以当前用户身份运行本地程序：${config.command} ${JSON.stringify(config.args ?? [])}\n该程序可以访问当前用户可访问的文件。`
  }
  return `连接 ${new URL(config.url!).origin}`
}

async function connectWithTimeout(
  client: Client,
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('MCP 连接已取消')
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      void Promise.resolve(transport.close()).catch(() => undefined)
      void safeCloseClient(client)
      reject(signal.reason instanceof Error ? signal.reason : new Error('MCP 连接超时或已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    client
      .connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS })
      .then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      )
  })
}

async function startExternal(
  ownerScope: McpConfigScope,
  scopeId: string,
  name: string,
  ext: External,
  win: BrowserWindow,
  root?: string,
  options?: { skipApproval?: boolean }
): Promise<void> {
  if (ext.client) return
  if (ext.config.needsConfig) {
    const errMsg = `MCP 服务「${name}」存在未填写的环境变量或密钥，请先编辑配置`
    ext.lastError = errMsg
    throw new Error(errMsg)
  }

  const key = flightKey(ownerScope, scopeId, name)
  if (inFlightConnects.has(key)) {
    throw new Error(`MCP 服务「${name}」正在启动中，请稍候`)
  }

  const gen = ++ext.generation
  const ac = new AbortController()
  inFlightConnects.set(key, ac)

  try {
    if (!options?.skipApproval) {
      await approve(win, `启动 MCP 服务 ${name}`, describeServerTarget(ext.config))
    }
    if (ac.signal.aborted || ext.generation !== gen) {
      throw ac.signal.reason instanceof Error ? ac.signal.reason : new Error('启动已取消')
    }

    const timeoutTimer = setTimeout(() => {
      ac.abort(new Error(`MCP 连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`))
    }, CONNECT_TIMEOUT_MS)

    const stderrRing = new StderrRingBuffer()
    let client = new Client({ name: 'BotArk', version: '1' })
    let usedTransport: McpTransportType = 'stdio'

    try {
      if (ext.config.command) {
        usedTransport = 'stdio'
        const effectiveCwd = ext.config.cwd || root
        const transport = new StdioClientTransport({
          command: ext.config.command,
          args: ext.config.args,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          env: ext.config.env
            ? { ...getDefaultEnvironment(), ...ext.config.env }
            : getDefaultEnvironment(),
          stderr: 'pipe'
        })
        transport.stderr?.on('data', (chunk: Buffer | string) => stderrRing.append(chunk))
        await connectWithTimeout(client, transport, ac.signal)
      } else if (ext.config.url) {
        const targetUrl = ext.config.url
        const customFetch = createFetchForUrl(targetUrl)
        const requestInit = ext.config.headers ? { headers: ext.config.headers } : undefined

        if (ext.config.transport === 'sse') {
          usedTransport = 'sse'
          const transport = new SSEClientTransport(new URL(targetUrl), {
            requestInit,
            fetch: customFetch
          })
          await connectWithTimeout(client, transport, ac.signal)
        } else if (ext.config.transport === 'streamable-http') {
          usedTransport = 'streamable-http'
          const transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
            requestInit,
            fetch: customFetch
          })
          await connectWithTimeout(client, transport, ac.signal)
        } else {
          usedTransport = 'streamable-http'
          const httpTransport = new StreamableHTTPClientTransport(new URL(targetUrl), {
            requestInit,
            fetch: customFetch
          })
          try {
            await connectWithTimeout(client, httpTransport, ac.signal)
          } catch (firstErr) {
            if (ac.signal.aborted || !shouldFallbackToSse(firstErr)) {
              throw firstErr
            }
            await safeCloseClient(client)
            client = new Client({ name: 'BotArk', version: '1' })
            usedTransport = 'sse'
            const sseTransport = new SSEClientTransport(new URL(targetUrl), {
              requestInit,
              fetch: customFetch
            })
            await connectWithTimeout(client, sseTransport, ac.signal)
          }
        }
      } else {
        throw new Error(`无效的 MCP 配置（${name}）：缺少 command 或 url`)
      }

      if (ac.signal.aborted || ext.generation !== gen) {
        await safeCloseClient(client)
        throw new Error('服务启动已被中止')
      }

      const tools: WorkspaceTool[] = []
      const caps = client.getServerCapabilities()
      if (caps?.tools) {
        let cursor: string | undefined
        do {
          const page = await client.listTools(
            { cursor },
            { signal: ac.signal, timeout: LIST_TOOLS_TIMEOUT_MS }
          )
          tools.push(...page.tools)
          cursor = page.nextCursor
        } while (cursor)
      }

      if (ac.signal.aborted || ext.generation !== gen) {
        await safeCloseClient(client)
        throw new Error('服务启动已被中止')
      }

      ext.client = client
      ext.tools = tools
      ext.resolvedTransport = usedTransport
      ext.lastError = undefined

      client.onclose = () => {
        if (ext.client === client) {
          ext.client = undefined
          ext.tools = []
          const tail = stderrRing.text()
          if (tail && !ext.lastError) {
            ext.lastError = `[stderr] ${tail}`
          }
        }
      }
      client.onerror = (err) => {
        if (ext.client === client) {
          ext.lastError = formatMcpError(err, stderrRing.text())
        }
      }
    } catch (err) {
      await safeCloseClient(client)
      const formatted = formatMcpError(err, stderrRing.text())
      ext.lastError = formatted
      throw new Error(formatted)
    } finally {
      clearTimeout(timeoutTimer)
    }
  } finally {
    if (inFlightConnects.get(key) === ac) {
      inFlightConnects.delete(key)
    }
  }
}

async function stopExternal(
  ownerScope: McpConfigScope,
  scopeId: string,
  name: string,
  ext: External
): Promise<void> {
  ext.generation++
  const key = flightKey(ownerScope, scopeId, name)
  inFlightConnects.get(key)?.abort(new Error('服务已停止'))
  inFlightConnects.delete(key)
  const client = ext.client
  ext.client = undefined
  ext.tools = []
  ext.resolvedTransport = undefined
  await safeCloseClient(client)
}

async function disposeBinding(scopeId: string, binding: Binding): Promise<void> {
  binding.endpoint?.server.closeAllConnections()
  binding.endpoint?.server.close()
  binding.endpoint = undefined
  await Promise.all(
    [...binding.servers.entries()].map(([name, ext]) => stopExternal('scope', scopeId, name, ext))
  )
}

async function startEndpoint(scopeId: string, binding: Binding, win: BrowserWindow) {
  if (binding.endpoint) return binding.endpoint
  const token = randomBytes(32).toString('base64url')
  const http = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.authorization !== 'Bearer ' + token || req.headers.origin) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const server = new Server({ name: 'botark-workspace', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: view(scopeId, binding).tools }))
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      try {
        const text = await invoke(win, scopeId, call.params.name, call.params.arguments ?? {}, 'Hermes')
        return { content: [{ type: 'text', text }] }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: String(e) }] }
      }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', resolve)
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('MCP listener unavailable')
  return (binding.endpoint = { server: http, token, url: `http://127.0.0.1:${address.port}/mcp` })
}

function getHermesHome(): string {
  return process.env['HERMES_HOME']?.trim() || join(homedir(), '.hermes')
}

async function connectHermes(
  win: BrowserWindow,
  scopeId: string,
  binding: Binding,
  accountId: string,
  configPath?: string
): Promise<boolean> {
  if (!binding.root) throw new Error('请先选择工作区目录')
  const account = hermesStore.getHermesAccount(accountId)
  if (!account || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(account.baseUrl).hostname)) {
    throw new Error('Loopback MCP 需要同机 Hermes 网关')
  }
  let targetPath = configPath?.trim()
  if (!targetPath) {
    const defaultYaml = join(getHermesHome(), 'config.yaml')
    const pick = await dialog.showOpenDialog(win, {
      title: '选择此 Hermes 实例的 config.yaml',
      defaultPath: existsSync(defaultYaml) ? defaultYaml : undefined,
      properties: ['openFile'],
      filters: [{ name: 'Hermes YAML', extensions: ['yaml', 'yml'] }]
    })
    if (pick.canceled) return false
    targetPath = pick.filePaths[0]!
  }
  const path = await realpath(targetPath)
  const original = await readFile(path, 'utf8')
  const config = parseDocument(original)
  if (config.errors.length) throw new Error('配置文件不是有效 YAML')
  await approve(
    win,
    '将本地工作区接入 Hermes',
    `${path}\nmcp_servers.botark_workspace 将指向 ${binding.root}。重新加载 Hermes 配置后生效。`
  )
  const endpoint = await startEndpoint(scopeId, binding, win)
  config.setIn(['mcp_servers', 'botark_workspace'], {
    url: endpoint.url,
    headers: { Authorization: 'Bearer ' + endpoint.token }
  })
  if ((await readFile(path, 'utf8')) !== original) throw new Error('Hermes 配置已变更，请重试')
  const tmp = path + '.' + randomUUID()
  try {
    await writeFile(tmp, config.toString(), { mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
  return true
}

function withinRoot(root: string, file: string): boolean {
  const rel = relative(root, file)
  return !(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
}

function collectSkipLoopbackUrls(binding?: Binding): Set<string> {
  const urls = new Set<string>()
  if (binding?.endpoint?.url) urls.add(binding.endpoint.url)
  for (const b of scopes.values()) {
    if (b.endpoint?.url) urls.add(b.endpoint.url)
  }
  return urls
}

interface ScannedConfigResult {
  detected: DetectedMcpConfig[]
  parsedByPath: Map<string, ParsedMcpServer[]>
}

async function scanConfigCandidates(
  root: string | undefined,
  existingNames: Set<string>,
  includeUserConfigs: boolean,
  skipLoopbackUrls: Set<string>
): Promise<ScannedConfigResult> {
  const detected: DetectedMcpConfig[] = []
  const parsedByPath = new Map<string, ParsedMcpServer[]>()
  const seenRealPaths = new Set<string>()

  if (root) {
    const workspaceCandidates = [
      { rel: '.mcp.json', label: '.mcp.json' },
      { rel: 'mcp.json', label: 'mcp.json' },
      { rel: join('.cursor', 'mcp.json'), label: '.cursor/mcp.json' },
      { rel: join('.vscode', 'mcp.json'), label: '.vscode/mcp.json' }
    ]
    for (const item of workspaceCandidates) {
      const fullPath = join(root, item.rel)
      if (!existsSync(fullPath)) continue
      try {
        const real = await realpath(fullPath)
        if (!withinRoot(root, real)) {
          detected.push({
            path: fullPath,
            label: item.label,
            origin: 'workspace',
            serverCount: 0,
            serverNames: [],
            newServerNames: [],
            parseError: '配置文件路径越界，已跳过'
          })
          continue
        }
        if (seenRealPaths.has(real)) continue
        seenRealPaths.add(real)
        const raw = await readFile(real, 'utf8')
        const servers = parseMcpConfigText(raw, {
          workspaceRoot: root,
          skipLoopbackUrls
        })
        const serverNames = servers.map((s) => s.name)
        const newServerNames = serverNames.filter((n) => !existingNames.has(n))
        parsedByPath.set(real, servers)
        detected.push({
          path: real,
          label: item.label,
          origin: 'workspace',
          serverCount: servers.length,
          serverNames,
          newServerNames
        })
      } catch (err) {
        detected.push({
          path: fullPath,
          label: item.label,
          origin: 'workspace',
          serverCount: 0,
          serverNames: [],
          newServerNames: [],
          parseError: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  if (includeUserConfigs) {
    const hermesYamlPath = join(getHermesHome(), 'config.yaml')
    if (existsSync(hermesYamlPath)) {
      try {
        const real = await realpath(hermesYamlPath)
        if (!seenRealPaths.has(real)) {
          seenRealPaths.add(real)
          const raw = await readFile(real, 'utf8')
          const servers = parseHermesYamlMcpServers(raw, {
            workspaceRoot: root,
            skipLoopbackUrls
          })
          if (servers.length > 0) {
            const serverNames = servers.map((s) => s.name)
            parsedByPath.set(real, servers)
            detected.push({
              path: real,
              label: '~/.hermes/config.yaml',
              origin: 'user',
              serverCount: servers.length,
              serverNames,
              newServerNames: serverNames.filter((n) => !existingNames.has(n))
            })
          }
        }
      } catch (err) {
        detected.push({
          path: hermesYamlPath,
          label: '~/.hermes/config.yaml',
          origin: 'user',
          serverCount: 0,
          serverNames: [],
          newServerNames: [],
          parseError: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const claudeDesktopPath =
      process.platform === 'win32'
        ? join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')

    const userJsonCandidates = [
      { path: join(homedir(), '.cursor', 'mcp.json'), label: '~/.cursor/mcp.json' },
      { path: claudeDesktopPath, label: 'Claude Desktop' }
    ]

    for (const item of userJsonCandidates) {
      if (!existsSync(item.path)) continue
      try {
        const real = await realpath(item.path)
        if (seenRealPaths.has(real)) continue
        seenRealPaths.add(real)
        const raw = await readFile(real, 'utf8')
        const servers = parseMcpConfigText(raw, {
          workspaceRoot: root,
          skipLoopbackUrls
        })
        const serverNames = servers.map((s) => s.name)
        parsedByPath.set(real, servers)
        detected.push({
          path: real,
          label: item.label,
          origin: 'user',
          serverCount: servers.length,
          serverNames,
          newServerNames: serverNames.filter((n) => !existingNames.has(n))
        })
      } catch (err) {
        detected.push({
          path: item.path,
          label: item.label,
          origin: 'user',
          serverCount: 0,
          serverNames: [],
          newServerNames: [],
          parseError: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const claudeJsonPath = join(homedir(), '.claude.json')
    if (existsSync(claudeJsonPath)) {
      try {
        const real = await realpath(claudeJsonPath)
        if (!seenRealPaths.has(real)) {
          seenRealPaths.add(real)
          const raw = JSON.parse(await readFile(real, 'utf8')) as Record<string, unknown>
          const collected: ParsedMcpServer[] = []
          const seenNames = new Set<string>()
          const projects =
            raw && typeof raw === 'object' && raw['projects'] && typeof raw['projects'] === 'object'
              ? (raw['projects'] as Record<string, unknown>)
              : undefined
          if (root && projects?.[root]) {
            try {
              for (const s of parseMcpConfigObject(projects[root], { workspaceRoot: root, skipLoopbackUrls })) {
                if (!seenNames.has(s.name)) {
                  seenNames.add(s.name)
                  collected.push(s)
                }
              }
            } catch {
              /* ignore project entry without mcpServers */
            }
          }
          if (raw?.['mcpServers']) {
            try {
              for (const s of parseMcpConfigObject({ mcpServers: raw['mcpServers'] }, { workspaceRoot: root, skipLoopbackUrls })) {
                if (!seenNames.has(s.name)) {
                  seenNames.add(s.name)
                  collected.push(s)
                }
              }
            } catch {
              /* ignore empty */
            }
          }
          if (collected.length > 0) {
            const serverNames = collected.map((s) => s.name)
            parsedByPath.set(real, collected)
            detected.push({
              path: real,
              label: '~/.claude.json',
              origin: 'user',
              serverCount: collected.length,
              serverNames,
              newServerNames: serverNames.filter((n) => !existingNames.has(n))
            })
          }
        }
      } catch (err) {
        detected.push({
          path: claudeJsonPath,
          label: '~/.claude.json',
          origin: 'user',
          serverCount: 0,
          serverNames: [],
          newServerNames: [],
          parseError: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  return { detected, parsedByPath }
}

async function inspectHermesReadiness(binding?: Binding): Promise<WorkspaceOptimizeReport['hermes']> {
  const hermesHome = getHermesHome()
  const homeFound = existsSync(hermesHome)
  const envFound = existsSync(join(hermesHome, '.env'))
  const configYamlPath = join(hermesHome, 'config.yaml')
  const hasConfigYaml = existsSync(configYamlPath)
  let configuredAccounts = 0
  try {
    if (typeof hermesStore.listHermesAccountRecords === 'function') {
      configuredAccounts = hermesStore.listHermesAccountRecords().length
    }
  } catch {
    configuredAccounts = 0
  }
  if (typeof hermesStore.readLocalHermesEnv === 'function') {
    try {
      hermesStore.readLocalHermesEnv()
    } catch {
      /* ignore */
    }
  }

  let loopbackState: 'active' | 'stale' | 'unconfigured' = 'unconfigured'
  if (hasConfigYaml) {
    try {
      const doc = parseDocument(await readFile(configYamlPath, 'utf8'))
      const urlVal = doc.getIn(['mcp_servers', 'botark_workspace', 'url'])
      if (typeof urlVal === 'string' && urlVal.trim()) {
        loopbackState = binding?.endpoint?.url === urlVal.trim() ? 'active' : 'stale'
      }
    } catch {
      /* ignore malformed yaml */
    }
  }

  return {
    homeFound,
    envFound,
    ...(hasConfigYaml ? { configYamlPath } : {}),
    configuredAccounts,
    loopbackState
  }
}

async function bindDirectory(
  scopeId: string,
  win: BrowserWindow,
  requestedDir?: string,
  optimizedAtMs?: number
): Promise<{ canceled: boolean; binding: Binding }> {
  let rawDir = requestedDir?.trim()
  if (!rawDir) {
    const pick = await dialog.showOpenDialog(win, {
      title: '授权工作区目录',
      properties: ['openDirectory']
    })
    if (pick.canceled || !pick.filePaths[0]) {
      return { canceled: true, binding: getOrCreateBinding(scopeId) }
    }
    rawDir = pick.filePaths[0]
  }
  const realRoot = await realpath(rawDir)
  const info = await stat(realRoot)
  if (!info.isDirectory()) {
    throw new Error(`所选路径不是有效目录：${rawDir}`)
  }

  let binding!: Binding
  await withStateLock(async () => {
    binding = getOrCreateBinding(scopeId)
    if (binding.root && binding.root !== realRoot && binding.endpoint) {
      binding.endpoint.server.closeAllConnections()
      binding.endpoint.server.close()
      binding.endpoint = undefined
    }
    binding.root = realRoot
    binding.trusted = true
    await saveScopeDirectory({ scopeId, directory: realRoot, optimizedAtMs })
  })

  return { canceled: false, binding }
}

async function batchStartServers(
  scopeId: string,
  binding: Binding | undefined,
  win: BrowserWindow,
  candidates: Array<{ name: string; ext: External; ownerScope: McpConfigScope }>
): Promise<{ startedServers: string[]; failedServers: Array<{ name: string; error: string }> }> {
  const startedServers: string[] = []
  const failedServers: Array<{ name: string; error: string }> = []
  if (!candidates.length) return { startedServers, failedServers }

  const detail = candidates
    .map((c) => `• ${c.name}：${c.ext.config.command ? `${c.ext.config.command} ${(c.ext.config.args ?? []).join(' ')}`.trim() : c.ext.config.url}`)
    .join('\n')

  try {
    await approve(win, `启动 ${candidates.length} 个 MCP 服务`, detail)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    for (const c of candidates) {
      failedServers.push({ name: c.name, error: reason })
    }
    return { startedServers, failedServers }
  }

  const results = await Promise.allSettled(
    candidates.map(async (c) => {
      await startExternal(c.ownerScope, scopeId, c.name, c.ext, win, binding?.root, {
        skipApproval: true
      })
      return c.name
    })
  )

  for (let i = 0; i < results.length; i++) {
    const res = results[i]!
    const item = candidates[i]!
    if (res.status === 'fulfilled') {
      startedServers.push(item.name)
    } else {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason)
      failedServers.push({ name: item.name, error: msg })
    }
  }
  return { startedServers, failedServers }
}

function mergeSecretsOnEdit(
  parsed: ParsedMcpServer,
  prev: External | undefined,
  keepExistingSecrets: boolean
): ParsedMcpServer {
  if (!keepExistingSecrets || !prev) return parsed
  const env =
    parsed.env !== undefined
      ? prev.config.env
        ? { ...prev.config.env, ...parsed.env }
        : parsed.env
      : prev.config.env
  const headers =
    parsed.headers !== undefined
      ? prev.config.headers
        ? { ...prev.config.headers, ...parsed.headers }
        : parsed.headers
      : prev.config.headers
  return {
    ...parsed,
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {})
  }
}

export function registerWorkspaceIpc(owner: () => BrowserWindow | null) {
  ipcMain.handle(WORKSPACE_CHANNEL, async (event, scope: string, request: WorkspaceRequest) => {
    const win = owner()
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Desktop window required')
    }
    const scopeId = (scope || '').trim() || GLOBAL_SCOPE
    await ensureHydrated()

    if (request.op === 'run') {
      return invoke(win, scopeId, request.tool, request.args, request.recipient)
    }

    switch (request.op) {
      case 'status': {
        const binding = scopes.get(scopeId)
        if (binding?.root && !binding.trusted) {
          binding.trusted = await isPersistedDirectoryTrusted(binding.root)
        }
        return view(scopeId, binding)
      }

      case 'bind': {
        const res = await bindDirectory(scopeId, win, request.directory)
        if (res.canceled) {
          return view(scopeId, scopes.get(scopeId), { canceled: true })
        }
        const existingNames = new Set(effectiveEntries(scopeId, res.binding).map((e) => e.name))
        const scanned = await scanConfigCandidates(
          res.binding.root,
          existingNames,
          false,
          collectSkipLoopbackUrls(res.binding)
        )
        return view(scopeId, res.binding, {
          canceled: false,
          detectedConfigs: scanned.detected
        })
      }

      case 'unbind': {
        const binding = scopes.get(scopeId)
        if (binding) {
          await withStateLock(async () => {
            binding.root = undefined
            binding.trusted = false
            binding.lastReport = undefined
            binding.endpoint?.server.closeAllConnections()
            binding.endpoint?.server.close()
            binding.endpoint = undefined
            await saveScopeDirectory({ scopeId, directory: undefined })
          })
        }
        return view(scopeId, binding)
      }

      case 'hermes': {
        const binding = scopes.get(scopeId)
        if (!binding?.root) throw new Error('请先选择工作区目录')
        const applied = await connectHermes(win, scopeId, binding, request.accountId, request.configPath)
        return view(scopeId, binding, { canceled: !applied })
      }

      case 'import': {
        const pick = await dialog.showOpenDialog(win, {
          title: '导入 mcpServers JSON',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json', 'jsonc'] }]
        })
        if (pick.canceled || !pick.filePaths[0]) {
          return view(scopeId, scopes.get(scopeId), { canceled: true, importedCount: 0 })
        }
        const rawText = await readFile(pick.filePaths[0], 'utf8')
        const binding = scopes.get(scopeId)
        const parsedServers = parseMcpConfigText(rawText, { workspaceRoot: binding?.root })
        const ownerScope = resolveTargetOwner(scopeId, request.targetScope)
        const targetMap = ownerScope === 'global' ? globalServers : getOrCreateBinding(scopeId).servers

        const toSave: Array<{ server: ParsedMcpServer; source: McpServerSource }> = []
        const importedExternals: Array<{ name: string; ext: External }> = []

        await withStateLock(async () => {
          for (const srv of parsedServers) {
            const prev = targetMap.get(srv.name)
            if (prev) await stopExternal(ownerScope, scopeId, srv.name, prev)
            const ext = createExternal(srv, 'import')
            targetMap.set(srv.name, ext)
            toSave.push({ server: srv, source: 'import' })
            importedExternals.push({ name: srv.name, ext })
          }
          persistedCount = await savePersistedServersBatch({
            targetScope: ownerScope,
            scopeId,
            servers: toSave
          })
        })

        if (request.autoStart) {
          const startable = importedExternals
            .filter(({ ext }) => ext.config.enabled && !ext.config.needsConfig)
            .map(({ name, ext }) => ({ name, ext, ownerScope }))
          await batchStartServers(scopeId, scopes.get(scopeId), win, startable)
        }

        return view(scopeId, scopes.get(scopeId), {
          canceled: false,
          importedCount: parsedServers.length
        })
      }

      case 'importJson': {
        const binding = scopes.get(scopeId)
        const reqAny = request as unknown as { rawJson?: unknown; text?: unknown; json?: unknown }
        const rawJsonText =
          typeof reqAny.rawJson === 'string'
            ? reqAny.rawJson
            : typeof reqAny.text === 'string'
              ? reqAny.text
              : typeof reqAny.json === 'string'
                ? reqAny.json
                : ''
        const parsedServers = parseMcpConfigText(rawJsonText, { workspaceRoot: binding?.root })
        const ownerScope = resolveTargetOwner(scopeId, request.targetScope)
        const targetMap = ownerScope === 'global' ? globalServers : getOrCreateBinding(scopeId).servers

        const toSave: Array<{ server: ParsedMcpServer; source: McpServerSource }> = []
        const importedExternals: Array<{ name: string; ext: External }> = []

        await withStateLock(async () => {
          for (const srv of parsedServers) {
            const prev = targetMap.get(srv.name)
            if (prev) await stopExternal(ownerScope, scopeId, srv.name, prev)
            const ext = createExternal(srv, 'import')
            targetMap.set(srv.name, ext)
            toSave.push({ server: srv, source: 'import' })
            importedExternals.push({ name: srv.name, ext })
          }
          persistedCount = await savePersistedServersBatch({
            targetScope: ownerScope,
            scopeId,
            servers: toSave
          })
        })

        if (request.autoStart) {
          const startable = importedExternals
            .filter(({ ext }) => ext.config.enabled && !ext.config.needsConfig)
            .map(({ name, ext }) => ({ name, ext, ownerScope }))
          await batchStartServers(scopeId, scopes.get(scopeId), win, startable)
        }

        return view(scopeId, scopes.get(scopeId), {
          canceled: false,
          importedCount: parsedServers.length
        })
      }

      case 'upsert':
      case 'update': {
        const binding = scopes.get(scopeId)
        const rawServerInput: McpServerConfigInput =
          request.server ??
          ({
            ...(((request as unknown as { config?: Record<string, unknown> }).config ?? {}) as Partial<McpServerConfigInput>),
            name: String((request as unknown as { name?: unknown }).name ?? '')
          } as McpServerConfigInput)
        const ownerScope = resolveTargetOwner(scopeId, rawServerInput.targetScope)
        const targetMap = ownerScope === 'global' ? globalServers : getOrCreateBinding(scopeId).servers
        const lookupName =
          request.op === 'update' && request.previousName
            ? request.previousName.trim()
            : rawServerInput.name.trim()
        const prev = targetMap.get(lookupName) ?? targetMap.get(rawServerInput.name.trim())
        const normalized = normalizeServerInput(rawServerInput, binding?.root)
        const keepSecrets =
          rawServerInput.keepExistingSecrets ??
          (request.op === 'update' &&
            rawServerInput.env === undefined &&
            rawServerInput.headers === undefined)
        const merged = mergeSecretsOnEdit(normalized, prev, keepSecrets)
        const source = prev?.source ?? 'manual'

        let ext!: External
        await withStateLock(async () => {
          if (prev) {
            await stopExternal(ownerScope, scopeId, lookupName, prev)
            if (lookupName !== merged.name) {
              targetMap.delete(lookupName)
            }
          }
          const existingSameNewName = targetMap.get(merged.name)
          if (existingSameNewName && existingSameNewName !== prev) {
            await stopExternal(ownerScope, scopeId, merged.name, existingSameNewName)
          }
          ext = createExternal(merged, source)
          targetMap.set(merged.name, ext)
          persistedCount = await savePersistedServer({
            targetScope: ownerScope,
            scopeId,
            server: merged,
            source,
            previousName: request.op === 'update' ? lookupName : undefined
          })
        })

        if (request.autoStart && merged.enabled && !merged.needsConfig) {
          await startExternal(ownerScope, scopeId, merged.name, ext, win, binding?.root)
        }

        return view(scopeId, scopes.get(scopeId))
      }

      case 'remove': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        await withStateLock(async () => {
          await stopExternal(found.ownerScope, scopeId, request.server, found.ext)
          found.map.delete(request.server)
          persistedCount = await removePersistedServer({
            targetScope: found.ownerScope,
            scopeId,
            serverName: request.server
          })
        })
        return view(scopeId, scopes.get(scopeId))
      }

      case 'start': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        const binding = scopes.get(scopeId)
        await startExternal(found.ownerScope, scopeId, request.server, found.ext, win, binding?.root)
        return view(scopeId, binding)
      }

      case 'stop': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        await stopExternal(found.ownerScope, scopeId, request.server, found.ext)
        return view(scopeId, scopes.get(scopeId))
      }

      case 'restart': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        const binding = scopes.get(scopeId)
        await stopExternal(found.ownerScope, scopeId, request.server, found.ext)
        found.ext.lastError = undefined
        await startExternal(found.ownerScope, scopeId, request.server, found.ext, win, binding?.root)
        return view(scopeId, binding)
      }

      case 'detectConfigs': {
        const binding = scopes.get(scopeId)
        const existingNames = new Set(effectiveEntries(scopeId, binding).map((e) => e.name))
        const scanned = await scanConfigCandidates(
          binding?.root,
          existingNames,
          Boolean(request.includeUserConfigs),
          collectSkipLoopbackUrls(binding)
        )
        return view(scopeId, binding, { detectedConfigs: scanned.detected })
      }

      case 'optimizeReady': {
        let binding = scopes.get(scopeId)
        const now = Date.now()

        if ((!binding?.root || request.directory) && (request.directory || request.bindIfMissing !== false)) {
          const bindRes = await bindDirectory(scopeId, win, request.directory, now)
          if (bindRes.canceled && !binding?.root) {
            return view(scopeId, scopes.get(scopeId), { canceled: true })
          }
          binding = bindRes.binding
        } else if (binding?.root) {
          const realRoot = await realpath(binding.root)
          const info = await stat(realRoot)
          if (!info.isDirectory()) throw new Error(`工作区目录不可用：${binding.root}`)
          await withStateLock(async () => {
            binding!.root = realRoot
            binding!.trusted = true
            await saveScopeDirectory({ scopeId, directory: realRoot, optimizedAtMs: now })
          })
        }

        const existingNames = new Set(effectiveEntries(scopeId, binding).map((e) => e.name))
        const scanned = await scanConfigCandidates(
          binding?.root,
          existingNames,
          Boolean(request.includeUserConfigs),
          collectSkipLoopbackUrls(binding)
        )

        const selectedSet = request.selectedPaths?.length ? new Set(request.selectedPaths) : null
        const importedServers: string[] = []
        const skippedExisting: string[] = []
        const skippedShadowed: string[] = []
        const malformedFiles: Array<{ path: string; error: string }> = []
        const toSave: Array<{ server: ParsedMcpServer; source: McpServerSource }> = []

        const ownerScope: McpConfigScope = scopeId === GLOBAL_SCOPE ? 'global' : 'scope'
        const targetMap =
          ownerScope === 'global' ? globalServers : getOrCreateBinding(scopeId).servers

        const claimedInScan = new Set<string>()
        for (const cfg of scanned.detected) {
          if (cfg.parseError) {
            malformedFiles.push({ path: cfg.label, error: cfg.parseError })
            continue
          }
          if (selectedSet && !selectedSet.has(cfg.path)) continue
          const parsedList = scanned.parsedByPath.get(cfg.path) ?? []
          for (const srv of parsedList) {
            if (existingNames.has(srv.name)) {
              skippedExisting.push(srv.name)
              continue
            }
            if (claimedInScan.has(srv.name)) {
              skippedShadowed.push(srv.name)
              continue
            }
            claimedInScan.add(srv.name)
            const ext = createExternal(srv, 'detected')
            targetMap.set(srv.name, ext)
            toSave.push({ server: srv, source: 'detected' })
            importedServers.push(srv.name)
          }
        }

        if (toSave.length > 0) {
          await withStateLock(async () => {
            persistedCount = await savePersistedServersBatch({
              targetScope: ownerScope,
              scopeId,
              servers: toSave
            })
          })
        }

        let startedServers: string[] = []
        let failedServers: Array<{ name: string; error: string }> = []
        if (request.autoStart !== false) {
          const startCandidates = effectiveEntries(scopeId, binding)
            .filter(
              (entry) =>
                entry.ext.config.enabled &&
                !entry.ext.config.needsConfig &&
                !entry.ext.client &&
                !inFlightConnects.has(flightKey(entry.ownerScope, scopeId, entry.name))
            )
            .map((entry) => ({
              name: entry.name,
              ext: entry.ext,
              ownerScope: entry.ownerScope
            }))
          const startRes = await batchStartServers(scopeId, binding, win, startCandidates)
          startedServers = startRes.startedServers
          failedServers = startRes.failedServers
        }

        const hermes = await inspectHermesReadiness(binding)
        const currentView = view(scopeId, binding)
        const trusted = binding?.root ? binding.trusted : true
        const ready = Boolean(trusted) && failedServers.length === 0
        const summary = [
          binding?.root ? `工作区已信任` : `MCP 全局就绪`,
          importedServers.length ? `新导入 ${importedServers.length} 个服务` : undefined,
          startedServers.length ? `已启动 ${startedServers.length} 个服务` : undefined,
          failedServers.length ? `${failedServers.length} 个启动失败` : undefined,
          `可用工具 ${currentView.tools.length} 个`
        ]
          .filter(Boolean)
          .join(' · ')

        const report: WorkspaceOptimizeReport = {
          completedAtMs: now,
          ...(binding?.root ? { directory: binding.root } : {}),
          trusted,
          scannedFiles: scanned.detected.length,
          detectedFiles: scanned.detected.map((d) => d.label),
          importedServers,
          skippedExisting,
          ...(skippedShadowed.length ? { skippedShadowed } : {}),
          ...(malformedFiles.length ? { malformedFiles } : {}),
          startedServers,
          failedServers,
          totalTools: currentView.tools.length,
          ready,
          hermes,
          summary
        }

        if (binding) binding.lastReport = report
        return view(scopeId, binding, {
          detectedConfigs: scanned.detected,
          lastReport: report,
          importedCount: importedServers.length
        })
      }
    }
  })
}

export function stopWorkspaces() {
  for (const [key, ac] of inFlightConnects) {
    ac.abort(new Error('工作区已关闭'))
    inFlightConnects.delete(key)
  }
  for (const [scopeId, binding] of scopes) {
    void disposeBinding(scopeId, binding)
  }
  for (const [name, ext] of globalServers) {
    void stopExternal('global', GLOBAL_SCOPE, name, ext)
  }
  scopes.clear()
  globalServers.clear()
  hydrated = false
  persistedCount = 0
}
