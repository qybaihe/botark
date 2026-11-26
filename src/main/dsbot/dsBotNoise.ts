/**
 * Pure `node:crypto` implementation of Fei-Craft/DS-Bot's encrypted link layer:
 * - `Noise_IK_25519_ChaChaPoly_SHA256` (initiator & responder)
 * - X25519 identity key generation and `d-<base64url(sha256(pub)[:16])>` deviceId derivation
 * - `SecureMessageCodec` (`DSBF` fragmentation for messages > 48 KiB)
 * - Pairing URI parser (`dsbot://pair?v=1&...` and web pairing links `#...`)
 *
 * Compatible wire-for-wire with `Fei-Craft/DS-Bot/link/src/*` with zero extra npm deps.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject
} from 'node:crypto'

export const DS_BOT_NOISE_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256' as const
export const DS_BOT_LINK_PROTOCOL_VERSION = 1 as const
export const DS_BOT_LINK_PATH = '/v1/link'
export const DS_BOT_DEFAULT_RELAY = `wss://relay.dsbot.app${DS_BOT_LINK_PATH}`
export const DS_BOT_MAX_CONTROL_FRAME_BYTES = 64 * 1024
export const DS_BOT_MAX_RELAY_FRAME_BYTES = 1024 * 1024
export const DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES = 48 * 1024
export const DS_BOT_MAX_SECURE_MESSAGE_BYTES = 4 * 1024 * 1024

const SECURE_FRAGMENT_MAGIC = new Uint8Array([0x44, 0x53, 0x42, 0x46]) // DSBF
const SECURE_FRAGMENT_VERSION = 1
const SECURE_FRAGMENT_HEADER_BYTES = 17
const MAX_IN_FLIGHT_SECURE_MESSAGES = 8
const EMPTY = new Uint8Array(0)
const MAX_NAME = 64

export interface DsBotKeyPair {
  publicKey: string
  privateKey: string
}

export interface DsBotPairingOffer {
  device?: 'browser'
  server: string
  hostDeviceId: string
  hostKey: string
  code: string
  name: string
}

export interface DsBotHandshakeHello {
  name?: string
  pairingCode?: string
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

export function randomBase64UrlToken(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength))
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, part) => acc + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest())
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmacSha256(ck, ikm)
  const out1 = hmacSha256(temp, Uint8Array.of(1))
  const out2 = hmacSha256(temp, concatBytes(out1, Uint8Array.of(2)))
  return [out1, out2]
}

function x25519PrivateKeyFromRaw(rawPriv: Uint8Array, rawPub: Uint8Array): KeyObject {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      d: toBase64Url(rawPriv),
      x: toBase64Url(rawPub)
    },
    format: 'jwk'
  })
}

function x25519PublicKeyFromRaw(rawPub: Uint8Array): KeyObject {
  return createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: toBase64Url(rawPub)
    },
    format: 'jwk'
  })
}

function rawX25519PairFromKeyPair(): { priv: KeyObject; privRaw: Uint8Array; pubRaw: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const privJwk = privateKey.export({ format: 'jwk' })
  const pubJwk = publicKey.export({ format: 'jwk' })
  return {
    priv: privateKey,
    privRaw: fromBase64Url(String(privJwk.d ?? '')),
    pubRaw: fromBase64Url(String(pubJwk.x ?? ''))
  }
}

function dhX25519(priv: KeyObject, remotePubRaw: Uint8Array): Uint8Array {
  const pub = x25519PublicKeyFromRaw(remotePubRaw)
  return new Uint8Array(diffieHellman({ privateKey: priv, publicKey: pub }))
}

export function generateX25519KeyPair(): DsBotKeyPair {
  const pair = rawX25519PairFromKeyPair()
  return {
    privateKey: toBase64Url(pair.privRaw),
    publicKey: toBase64Url(pair.pubRaw)
  }
}

export function deviceIdForPublicKey(publicKey: string): string {
  const key = fromBase64Url(publicKey)
  if (key.byteLength !== 32) {
    throw new Error('X25519 public key must be 32 bytes')
  }
  const digest = createHash('sha256').update(key).digest()
  return `d-${toBase64Url(new Uint8Array(digest.subarray(0, 16)))}`
}

export function createDsBotNoisePrologue(
  connectionId: string,
  hostDeviceId: string,
  clientDeviceId: string
): Uint8Array {
  for (const [label, value] of Object.entries({ connectionId, hostDeviceId, clientDeviceId })) {
    if (!value || value.includes('\0')) {
      throw new TypeError(`${label} is not safe for a Noise prologue`)
    }
  }
  return new TextEncoder().encode(
    `DS-BOT-LINK\0v=1\0connection=${connectionId}\0host=${hostDeviceId}\0client=${clientDeviceId}`
  )
}

export function encodeHandshakeHello(hello: DsBotHandshakeHello): Uint8Array {
  const clean: DsBotHandshakeHello = {}
  if (typeof hello.name === 'string') clean.name = hello.name.slice(0, MAX_NAME)
  if (typeof hello.pairingCode === 'string' && hello.pairingCode.length > 0) {
    clean.pairingCode = hello.pairingCode
  }
  return new TextEncoder().encode(JSON.stringify(clean))
}

export function decodeHandshakeHello(data: Uint8Array): DsBotHandshakeHello {
  if (data.byteLength === 0) return {}
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid DS Bot handshake hello')
  }
  const out: DsBotHandshakeHello = {}
  if (typeof parsed.name === 'string') out.name = parsed.name.slice(0, MAX_NAME)
  if (typeof parsed.pairingCode === 'string') out.pairingCode = parsed.pairingCode
  return out
}

/**
 * Parse a DS Bot pairing URI from either:
 * - Native URI: `dsbot://pair?v=1&server=...&host=...&key=...&code=...&name=...`
 * - Browser remote link: `https://<relay>/pair#v=1&server=...` or `https://<relay>/?pair=...`
 */
export function parseDsBotPairingUri(rawInput: string): DsBotPairingOffer {
  const trimmed = (rawInput ?? '').trim()
  if (!trimmed) throw new Error('请输入 DS Bot 配对链接（dsbot://pair?...）')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('DS Bot 配对链接格式无效')
  }

  let params: URLSearchParams
  if (url.protocol === 'dsbot:' && url.host === 'pair') {
    params = url.searchParams
  } else if (url.protocol === 'https:' || url.protocol === 'http:') {
    const hash = url.hash.replace(/^#/, '')
    if (hash.startsWith('dsbot://')) {
      return parseDsBotPairingUri(hash)
    }
    const hashParams = new URLSearchParams(hash)
    const nested = hashParams.get('uri') || hashParams.get('pair') || url.searchParams.get('uri') || url.searchParams.get('pair')
    if (nested && nested.startsWith('dsbot://')) {
      return parseDsBotPairingUri(nested)
    }
    params = hashParams.has('host') || hashParams.has('key') ? hashParams : url.searchParams
  } else {
    throw new Error('不是有效的 DS Bot 配对链接')
  }

  if (params.get('v') !== '1') {
    throw new Error('不支持的 DS Bot 配对链接版本（需要 v=1）')
  }
  const required = (name: string): string => {
    const value = params.get(name)?.trim() ?? ''
    if (!value) throw new Error(`DS Bot 配对链接缺少字段：${name}`)
    return value
  }

  let server = required('server')
  const serverUrl = new URL(server)
  if (serverUrl.protocol !== 'wss:' && serverUrl.protocol !== 'ws:') {
    throw new Error('配对链接中的中继服务器地址必须为 ws:// 或 wss://')
  }
  if (serverUrl.pathname === '/' || serverUrl.pathname === '') {
    serverUrl.pathname = DS_BOT_LINK_PATH
    server = serverUrl.toString()
  }

  const hostDeviceId = required('host')
  const hostKey = required('key')
  const code = required('code')
  const name = (params.get('name') ?? '').slice(0, MAX_NAME)
  const device = params.get('device')

  if (device !== null && device !== 'browser') {
    throw new Error('配对链接中的设备类型无效')
  }
  if (deviceIdForPublicKey(hostKey) !== hostDeviceId) {
    throw new Error('配对链接中的主机公钥与设备 ID 不匹配')
  }

  return {
    server,
    hostDeviceId,
    hostKey,
    code,
    name,
    ...(device === 'browser' ? { device: 'browser' } : {})
  }
}

/**
 * ChaCha20-Poly1305 CipherState per Noise spec §4.2:
 * 12-byte nonce = 4 zero bytes + 64-bit little-endian counter.
 */
export class ChaChaCipherState {
  private key: Uint8Array | null = null
  private n = 0
  private poisoned = false

  constructor(key?: Uint8Array) {
    if (key) this.key = new Uint8Array(key)
  }

  hasKey(): boolean {
    return this.key !== null
  }

  private nextNonce(): Buffer {
    if (this.n >= Number.MAX_SAFE_INTEGER) {
      this.poisoned = true
      throw new Error('ChaChaCipherState: nonce exhausted')
    }
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64LE(BigInt(this.n++), 4)
    return nonce
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.poisoned) throw new Error('ChaChaCipherState: poisoned')
    if (!this.key) return new Uint8Array(plaintext)
    try {
      const cipher = createCipheriv('chacha20-poly1305', this.key, this.nextNonce(), {
        authTagLength: 16
      })
      cipher.setAAD(ad, { plaintextLength: plaintext.byteLength })
      const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
      return new Uint8Array(body)
    } catch (error) {
      this.poisoned = true
      throw error
    }
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.poisoned) throw new Error('ChaChaCipherState: poisoned')
    if (!this.key) return new Uint8Array(ciphertext)
    try {
      if (ciphertext.byteLength < 16) {
        throw new Error('ChaChaCipherState: ciphertext too short')
      }
      const payload = ciphertext.subarray(0, ciphertext.byteLength - 16)
      const tag = ciphertext.subarray(ciphertext.byteLength - 16)
      const decipher = createDecipheriv('chacha20-poly1305', this.key, this.nextNonce(), {
        authTagLength: 16
      })
      decipher.setAAD(ad, { plaintextLength: payload.byteLength })
      decipher.setAuthTag(tag)
      return new Uint8Array(Buffer.concat([decipher.update(payload), decipher.final()]))
    } catch (error) {
      this.poisoned = true
      throw error
    }
  }

  destroy(): void {
    this.poisoned = true
    if (this.key) {
      this.key.fill(0)
      this.key = null
    }
  }
}

class NoiseIkSymmetricState {
  private h: Uint8Array
  private ck: Uint8Array
  private cs = new ChaChaCipherState()

  constructor(prologue: Uint8Array) {
    const nameBytes = new TextEncoder().encode(DS_BOT_NOISE_PROTOCOL)
    // Length is exactly 32 bytes; per Noise spec, <=32 is zero-padded to 32 bytes.
    if (nameBytes.byteLength <= 32) {
      const padded = new Uint8Array(32)
      padded.set(nameBytes)
      this.h = padded
    } else {
      this.h = new Uint8Array(createHash('sha256').update(nameBytes).digest())
    }
    this.ck = new Uint8Array(this.h)
    this.mixHash(prologue)
  }

  mixHash(data: Uint8Array): void {
    this.h = new Uint8Array(createHash('sha256').update(concatBytes(this.h, data)).digest())
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm)
    this.ck = ck
    this.cs = new ChaChaCipherState(k)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cs.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cs.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [ChaChaCipherState, ChaChaCipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY)
    return [new ChaChaCipherState(k1), new ChaChaCipherState(k2)]
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i]! ^ b[i]!
  return diff === 0
}

function requireRawX25519Key(base64url: string, label: string): Uint8Array {
  const bytes = fromBase64Url(base64url)
  if (bytes.byteLength !== 32) {
    throw new Error(`${label} must be a 32-byte X25519 key`)
  }
  return bytes
}

export interface DsBotNoiseIkOptions {
  role: 'initiator' | 'responder'
  localPrivateKey: string
  localPublicKey: string
  remotePublicKey?: string
  prologue: Uint8Array
}

/**
 * Noise_IK_25519_ChaChaPoly_SHA256 session.
 * Pattern:
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 */
export class DsBotNoiseIkSession {
  private readonly role: 'initiator' | 'responder'
  private readonly ss: NoiseIkSymmetricState
  private readonly sPriv: KeyObject
  private readonly sPub: Uint8Array
  private readonly expectedRemoteStatic?: Uint8Array
  private ePriv?: KeyObject
  private rePub?: Uint8Array
  private rsPub?: Uint8Array
  private sendCipher?: ChaChaCipherState
  private recvCipher?: ChaChaCipherState
  private phase: 1 | 2 | 3 = 1
  private destroyed = false

  constructor(options: DsBotNoiseIkOptions) {
    this.role = options.role
    const privRaw = requireRawX25519Key(options.localPrivateKey, 'local private key')
    const pubRaw = requireRawX25519Key(options.localPublicKey, 'local public key')
    this.sPriv = x25519PrivateKeyFromRaw(privRaw, pubRaw)
    this.sPub = pubRaw
    this.ss = new NoiseIkSymmetricState(options.prologue)

    if (options.role === 'initiator') {
      if (!options.remotePublicKey) {
        throw new Error('Noise IK initiator requires remotePublicKey')
      }
      const remoteRaw = requireRawX25519Key(options.remotePublicKey, 'remote public key')
      this.expectedRemoteStatic = remoteRaw
      this.rsPub = remoteRaw
      // Pre-message: <- s
      this.ss.mixHash(remoteRaw)
    } else {
      if (options.remotePublicKey) {
        this.expectedRemoteStatic = requireRawX25519Key(options.remotePublicKey, 'remote public key')
      }
      // Pre-message: <- s (responder's own static public key)
      this.ss.mixHash(pubRaw)
    }
  }

  get complete(): boolean {
    return this.phase === 3 && !this.destroyed
  }

  remoteStaticKey(): string | undefined {
    return this.rsPub ? toBase64Url(this.rsPub) : undefined
  }

  writeHandshake(payload: Uint8Array = EMPTY): Uint8Array {
    this.assertLive()
    if (this.role === 'initiator') {
      if (this.phase !== 1) throw new Error('Noise IK initiator writeHandshake out of order')
      const e = rawX25519PairFromKeyPair()
      this.ePriv = e.priv
      this.ss.mixHash(e.pubRaw)
      this.ss.mixKey(dhX25519(e.priv, this.rsPub!)) // es
      const encS = this.ss.encryptAndHash(this.sPub) // s
      this.ss.mixKey(dhX25519(this.sPriv, this.rsPub!)) // ss
      const encPayload = this.ss.encryptAndHash(payload)
      this.phase = 2
      return concatBytes(e.pubRaw, encS, encPayload)
    }

    if (this.phase !== 2 || !this.rePub || !this.rsPub) {
      throw new Error('Noise IK responder writeHandshake out of order')
    }
    const e = rawX25519PairFromKeyPair()
    this.ePriv = e.priv
    this.ss.mixHash(e.pubRaw)
    this.ss.mixKey(dhX25519(e.priv, this.rePub)) // ee
    this.ss.mixKey(dhX25519(e.priv, this.rsPub)) // se
    const encPayload = this.ss.encryptAndHash(payload)
    const [k1, k2] = this.ss.split()
    this.recvCipher = k1
    this.sendCipher = k2
    this.phase = 3
    return concatBytes(e.pubRaw, encPayload)
  }

  readHandshake(message: Uint8Array): Uint8Array {
    this.assertLive()
    if (this.role === 'responder') {
      if (this.phase !== 1) throw new Error('Noise IK responder readHandshake out of order')
      if (message.byteLength < 96) {
        throw new Error(`Noise IK message 1 too short (${message.byteLength})`)
      }
      const re = message.slice(0, 32)
      this.rePub = re
      this.ss.mixHash(re)
      this.ss.mixKey(dhX25519(this.sPriv, re)) // es
      const rs = this.ss.decryptAndHash(message.subarray(32, 80)) // s (32 + 16 tag)
      if (this.expectedRemoteStatic && !constantTimeEqual(rs, this.expectedRemoteStatic)) {
        this.destroy()
        throw new Error('Peer static key does not match expected key')
      }
      this.rsPub = rs
      this.ss.mixKey(dhX25519(this.sPriv, rs)) // ss
      const payload = this.ss.decryptAndHash(message.subarray(80))
      this.phase = 2
      return payload
    }

    if (this.phase !== 2 || !this.ePriv) {
      throw new Error('Noise IK initiator readHandshake out of order')
    }
    if (message.byteLength < 48) {
      throw new Error(`Noise IK message 2 too short (${message.byteLength})`)
    }
    const re = message.slice(0, 32)
    this.rePub = re
    this.ss.mixHash(re)
    this.ss.mixKey(dhX25519(this.ePriv, re)) // ee
    this.ss.mixKey(dhX25519(this.sPriv, re)) // se
    const payload = this.ss.decryptAndHash(message.subarray(32))
    const [k1, k2] = this.ss.split()
    this.sendCipher = k1
    this.recvCipher = k2
    this.phase = 3
    return payload
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    this.assertLive()
    if (!this.sendCipher || this.phase !== 3) {
      throw new Error('Noise IK session is not ready for transport')
    }
    return this.sendCipher.encryptWithAd(EMPTY, plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    this.assertLive()
    if (!this.recvCipher || this.phase !== 3) {
      throw new Error('Noise IK session is not ready for transport')
    }
    return this.recvCipher.decryptWithAd(EMPTY, ciphertext)
  }

  destroy(): void {
    this.destroyed = true
    this.sendCipher?.destroy()
    this.recvCipher?.destroy()
    this.sendCipher = undefined
    this.recvCipher = undefined
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error('Noise IK session is destroyed')
  }
}

interface FragmentAssembly {
  total: number
  totalBytes: number
  receivedBytes: number
  chunks: Uint8Array[]
}

/**
 * Wire-compatible fragmentation codec matching `Fei-Craft/DS-Bot/link/src/frames.ts`.
 */
export class DsBotSecureMessageCodec {
  private nextMessageId = 1
  private readonly assemblies = new Map<number, FragmentAssembly>()

  encode(message: Uint8Array): Uint8Array[] {
    if (message.byteLength > DS_BOT_MAX_SECURE_MESSAGE_BYTES) {
      throw new Error('Secure message exceeds the 4 MiB reassembly limit')
    }
    if (message.byteLength <= DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES) return [message]

    const messageId = this.nextMessageId
    this.nextMessageId = messageId === 0xffff_ffff ? 1 : messageId + 1
    const total = Math.ceil(message.byteLength / DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES)
    const frames: Uint8Array[] = []
    for (let index = 0; index < total; index += 1) {
      const start = index * DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES
      const chunk = message.subarray(
        start,
        Math.min(message.byteLength, start + DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES)
      )
      const frame = new Uint8Array(SECURE_FRAGMENT_HEADER_BYTES + chunk.byteLength)
      frame.set(SECURE_FRAGMENT_MAGIC)
      frame[4] = SECURE_FRAGMENT_VERSION
      const view = new DataView(frame.buffer)
      view.setUint32(5, messageId)
      view.setUint16(9, index)
      view.setUint16(11, total)
      view.setUint32(13, message.byteLength)
      frame.set(chunk, SECURE_FRAGMENT_HEADER_BYTES)
      frames.push(frame)
    }
    return frames
  }

  decode(frame: Uint8Array): Uint8Array | undefined {
    if (!isSecureFragment(frame)) return frame
    if (frame.byteLength < SECURE_FRAGMENT_HEADER_BYTES || frame[4] !== SECURE_FRAGMENT_VERSION) {
      throw new Error('Invalid DSBF fragment header')
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const messageId = view.getUint32(5)
    const index = view.getUint16(9)
    const total = view.getUint16(11)
    const totalBytes = view.getUint32(13)
    if (
      messageId === 0 ||
      total < 2 ||
      index >= total ||
      totalBytes <= DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES ||
      totalBytes > DS_BOT_MAX_SECURE_MESSAGE_BYTES ||
      total !== Math.ceil(totalBytes / DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES)
    ) {
      throw new Error('Invalid DSBF fragment metadata')
    }
    const expectedLen = Math.min(
      DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES,
      totalBytes - index * DS_BOT_SECURE_FRAGMENT_CHUNK_BYTES
    )
    const chunk = frame.subarray(SECURE_FRAGMENT_HEADER_BYTES)
    if (chunk.byteLength !== expectedLen) {
      throw new Error('Invalid DSBF fragment length')
    }

    let assembly = this.assemblies.get(messageId)
    if (!assembly) {
      if (index !== 0 || this.assemblies.size >= MAX_IN_FLIGHT_SECURE_MESSAGES) {
        throw new Error('Invalid DSBF fragment sequence')
      }
      assembly = { total, totalBytes, receivedBytes: 0, chunks: [] }
      this.assemblies.set(messageId, assembly)
    }
    if (assembly.total !== total || assembly.totalBytes !== totalBytes || index !== assembly.chunks.length) {
      this.assemblies.delete(messageId)
      throw new Error('Out-of-order DSBF fragment')
    }
    assembly.chunks.push(Uint8Array.from(chunk))
    assembly.receivedBytes += chunk.byteLength
    if (assembly.chunks.length < total) return undefined
    this.assemblies.delete(messageId)
    const out = new Uint8Array(totalBytes)
    let offset = 0
    for (const part of assembly.chunks) {
      out.set(part, offset)
      offset += part.byteLength
    }
    return out
  }

  reset(): void {
    this.nextMessageId = 1
    this.assemblies.clear()
  }
}

function isSecureFragment(frame: Uint8Array): boolean {
  if (frame.byteLength < SECURE_FRAGMENT_MAGIC.byteLength) return false
  for (let i = 0; i < SECURE_FRAGMENT_MAGIC.byteLength; i += 1) {
    if (frame[i] !== SECURE_FRAGMENT_MAGIC[i]) return false
  }
  return true
}
