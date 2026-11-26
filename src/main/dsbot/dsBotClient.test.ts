import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const tempDir = mkdtempSync(join(tmpdir(), 'botark-dsbot-test-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => tempDir,
    isReady: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('corrupt')
      return s.slice(4)
    }
  }
}))

import {
  addDsBotMemory,
  answerDsBotQuestion,
  cancelAllDsBotRuns,
  createDsBotMember,
  decideDsBotApproval,
  deleteDsBotSchedule,
  forgetDsBotMemory,
  getDsBotHistory,
  getDsBotMemory,
  getDsBotUsage,
  listDsBotModels,
  listDsBotSchedules,
  listDsBotTargets,
  listDsBotWaiting,
  probeDsBotConnection,
  sendDsBotMessage,
  setDsBotModel,
  toggleDsBotSchedule
} from './dsBotClient'
import {
  createDsBotNoisePrologue,
  decodeHandshakeHello,
  deviceIdForPublicKey,
  DsBotNoiseIkSession,
  DsBotSecureMessageCodec,
  encodeHandshakeHello,
  fromBase64Url,
  generateX25519KeyPair,
  toBase64Url
} from './dsBotNoise'
import { clearDsBotAccount, getDsBotAccountRevision, saveDsBotAccount } from './dsBotStore'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

describe('dsBotClient (MCP, Channel SSE, and Encrypted Relay)', () => {
  let mcpServer: Server
  let mcpPort = 0
  let channelServer: Server
  let channelPort = 0
  let relayHttpServer: Server
  let relayWss: WebSocketServer
  let relayPort = 0

  const channelCalls: Array<{ endpoint: string; payload: unknown }> = []
  const sseClients: Array<(chunk: string) => void> = []
  const hostKeys = generateX25519KeyPair()
  const hostDeviceId = deviceIdForPublicKey(hostKeys.publicKey)

  beforeAll(async () => {
    // 1. Mock DS Bot MCP HTTP Server
    mcpServer = createServer(async (req, res) => {
      if (req.headers.origin !== undefined) {
        res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' }))
        return
      }
      if (req.headers.authorization !== 'Bearer dsb_test_token') {
        res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: string
        method: string
        params?: { name?: string; arguments?: Record<string, unknown> }
      }
      let result: unknown = {}
      if (body.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', serverInfo: { name: 'ds-bot', version: '0.3.1' } }
      } else if (body.method === 'tools/call') {
        const name = body.params?.name
        const args = body.params?.arguments ?? {}
        if (name === 'list_bots') {
          result = {
            structuredContent: {
              bots: [
                { id: 'chief', name: 'Chief', role: 'Team Lead', main: true, working: false },
                { id: 'coder', name: 'Coder', role: 'Engineer', main: false, working: true }
              ]
            }
          }
        } else if (name === 'list_groups') {
          result = {
            structuredContent: {
              groups: [{ id: 'room1', name: 'Core Team', members: ['Chief', 'Coder'] }]
            }
          }
        } else if (name === 'read_chat') {
          result = {
            structuredContent: {
              messages: [
                { kind: 'user', text: 'Hi Chief', time: 1000 },
                { kind: 'bot', from: 'Chief', text: 'Ready to help!', time: 2000 }
              ],
              cursor: null,
              working: false
            }
          }
        } else if (name === 'send_to_bot' || name === 'send_to_group') {
          result = { structuredContent: { sent: true, after: 5000 } }
        } else if (name === 'wait_for_reply') {
          const isGroup = Boolean(args.group)
          result = {
            structuredContent: {
              done: true,
              working: false,
              after: 6000,
              messages: isGroup
                ? [{ kind: 'bot', from: 'Coder', text: 'PR merged!', time: 6000 }]
                : [{ kind: 'bot', from: 'Chief', text: 'Done via MCP!', time: 6000 }]
            }
          }
        } else if (name === 'list_waiting') {
          result = {
            structuredContent: {
              waiting: [
                { kind: 'approval', bot: 'Coder', tool: 'shell', reason: 'Run tests' },
                { kind: 'question', bot: 'Chief', question: 'Deploy now?' }
              ]
            }
          }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    })
    mcpPort = await listen(mcpServer)

    // 2. Mock DS Bot Direct Channel HTTP + SSE Server
    const memoryEntries = [{ scope: 'own', text: 'Prefers TypeScript', added: '2026-11-20' }]
    channelServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${channelPort}`)
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === 'boot_tok') {
        res.writeHead(302, {
          location: '/',
          'set-cookie': 'dsh_session=signed_30d; Path=/; HttpOnly'
        })
        res.end()
        return
      }
      if (req.headers.cookie !== 'dsh_session=signed_30d') {
        res.writeHead(401).end('Unauthorized')
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/bot/feed') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        res.write(`event: hello\ndata: ${JSON.stringify({ revision: 1 })}\n\n`)
        const writer = (chunk: string) => {
          if (!res.writableEnded) res.write(chunk)
        }
        sseClients.push(writer)
        req.on('close', () => {
          const idx = sseClients.indexOf(writer)
          if (idx >= 0) sseClients.splice(idx, 1)
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/bot') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const { endpoint, payload } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          endpoint: string
          payload: Record<string, unknown>
        }
        channelCalls.push({ endpoint, payload })
        let value: unknown = true
        if (endpoint === 'hello') {
          value = { api: 1, plugin: { name: 'ds-bot', version: '0.3.2' } }
        } else if (endpoint === 'state') {
          value = {
            revision: 3,
            mainBotId: 'chief',
            defaultModel: 'deepseek/deepseek-chat',
            models: [
              { ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', providerName: 'DeepSeek' },
              { ref: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner', providerName: 'DeepSeek' }
            ],
            bots: [
              { id: 'chief', name: 'Chief', role: 'Orchestrator', main: true, model: 'deepseek/deepseek-chat', sessionId: 'sess_chief' }
            ],
            rooms: [{ id: 'grp1', name: 'Dev Room', members: ['chief'], sessionId: 'sess_grp1' }],
            work: {
              bots: {},
              rooms: {},
              approvals: [
                { id: 'apr_1', botId: 'chief', sessionId: 'sess_chief', tool: 'bash', reason: 'Run build', answerable: true }
              ]
            },
            questions: {
              sess_chief: { id: 'q_1', question: 'Continue?', options: [{ label: 'Yes' }] }
            }
          }
        } else if (endpoint === 'chat') {
          value = {
            items: [
              { seq: 1, kind: 'user', text: 'Status?', time: 1000 },
              { seq: 2, kind: 'bot', text: 'All green', time: 2000 }
            ]
          }
        } else if (endpoint === 'stage-image') {
          value = { id: 'staged_img_1' }
        } else if (endpoint === 'send') {
          // Stream live tokens over SSE feed!
          setTimeout(() => {
            for (const write of sseClients) {
              write(`event: stream\ndata: ${JSON.stringify({ botId: 'chief', attemptId: 'att1', phase: 'start' })}\n\n`)
              write(`event: stream\ndata: ${JSON.stringify({ botId: 'chief', attemptId: 'att1', text: 'Hello ' })}\n\n`)
              write(`event: stream\ndata: ${JSON.stringify({ botId: 'chief', attemptId: 'att1', text: 'streaming!' })}\n\n`)
              write(`event: stream\ndata: ${JSON.stringify({ botId: 'chief', attemptId: 'att1', phase: 'end' })}\n\n`)
            }
          }, 25)
          value = true
        } else if (endpoint === 'memory-view') {
          value = { summary: { text: 'Summary text', at: Date.now() }, entries: memoryEntries }
        } else if (endpoint === 'memory-add') {
          memoryEntries.push({ scope: 'own', text: String(payload.text), added: '2026-11-26' })
          value = { entries: memoryEntries }
        } else if (endpoint === 'memory-forget') {
          const idx = memoryEntries.findIndex((e) => e.text === payload.text)
          if (idx >= 0) memoryEntries.splice(idx, 1)
          value = { entries: memoryEntries }
        } else if (endpoint === 'schedules') {
          value = {
            available: true,
            canPause: true,
            tasks: [{ id: 'sch_1', sessionId: 'sess_chief', title: 'Morning digest', prompt: 'Summarize', state: 'scheduled', botId: 'chief' }]
          }
        } else if (endpoint === 'usage-summary') {
          value = {
            botId: 'chief',
            day: { input: 1000, cacheRead: 200, cacheWrite: 0, output: 500, calls: 2 },
            week: { input: 5000, cacheRead: 1000, cacheWrite: 0, output: 2500, calls: 10 },
            month: { input: 20000, cacheRead: 4000, cacheWrite: 0, output: 10000, calls: 40 },
            models: []
          }
        } else if (endpoint === 'create-bot') {
          value = { id: 'writer', name: payload.name }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value }))
        return
      }
      res.writeHead(404).end()
    })
    channelPort = await listen(channelServer)

    // 3. Mock DS Bot Encrypted Relay Server + Noise_IK Host Responder
    relayHttpServer = createServer()
    relayWss = new WebSocketServer({ server: relayHttpServer, path: '/v1/link' })
    relayWss.on('connection', (ws) => {
      let clientDeviceId = ''
      const connId = 'conn-relay-1'
      let noise: DsBotNoiseIkSession | null = null
      const inCodec = new DsBotSecureMessageCodec()
      const outCodec = new DsBotSecureMessageCodec()
      let counter = 0

      const sendFrame = (type: string, payload: Record<string, unknown>) => {
        ws.send(JSON.stringify({ v: 1, id: `srv-${Date.now()}`, type, timestamp: Date.now(), payload }))
      }

      const sendEncrypted = (msg: Record<string, unknown>) => {
        if (!noise) return
        const bytes = new TextEncoder().encode(JSON.stringify(msg))
        for (const chunk of outCodec.encode(bytes)) {
          sendFrame('relay', {
            connectionId: connId,
            targetDeviceId: clientDeviceId,
            counter: counter++,
            ciphertext: toBase64Url(noise.encrypt(chunk))
          })
        }
      }

      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> }
        if (frame.type === 'hello') {
          clientDeviceId = String(frame.payload.deviceId)
          sendFrame('hello.ack', {
            protocol: 1,
            serverVersion: 'test',
            connectionSessionId: 'cs-1',
            heartbeatIntervalMs: 30_000,
            maxControlFrameBytes: 64 * 1024,
            maxRelayFrameBytes: 1024 * 1024,
            capabilities: ['transport.relay']
          })
        } else if (frame.type === 'connect.request') {
          sendFrame('connect.accepted', { connectionId: connId })
        } else if (frame.type === 'secure.handshake' && frame.payload.step === 1) {
          noise = new DsBotNoiseIkSession({
            role: 'responder',
            localPrivateKey: hostKeys.privateKey,
            localPublicKey: hostKeys.publicKey,
            prologue: createDsBotNoisePrologue(connId, hostDeviceId, clientDeviceId)
          })
          const hello = decodeHandshakeHello(noise.readHandshake(fromBase64Url(String(frame.payload.data))))
          if (hello.pairingCode && hello.pairingCode !== 'pair_valid') {
            sendFrame('connect.rejected', { connectionId: connId, code: 'BAD_CODE', message: 'Invalid pairing code' })
            return
          }
          const step2 = noise.writeHandshake(encodeHandshakeHello({ name: 'HomeMac-DSBot' }))
          sendFrame('secure.handshake', {
            connectionId: connId,
            targetDeviceId: clientDeviceId,
            step: 2,
            data: toBase64Url(step2)
          })
        } else if (frame.type === 'relay' && noise) {
          const assembled = inCodec.decode(noise.decrypt(fromBase64Url(String(frame.payload.ciphertext))))
          if (!assembled) return
          const req = JSON.parse(new TextDecoder().decode(assembled)) as {
            id: string
            type: string
            payload: { method: string; params: { endpoint: string; payload: Record<string, unknown> } }
          }
          if (req.type !== 'rpc.request') return
          const ep = req.payload.params.endpoint
          let value: unknown = true
          if (ep === 'hello') value = { api: 1, plugin: { name: 'ds-bot', version: '0.3.9' } }
          else if (ep === 'state') {
            value = {
              revision: 1,
              mainBotId: 'chief',
              bots: [{ id: 'chief', name: 'Chief', role: 'Relay Lead', main: true }],
              rooms: [],
              work: { bots: {}, rooms: {}, approvals: [] },
              questions: {}
            }
          } else if (ep === 'send') {
            setTimeout(() => {
              sendEncrypted({
                v: 1,
                id: 'ev-1',
                type: 'event',
                timestamp: Date.now(),
                payload: { event: 'stream', data: { botId: 'chief', attemptId: 'r1', phase: 'start' } }
              })
              sendEncrypted({
                v: 1,
                id: 'ev-2',
                type: 'event',
                timestamp: Date.now(),
                payload: { event: 'stream', data: { botId: 'chief', attemptId: 'r1', text: 'Encrypted reply!' } }
              })
              sendEncrypted({
                v: 1,
                id: 'ev-3',
                type: 'event',
                timestamp: Date.now(),
                payload: { event: 'stream', data: { botId: 'chief', attemptId: 'r1', phase: 'end' } }
              })
            }, 20)
          }
          sendEncrypted({
            v: 1,
            id: `res-${req.id}`,
            type: 'rpc.response',
            timestamp: Date.now(),
            payload: { requestId: req.id, result: { ok: true, value } }
          })
        }
      })
    })
    relayPort = await listen(relayHttpServer)
  })

  afterEach(async () => {
    cancelAllDsBotRuns('*')
    await clearDsBotAccount('*')
    channelCalls.length = 0
  })

  afterAll(async () => {
    cancelAllDsBotRuns('*')
    await Promise.all([
      new Promise<void>((r) => mcpServer.close(() => r())),
      new Promise<void>((r) => channelServer.close(() => r())),
      new Promise<void>((r) => relayWss.close(() => relayHttpServer.close(() => r())))
    ])
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('connects in MCP mode, expands bots & groups, hydrates chat, sends & waits, and lists waiting items', async () => {
    const accountId = 'acc_ds_mcp'
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`
    const probe = await probeDsBotConnection({
      accountId,
      mode: 'mcp',
      endpointUrl: mcpUrl,
      secret: 'dsb_test_token'
    })
    expect(probe.authenticated).toBe(true)
    expect(probe.version).toBe('0.3.1')
    expect(probe.botCount).toBe(2)
    expect(probe.groupCount).toBe(1)

    await saveDsBotAccount({
      accountId,
      mode: 'mcp',
      expectedRevision: getDsBotAccountRevision(accountId),
      baseUrl: mcpUrl,
      secret: 'dsb_test_token'
    })

    const targets = await listDsBotTargets(accountId)
    expect(targets.map((t) => t.id)).toEqual(['bot:chief', 'bot:coder', 'room:room1'])

    const history = await getDsBotHistory(accountId, 'bot:chief')
    expect(history.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Hi Chief'],
      ['assistant', 'Ready to help!']
    ])

    let accepted = false
    const deltas: string[] = []
    const sendRes = await sendDsBotMessage({
      accountId,
      agentId: 'room:room1',
      text: 'Status update?',
      callbacks: {
        onAccepted: () => {
          accepted = true
        },
        onDelta: (d) => deltas.push(d.text)
      }
    })
    expect(accepted).toBe(true)
    expect(sendRes.replyText).toBe('**Coder**：PR merged!')
    expect(deltas.at(-1)).toBe('**Coder**：PR merged!')

    const waiting = await listDsBotWaiting(accountId)
    expect(waiting.approvals).toHaveLength(1)
    expect(waiting.approvals[0]?.answerable).toBe(false)
    expect(waiting.questions).toHaveLength(1)
  })

  it('connects in Channel SSE mode, exchanges ?token= cookie, streams replies, stages images, and drives full native endpoints', async () => {
    const accountId = 'acc_ds_chan'
    const rawUrl = `http://127.0.0.1:${channelPort}/?token=boot_tok`
    const probe = await probeDsBotConnection({ accountId, mode: 'channel', endpointUrl: rawUrl })
    expect(probe.authenticated).toBe(true)
    expect(probe.exchangedCookie).toBe('dsh_session=signed_30d')
    expect(probe.botCount).toBe(1)
    expect(probe.groupCount).toBe(1)

    await saveDsBotAccount({
      accountId,
      mode: 'channel',
      expectedRevision: getDsBotAccountRevision(accountId),
      baseUrl: `http://127.0.0.1:${channelPort}`,
      secret: probe.exchangedCookie
    })

    const targets = await listDsBotTargets(accountId)
    expect(targets.map((t) => t.id)).toEqual(['bot:chief', 'room:grp1'])

    const deltas: string[] = []
    const sent = await sendDsBotMessage({
      accountId,
      agentId: 'bot:chief',
      text: 'Inspect this image',
      attachments: [{ name: 'pic.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
      callbacks: { onDelta: (d) => deltas.push(d.text) }
    })
    expect(sent.replyText).toBe('Hello streaming!')
    expect(deltas).toContain('Hello ')
    expect(channelCalls.some((c) => c.endpoint === 'stage-image')).toBe(true)

    const waiting = await listDsBotWaiting(accountId)
    expect(waiting.approvals[0]).toMatchObject({ id: 'apr_1', tool: 'bash', answerable: true })
    expect(waiting.questions[0]).toMatchObject({ id: 'q_1', question: 'Continue?', answerable: true })

    await decideDsBotApproval(accountId, 'apr_1', 'allow')
    await answerDsBotQuestion(accountId, 'sess_chief', 'q_1', 'Yes')
    expect(channelCalls).toContainEqual({ endpoint: 'approval-answer', payload: { id: 'apr_1', choice: 'allow' } })
    expect(channelCalls).toContainEqual({
      endpoint: 'answer-question',
      payload: { sessionId: 'sess_chief', questionId: 'q_1', answer: 'Yes' }
    })

    const mem1 = await getDsBotMemory(accountId, 'bot:chief')
    expect(mem1.summary).toBe('Summary text')
    expect(mem1.entries).toHaveLength(1)
    const mem2 = await addDsBotMemory(accountId, 'bot:chief', 'Likes clean tests')
    expect(mem2.entries).toHaveLength(2)
    const mem3 = await forgetDsBotMemory(accountId, 'bot:chief', 'Likes clean tests')
    expect(mem3.entries).toHaveLength(1)

    const schedules = await listDsBotSchedules(accountId)
    expect(schedules.tasks).toHaveLength(1)
    await toggleDsBotSchedule(accountId, 'sch_1', 'sess_chief', false)
    await deleteDsBotSchedule(accountId, 'sch_1', 'sess_chief')

    const usage = await getDsBotUsage(accountId, 'bot:chief')
    expect(usage?.day.calls).toBe(2)

    const { models } = await listDsBotModels(accountId)
    expect(models).toHaveLength(2)
    await setDsBotModel(accountId, 'bot:chief', 'deepseek/deepseek-reasoner')
    await createDsBotMember(accountId, { name: 'Writer', role: 'Docs' })
    expect(channelCalls).toContainEqual({
      endpoint: 'update-bot',
      payload: { id: 'chief', model: 'deepseek/deepseek-reasoner' }
    })
  })

  it('pairs and streams end-to-end encrypted replies over DS Bot Noise_IK Relay mode', async () => {
    const accountId = 'acc_ds_relay'
    const pairingUri = `dsbot://pair?v=1&server=${encodeURIComponent(`ws://127.0.0.1:${relayPort}/v1/link`)}&host=${encodeURIComponent(hostDeviceId)}&key=${encodeURIComponent(hostKeys.publicKey)}&code=pair_valid&name=HomeMac`

    const probe = await probeDsBotConnection({
      accountId,
      mode: 'relay',
      pairingUri
    })
    expect(probe.authenticated).toBe(true)
    expect(probe.hostName).toBe('HomeMac-DSBot')
    expect(probe.pairedIdentity?.hostDeviceId).toBe(hostDeviceId)
    expect(probe.botCount).toBe(1)

    await saveDsBotAccount({
      accountId,
      mode: 'relay',
      expectedRevision: getDsBotAccountRevision(accountId),
      relayServer: probe.pairedIdentity!.relayServer,
      hostDeviceId: probe.pairedIdentity!.hostDeviceId,
      hostKey: probe.pairedIdentity!.hostKey,
      hostName: probe.pairedIdentity!.hostName,
      deviceId: probe.pairedIdentity!.deviceId,
      publicKey: probe.pairedIdentity!.publicKey,
      privateKey: probe.pairedIdentity!.privateKey,
      accessToken: probe.pairedIdentity!.accessToken
    })

    const res = await sendDsBotMessage({
      accountId,
      agentId: 'bot:chief',
      text: 'Encrypted ping'
    })
    expect(res.replyText).toBe('Encrypted reply!')
  })
})
