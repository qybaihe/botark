import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { buildPairingUri, parsePairingUri, type MobileRelayCommand, type MobileSendCommand } from '@shared/mobileSync'
import {
  decryptAesGcmCombined,
  encryptAesGcmCombined,
  fingerprintFromKey,
  generateAes256KeyBase64Url
} from './mobileSyncCrypto'
import { MobileSyncServer } from './mobileSyncServer'

describe('mobileSyncCrypto & Pairing URI', () => {
  it('round-trips AES-256-GCM combined base64 matching Apple CryptoKit SealedBox(combined:)', () => {
    const key = generateAes256KeyBase64Url()
    const payload = JSON.stringify({ hello: 'BotArk iOS', apiKey: 'sk-hermes-123' })
    const encrypted = encryptAesGcmCombined(payload, key)
    expect(decryptAesGcmCombined(encrypted, key)).toBe(payload)
  })

  it('produces deterministic known test vector verifiable in Swift CryptoKit', () => {
    const fixedKey = Buffer.alloc(32, 0x42).toString('base64url')
    const fixedIv = Buffer.alloc(12, 0x11)
    const encrypted = encryptAesGcmCombined('BotArk-Zero-Server-2026', fixedKey, fixedIv)
    expect(decryptAesGcmCombined(encrypted, fixedKey)).toBe('BotArk-Zero-Server-2026')
    expect(Buffer.from(encrypted, 'base64').length).toBe(12 + Buffer.byteLength('BotArk-Zero-Server-2026') + 16)
  })

  it('builds and parses botark://pair URIs cleanly', () => {
    const key = generateAes256KeyBase64Url()
    const uri = buildPairingUri({
      version: 1,
      hosts: ['192.168.1.25', '100.64.0.12'],
      port: 19472,
      token: 'tok_abc',
      key,
      name: 'MacBook-Pro',
      fp: fingerprintFromKey(key)
    })
    const parsed = parsePairingUri(uri)
    expect(parsed).toMatchObject({
      version: 1,
      hosts: ['192.168.1.25', '100.64.0.12'],
      port: 19472,
      token: 'tok_abc',
      key,
      name: 'MacBook-Pro'
    })
    expect(parsePairingUri('https://evil.example/pair')).toBeNull()
  })
})

describe('MobileSyncServer zero-server LAN bridge', () => {
  it('pairs via QR token, decrypts direct Hermes creds, streams WS deltas, relays commands, and revokes devices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botark-msync-'))
    const commands: MobileRelayCommand[] = []
    const sends: MobileSendCommand[] = []
    let markEntered!: () => void
    let allowAck!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const acknowledge = new Promise<void>((resolve) => { allowAck = resolve })
    const srv = new MobileSyncServer({
      storePath: join(dir, 'devices.json'),
      defaultPort: 0,
      hostName: 'Test-Mac',
      getDirectCredentials: () => [
        {
          accountId: 'acc_h1',
          baseUrl: 'http://127.0.0.1:8642',
          apiKey: 'hermes-secret-999',
          model: 'hermes-agent',
          displayName: 'Hermes Local'
        }
      ],
      onCommand: (cmd) => commands.push(cmd),
      onSendMessage: async (cmd) => {
        if (cmd.botId !== 'bot_1') return { ok: false, status: 404, message: 'Bot not found' }
        if (cmd.clientMessageId === 'client-1') {
          markEntered()
          await acknowledge
        }
        sends.push(cmd)
        return { ok: true, messageId: cmd.clientMessageId }
      }
    })

    try {
      const started = await srv.start()
      expect(started.running).toBe(true)
      expect(started.port).toBeGreaterThan(0)
      expect(started.pairUri).toBeTruthy()
      const parsedUri = parsePairingUri(started.pairUri!)!
      const base = `http://127.0.0.1:${started.port}`

      // 1. Ping succeeds unauthenticated
      const ping = await fetch(`${base}/api/mobile/v1/ping`).then((r) => r.json() as Promise<Record<string, unknown>>)
      expect(ping['ok']).toBe(true)
      expect(ping['hostName']).toBe('Test-Mac')

      // 2. Push snapshot from Desktop
      srv.updateSnapshot({
        version: 1,
        updatedAtMs: Date.now(),
        hostName: 'Test-Mac',
        selectedBotId: 'bot_1',
        groups: [{ id: 'g1', name: 'Work', collapsed: false }],
        bots: [
          {
            id: 'bot_1',
            platformId: 'hermes',
            name: 'Hermes Local',
            groupId: 'g1',
            activeAccountId: 'acc_h1',
            lastActivityAt: Date.now()
          }
        ],
        accounts: {
          acc_h1: {
            id: 'acc_h1',
            platformId: 'hermes',
            displayName: 'Hermes Local',
            handle: '127.0.0.1:8642',
            status: 'online'
          }
        },
        messages: {
          bot_1: [
            {
              id: 'm1',
              botId: 'bot_1',
              accountId: 'acc_h1',
              role: 'bot',
              text: 'Ready on iPhone!',
              createdAt: Date.now()
            }
          ]
        },
        approvals: {}
      })

      // 3. Wrong pair token returns 401
      const badPair = await fetch(`${base}/api/mobile/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairToken: 'wrong', deviceName: 'iPhone' })
      })
      expect(badPair.status).toBe(401)

      // 4. Valid pair token returns deviceToken, snapshot, and AES-256-GCM encrypted Hermes credentials
      const pairRes = await fetch(`${base}/api/mobile/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairToken: parsedUri.token, deviceName: 'Timo iPhone', deviceModel: 'iPhone 15 Pro' })
      })
      expect(pairRes.status).toBe(200)
      const pairJson = (await pairRes.json()) as {
        ok: boolean
        deviceId: string
        deviceToken: string
        snapshot: { bots: Array<{ id: string }> }
        directCredentialsEnc?: string
      }
      expect(pairJson.ok).toBe(true)
      expect(pairJson.snapshot.bots[0]?.id).toBe('bot_1')
      expect(pairJson.directCredentialsEnc).toBeTruthy()
      const decryptedCreds = JSON.parse(decryptAesGcmCombined(pairJson.directCredentialsEnc!, parsedUri.key)) as Array<{
        apiKey: string
      }>
      expect(decryptedCreds[0]?.apiKey).toBe('hermes-secret-999')

      // 5. Replaying same single-use pair token fails (token auto-rotated!)
      const replay = await fetch(`${base}/api/mobile/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairToken: parsedUri.token, deviceName: 'Attacker' })
      })
      expect(replay.status).toBe(401)

      // 6. Connect authenticated WebSocket and receive initial snapshot + live message_delta
      const ws = new WebSocket(`ws://127.0.0.1:${started.port}/api/mobile/v1/ws?token=${encodeURIComponent(pairJson.deviceToken)}`)
      const received: Array<Record<string, unknown>> = []
      await new Promise<void>((resolve, reject) => {
        ws.once('error', reject)
        ws.on('message', (data) => {
          received.push(JSON.parse(String(data)) as Record<string, unknown>)
          if (received.length === 1) {
            srv.broadcastLiveEvent({
              type: 'message_delta',
              botId: 'bot_1',
              accountId: 'acc_h1',
              messageId: 'm_stream_1',
              text: 'Streaming to iPhone…'
            })
          } else if (received.length >= 2) {
            resolve()
          }
        })
      })
      expect(received[0]?.['type']).toBe('snapshot')
      expect(received[1]).toMatchObject({
        type: 'message_delta',
        botId: 'bot_1',
        text: 'Streaming to iPhone…'
      })

      // 7. Both companion apps use the same authenticated command routes.
      const postCommand = (path: string, body?: Record<string, string>) =>
        fetch(`${base}/api/mobile/v1/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pairJson.deviceToken}`
          },
          body: body && JSON.stringify(body)
        })
      let completed = false
      const sending = postCommand('bots/bot_1/send', { text: ' Hello! ', clientMessageId: 'client-1' })
        .then((response) => { completed = true; return response })
      await entered
      const retry = postCommand('bots/bot_1/send', { text: 'Hello!', clientMessageId: 'client-1' })
      try {
        expect(completed).toBe(false)
        expect((await postCommand('bots/bot_1/send', { text: 'Different', clientMessageId: 'client-1' })).status).toBe(409)
      } finally {
        allowAck()
      }
      const sendResponse = await sending
      expect(sendResponse.status).toBe(200)
      expect(await sendResponse.json()).toMatchObject({ ok: true, messageId: 'client-1' })
      expect(await (await retry).json()).toMatchObject({ ok: true, messageId: 'client-1' })
      expect(sends).toEqual([{ botId: 'bot_1', text: 'Hello!', clientMessageId: 'client-1' }])
      expect((await postCommand('bots/missing/send', { text: 'Hi', clientMessageId: 'client-2' })).status).toBe(404)
      expect((await postCommand('bots/bot_1/send', { text: 'Hi', clientMessageId: 'not valid' })).status).toBe(400)
      expect((await postCommand('bots/bot_1/send', { text: 'Older client' })).status).toBe(200)
      expect(sends[1]?.clientMessageId).toMatch(/^mobile_/)
      expect((await postCommand('bots/bot_1/stop')).status).toBe(200)
      expect((await postCommand('bots/bot_1/new-session')).status).toBe(200)
      expect((await postCommand('approvals/acc_h1/request%2Fone', {
        platformId: 'hermes',
        decision: 'allow_once'
      })).status).toBe(200)
      expect(commands).toEqual([
        { kind: 'stopGeneration', botId: 'bot_1' },
        { kind: 'newSession', botId: 'bot_1' },
        { kind: 'decideApproval', accountId: 'acc_h1', platformId: 'hermes', approvalId: 'request/one', decision: 'allow_once' }
      ])

      // 8. Export offline AirDrop encrypted bundle and verify decryption
      const bundle = srv.createOfflineEncryptedBundle()
      const outer = JSON.parse(bundle.bundleJson) as { format: string; payload: string }
      expect(outer.format).toBe('botark-sync-v1')
      const inner = JSON.parse(decryptAesGcmCombined(outer.payload, bundle.transferKey)) as {
        snapshot: { bots: Array<{ name: string }> }
        directCredentials: Array<{ apiKey: string }>
      }
      expect(inner.snapshot.bots[0]?.name).toBe('Hermes Local')
      expect(inner.directCredentials[0]?.apiKey).toBe('hermes-secret-999')

      // 9. Revoking device immediately invalidates token (401)
      srv.revokeDevice(pairJson.deviceId)
      const afterRevoke = await fetch(`${base}/api/mobile/v1/snapshot`, {
        headers: { Authorization: `Bearer ${pairJson.deviceToken}` }
      })
      expect(afterRevoke.status).toBe(401)
      ws.close()
    } finally {
      await srv.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
