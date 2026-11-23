import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const { watchEvents, loadCueTokens } = vi.hoisted(() => ({
  watchEvents: [] as unknown[],
  loadCueTokens: vi.fn(async (accountId: string) => ({
    accountId,
    accessToken: 'jwt_cue_socket_test',
    deviceId: 'dev_socket_1',
    authKind: 'session' as const,
    accountFingerprint: 'fp_1'
  }))
}))

vi.mock('./cueAuth', () => ({
  CUE_CONNECT_BASE: 'https://api.manus.im',
  CUE_ORIGIN: 'https://cue.im',
  loadCueTokens
}))
vi.mock('./cueDeviceId', () => ({
  getOrCreateCueDeviceId: () => 'dev_socket_1'
}))
vi.mock('../muse/accountProxy', () => ({
  createProxyAgent: vi.fn(async () => undefined)
}))
vi.mock('./cueWatchManager', () => ({
  emitCueWatchEvent: (ev: unknown) => watchEvents.push(ev)
}))

import {
  buildCueSocketUrl,
  createCueEventId,
  encodeSocketIoEvent,
  parseSocketIoPacket,
  sendCueNativeMessage,
  stopCueChatSocket
} from './cueChatSocket'

describe('Cue native Engine.IO / Socket.IO chat client', () => {
  const servers: WebSocketServer[] = []

  afterEach(async () => {
    stopCueChatSocket('*')
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
})
