import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const { watchEvents, loadCueTokens, createProxyAgent, credentialRevision } = vi.hoisted(() => ({
  watchEvents: [] as unknown[],
  loadCueTokens: vi.fn(async (accountId: string) => ({
    accountId,
    accessToken: 'jwt_cue_socket_test',
    deviceId: 'dev_socket_1',
    authKind: 'session' as const,
    accountFingerprint: 'fp_1'
  })),
  createProxyAgent: vi.fn(async () => undefined),
  credentialRevision: Symbol()
}))

vi.mock('./cueAuth', () => ({
  CUE_CONNECT_BASE: 'https://api.manus.im',
  CUE_ORIGIN: 'https://cue.im',
  getCueCredentialRevision: () => credentialRevision,
  loadCueTokens
}))
vi.mock('./cueDeviceId', () => ({
  getOrCreateCueDeviceId: () => 'dev_socket_1'
}))
vi.mock('../muse/accountProxy', () => ({
  createProxyAgent
}))
vi.mock('./cueWatchManager', () => ({
  emitCueWatchEvent: (ev: unknown) => watchEvents.push(ev)
}))

import {
  buildCueSocketUrl,
  cancelCueNativeTurn,
  createCueEventId,
  encodeSocketIoEvent,
  parseSocketIoPacket,
  sendCueNativeMessage,
  stopCueChatSocket,
  syncCueWatchedSessions
} from './cueChatSocket'

describe('Cue native Engine.IO / Socket.IO chat client', () => {
  const servers: WebSocketServer[] = []

  afterEach(async () => {
    stopCueChatSocket('*')
    createProxyAgent.mockClear()
    watchEvents.length = 0
    await Promise.all(
      servers.splice(0).map(
        (srv) =>
          new Promise<void>((resolve) => {
            srv.close(() => resolve())
          })
      )
    )
  })

  it('builds Socket.IO URL with desktop headers/query and parses/encodes EIO4 packets', () => {
    const url = new URL(buildCueSocketUrl({ deviceId: 'dev_1', locale: 'zh-CN', tz: 'Asia/Shanghai' }))
    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('api.manus.im')
    expect(url.pathname).toBe('/socket.io/')
    expect(url.searchParams.get('EIO')).toBe('4')
    expect(url.searchParams.get('transport')).toBe('websocket')
    expect(url.searchParams.get('x-product-name')).toBe('manus-agents')
    expect(url.searchParams.get('deviceId')).toBe('dev_1')

    expect(parseSocketIoPacket('2')).toEqual({ kind: 'ping' })
    expect(parseSocketIoPacket('40{"sid":"s1"}')).toEqual({ kind: 'connect', payload: { sid: 's1' } })
    const encoded = encodeSocketIoEvent('message', { type: 'user_message', content: 'hi' })
    expect(parseSocketIoPacket(encoded)).toEqual({
      kind: 'event',
      eventName: 'message',
      payload: { type: 'user_message', content: 'hi' }
    })

    for (let i = 0; i < 10; i += 1) {
      expect(createCueEventId()).toMatch(/^[A-Za-z0-9]{22}$/)
    }
  })

  it('completes EIO4 handshake, answers pings, joins session, streams chatDelta, and resolves on stopped', async () => {
    const receivedFrames: string[] = []
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const port = (wss.address() as AddressInfo).port

    wss.on('connection', (ws, req) => {
      expect(req.url).toContain('/socket.io/?EIO=4&transport=websocket')
      expect(req.headers.authorization).toBe('Bearer jwt_cue_socket_test')
      expect(req.headers['x-product-name']).toBe('manus-agents')

      ws.send('0{"sid":"eio_1","pingInterval":25000,"pingTimeout":20000}')
      ws.on('message', (data) => {
        const raw = data.toString('utf8')
        receivedFrames.push(raw)
        if (raw.startsWith('40')) {
          expect(JSON.parse(raw.slice(2))).toEqual({ token: 'jwt_cue_socket_test' })
          ws.send('40{"sid":"sio_1"}')
          ws.send('2')
          return
        }
        if (raw.startsWith('42')) {
          const parsed = JSON.parse(raw.slice(2)) as [string, Record<string, unknown>]
          if (parsed[0] === 'message' && parsed[1]['type'] === 'user_message') {
            const sid = String(parsed[1]['sessionId'])
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: sid,
                event: { type: 'statusUpdate', agentStatus: 'running' }
              })
            )
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: sid,
                event: {
                  type: 'chatDelta',
                  sender: 'assistant',
                  targetEventId: 'reply_cue_1',
                  delta: { content: '你好，' }
                }
              })
            )
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: sid,
                event: {
                  type: 'chatDelta',
                  sender: 'assistant',
                  targetEventId: 'reply_cue_1',
                  delta: { content: '我是 Cue。' }
                }
              })
            )
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: sid,
                event: {
                  type: 'chat',
                  sender: 'assistant',
                  id: 'reply_cue_1',
                  content: '你好，我是 Cue。'
                }
              })
            )
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: sid,
                event: { type: 'statusUpdate', agentStatus: 'stopped' }
              })
            )
          }
        }
      })
    })

    const result = await sendCueNativeMessage({
      accountId: 'acc_cue_ws_1',
      sessionId: 'sess_cue_1',
      agentId: 'ag_1',
      conversationId: 'bot_cue_1',
      text: '你好',
      wsBaseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
      settleIdleMs: 500
    })

    expect(result).toEqual({
      sessionId: 'sess_cue_1',
      messageId: 'reply_cue_1',
      reply: {
        id: 'reply_cue_1',
        text: '你好，我是 Cue。'
      }
    })
    expect(receivedFrames).toContain('3')
    const sentMessages = receivedFrames
      .filter((f) => f.startsWith('42'))
      .map((f) => (JSON.parse(f.slice(2)) as [string, Record<string, unknown>])[1]!)
    expect(sentMessages.map((m) => m['type'])).toEqual(['join_session', 'user_message'])
    for (const msg of sentMessages) {
      expect(msg['id']).toMatch(/^[A-Za-z0-9]{22}$/)
    }

    const streams = watchEvents.filter(
      (ev): ev is { type: string; messageId?: string; text?: string } =>
        Boolean(ev && typeof ev === 'object' && (ev as { type?: string }).type === 'stream')
    )
    expect(streams.map((s) => s.text)).toEqual(['你好，', '你好，我是 Cue。', '你好，我是 Cue。'])
  })

  it('rejects cleanly when server emits agent_error', async () => {
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const port = (wss.address() as AddressInfo).port

    wss.on('connection', (ws) => {
      ws.send('0{"sid":"eio_2"}')
      ws.on('message', (data) => {
        const raw = data.toString('utf8')
        if (raw.startsWith('40')) {
          ws.send('40{"sid":"sio_2"}')
          return
        }
        if (raw.startsWith('42')) {
          const parsed = JSON.parse(raw.slice(2)) as [string, Record<string, unknown>]
          if (parsed[1]?.['type'] === 'user_message') {
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'agent_error',
                sessionId: 'sess_err',
                code: 4001,
                message: 'Insufficient Cue credits'
              })
            )
          }
        }
      })
    })

    await expect(
      sendCueNativeMessage({
        accountId: 'acc_cue_ws_2',
        sessionId: 'sess_err',
        text: 'test',
        wsBaseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 5_000
      })
    ).rejects.toThrow('Insufficient Cue credits')
  })

  it('registers one connection before proxy lookup and expires it when Engine.IO pings stop', async () => {
    let releaseProxy!: () => void
    createProxyAgent.mockImplementationOnce(() => new Promise((resolve) => { releaseProxy = () => resolve(undefined) }))
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const connections = vi.fn()
    wss.on('connection', (ws) => {
      connections()
      ws.send('0{"pingInterval":30,"pingTimeout":30}')
      ws.on('message', (data) => {
        if (data.toString().startsWith('40')) ws.send('40{}')
      })
    })
    const opts = {
      accountId: 'heartbeat-fixture', text: 'test',
      wsBaseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, timeoutMs: 2_000
    }
    const results = Promise.allSettled([
      sendCueNativeMessage({ ...opts, sessionId: 'first' }),
      sendCueNativeMessage({ ...opts, sessionId: 'second' })
    ])
    await vi.waitFor(() => expect(createProxyAgent).toHaveBeenCalledOnce())
    releaseProxy()
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('心跳') }) },
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('心跳') }) }
    ])
    expect(connections).toHaveBeenCalledOnce()
  })

  it('serializes the same session, acknowledges its user echo, and keeps each final snapshot', async () => {
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const dispatched = vi.fn()
    let finishFirst!: () => void
    wss.on('connection', (ws) => {
      const emit = (event: object) => ws.send(encodeSocketIoEvent('message', {
        type: 'event', sessionId: 'serial-session', event
      }))
      const finish = () => emit({ type: 'statusUpdate', agentStatus: 'completed' })
      ws.send('0{}')
      ws.on('message', (data) => {
        const packet = parseSocketIoPacket(data.toString())
        if (packet.kind === 'connect') ws.send('40{}')
        if (packet.kind !== 'event') return
        const payload = packet.payload as { type: string; id: string; content: string }
        if (payload.type !== 'user_message') return
        dispatched(payload.content)
        emit({ type: 'chat', sender: 'user', id: payload.id })
        emit({ type: 'statusUpdate', agentStatus: 'running' })
        if (payload.content === 'First') {
          emit({ type: 'chatDelta', sender: 'assistant', targetEventId: 'one', content: 'Long draft' })
          emit({ type: 'chat', sender: 'assistant', id: 'one', content: 'Fixed' })
          emit({ type: 'chatDelta', sender: 'assistant', targetEventId: 'one', content: 'stale' })
          emit({ type: 'chat', sender: 'assistant', id: 'two', content: 'B' })
          finishFirst = finish
        } else {
          emit({ type: 'chat', sender: 'assistant', id: 'three', content: 'Second' })
          finish()
        }
      })
    })
    const opts = {
      accountId: 'serial-fixture', sessionId: 'serial-session',
      wsBaseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, timeoutMs: 2_000
    }
    const first = sendCueNativeMessage({ ...opts, text: 'First', requestId: 'req-1' })
    const second = sendCueNativeMessage({ ...opts, text: 'Second', requestId: 'req-2' })
    await vi.waitFor(() => expect(watchEvents).toContainEqual(expect.objectContaining({ type: 'accepted', requestId: 'req-1' })))
    expect(dispatched.mock.calls).toEqual([['First']])
    finishFirst()
    expect((await first).replies).toEqual([{ id: 'one', text: 'Fixed' }, { id: 'two', text: 'B' }])
    expect((await second).reply).toEqual({ id: 'three', text: 'Second' })
  })

  it('ignores historical join_session replay and initial stopped status until the new turn responds', async () => {
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const port = (wss.address() as AddressInfo).port

    wss.on('connection', (ws) => {
      ws.send('0{"sid":"eio_3"}')
      ws.on('message', (data) => {
        const raw = data.toString('utf8')
        if (raw.startsWith('40')) {
          ws.send('40{"sid":"sio_3"}')
          return
        }
        if (raw.startsWith('42')) {
          const parsed = JSON.parse(raw.slice(2)) as [string, Record<string, unknown>]
          const msg = parsed[1]
          if (msg?.['type'] === 'join_session') {
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: 'sess_replay',
                event: {
                  type: 'chat',
                  sender: 'assistant',
                  id: 'hist_old_1',
                  content: '这是旧会话的历史消息',
                  timestamp: Math.floor((Date.now() - 120_000) / 1000)
                }
              })
            )
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: 'sess_replay',
                event: { type: 'statusUpdate', agentStatus: 'stopped' }
              })
            )
            return
          }
          if (msg?.['type'] === 'user_message') {
            setTimeout(() => {
              ws.send(
                encodeSocketIoEvent('message', {
                  type: 'event',
                  sessionId: 'sess_replay',
                  event: { type: 'chat', sender: 'user', id: msg['id'], content: '11', timestamp: Date.now() }
                })
              )
              ws.send(
                encodeSocketIoEvent('message', {
                  type: 'event',
                  sessionId: 'sess_replay',
                  event: { type: 'statusUpdate', agentStatus: 'running' }
                })
              )
              ws.send(
                encodeSocketIoEvent('message', {
                  type: 'event',
                  sessionId: 'sess_replay',
                  event: {
                    type: 'chat',
                    sender: 'assistant',
                    id: 'live_reply_1',
                    content: '收到新消息 11',
                    timestamp: Date.now()
                  }
                })
              )
              ws.send(
                encodeSocketIoEvent('message', {
                  type: 'event',
                  sessionId: 'sess_replay',
                  event: { type: 'statusUpdate', agentStatus: 'stopped' }
                })
              )
            }, 20)
          }
        }
      })
    })

    const result = await sendCueNativeMessage({
      accountId: 'acc_cue_ws_3',
      sessionId: 'sess_replay',
      text: '11',
      wsBaseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
      settleIdleMs: 500
    })

    expect(result).toEqual({
      sessionId: 'sess_replay',
      messageId: 'live_reply_1',
      reply: {
        id: 'live_reply_1',
        text: '收到新消息 11'
      }
    })
  })

  it('cancels an active turn immediately without closing the shared WebSocket', async () => {
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const port = (wss.address() as AddressInfo).port
    const connections = vi.fn()
    let turnCount = 0

    wss.on('connection', (ws) => {
      connections()
      ws.send('0{"sid":"eio_cancel"}')
      ws.on('message', (data) => {
        const packet = parseSocketIoPacket(data.toString())
        if (packet.kind === 'connect') {
          ws.send('40{"sid":"sio_cancel"}')
          return
        }
        if (packet.kind !== 'event') return
        const payload = packet.payload as { type: string; sessionId: string; content: string }
        if (payload.type !== 'user_message') return
        turnCount += 1
        ws.send(
          encodeSocketIoEvent('message', {
            type: 'event',
            sessionId: payload.sessionId,
            event: { type: 'statusUpdate', agentStatus: 'running' }
          })
        )
        if (turnCount === 2) {
          ws.send(
            encodeSocketIoEvent('message', {
              type: 'event',
              sessionId: payload.sessionId,
              event: { type: 'chat', sender: 'assistant', id: 'after_cancel', content: '第二次回复' }
            })
          )
          ws.send(
            encodeSocketIoEvent('message', {
              type: 'event',
              sessionId: payload.sessionId,
              event: { type: 'statusUpdate', agentStatus: 'stopped' }
            })
          )
        }
      })
    })

    const first = sendCueNativeMessage({
      accountId: 'acc_cancel',
      sessionId: 'sess_cancel',
      requestId: 'req_cancel_1',
      text: '长任务',
      wsBaseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 10_000
    })

    await vi.waitFor(() => expect(turnCount).toBe(1))
    const cancelled = cancelCueNativeTurn({ accountId: 'acc_cancel', sessionId: 'sess_cancel' })
    expect(cancelled).toEqual({ cancelledCount: 1, sessionIds: ['sess_cancel'] })
    await expect(first).rejects.toMatchObject({ code: 'cancelled', message: 'Cue 运行已停止' })

    const second = await sendCueNativeMessage({
      accountId: 'acc_cancel',
      sessionId: 'sess_cancel',
      text: '继续',
      wsBaseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000
    })
    expect(second.reply?.text).toBe('第二次回复')
    expect(connections).toHaveBeenCalledOnce()
  })

  it('refreshes inactivity timeout during active tool execution, captures tools/media, and forwards uploaded attachments', async () => {
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const port = (wss.address() as AddressInfo).port
    let receivedAttachments: unknown

    wss.on('connection', (ws) => {
      ws.send('0{"sid":"eio_tools"}')
      ws.on('message', (data) => {
        const packet = parseSocketIoPacket(data.toString())
        if (packet.kind === 'connect') {
          ws.send('40{"sid":"sio_tools"}')
          return
        }
        if (packet.kind !== 'event') return
        const payload = packet.payload as { type: string; sessionId: string; attachments?: unknown }
        if (payload.type !== 'user_message') return
        receivedAttachments = payload.attachments
        const emit = (event: object) =>
          ws.send(encodeSocketIoEvent('message', { type: 'event', sessionId: payload.sessionId, event }))
        emit({ type: 'statusUpdate', agentStatus: 'running' })
        setTimeout(() => emit({ type: 'toolUsed', id: 't1', tool: 'browser', title: '搜索文档', status: 'running' }), 40)
        setTimeout(() => emit({ type: 'liveStatus', title: '整理图表' }), 85)
        setTimeout(() => {
          emit({
            type: 'chat',
            sender: 'assistant',
            id: 'reply_rich',
            content: '分析完成',
            attachments: [{ id: 'img1', url: 'https://files.manuscdn.com/out.png', filename: 'out.png', mimeType: 'image/png' }]
          })
          emit({ type: 'statusUpdate', agentStatus: 'stopped' })
        }, 135)
      })
    })

    const uploadAttachment = vi.fn(async (att) => ({
      file_id: 'file_up_1',
      filename: att.name,
      mime_type: att.mimeType,
      size: 4
    }))

    const result = await sendCueNativeMessage({
      accountId: 'acc_tools',
      sessionId: 'sess_tools',
      text: '帮我分析这张图',
      attachments: [
        { name: 'input.png', mimeType: 'image/png', dataBase64: Buffer.from('test').toString('base64') }
      ],
      uploadAttachment,
      wsBaseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 90,
      maxTurnMs: 2_000
    })

    expect(uploadAttachment).toHaveBeenCalledOnce()
    expect(receivedAttachments).toEqual([
      expect.objectContaining({ file_id: 'file_up_1', filename: 'input.png', mime_type: 'image/png' })
    ])
    expect(result.reply).toEqual({
      id: 'reply_rich',
      text: '分析完成',
      tools: [{ id: 't1', name: 'browser', toolType: 'browser', status: 'completed', summary: '搜索文档' }],
      media: [{ kind: 'image', path: 'https://files.manuscdn.com/out.png', name: 'out.png', mimeType: 'image/png', imageId: 'img1' }]
    })
  })

  it('delivers unsolicited background pushes for watched sessions while ignoring historical replays', async () => {
    const wss = new WebSocketServer({ port: 0 })
    servers.push(wss)
    const port = (wss.address() as AddressInfo).port
    let serverSocket: import('ws').WebSocket | undefined

    wss.on('connection', (ws) => {
      serverSocket = ws
      ws.send('0{"sid":"eio_watch"}')
      ws.on('message', (data) => {
        const packet = parseSocketIoPacket(data.toString())
        if (packet.kind === 'connect') {
          ws.send('40{"sid":"sio_watch"}')
          return
        }
        if (packet.kind === 'event') {
          const payload = packet.payload as { type: string; sessionId: string }
          if (payload.type === 'join_session') {
            ws.send(
              encodeSocketIoEvent('message', {
                type: 'event',
                sessionId: payload.sessionId,
                event: {
                  type: 'chat',
                  sender: 'assistant',
                  id: 'old_replay',
                  content: '旧记录',
                  timestamp: Date.now() - 120_000
                }
              })
            )
          }
        }
      })
    })

    await syncCueWatchedSessions(
      'acc_watch',
      [{ sessionId: 'sess_bg', agentId: 'ag_bg' }],
      { wsBaseUrl: `http://127.0.0.1:${port}` }
    )

    serverSocket!.send(
      encodeSocketIoEvent('message', {
        type: 'event',
        sessionId: 'sess_bg',
        event: {
          type: 'chat',
          sender: 'assistant',
          id: 'bg_push_1',
          content: '定时早报已生成',
          timestamp: Date.now()
        }
      })
    )

    await vi.waitFor(() =>
      expect(watchEvents).toContainEqual(
        expect.objectContaining({
          type: 'stream',
          accountId: 'acc_watch',
          sessionId: 'sess_bg',
          agentId: 'ag_bg',
          messageId: 'bg_push_1',
          text: '定时早报已生成',
          done: true
        })
      )
    )
    expect(watchEvents.some((ev) => (ev as { messageId?: string }).messageId === 'old_replay')).toBe(false)
  })
})
