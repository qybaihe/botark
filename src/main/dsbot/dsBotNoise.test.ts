import { describe, expect, it } from 'vitest'
import {
  createDsBotNoisePrologue,
  decodeHandshakeHello,
  deviceIdForPublicKey,
  DS_BOT_LINK_PATH,
  DsBotNoiseIkSession,
  DsBotSecureMessageCodec,
  encodeHandshakeHello,
  generateX25519KeyPair,
  parseDsBotPairingUri
} from './dsBotNoise'
import { normalizeDsBotChannelUrl, normalizeDsBotMcpUrl } from './dsBotStore'

describe('dsBotNoise & URL normalization', () => {
  it('completes Noise_IK_25519_ChaChaPoly_SHA256 handshake and bidirectional transport encryption', () => {
    const hostKeys = generateX25519KeyPair()
    const clientKeys = generateX25519KeyPair()
    const hostDeviceId = deviceIdForPublicKey(hostKeys.publicKey)
    const clientDeviceId = deviceIdForPublicKey(clientKeys.publicKey)
    const prologue = createDsBotNoisePrologue('conn-123', hostDeviceId, clientDeviceId)

    const initiator = new DsBotNoiseIkSession({
      role: 'initiator',
      localPrivateKey: clientKeys.privateKey,
      localPublicKey: clientKeys.publicKey,
      remotePublicKey: hostKeys.publicKey,
      prologue
    })
    const responder = new DsBotNoiseIkSession({
      role: 'responder',
      localPrivateKey: hostKeys.privateKey,
      localPublicKey: hostKeys.publicKey,
      prologue
    })

    const hello = encodeHandshakeHello({ name: 'BotArk Desktop', pairingCode: 'secret-code' })
    const msg1 = initiator.writeHandshake(hello)
    const receivedHello = decodeHandshakeHello(responder.readHandshake(msg1))
    expect(receivedHello).toEqual({ name: 'BotArk Desktop', pairingCode: 'secret-code' })
    expect(responder.remoteStaticKey()).toBe(clientKeys.publicKey)

    const hostHello = encodeHandshakeHello({ name: 'MacBook-Pro' })
    const msg2 = responder.writeHandshake(hostHello)
    const receivedHostHello = decodeHandshakeHello(initiator.readHandshake(msg2))
    expect(receivedHostHello).toEqual({ name: 'MacBook-Pro' })
    expect(initiator.complete).toBe(true)
    expect(responder.complete).toBe(true)

    const c2hPlain = new TextEncoder().encode('hello from botark')
    const c2hCipher = initiator.encrypt(c2hPlain)
    expect(new TextDecoder().decode(responder.decrypt(c2hCipher))).toBe('hello from botark')

    const h2cPlain = new TextEncoder().encode('hello from ds-bot')
    const h2cCipher = responder.encrypt(h2cPlain)
    expect(new TextDecoder().decode(initiator.decrypt(h2cCipher))).toBe('hello from ds-bot')

    // Tampered ciphertext must fail authentication
    const tampered = new Uint8Array(h2cCipher)
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff
    expect(() => initiator.decrypt(tampered)).toThrow()
  })

  it('fragments and reassembles large payloads over 48 KiB using DSBF codec', () => {
    const codec = new DsBotSecureMessageCodec()
    const payload = new Uint8Array(120 * 1024)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251

    const frames = codec.encode(payload)
    expect(frames.length).toBe(3)
    expect(codec.decode(frames[0]!)).toBeUndefined()
    expect(codec.decode(frames[1]!)).toBeUndefined()
    const assembled = codec.decode(frames[2]!)
    expect(assembled).toEqual(payload)
  })

  it('parses native dsbot:// and browser #pair= pairing links and rejects mismatched keys', () => {
    const hostKeys = generateX25519KeyPair()
    const hostId = deviceIdForPublicKey(hostKeys.publicKey)
    const uri = `dsbot://pair?v=1&server=${encodeURIComponent('wss://relay.dsbot.app')}&host=${encodeURIComponent(hostId)}&key=${encodeURIComponent(hostKeys.publicKey)}&code=pair_abc&name=StudioMac`

    const offer = parseDsBotPairingUri(uri)
    expect(offer.hostDeviceId).toBe(hostId)
    expect(offer.hostKey).toBe(hostKeys.publicKey)
    expect(offer.code).toBe('pair_abc')
    expect(offer.name).toBe('StudioMac')
    expect(offer.server).toBe(`wss://relay.dsbot.app${DS_BOT_LINK_PATH}`)

    const browserLink = `https://relay.dsbot.app/#pair=${encodeURIComponent(uri)}`
    expect(parseDsBotPairingUri(browserLink)).toEqual(offer)

    const badUri = `dsbot://pair?v=1&server=${encodeURIComponent('wss://relay.dsbot.app/v1/link')}&host=d-wrong&key=${encodeURIComponent(hostKeys.publicKey)}&code=pair_abc`
    expect(() => parseDsBotPairingUri(badUri)).toThrow(/不匹配/)
  })

  it('normalizes DS Bot MCP and Channel URLs accurately', () => {
    expect(normalizeDsBotMcpUrl('')).toBe('http://127.0.0.1:8797/mcp')
    expect(normalizeDsBotMcpUrl('9001')).toBe('http://127.0.0.1:9001/mcp')
    expect(normalizeDsBotMcpUrl('https://dsbot.example.com')).toBe('https://dsbot.example.com/mcp')
    expect(normalizeDsBotMcpUrl('https://dsbot.example.com/custom/mcp/')).toBe('https://dsbot.example.com/custom/mcp')
    expect(() => normalizeDsBotMcpUrl('ftp://127.0.0.1:8797')).toThrow(/http:\/\/ 或 https:\/\//)

    expect(normalizeDsBotChannelUrl('http://192.168.1.10:13080/?token=tok_123')).toEqual({
      baseUrl: 'http://192.168.1.10:13080',
      initialToken: 'tok_123'
    })
    expect(normalizeDsBotChannelUrl('https://nas.local/dsh/api/bot')).toEqual({
      baseUrl: 'https://nas.local/dsh'
    })
  })
})
