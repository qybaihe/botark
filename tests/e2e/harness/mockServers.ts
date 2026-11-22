import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const require = createRequire(import.meta.url)

export interface CapturedCueRequest {
  method: string
  url: string
  authorization?: string
  apiKey?: string
  cookie?: string
  body?: unknown
}

export interface MockCueServer {
  url: string
  requests: CapturedCueRequest[]
  refreshCount: number
  force401OnceForToken: (token: string) => void
  pushSseEvent: (tokenOrAccountHint: string, payload: unknown) => void
  close: () => Promise<void>
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function createMockCueServer(): Promise<MockCueServer> {
  const requests: CapturedCueRequest[] = []
  const oneShot401Tokens = new Set<string>()
  const sseStreams = new Map<string, Set<ServerResponse>>()
  let refreshCount = 0

  const server = createServer(async (req, res) => {
    const reqUrl = req.url || '/'
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    const apiKey = typeof req.headers['x-manus-api-key'] === 'string' ? req.headers['x-manus-api-key'] : undefined
    const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined

    if (req.method === 'GET' && reqUrl.startsWith('/watch')) {
      const key = bearerToken || apiKey || 'anon'
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      let set = sseStreams.get(key)
      if (!set) {
        set = new Set()
        sseStreams.set(key, set)
      }
      set.add(res)
      req.on('close', () => {
        set?.delete(res)
      })
      return
    }

    const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : undefined
    requests.push({ method: req.method || 'GET', url: reqUrl, authorization: auth, apiKey, cookie, body })

    if (bearerToken && oneShot401Tokens.has(bearerToken)) {
      oneShot401Tokens.delete(bearerToken)
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'token_expired' }))
      return
    }

    if (reqUrl.includes('/auth/refresh') || reqUrl.includes('/oauth/token')) {
      refreshCount++
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
      const oldRt = String(b.refresh_token || b.refreshToken || 'rt')
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          access_token: `refreshed_access_${refreshCount}_${oldRt}`,
          accessToken: `refreshed_access_${refreshCount}_${oldRt}`,
          refresh_token: `refreshed_rt_${refreshCount}`,
          refreshToken: `refreshed_rt_${refreshCount}`,
          expires_in: 3600
        })
      )
      return
    }

    if (reqUrl.includes('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, status: 'healthy' }))
      return
    }

    if (reqUrl.includes('/agents') || reqUrl.includes('ListAgents')) {
      const suffix = bearerToken?.slice(-6) || apiKey?.slice(-6) || 'default'
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          agents: [{ id: `agent_${suffix}`, name: `Cue ${suffix}`, description: 'Cue mock agent' }]
        })
      )
      return
    }

    if (reqUrl.includes('/tasks')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ tasks: [{ id: 'task_1', title: 'Mock Cue Task', status: 'running' }] })
      )
      return
    }

    if (reqUrl.includes('/messages') || reqUrl.includes('SendMessage')) {
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
      const sessionId = String(b.sessionId || b.session_id || `sess_${Date.now()}`)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          messageId: `msg_${requests.length}`,
          sessionId,
          reply: { id: `reply_${requests.length}`, text: `Cue reply to: ${String(b.text || '')}` }
        })
      )
      return
    }

    if (reqUrl.includes('/approve')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, approved: true }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('MockCueServer failed to bind')

  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    get refreshCount() {
      return refreshCount
    },
    force401OnceForToken(token: string) {
      oneShot401Tokens.add(token)
    },
    pushSseEvent(tokenOrAccountHint: string, payload: unknown) {
      const data = `data: ${JSON.stringify(payload)}\n\n`
      const targets = sseStreams.get(tokenOrAccountHint)
      if (!targets) return
      for (const stream of targets) {
        stream.write(data)
      }
    },
    async close() {
      for (const set of sseStreams.values()) {
        for (const stream of set) stream.end()
      }
      sseStreams.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export interface MockLegacySseMcpServer {
  sseUrl: string
  baseUrl: string
  streamableRejectCode: number
  setStreamableRejectCode: (code: number) => void
  close: () => Promise<void>
}

export async function createMockLegacySseMcpServer(): Promise<MockLegacySseMcpServer> {
  let streamableRejectCode = 405
  const transports = new Map<string, SSEServerTransport>()
  const servers = new Set<McpServer>()

  const httpServer: Server = createServer(async (req, res) => {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1')

    if (parsed.pathname === '/sse' && req.method === 'GET') {
      const mcpServer = new McpServer(
        { name: 'legacy-sse-fixture', version: '1.0.0' },
        { capabilities: { tools: {} } }
      )
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: 'ping', description: 'Legacy SSE ping tool', inputSchema: { type: 'object', properties: {} } },
          {
            name: 'echo',
            description: 'Echo input msg',
            inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] }
          }
        ]
      }))
      mcpServer.setRequestHandler(CallToolRequestSchema, async (call) => {
        if (call.params.name === 'ping') {
          return { content: [{ type: 'text', text: 'pong-from-sse' }] }
        }
        if (call.params.name === 'echo') {
          const msg = String((call.params.arguments as Record<string, unknown> | undefined)?.msg ?? '')
          return { content: [{ type: 'text', text: `sse-echo:${msg}` }] }
        }
        return { isError: true, content: [{ type: 'text', text: `Unknown tool ${call.params.name}` }] }
      })

      const transport = new SSEServerTransport('/messages', res)
      transports.set(transport.sessionId, transport)
      servers.add(mcpServer)
      res.on('close', () => {
        transports.delete(transport.sessionId)
        servers.delete(mcpServer)
        void mcpServer.close()
      })
      await mcpServer.connect(transport)
      return
    }

    if (parsed.pathname === '/messages' && req.method === 'POST') {
      const sessionId = parsed.searchParams.get('sessionId') || ''
      const transport = transports.get(sessionId)
      if (!transport) {
        res.writeHead(404).end('Session not found')
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    // Legacy SSE-only endpoint rejects Streamable HTTP POST with 404/405
    if (req.method === 'POST') {
      res.writeHead(streamableRejectCode, { 'Content-Type': 'text/plain' }).end('Streamable HTTP unsupported')
      return
    }

    res.writeHead(404).end('Not found')
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const addr = httpServer.address()
  if (!addr || typeof addr === 'string') throw new Error('MockLegacySseMcpServer failed to bind')
  const baseUrl = `http://127.0.0.1:${addr.port}`

  return {
    sseUrl: `${baseUrl}/sse`,
    baseUrl,
    get streamableRejectCode() {
      return streamableRejectCode
    },
    setStreamableRejectCode(code: number) {
      streamableRejectCode = code
    },
    async close() {
      for (const s of servers) await s.close().catch(() => {})
      servers.clear()
      transports.clear()
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}

export interface StdioMcpFixtures {
  validScript: string
  stderrCrashScript: string
  hangScript: string
  noToolsScript: string
}

export async function createStdioMcpFixtures(dir: string): Promise<StdioMcpFixtures> {
  const sdkServerPath = require.resolve('@modelcontextprotocol/sdk/server/index.js')
  const sdkStdioPath = require.resolve('@modelcontextprotocol/sdk/server/stdio.js')
  const sdkTypesPath = require.resolve('@modelcontextprotocol/sdk/types.js')

  const validScript = join(dir, 'mcp-valid.cjs')
  const stderrCrashScript = join(dir, 'mcp-stderr-crash.cjs')
  const hangScript = join(dir, 'mcp-hang.cjs')
  const noToolsScript = join(dir, 'mcp-no-tools.cjs')

  await writeFile(
    validScript,
    [
      `const { Server } = require(${JSON.stringify(sdkServerPath)});`,
      `const { StdioServerTransport } = require(${JSON.stringify(sdkStdioPath)});`,
      `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkTypesPath)});`,
      `const server = new Server({ name: 'stdio-valid', version: '1.0.0' }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({`,
      `  tools: [`,
      `    { name: 'echo', description: 'Echo message', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },`,
      `    { name: 'pwd', description: 'Report process.cwd()', inputSchema: { type: 'object', properties: {} } }`,
      `  ]`,
      `}));`,
      `server.setRequestHandler(CallToolRequestSchema, async (req) => {`,
      `  if (req.params.name === 'pwd') return { content: [{ type: 'text', text: process.cwd() }] };`,
      `  if (req.params.name === 'echo') return { content: [{ type: 'text', text: 'stdio:' + String((req.params.arguments || {}).msg || '') }] };`,
      `  return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };`,
      `});`,
      `server.connect(new StdioServerTransport());`
    ].join('\n'),
    'utf8'
  )

  await writeFile(
    stderrCrashScript,
    [
      `process.stderr.write('FATAL_STDIO_DIAG: missing runtime token\\n');`,
      `setTimeout(() => process.exit(1), 20);`
    ].join('\n'),
    'utf8'
  )

  await writeFile(
    hangScript,
    `setInterval(() => {}, 1000);\n`,
    'utf8'
  )

  await writeFile(
    noToolsScript,
    [
      `const { Server } = require(${JSON.stringify(sdkServerPath)});`,
      `const { StdioServerTransport } = require(${JSON.stringify(sdkStdioPath)});`,
      `const { ListPromptsRequestSchema } = require(${JSON.stringify(sdkTypesPath)});`,
      `const server = new Server({ name: 'stdio-no-tools', version: '1.0.0' }, { capabilities: { prompts: {} } });`,
      `server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));`,
      `server.connect(new StdioServerTransport());`
    ].join('\n'),
    'utf8'
  )

  return { validScript, stderrCrashScript, hangScript, noToolsScript }
}
