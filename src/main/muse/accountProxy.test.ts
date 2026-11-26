import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAllLocalProxyBridges } from '../localProxyBridge'

const dir = mkdtempSync(join(tmpdir(), 'bothub-proxy-'))
const setProxy = vi.fn(async (_cfg: unknown) => undefined)
const closeAllConnections = vi.fn(async () => undefined)
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => encryptionAvailable,
    encryptStringAsync: async (plain: string) => Buffer.from(`ok:${plain}`, 'utf8'),
    decryptStringAsync: async (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('ok:')) throw new Error('bad key')
      return { result: s.slice(3), shouldReEncrypt: false }
    }
  },
  session: {
    fromPartition: (() => {
      const sessions = new Map<string, { setProxy: typeof setProxy; closeAllConnections: typeof closeAllConnections }>()
      return (partition: string) => {
        if (!sessions.has(partition)) sessions.set(partition, { setProxy, closeAllConnections })
        return sessions.get(partition)
      }
    })()
  }
}))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => `persist:test-${id}` }))

const {
  applyAllStoredProxies,
  applyProxyToPartition,
  assignProxyPoolToAccounts,
  buildAccountProxyUrl,
  importProxyPool,
  listProxyPool,
  loadProxyConfig,
  parseProxyLine,
  ProxyConfigUnreadableError,
  releaseProxyPoolAccount,
  saveProxyConfig,
  testAccountProxy,
  testProxyPoolItems
} = await import('./accountProxy')

afterAll(async () => {
  await closeAllLocalProxyBridges()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  setProxy.mockClear()
  closeAllConnections.mockClear()
  encryptionAvailable = true
  writeFileSync(join(dir, 'muse-account-proxy.json'), JSON.stringify({ acc1: { enc: 'AAAA' } }))
  writeFileSync(join(dir, 'muse-proxy-pool.json'), '[]')
})

describe('account proxy fails closed', () => {
  it('does not close active connections on repeated or concurrent proxy preparation', async () => {
    const accountId = 'concurrent-hark-requests'
    await Promise.all([applyProxyToPartition(accountId), applyProxyToPartition(accountId)])
    expect(setProxy).toHaveBeenCalledTimes(1)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)

    await applyProxyToPartition(accountId)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)

    await applyProxyToPartition(accountId, { mode: 'socks5', host: '127.0.0.1', port: 1080 })
    expect(setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ proxyRules: 'socks5://127.0.0.1:1080' }))
    expect(closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('does not report direct when a stored proxy cannot be decrypted', async () => {
    await expect(loadProxyConfig('acc1')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    encryptionAvailable = false
    await expect(loadProxyConfig('acc1')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
  })

  it('blocks the partition instead of going direct', async () => {
    await expect(applyProxyToPartition('acc1')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    expect(setProxy).toHaveBeenCalledWith(expect.objectContaining({ proxyRules: 'http://127.0.0.1:9' }))
  })

  it('accounts without a proxy use system network stack', async () => {
    await expect(loadProxyConfig('nobody')).resolves.toEqual({ mode: 'direct' })
    await applyProxyToPartition('nobody')
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('applies every stored account at startup without throwing', async () => {
    const log = vi.fn()
    await applyAllStoredProxies(log)
    expect(setProxy.mock.calls.length).toBeGreaterThanOrEqual(1)
    for (const [cfg] of setProxy.mock.calls) expect(cfg).toMatchObject({ proxyRules: 'http://127.0.0.1:9' })
    expect(log).toHaveBeenCalledOnce()
  })
})

describe('HTTPS and authenticated proxy support', () => {
  it('preserves https:// scheme in parseProxyLine and buildAccountProxyUrl instead of turning it into http', () => {
    expect(parseProxyLine('https://alice:s3cr3t@proxy.example.com:8443')).toEqual({
      mode: 'https',
      host: 'proxy.example.com',
      port: 8443,
      username: 'alice',
      password: 's3cr3t'
    })
    expect(parseProxyLine('https://proxy.example.com')).toEqual({
      mode: 'https',
      host: 'proxy.example.com',
      port: 443,
      username: undefined,
      password: undefined
    })
    expect(parseProxyLine('https://gate.provider.com:7000:user1:pass:word')).toEqual({
      mode: 'https',
      host: 'gate.provider.com',
      port: 7000,
      username: 'user1',
      password: 'pass:word'
    })
    expect(parseProxyLine('user:p@ss%99@1.2.3.4:1080', 'socks5')).toEqual({
      mode: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'user',
      password: 'p@ss%99'
    })
    expect(
      buildAccountProxyUrl({
        mode: 'https',
        host: 'proxy.example.com',
        port: 8443,
        username: 'alice',
        password: 'p@ss'
      })
    ).toBe('https://alice:p%40ss@proxy.example.com:8443')
  })

  it('auto-upgrades mode to https when a full https:// URL is saved via host field', async () => {
    const view = await saveProxyConfig('acc_https', {
      mode: 'http',
      host: 'https://u1:p1@tls-proxy.example.com:8443'
    })
    expect(view).toEqual({
      mode: 'https',
      host: 'tls-proxy.example.com',
      port: 8443,
      username: 'u1',
      hasPassword: true
    })
    // Chromium partition gets a loopback bridge URL rather than raw credentials or plain http
    expect(setProxy).toHaveBeenCalledWith({
      proxyRules: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      proxyBypassRules: '<local>'
    })
    expect(closeAllConnections).toHaveBeenCalled()
  })

  it('maps unauthenticated socks5h to socks5:// for Chromium proxyRules', async () => {
    await applyProxyToPartition('acc_s5h', {
      mode: 'socks5h',
      host: '127.0.0.1',
      port: 1080
    })
    expect(setProxy).toHaveBeenCalledWith({
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: '<local>'
    })
  })
})

describe('saved credentials and pool ownership', () => {
  const original = { mode: 'http', host: 'proxy.example.com', port: 8080, username: 'alice', password: 'saved' } as const

  it('keeps a blank password only for the same normalized proxy identity', async () => {
    await saveProxyConfig('credentials', original)
    await expect(saveProxyConfig('credentials', {
      mode: 'socks5', host: ' HTTP://alice@PROXY.EXAMPLE.COM:8080 ', password: ''
    })).resolves.toMatchObject({ hasPassword: true })

    for (const change of [
      { mode: 'socks5' } as const, { host: 'other.example.com' }, { port: 8081 }, { username: 'bob' }, { username: '' }
    ]) {
      await saveProxyConfig('credentials', original)
      const view = await saveProxyConfig('credentials', { ...original, ...change, password: '' })
      expect(view.hasPassword).toBe(false)
      expect((await loadProxyConfig('credentials')).password).toBeUndefined()
    }
  })

  it('serializes release and reassignment through partition setup', async () => {
    await importProxyPool('http://proxy.example.com:8080')
    await assignProxyPoolToAccounts(['pool-owner'])
    let finishRelease!: () => void
    let enteredRelease!: () => void
    const entered = new Promise<void>((resolve) => { enteredRelease = resolve })
    setProxy.mockImplementationOnce(async () => {
      enteredRelease()
      await new Promise<void>((resolve) => { finishRelease = resolve })
    })
    const release = releaseProxyPoolAccount('pool-owner')
    await entered
    const reassign = assignProxyPoolToAccounts(['pool-owner'])
    finishRelease()
    await Promise.all([release, reassign])
    expect(await listProxyPool()).toMatchObject([{ assignedAccountId: 'pool-owner' }])
    expect(await loadProxyConfig('pool-owner')).toMatchObject({ host: 'proxy.example.com', port: 8080 })
    expect(setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ proxyRules: 'http://proxy.example.com:8080' }))
  })

  it('releases a pool slot without deleting a newer manually saved configuration', async () => {
    await importProxyPool('http://proxy.example.com:8080')
    await assignProxyPoolToAccounts(['pool-manual'])
    await saveProxyConfig('pool-manual', { mode: 'http', host: 'manual.example.com', port: 9999 })
    await releaseProxyPoolAccount('pool-manual')
    expect((await listProxyPool())[0]?.assignedAccountId).toBeUndefined()
    expect(await loadProxyConfig('pool-manual')).toMatchObject({ host: 'manual.example.com', port: 9999 })
  })

  it('tests account proxy drafts reusing saved encrypted password and fails closed on unreadable config', async () => {
    await saveProxyConfig('probe-acc', {
      mode: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'alice',
      password: 'saved-secret'
    })
    const seenProxyUrls: Array<string | undefined> = []
    const fetchImpl = vi.fn(async (proxyUrl: string | undefined) => {
      seenProxyUrls.push(proxyUrl)
      return new Response('ip=198.51.100.9\nloc=SG\n', { status: 200 })
    })

    const draftResult = await testAccountProxy(
      'probe-acc',
      { mode: 'http', host: 'proxy.example.com', port: 8080, username: 'alice', password: '' },
      { probeUrls: ['https://www.cloudflare.com/cdn-cgi/trace'], fetchImpl }
    )
    expect(draftResult.ok).toBe(true)
    expect(draftResult.country).toBe('SG')
    expect(draftResult.exitIp).toBe('198.51.100.9')
    expect(seenProxyUrls).toEqual(['http://alice:saved-secret@proxy.example.com:8080'])

    // Unreadable stored proxy fails closed cleanly in testAccountProxy.
    const unreadable = await testAccountProxy('acc1', undefined, { fetchImpl })
    expect(unreadable.ok).toBe(false)
    expect(unreadable.error).toContain('代理配置无法读取')

    // Batch pool probe tests all pool entries with decrypted credentials.
    const imported = await importProxyPool('socks5://u:p@10.0.0.1:1080\nhttp://10.0.0.2:7890')
    const poolRes = await testProxyPoolItems(undefined, {
      probeUrls: ['https://www.cloudflare.com/cdn-cgi/trace'],
      fetchImpl
    })
    expect(Object.keys(poolRes)).toEqual(imported.items.map((i) => i.id))
    expect(Object.values(poolRes).every((r) => r.ok)).toBe(true)
    expect(seenProxyUrls).toContain('socks5://u:p@10.0.0.1:1080')
    expect(seenProxyUrls).toContain('http://10.0.0.2:7890')
  })
})
