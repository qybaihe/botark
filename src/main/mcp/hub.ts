import { createServer, type Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
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
  MAX_MCP_CONFIG_BYTES,
  parseHermesYamlMcpServers,
  parseMcpConfigObject,
  parseMcpConfigText,
  readMcpConfigFile,
  type ParsedMcpServer
} from './configParser'
import {
  isPersistedDirectoryTrusted,
  loadMcpRegistry,
  removePersistedScope,
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
const GLOBAL_LAUNCH_DIRECTORY = homedir()
const HTTP_SESSION_CLOSE_TIMEOUT_MS = 1_500

type ClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

interface WorkspaceEndpoint {
  server: HttpServer
  url: string
  token: string
  configPath?: string
}

interface External {
  config: ParsedMcpServer
  source: McpServerSource
  envKeys: string[]
  headerKeys: string[]
  client?: Client
  transport?: ClientTransport
  launchDirectory?: string
  replacement?: Promise<void>
  resolvedTransport?: McpTransportType
  tools: WorkspaceTool[]
  lastError?: string
  generation: number
  closing?: Promise<void>
}

interface Binding {
  root?: string
  trusted: boolean
  revision: number
  servers: Map<string, External>
  endpoint?: WorkspaceEndpoint
  lastReport?: WorkspaceOptimizeReport
}

const globalServers = new Map<string, External>()
const scopes = new Map<string, Binding>()
const inFlightConnects = new Map<External, AbortController>()
const withStateLock = createMutex()
let hydrated = false
let persistedCount = 0
let registryGeneration = 0
const disposedScopes = new Set<string>()

function getOrCreateBinding(scopeId: string): Binding {
  let b = scopes.get(scopeId)
  if (!b) {
    b = { trusted: false, revision: 0, servers: new Map() }
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

function trackReplacement(ext: External, closing: Promise<void>): void {
  ext.replacement = closing
  void closing.then(() => {
    if (ext.replacement === closing) ext.replacement = undefined
  })
}

async function ensureHydrated(): Promise<void> {
  if (hydrated) return
  await withStateLock(async () => {
    if (hydrated) return
    const generation = registryGeneration
    const reg = await loadMcpRegistry()
    if (generation !== registryGeneration) throw new Error('工作区已关闭')
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
    ...((ext.launchDirectory ?? ext.config.cwd) ? { cwd: ext.launchDirectory ?? ext.config.cwd } : {}),
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
  const externalTools = Array.from(advertisedTools(entries).values(), ({ tool }) => tool)
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

function advertisedTools(entries: EffectiveEntry[]) {
  const aliases = new Map<string, { tool: WorkspaceTool; entry: EffectiveEntry; remoteName: string }>()
  for (const entry of entries) {
    for (const tool of entry.ext.tools) {
      const base = `${entry.prefix}__${tool.name}`
      let name = base
      for (let suffix = 2; aliases.has(name); suffix++) name = `${base}_${suffix}`
      aliases.set(name, { tool: { ...tool, name }, entry, remoteName: tool.name })
    }
  }
  return aliases
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

const rootChangeListeners = new Set<(scopeId: string) => void>()

export function onWorkspaceRootChanged(listener: (scopeId: string) => void): () => void {
  rootChangeListeners.add(listener)
  return () => {
    rootChangeListeners.delete(listener)
  }
}

function notifyWorkspaceRootChanged(scopeId: string): void {
  for (const listener of rootChangeListeners) {
    try {
      listener(scopeId)
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * The workspace root bound to a scope, if any. The workspace portal uses it
 * to serve the same directory the `[TOOL]` protocol would reach.
 */
export function workspaceRootFor(scopeId: string): string | undefined {
  const binding = scopes.get((scopeId || '').trim() || GLOBAL_SCOPE)
  return binding?.root
}

/**
 * Same as {@link workspaceRootFor} but waits for the persisted scope state to
 * be loaded first, so a caller that runs right after startup still sees the
 * directory the user bound earlier.
 */
export async function resolveWorkspaceRootFor(scopeId: string): Promise<string | undefined> {
  await ensureHydrated()
  return workspaceRootFor(scopeId)
}

async function invoke(
  win: BrowserWindow,
  scopeId: string,
  tool: string,
  args: Record<string, unknown>,
  recipient: string
): Promise<string | CallToolResult> {
  await ensureHydrated()
  if (disposedScopes.has(scopeId)) throw new Error('工作区已关闭')
  const binding = scopes.get(scopeId)
  const bindingRevision = binding?.revision
  const registryRevision = registryGeneration
  const assertScope = () => {
    if (registryGeneration !== registryRevision || disposedScopes.has(scopeId) || scopes.get(scopeId) !== binding ||
      binding?.revision !== bindingRevision) throw new Error('目录授权已变更')
  }
  if (fileTools.some((fileTool) => fileTool.name === tool)) {
    if (!binding?.root) throw new Error('请选择工作区')
    const boundRoot = binding.root
    await approve(
      win,
      `${recipient} 请求使用 ${tool}`,
      `目录：${boundRoot}\n参数：${JSON.stringify(args, null, 2)}`
    )
    assertScope()
    return workspaceFile(boundRoot, tool, args, assertScope)
  }

  const target = advertisedTools(effectiveEntries(scopeId, binding)).get(tool)
  if (!target) throw new Error('工具不可用')
  const { entry, remoteName } = target
  const clientAtStart = entry.ext.client
  if (!clientAtStart) throw new Error('MCP 服务已停止')

  await approve(
    win,
    `${recipient} 请求使用 ${tool}`,
    `服务：${entry.name}\n${entry.ext.launchDirectory ? `目录：${entry.ext.launchDirectory}\n` : ''}参数：${JSON.stringify(args, null, 2)}`
  )
  assertScope()
  const latest = advertisedTools(effectiveEntries(scopeId, binding)).get(tool)
  if (latest?.entry.ext !== entry.ext || latest.remoteName !== remoteName || entry.ext.client !== clientAtStart) {
    throw new Error('MCP 服务已停止或配置已变更')
  }

  return await clientAtStart.callTool({ name: remoteName, arguments: args }) as CallToolResult
}

function toolResultText(result: string | CallToolResult): string {
  if (typeof result === 'string') return result
  const text = JSON.stringify(result.structuredContent !== undefined || result.isError !== undefined ? result : result.content)
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

async function safeCloseClient(client: Client | undefined, transport?: ClientTransport): Promise<void> {
  if (!client) return
  if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        transport.terminateSession(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, HTTP_SESSION_CLOSE_TIMEOUT_MS) })
      ])
    } catch {
      // Closing the transport below also aborts a stalled DELETE.
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await client.close()
  } catch {
    /* preserve primary error */
  }
}

function launchDirectory(ownerScope: McpConfigScope, ext: External, binding?: Binding): string | undefined {
  if (!ext.config.command) return undefined
  const root = ownerScope === 'scope' ? binding?.root ?? GLOBAL_LAUNCH_DIRECTORY : GLOBAL_LAUNCH_DIRECTORY
  return resolve(root, ext.config.cwd || '.')
}

function describeServerTarget(config: ParsedMcpServer, cwd?: string): string {
  if (config.command) {
    return `以当前用户身份运行本地程序：${config.command} ${JSON.stringify(config.args ?? [])}\n目录：${cwd}\n该程序可以访问当前用户可访问的文件。`
  }
  return `连接 ${new URL(config.url!).origin}`
}

async function connectWithTimeout(
  client: Client,
  transport: ClientTransport,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('MCP 连接已取消')
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('MCP 连接超时或已取消'))
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
  approval?: () => Promise<void>
): Promise<void> {
  const binding = scopes.get(scopeId)
  const scopeRevision = binding?.revision
  const isRegistered = () => ownerScope === 'global'
    ? globalServers.get(name) === ext
    : binding !== undefined && scopes.get(scopeId) === binding && binding.revision === scopeRevision &&
      binding.servers.get(name) === ext
  if (disposedScopes.has(scopeId) || !isRegistered()) throw new Error('MCP 服务已停止或配置已变更')
  if (ext.client) return
  if (ext.config.needsConfig) {
    const errMsg = `MCP 服务「${name}」存在未填写的环境变量或密钥，请先编辑配置`
    ext.lastError = errMsg
    throw new Error(errMsg)
  }

  if (inFlightConnects.has(ext)) {
    throw new Error(`MCP 服务「${name}」正在启动中，请稍候`)
  }

  const gen = ++ext.generation
  const ac = new AbortController()
  const cwd = launchDirectory(ownerScope, ext, binding)
  inFlightConnects.set(ext, ac)
  const assertStarting = () => {
    ac.signal.throwIfAborted()
    if (ext.generation !== gen || !isRegistered() || disposedScopes.has(scopeId)) {
      throw new Error('服务启动已被中止')
    }
  }

  try {
    if (ext.replacement) await ext.replacement
    if (ext.closing) await ext.closing
    assertStarting()
    await (approval ? approval() : approve(win, `启动 MCP 服务 ${name}`, describeServerTarget(ext.config, cwd)))
    assertStarting()

    const timeoutTimer = setTimeout(() => {
      ac.abort(new Error(`MCP 连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`))
    }, CONNECT_TIMEOUT_MS)

    const stderrRing = new StderrRingBuffer()
    let client = new Client({ name: 'BotArk', version: '1' })
    let transport: ClientTransport | undefined
    let usedTransport: McpTransportType = 'stdio'
    let transportClosed = false
    const watchClose = (target: Client) => {
      target.onclose = () => {
        transportClosed = true
        if (ext.client === target) {
          ext.client = undefined
          ext.transport = undefined
          ext.tools = []
          ext.resolvedTransport = undefined
          const tail = stderrRing.text()
          if (tail && !ext.lastError) ext.lastError = `[stderr] ${tail}`
        }
      }
    }
    watchClose(client)

    try {
      if (ext.config.command) {
        usedTransport = 'stdio'
        transport = new StdioClientTransport({
          command: ext.config.command,
          args: ext.config.args,
          cwd,
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
          transport = new SSEClientTransport(new URL(targetUrl), {
            requestInit,
            fetch: customFetch
          })
          await connectWithTimeout(client, transport, ac.signal)
        } else if (ext.config.transport === 'streamable-http') {
          usedTransport = 'streamable-http'
          transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
            requestInit,
            fetch: customFetch
          })
          await connectWithTimeout(client, transport, ac.signal)
        } else {
          usedTransport = 'streamable-http'
          transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
            requestInit,
            fetch: customFetch
          })
          try {
            await connectWithTimeout(client, transport, ac.signal)
          } catch (firstErr) {
            if (ac.signal.aborted || !shouldFallbackToSse(firstErr)) {
              throw firstErr
            }
            await safeCloseClient(client, transport)
            assertStarting()
            client = new Client({ name: 'BotArk', version: '1' })
            transportClosed = false
            watchClose(client)
            usedTransport = 'sse'
            transport = new SSEClientTransport(new URL(targetUrl), {
              requestInit,
              fetch: customFetch
            })
            await connectWithTimeout(client, transport, ac.signal)
          }
        }
      } else {
        throw new Error(`无效的 MCP 配置（${name}）：缺少 command 或 url`)
      }

      assertStarting()

      const tools: WorkspaceTool[] = []
      const caps = client.getServerCapabilities()
      if (caps?.tools) {
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const page = await client.listTools(
            { cursor },
            { signal: ac.signal, timeout: LIST_TOOLS_TIMEOUT_MS }
          )
          assertStarting()
          tools.push(...page.tools)
          cursor = page.nextCursor
          if (cursor && cursors.has(cursor)) throw new Error('MCP 工具列表重复返回相同游标')
          if (cursor) cursors.add(cursor)
        } while (cursor)
      }

      assertStarting()
      if (transportClosed) throw new Error('MCP 服务在启动时关闭')

      ext.client = client
      ext.transport = transport
      ext.launchDirectory = cwd
      ext.tools = tools
      ext.resolvedTransport = usedTransport
      ext.lastError = undefined

      client.onerror = (err) => {
        if (ext.client === client) {
          ext.lastError = formatMcpError(err, stderrRing.text())
        }
      }
    } catch (err) {
      await safeCloseClient(client, transport)
      const formatted = formatMcpError(err, stderrRing.text())
      if (ext.generation === gen && isRegistered()) ext.lastError = formatted
      throw new Error(formatted)
    } finally {
      clearTimeout(timeoutTimer)
    }
  } finally {
    if (inFlightConnects.get(ext) === ac) {
      inFlightConnects.delete(ext)
    }
  }
}

async function stopExternal(ext: External): Promise<void> {
  ext.generation++
  inFlightConnects.get(ext)?.abort(new Error('服务已停止'))
  inFlightConnects.delete(ext)
  const client = ext.client
  const transport = ext.transport
  ext.client = undefined
  ext.transport = undefined
  ext.tools = []
  ext.resolvedTransport = undefined
  if (!client) return ext.closing ?? ext.replacement
  const closing = safeCloseClient(client, transport)
  ext.closing = closing
  try {
    await closing
  } finally {
    if (ext.closing === closing) ext.closing = undefined
  }
}

function readHermesConfigForCleanup(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(fd)
    const { size } = info
    if (size > MAX_MCP_CONFIG_BYTES || !info.isFile()) throw new Error('Invalid Hermes config')
    const data = Buffer.allocUnsafe(size + 1)
    let offset = 0
    while (offset < data.length) {
      const bytes = readSync(fd, data, offset, data.length - offset, offset)
      if (!bytes) break
      offset += bytes
    }
    if (offset > size) throw new Error('Hermes config changed while reading')
    return data.toString('utf8', 0, offset)
  } finally {
    closeSync(fd)
  }
}

function writeHermesConfig(path: string, contents: string): void {
  const tmp = path + '.' + randomUUID()
  try {
    writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp)
  }
}

function closeEndpoint(endpoint: WorkspaceEndpoint): void {
  endpoint.server.close()
  endpoint.server.closeAllConnections()
  if (!endpoint.configPath) return
  try {
    const key = ['mcp_servers', 'botark_workspace']
    const doc = parseDocument(readHermesConfigForCleanup(endpoint.configPath))
    if (doc.errors.length || doc.getIn([...key, 'url']) !== endpoint.url ||
      doc.getIn([...key, 'headers', 'Authorization']) !== 'Bearer ' + endpoint.token) return
    doc.deleteIn(key)
    writeHermesConfig(endpoint.configPath, doc.toString())
  } catch {
    // The caller may have moved, removed, or replaced the YAML file.
  }
}

async function disposeBinding(binding: Binding): Promise<void> {
  binding.revision++
  if (binding.endpoint) closeEndpoint(binding.endpoint)
  binding.endpoint = undefined
  await Promise.all(Array.from(binding.servers.values(), stopExternal))
}

async function startEndpoint(scopeId: string, win: BrowserWindow): Promise<WorkspaceEndpoint> {
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
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: view(scopeId, scopes.get(scopeId)).tools }))
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      try {
        const result = await invoke(win, scopeId, call.params.name, call.params.arguments ?? {}, 'Hermes')
        return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result
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
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    http.close()
    throw error
  }
  const address = http.address()
  if (!address || typeof address === 'string') {
    http.close()
    throw new Error('MCP listener unavailable')
  }
  return { server: http, token, url: `http://127.0.0.1:${address.port}/mcp` }
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
  const root = binding.root
  const revision = binding.revision
  const assertBinding = () => {
    if (scopes.get(scopeId) !== binding || binding.revision !== revision) throw new Error('目录授权已变更')
  }
  if (!root) throw new Error('请先选择工作区目录')
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
  const original = await readMcpConfigFile(path)
  const config = parseDocument(original)
  if (config.errors.length) throw new Error('配置文件不是有效 YAML')
  await approve(
    win,
    '将本地工作区接入 Hermes',
    `${path}\nmcp_servers.botark_workspace 将指向 ${root}。重新加载 Hermes 配置后生效。`
  )
  await withStateLock(async () => {
    assertBinding()
    const previous = binding.endpoint
    const endpoint = previous?.configPath === path ? previous : await startEndpoint(scopeId, win)
    try {
      assertBinding()
      if (readHermesConfigForCleanup(path) !== original) throw new Error('Hermes 配置已变更，请重试')
      config.setIn(['mcp_servers', 'botark_workspace'], {
        url: endpoint.url,
        headers: { Authorization: 'Bearer ' + endpoint.token }
      })
      writeHermesConfig(path, config.toString())
      endpoint.configPath = path
      binding.endpoint = endpoint
      if (previous && previous !== endpoint) closeEndpoint(previous)
    } catch (error) {
      if (endpoint !== previous) closeEndpoint(endpoint)
      throw error
    }
  })
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
        const raw = await readMcpConfigFile(real)
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
          const raw = await readMcpConfigFile(real)
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
        const raw = await readMcpConfigFile(real)
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
          const raw = JSON.parse(await readMcpConfigFile(real)) as Record<string, unknown>
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
      const doc = parseDocument(await readMcpConfigFile(await realpath(configYamlPath)))
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
  const assertCurrent = captureScope(scopeId)
  let rawDir = requestedDir?.trim()
  if (!rawDir) {
    const pick = await dialog.showOpenDialog(win, {
      title: '授权工作区目录',
      properties: ['openDirectory']
    })
    if (pick.canceled || !pick.filePaths[0]) {
      assertCurrent()
      return { canceled: true, binding: getOrCreateBinding(scopeId) }
    }
    rawDir = pick.filePaths[0]
  }
  const realRoot = await realpath(rawDir)
  const info = await stat(realRoot)
  if (!info.isDirectory()) {
    throw new Error(`所选路径不是有效目录：${rawDir}`)
  }

  const { binding, restarting, stopped, revision, rootChanged } = await withStateLock(async () => {
    assertCurrent()
    const binding = getOrCreateBinding(scopeId)
    await saveScopeDirectory({ scopeId, directory: realRoot, optimizedAtMs })
    assertCurrent()
    const changing = binding.root !== realRoot
    const rootChanged = Boolean(binding.root && changing)
    const restarting = changing ? scopedRestarts(binding) : []
    const stopped = changing ? disposeBinding(binding) : Promise.resolve()
    binding.root = realRoot
    binding.trusted = true
    if (changing) binding.lastReport = undefined
    return { binding, restarting, stopped, revision: binding.revision, rootChanged }
  })
  if (rootChanged) notifyWorkspaceRootChanged(scopeId)
  await stopped
  if (scopes.get(scopeId) === binding && binding.revision === revision) {
    await batchStartServers(scopeId, binding, win, restarting)
  }

  return { canceled: false, binding }
}

function captureScope(scopeId: string): () => void {
  const registryRevision = registryGeneration
  const binding = scopes.get(scopeId)
  const revision = binding?.revision
  return () => {
    if (registryRevision !== registryGeneration || disposedScopes.has(scopeId) ||
      (binding && (scopes.get(scopeId) !== binding || binding.revision !== revision))) {
      throw new Error('目录授权已变更')
    }
  }
}

function scopedRestarts(binding: Binding) {
  return Array.from(binding.servers, ([name, ext]) => ({ name, ext, ownerScope: 'scope' as const }))
    .filter(({ ext }) => ext.client && ext.config.enabled)
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
    .map((c) => `• ${c.name}：${describeServerTarget(c.ext.config, launchDirectory(c.ownerScope, c.ext, binding))}`)
    .join('\n')
  let approval: Promise<void> | undefined
  // Queue the shared dialog after every startup has registered its own controller.
  const confirm = () => approval ??= Promise.resolve().then(() =>
    approve(win, `启动 ${candidates.length} 个 MCP 服务`, detail))

  const results = await Promise.allSettled(
    candidates.map(async (c) => {
      await startExternal(c.ownerScope, scopeId, c.name, c.ext, win, confirm)
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

async function importServers(
  scopeId: string,
  ownerScope: McpConfigScope,
  parsed: ParsedMcpServer[],
  assertCurrent: () => void
) {
  const closing: Promise<void>[] = []
  const imported = await withStateLock(async () => {
    assertCurrent()
    persistedCount = await savePersistedServersBatch({
      targetScope: ownerScope, scopeId,
      servers: parsed.map((server) => ({ server, source: 'import' }))
    })
    assertCurrent()
    const map = ownerScope === 'global' ? globalServers : getOrCreateBinding(scopeId).servers
    return parsed.map((server) => {
      const previous = map.get(server.name)
      const ext = createExternal(server, 'import')
      if (previous) {
        const stopped = stopExternal(previous)
        trackReplacement(ext, stopped)
        closing.push(stopped)
      }
      map.set(server.name, ext)
      return { name: server.name, ext, ownerScope }
    })
  })
  await Promise.all(closing)
  return imported
}

export function registerWorkspaceIpc(owner: () => BrowserWindow | null) {
  ipcMain.handle(WORKSPACE_CHANNEL, async (event, scope: string, request: WorkspaceRequest | { op: 'dispose' }) => {
    const win = owner()
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Desktop window required')
    }
    const scopeId = (scope || '').trim() || GLOBAL_SCOPE
    await ensureHydrated()

    if (request.op === 'dispose') {
      if (scopeId === GLOBAL_SCOPE) throw new Error('无法删除全局 MCP 工作区')
      const cleanup = await withStateLock(async () => {
        persistedCount = await removePersistedScope(scopeId)
        disposedScopes.add(scopeId)
        const binding = scopes.get(scopeId)
        scopes.delete(scopeId)
        return { stopped: binding ? disposeBinding(binding) : undefined }
      })
      await cleanup.stopped
      return view(scopeId)
    }
    if (disposedScopes.has(scopeId)) {
      if (request.op === 'status') return view(scopeId)
      throw new Error('工作区已关闭')
    }
    const assertCurrent = captureScope(scopeId)
    if (request.op === 'run') {
      return toolResultText(await invoke(win, scopeId, request.tool, request.args, request.recipient))
    }

    switch (request.op) {
      case 'status': {
        const binding = scopes.get(scopeId)
        if (binding?.root && !binding.trusted) {
          const trusted = await isPersistedDirectoryTrusted(binding.root)
          assertCurrent()
          binding.trusted = trusted
        }
        return view(scopeId, binding)
      }

      case 'bind': {
        const res = await bindDirectory(scopeId, win, request.directory)
        if (res.canceled) {
          return view(scopeId, scopes.get(scopeId), { canceled: true })
        }
        const assertBound = captureScope(scopeId)
        const existingNames = new Set(effectiveEntries(scopeId, res.binding).map((e) => e.name))
        const scanned = await scanConfigCandidates(
          res.binding.root,
          existingNames,
          false,
          collectSkipLoopbackUrls(res.binding)
        )
        assertBound()
        return view(scopeId, res.binding, {
          canceled: false,
          detectedConfigs: scanned.detected
        })
      }

      case 'unbind': {
        const binding = scopes.get(scopeId)
        if (binding?.root) {
          const { restarting, stopped, revision } = await withStateLock(async () => {
            assertCurrent()
            await saveScopeDirectory({ scopeId, directory: undefined })
            assertCurrent()
            const restarting = scopedRestarts(binding)
            const stopped = disposeBinding(binding)
            binding.root = undefined
            binding.trusted = false
            binding.lastReport = undefined
            return { restarting, stopped, revision: binding.revision }
          })
          notifyWorkspaceRootChanged(scopeId)
          await stopped
          if (scopes.get(scopeId) === binding && binding.revision === revision) {
            await batchStartServers(scopeId, binding, win, restarting)
          }
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
        const rawText = await readMcpConfigFile(await realpath(pick.filePaths[0]))
        assertCurrent()
        const ownerScope = resolveTargetOwner(scopeId, request.targetScope)
        const parsedServers = parseMcpConfigText(rawText, {
          workspaceRoot: ownerScope === 'scope' ? scopes.get(scopeId)?.root : undefined
        })
        const imported = await importServers(scopeId, ownerScope, parsedServers, assertCurrent)

        if (request.autoStart) {
          assertCurrent()
          const startable = imported.filter(({ ext }) => ext.config.enabled && !ext.config.needsConfig)
          await batchStartServers(scopeId, scopes.get(scopeId), win, startable)
        }

        return view(scopeId, scopes.get(scopeId), {
          canceled: false,
          importedCount: parsedServers.length
        })
      }

      case 'importJson': {
        const reqAny = request as unknown as { rawJson?: unknown; text?: unknown; json?: unknown }
        const rawJsonText =
          typeof reqAny.rawJson === 'string'
            ? reqAny.rawJson
            : typeof reqAny.text === 'string'
              ? reqAny.text
              : typeof reqAny.json === 'string'
                ? reqAny.json
                : ''
        const ownerScope = resolveTargetOwner(scopeId, request.targetScope)
        const parsedServers = parseMcpConfigText(rawJsonText, {
          workspaceRoot: ownerScope === 'scope' ? scopes.get(scopeId)?.root : undefined
        })
        const imported = await importServers(scopeId, ownerScope, parsedServers, assertCurrent)

        if (request.autoStart) {
          assertCurrent()
          const startable = imported.filter(({ ext }) => ext.config.enabled && !ext.config.needsConfig)
          await batchStartServers(scopeId, scopes.get(scopeId), win, startable)
        }

        return view(scopeId, scopes.get(scopeId), {
          canceled: false,
          importedCount: parsedServers.length
        })
      }

      case 'upsert':
      case 'update': {
        const rawServerInput: McpServerConfigInput =
          request.server ??
          ({
            ...(((request as unknown as { config?: Record<string, unknown> }).config ?? {}) as Partial<McpServerConfigInput>),
            name: String((request as unknown as { name?: unknown }).name ?? '')
          } as McpServerConfigInput)
        const ownerScope = resolveTargetOwner(scopeId, rawServerInput.targetScope)
        const lookupName =
          request.op === 'update' && request.previousName
            ? request.previousName.trim()
            : rawServerInput.name.trim()
        const keepSecrets =
          rawServerInput.keepExistingSecrets ??
          (request.op === 'update' &&
            rawServerInput.env === undefined &&
            rawServerInput.headers === undefined)
        const { merged, ext, closing } = await withStateLock(async () => {
          assertCurrent()
          const binding = scopes.get(scopeId)
          const existing = ownerScope === 'global' ? globalServers : binding?.servers
          const prev = existing?.get(lookupName) ?? existing?.get(rawServerInput.name.trim())
          const normalized = normalizeServerInput(rawServerInput, ownerScope === 'scope' ? binding?.root : undefined)
          const merged = mergeSecretsOnEdit(normalized, prev, keepSecrets)
          const source = prev?.source ?? 'manual'
          persistedCount = await savePersistedServer({
            targetScope: ownerScope,
            scopeId,
            server: merged,
            source,
            previousName: request.op === 'update' ? lookupName : undefined
          })
          assertCurrent()
          const targetMap = ownerScope === 'global' ? globalServers : getOrCreateBinding(scopeId).servers
          const replacing = new Set([targetMap.get(lookupName), targetMap.get(merged.name)])
          const closing = Array.from(replacing).flatMap((current) => current ? [stopExternal(current)] : [])
          if (lookupName !== merged.name) targetMap.delete(lookupName)
          const ext = createExternal(merged, source)
          if (closing.length) trackReplacement(ext, Promise.all(closing).then(() => undefined))
          targetMap.set(merged.name, ext)
          return { merged, ext, closing }
        })
        await Promise.all(closing)

        if (request.autoStart && merged.enabled && !merged.needsConfig) {
          assertCurrent()
          await startExternal(ownerScope, scopeId, merged.name, ext, win)
        }

        return view(scopeId, scopes.get(scopeId))
      }

      case 'remove': {
        const { closing } = await withStateLock(async () => {
          assertCurrent()
          const found = findServerEntry(scopeId, request.server, request.targetScope)
          if (!found) throw new Error(`未知服务：${request.server}`)
          persistedCount = await removePersistedServer({
            targetScope: found.ownerScope,
            scopeId,
            serverName: request.server
          })
          assertCurrent()
          found.map.delete(request.server)
          return { closing: stopExternal(found.ext) }
        })
        await closing
        return view(scopeId, scopes.get(scopeId))
      }

      case 'start': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        await startExternal(found.ownerScope, scopeId, request.server, found.ext, win)
        return view(scopeId, scopes.get(scopeId))
      }

      case 'stop': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        await stopExternal(found.ext)
        return view(scopeId, scopes.get(scopeId))
      }

      case 'restart': {
        const found = findServerEntry(scopeId, request.server, request.targetScope)
        if (!found) throw new Error(`未知服务：${request.server}`)
        await stopExternal(found.ext)
        assertCurrent()
        await startExternal(found.ownerScope, scopeId, request.server, found.ext, win)
        return view(scopeId, scopes.get(scopeId))
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
        assertCurrent()
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
          assertCurrent()
          binding = (await bindDirectory(scopeId, win, realRoot, now)).binding
        }

        const assertScannedScope = captureScope(scopeId)
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
        await withStateLock(async () => {
          assertScannedScope()
          const latestNames = new Set(effectiveEntries(scopeId, scopes.get(scopeId)).map((entry) => entry.name))
          const claimedInScan = new Set<string>()
          for (const cfg of scanned.detected) {
            if (cfg.parseError) {
              malformedFiles.push({ path: cfg.label, error: cfg.parseError })
              continue
            }
            if (selectedSet && !selectedSet.has(cfg.path)) continue
            for (const srv of scanned.parsedByPath.get(cfg.path) ?? []) {
              if (latestNames.has(srv.name)) {
                skippedExisting.push(srv.name)
                continue
              }
              if (claimedInScan.has(srv.name)) {
                skippedShadowed.push(srv.name)
                continue
              }
              claimedInScan.add(srv.name)
              toSave.push({ server: srv, source: 'detected' })
            }
          }
          if (!toSave.length) return
          persistedCount = await savePersistedServersBatch({
            targetScope: ownerScope,
            scopeId,
            servers: toSave
          })
          assertScannedScope()
          binding = scopes.get(scopeId)
          if (ownerScope === 'scope') binding = getOrCreateBinding(scopeId)
          const targetMap = ownerScope === 'global' ? globalServers : binding!.servers
          for (const { server, source } of toSave) {
            targetMap.set(server.name, createExternal(server, source))
            importedServers.push(server.name)
          }
        })

        let startedServers: string[] = []
        let failedServers: Array<{ name: string; error: string }> = []
        if (request.autoStart !== false) {
          assertScannedScope()
          binding = scopes.get(scopeId)
          const startCandidates = effectiveEntries(scopeId, binding)
            .filter(
              (entry) =>
                entry.ext.config.enabled &&
                !entry.ext.config.needsConfig &&
                !entry.ext.client &&
                !inFlightConnects.has(entry.ext)
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
        assertScannedScope()
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

export async function stopWorkspaces(): Promise<void> {
  registryGeneration++
  const cleanup = [
    ...Array.from(scopes.values(), disposeBinding),
    ...Array.from(globalServers.values(), stopExternal)
  ]
  scopes.clear()
  globalServers.clear()
  disposedScopes.clear()
  hydrated = false
  persistedCount = 0
  await Promise.all(cleanup)
}
