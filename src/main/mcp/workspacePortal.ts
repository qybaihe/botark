import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { Readable } from 'node:stream'
import { fileTools, workspaceFile } from './workspaceFiles'
import { onWorkspaceRootChanged, resolveWorkspaceRootFor } from './hub'
import type {
  PortalCatalog,
  PortalRequest,
  PortalState,
  PortalToolSummary
} from '@shared/workspacePortal'
import { WORKSPACE_PORTAL_CHANNEL } from '@shared/workspacePortal'

/**
 * Workspace portal.
 *
 * Members such as Hark refuse to emit BotArk's external `[TOOL]` protocol —
 * their policy forbids acting as another application's backend model — and
 * they reject a multi-agent room frame as well. They do however have their
 * own native web tools (web_fetch, browser).
 *
 * Safety model:
 *   - IPC channel accepts calls only from the main Electron BrowserWindow frame;
 *   - publishing a public tunnel requires explicit user confirmation first;
 *   - the HTTP service binds to 127.0.0.1 only and checks a random per-session
 *     token with constant-time comparison on every request;
 *   - reads/writes reuse `workspaceFile` (canonical path boundary checks) AND
 *     block sensitive credential/key files and `.git` metadata;
 *   - every write goes through an explicit Electron human-approval dialog;
 *   - portals auto-close on workspace root change/unbind, app quit, or 15 min idle.
 */

const PORTAL_HOST = '127.0.0.1'
const MAX_BODY = 128 * 1024
const TUNNEL_START_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const TRUNCATED_SENTINEL = '… (listing truncated)'

interface PortalSession {
  scope: string
  root: string
  token: string
  server: Server
  tunnel: ChildProcessByStdio<null, Readable, Readable> | null
  publicUrl?: string
  localUrl: string
  tools: PortalToolSummary[]
  expiresAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  error?: string
}

const sessions = new Map<string, PortalSession>()
const pendingOpens = new Map<string, Promise<PortalState>>()

let currentOwner: (() => BrowserWindow | null) | null = null
let tunnelEnabled = true
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
let rootChangeUnsubscribe: (() => void) | null = null

const SAFE_ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/i
const SENSITIVE_DIR_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube'])
const SENSITIVE_EXACT_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.dockercfg',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml'
])
const SENSITIVE_EXT_RE = /\.(pem|key|p12|pfx|jks|kdbx)$/i
const SENSITIVE_NAME_RE = /^(id_(rsa|ed25519|ecdsa|dsa)\..+|service-account.*\.json|.*credentials.*\.json)$/i

export function normalizePortalRelPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized || '.'
}

export function isSensitivePortalPath(rawPath: string): boolean {
  const normalized = normalizePortalRelPath(rawPath)
  if (normalized === '.') return false
  const segments = normalized.split('/').filter(Boolean)
  for (const seg of segments) {
    const lower = seg.toLowerCase()
    if (SENSITIVE_DIR_SEGMENTS.has(lower)) return true
  }
  const base = segments[segments.length - 1] ?? ''
  const lowerBase = base.toLowerCase()
  if (lowerBase.startsWith('.env.') && !SAFE_ENV_TEMPLATE_RE.test(lowerBase)) return true
  if (SENSITIVE_EXACT_NAMES.has(lowerBase)) return true
  if (SENSITIVE_EXT_RE.test(lowerBase)) return true
  if (SENSITIVE_NAME_RE.test(lowerBase)) return true
  return false
}

function normalizeScope(scope: string | undefined): string {
  return (scope || '').trim() || '__global__'
}

function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

function tokensMatch(supplied: string | string[] | undefined, expected: string): boolean {
  if (typeof supplied !== 'string' || !supplied) return false
  const a = Buffer.from(supplied, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function tunnelBinary(): string | null {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extraUnixDirs = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  const roots = [
    process.resourcesPath ? join(process.resourcesPath, 'bin') : null,
    process.resourcesPath ?? null,
    join(app.getPath('userData'), 'bin'),
    join(process.cwd(), 'resources', 'bin'),
    ...extraUnixDirs,
    ...pathDirs
  ].filter((root): root is string => Boolean(root))

  for (const root of roots) {
    const candidate = join(root, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function html(res: ServerResponse, status: number, body: string): void {
  const payload = Buffer.from(body, 'utf-8')
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(payload)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>${body}</body></html>`
}

/**
 * Absolute URL for a portal path. Listed as visible text because web-fetch
 * tools return plain text with HTML link attributes stripped.
 */
function portalUrl(session: PortalSession, path: string, query: Record<string, string>): string {
  const base = tunnelEnabled ? (session.publicUrl ?? '') : session.localUrl
  const params = new URLSearchParams({ ...query, token: session.token })
  return `${base}${path}?${params.toString()}`
}

function formatEntryRows(session: PortalSession, rawEntries: string[]): string {
  const lines: string[] = []
  for (const raw of rawEntries) {
    if (!raw) continue
    if (raw === TRUNCATED_SENTINEL) {
      lines.push(`<li>${escapeHtml(raw)}</li>`)
      continue
    }
    const normalized = raw.replace(/\\/g, '/')
    const isDir = normalized.endsWith('/')
    const relPath = isDir ? normalized.slice(0, -1) : normalized
    if (isSensitivePortalPath(relPath)) continue
    const target = isDir ? '/browse' : '/raw'
    const href = portalUrl(session, target, { path: relPath })
    const edit = isDir ? '' : ` | edit: ${portalUrl(session, '/write', { path: relPath })}`
    lines.push(`<li>${escapeHtml(normalized)} - ${href}${edit}</li>`)
  }
  return lines.join('\n')
}

function indexPage(session: PortalSession, entries: string[]): string {
  const rows = formatEntryRows(session, entries)
  const searchSample = portalUrl(session, '/search', { q: 'README' })
  return page(
    'Workspace',
    `<h1>Workspace</h1>
<p>本机工作区的根目录。下面每一行是一个条目，后面是可直接打开的完整地址（敏感凭据和 .git 目录已自动隐藏）。</p>
<ul>
${rows}
</ul>
<p>读文件：打开上面的 /raw 地址，返回的是纯文本原文。</p>
<p>按文件名搜索：打开 /search?q=关键词&amp;token=…（例如：${escapeHtml(searchSample)}）。</p>
<p>改文件：打开上面的 /write 地址，页面里有一个输入框，填好内容后点 Save 提交（提交前会有人工确认）。</p>`
  )
}

function browsePage(session: PortalSession, relDir: string, entries: string[]): string {
  const cleanDir = normalizePortalRelPath(relDir)
  const rows = formatEntryRows(session, entries)
  const parentPath = cleanDir.includes('/') ? cleanDir.slice(0, cleanDir.lastIndexOf('/')) : '.'
  const parent =
    cleanDir === '.' ? '' : `<p>parent: ${portalUrl(session, '/browse', { path: parentPath })}</p>`
  return page(`Workspace ${cleanDir}`, `<h1>${escapeHtml(cleanDir)}</h1>${parent}<ul>\n${rows}\n</ul>`)
}

function searchPage(session: PortalSession, relDir: string, query: string, entries: string[]): string {
  const cleanDir = normalizePortalRelPath(relDir)
  const rows = formatEntryRows(session, entries)
  const listHtml = rows ? `<ul>\n${rows}\n</ul>` : '<p>没有找到匹配的文件。</p>'
  return page(
    `Search ${query}`,
    `<h1>搜索：${escapeHtml(query)}（范围：${escapeHtml(cleanDir)}）</h1>
${listHtml}
<p>根目录：${portalUrl(session, '/browse', { path: '.' })}</p>`
  )
}

function writePage(session: PortalSession, path: string, content: string): string {
  const cleanPath = normalizePortalRelPath(path)
  return page(
    `Edit ${cleanPath}`,
    `<h1>编辑文件</h1>
<form method="POST" action="/write">
<p>文件路径（相对工作区根目录，可改成任意新文件名来新建文件）：</p>
<input type="text" name="path" size="70" value="${escapeHtml(cleanPath === '.' ? '' : cleanPath)}"><br>
<input type="hidden" name="token" value="${escapeHtml(session.token)}">
<p>内容：</p>
<textarea name="text" rows="24" cols="90">${escapeHtml(content)}</textarea><br>
<button type="submit">Save</button>
</form>
<p>raw: ${portalUrl(session, '/raw', { path: cleanPath })}</p>`
  )
}

function touchSession(session: PortalSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
  if (idleTimeoutMs > 0) {
    session.expiresAt = Date.now() + idleTimeoutMs
    session.idleTimer = setTimeout(() => {
      void closePortal(session.scope)
    }, idleTimeoutMs)
    session.idleTimer.unref?.()
  }
}

function stateOf(session: PortalSession): PortalState {
  return {
    scope: session.scope,
    root: session.root,
    publicUrl: session.publicUrl,
    entryUrl: entryUrlFor(session),
    localUrl: session.localUrl,
    running: true,
    expiresAt: session.expiresAt,
    tools: session.tools,
    ...(session.error ? { error: session.error } : {})
  }
}

async function handlePortalRequest(
  session: PortalSession,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = requestUrl.pathname
  const rel = requestUrl.searchParams.get('path') ?? '.'

  let form: URLSearchParams | null = null
  if (pathname === '/write' && req.method === 'POST') {
    form = new URLSearchParams(await readBody(req))
  }
  const supplied =
    requestUrl.searchParams.get('token') ??
    req.headers['x-botark-token'] ??
    form?.get('token') ??
    undefined
  if (!tokensMatch(supplied, session.token)) {
    html(res, 401, page('Unauthorized', '<h1>需要有效 token</h1>'))
    return
  }

  touchSession(session)

  if (pathname === '/' || pathname === '/index.html') {
    const listing = await workspaceFile(session.root, 'list', { path: '.' })
    const entries = listing.split('\n').filter(Boolean)
    html(res, 200, indexPage(session, entries))
    return
  }
  if (pathname === '/api/catalog' && req.method === 'GET') {
    const catalog: PortalCatalog = {
      service: 'botark-workspace-portal',
      tools: session.tools,
      endpoints: [
        { method: 'GET', path: '/browse?path=…', purpose: '目录列表' },
        { method: 'GET', path: '/raw?path=…', purpose: '文件原文' },
        { method: 'GET', path: '/search?q=…&path=…', purpose: '文件名搜索' },
        { method: 'GET', path: '/write?path=…', purpose: '编辑表单' },
        { method: 'POST', path: '/write', purpose: '保存（需人工批准）' }
      ]
    }
    json(res, 200, catalog)
    return
  }
  if (pathname === '/browse' && req.method === 'GET') {
    if (isSensitivePortalPath(rel)) {
      html(res, 403, page('Forbidden', '<h1>出于安全原因，工作区门户禁止访问敏感凭据或版本库目录。</h1>'))
      return
    }
    const listing = await workspaceFile(session.root, 'list', { path: rel })
    const entries = listing.split('\n').filter(Boolean)
    html(res, 200, browsePage(session, rel, entries))
    return
  }
  if (pathname === '/search' && req.method === 'GET') {
    const query = (requestUrl.searchParams.get('q') ?? '').trim()
    if (!query) {
      html(res, 400, page('Bad Request', '<h1>请提供搜索关键词参数 q</h1>'))
      return
    }
    if (isSensitivePortalPath(rel)) {
      html(res, 403, page('Forbidden', '<h1>出于安全原因，工作区门户禁止访问敏感凭据或版本库目录。</h1>'))
      return
    }
    const listing = await workspaceFile(session.root, 'search', { path: rel, query })
    const entries = listing.split('\n').filter(Boolean)
    html(res, 200, searchPage(session, rel, query, entries))
    return
  }
  if (pathname === '/raw' && req.method === 'GET') {
    if (isSensitivePortalPath(rel)) {
      html(res, 403, page('Forbidden', '<h1>出于安全原因，工作区门户禁止读取敏感凭据或私钥文件。</h1>'))
      return
    }
    const content = await workspaceFile(session.root, 'read', { path: rel })
    html(res, 200, page(rel, `<h1>${escapeHtml(rel)}</h1><pre>${escapeHtml(content)}</pre>`))
    return
  }
  if (pathname === '/write' && req.method === 'GET') {
    if (isSensitivePortalPath(rel)) {
      html(res, 403, page('Forbidden', '<h1>出于安全原因，工作区门户禁止编辑敏感凭据或私钥文件。</h1>'))
      return
    }
    let content = ''
    try {
      content = await workspaceFile(session.root, 'read', { path: rel })
    } catch {
      content = ''
    }
    html(res, 200, writePage(session, rel, content))
    return
  }
  if (pathname === '/write' && req.method === 'POST') {
    const target = (form?.get('path') ?? '').trim()
    const text = form?.get('text') ?? ''
    if (!target || isSensitivePortalPath(target)) {
      html(
        res,
        403,
        page('Forbidden', '<h1>保存失败</h1><pre>文件路径无效或属于受保护的敏感文件。</pre>')
      )
      return
    }
    const result = await runPortalTool(session, 'write', { path: target, text })
    const ok = !result.startsWith('error:')
    const cleanTarget = normalizePortalRelPath(target)
    html(
      res,
      ok ? 200 : 400,
      page(
        ok ? 'Saved' : 'Failed',
        ok
          ? `<h1>已保存 ${escapeHtml(cleanTarget)}</h1><p>原文：${portalUrl(session, '/raw', {
              path: cleanTarget
            })}</p><p>目录：${portalUrl(session, '/browse', { path: '.' })}</p>`
          : `<h1>保存失败</h1><pre>${escapeHtml(result)}</pre>`
      )
    )
    return
  }
  html(res, 404, page('Not found', '<h1>没有这个页面</h1>'))
}

async function runPortalTool(
  session: PortalSession,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const owner = currentOwner?.()
  if (!owner) return 'error: BotArk window is not available'
  if (name === 'write' || name === 'patch') {
    const targetPath = typeof args['path'] === 'string' ? args['path'] : ''
    const byteLen = typeof args['text'] === 'string' ? Buffer.byteLength(args['text'], 'utf-8') : 0
    const choice = await dialog.showMessageBox(owner, {
      type: 'question',
      message: `工作区门户请求保存文件：${targetPath}`,
      detail: `工作区：${session.root}\n目标文件：${targetPath}\n内容大小：${byteLen} 字节\n\n确认允许本次写入？`,
      buttons: ['取消', '允许一次'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (choice.response !== 1) return 'error: 用户已取消本次操作'
  }
  try {
    return await workspaceFile(session.root, name, args)
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function confirmPublicTunnel(owner: BrowserWindow, root: string): Promise<boolean> {
  const idleMinutes = Math.max(1, Math.round(idleTimeoutMs / 60_000))
  const choice = await dialog.showMessageBox(owner, {
    type: 'question',
    message: '发布临时工作区门户供 Hark 访问？',
    detail:
      `目录：${root}\n\n` +
      'Hark 不支持外部 [TOOL] 协议。开启后将通过临时 HTTPS 隧道（trycloudflare.com）发布带随机口令的网页门户：\n' +
      '• 默认屏蔽 .env、私钥和 .git 目录\n' +
      '• 所有写入操作仍需你逐次点击确认\n' +
      `• 空闲 ${idleMinutes} 分钟后或关闭/更换工作区时自动停止`,
    buttons: ['暂不发布（仅纯对话）', '发布临时门户'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return choice.response === 1
}

async function startTunnel(session: PortalSession): Promise<void> {
  if (!tunnelEnabled) return
  const binary = tunnelBinary()
  if (!binary) {
    session.error = '未找到 cloudflared，无法发布临时公网门户'
    return
  }
  const proc = spawn(binary, ['tunnel', '--url', session.localUrl, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  session.tunnel = proc
  const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
  const found = await new Promise<string | undefined>((resolve) => {
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
      proc.off('error', onError)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), TUNNEL_START_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      const match = pattern.exec(chunk.toString('utf-8'))
      if (match) finish(match[0])
    }
    const onExit = (): void => finish(undefined)
    const onError = (): void => finish(undefined)
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', onExit)
    proc.on('error', onError)
  })
  if (found) {
    session.publicUrl = found
    session.error = undefined
    proc.once('exit', () => {
      if (sessions.get(session.scope) === session) {
        void closePortal(session.scope)
      }
    })
  } else {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    session.tunnel = null
    session.error = 'cloudflared 隧道启动超时或失败'
  }
}

async function openPortalInternal(scopeId: string, owner: BrowserWindow): Promise<PortalState> {
  const root = await resolveWorkspaceRootFor(scopeId)
  if (!root) {
    await closePortal(scopeId)
    return { scope: scopeId, running: false, tools: [], error: '请先选择工作区目录' }
  }

  const existing = sessions.get(scopeId)
  if (existing) {
    const tunnelAlive = !tunnelEnabled || Boolean(existing.publicUrl && existing.tunnel && existing.tunnel.exitCode === null)
    if (existing.root === root && tunnelAlive) {
      touchSession(existing)
      return stateOf(existing)
    }
    await closePortal(scopeId)
  }

  if (tunnelEnabled) {
    const approved = await confirmPublicTunnel(owner, root)
    if (!approved) {
      return { scope: scopeId, running: false, tools: [], error: '用户已取消发布工作区门户' }
    }
  }

  const session: PortalSession = {
    scope: scopeId,
    root,
    token: generateToken(),
    server: null as unknown as Server,
    tunnel: null,
    localUrl: '',
    expiresAt: Date.now() + idleTimeoutMs,
    idleTimer: null,
    tools: fileTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }

  const server = createServer((req, res) => {
    handlePortalRequest(session, req, res).catch((error: unknown) => {
      html(
        res,
        500,
        page(
          'Error',
          `<h1>出错了</h1><pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>`
        )
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, PORTAL_HOST, () => resolve())
  })
  session.server = server
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  session.localUrl = `http://${PORTAL_HOST}:${port}`

  await startTunnel(session)
  if (tunnelEnabled && !session.publicUrl) {
    const err = session.error ?? '无法建立公网隧道'
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
    return { scope: scopeId, running: false, tools: [], error: err }
  }

  sessions.set(scopeId, session)
  touchSession(session)
  return stateOf(session)
}

async function openPortal(scope: string, owner: BrowserWindow): Promise<PortalState> {
  const scopeId = normalizeScope(scope)
  const inflight = pendingOpens.get(scopeId)
  if (inflight) return inflight
  const run = openPortalInternal(scopeId, owner).finally(() => {
    if (pendingOpens.get(scopeId) === run) pendingOpens.delete(scopeId)
  })
  pendingOpens.set(scopeId, run)
  return run
}

export async function closePortal(scope: string): Promise<void> {
  const scopeId = normalizeScope(scope)
  const session = sessions.get(scopeId)
  if (!session) return
  sessions.delete(scopeId)
  if (session.idleTimer) {
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }
  try {
    session.tunnel?.kill()
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    session.server.closeAllConnections?.()
    session.server.close(() => resolve())
  })
}

function entryUrlFor(session: PortalSession): string | undefined {
  const base = tunnelEnabled ? session.publicUrl : session.localUrl
  if (!base) return undefined
  return `${base}/?token=${session.token}`
}

export function registerWorkspacePortalIpc(owner: () => BrowserWindow | null): void {
  currentOwner = owner
  rootChangeUnsubscribe?.()
  rootChangeUnsubscribe = onWorkspaceRootChanged((scopeId) => {
    void closePortal(scopeId)
  })
  ipcMain.handle(WORKSPACE_PORTAL_CHANNEL, async (event, request: PortalRequest) => {
    const win = owner()
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Desktop window required')
    }
    const scopeId = normalizeScope(request.scope)
    if (request.op === 'open') return openPortal(scopeId, win)
    if (request.op === 'close') {
      await closePortal(scopeId)
      return { scope: scopeId, running: false, tools: [] }
    }
    const session = sessions.get(scopeId)
    if (!session) return { scope: scopeId, running: false, tools: [] }
    return stateOf(session)
  })
}

/** Test hook: disable cloudflared spawning so tests exercise the loopback portal directly. */
export function setWorkspacePortalTunnelEnabled(enabled: boolean): void {
  tunnelEnabled = enabled
}

/** Test hook: override the idle auto-shutdown timeout (0 disables timer). */
export function setWorkspacePortalIdleTimeoutMs(ms: number): void {
  idleTimeoutMs = ms
}

export async function stopWorkspacePortals(): Promise<void> {
  rootChangeUnsubscribe?.()
  rootChangeUnsubscribe = null
  for (const scope of [...sessions.keys()]) await closePortal(scope)
}
