import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: true,
  decryptShouldFail: false
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userDataDir
  },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      if (state.decryptShouldFail) throw new Error('keychain locked')
      const text = buf.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  }
}))

import {
  getMcpRegistryPath,
  loadMcpRegistry,
  removePersistedServer,
  savePersistedServer,
  saveScopeDirectory
} from './mcpStore'

describe('mcpStore', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await realpath(await mkdtemp(join(tmpdir(), 'mcp-store-test-')))
    state.userDataDir = join(tmpRoot, 'userdata')
    await mkdir(state.userDataDir, { recursive: true })
    state.encryptionAvailable = true
    state.decryptShouldFail = false
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('persists servers atomically with safeStorage-encrypted env/headers and zero plaintext secrets on disk', async () => {
    await savePersistedServer({
      targetScope: 'global',
      scopeId: '__global__',
      source: 'manual',
      server: {
        name: 'context7',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: { CONTEXT7_API_KEY: 'SUPER_SECRET_ENV_VALUE' },
        enabled: true,
        needsConfig: false,
        unresolvedVars: []
      }
    })

    await savePersistedServer({
      targetScope: 'scope',
      scopeId: 'room-1',
      source: 'manual',
      server: {
        name: 'remote-http',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer SECRET_BEARER_TOKEN' },
        enabled: true,
        needsConfig: false,
        unresolvedVars: []
      }
    })

    const rawDisk = await readFile(getMcpRegistryPath(), 'utf8')
    expect(rawDisk).not.toContain('SUPER_SECRET_ENV_VALUE')
    expect(rawDisk).not.toContain('SECRET_BEARER_TOKEN')
    expect(rawDisk).toContain('secretsEnc')
    expect(rawDisk).toContain('CONTEXT7_API_KEY')

    const reg = await loadMcpRegistry()
    expect(reg.persistedCount).toBe(2)
    expect(reg.globalServers.get('context7')?.config.env).toEqual({
      CONTEXT7_API_KEY: 'SUPER_SECRET_ENV_VALUE'
    })
    expect(reg.scopes.get('room-1')?.servers.get('remote-http')?.config.headers).toEqual({
      Authorization: 'Bearer SECRET_BEARER_TOKEN'
    })
  })

  it('fails closed when safeStorage is unavailable and secrets are present', async () => {
    state.encryptionAvailable = false
    await expect(
      savePersistedServer({
        targetScope: 'global',
        scopeId: '__global__',
        source: 'manual',
        server: {
          name: 'secret-srv',
          transport: 'stdio',
          command: 'node',
          env: { API_KEY: 'PLAINTEXT_MUST_NOT_HIT_DISK' },
          enabled: true,
          needsConfig: false,
          unresolvedVars: []
        }
      })
    ).rejects.toThrow(/safeStorage/)

    const reg = await loadMcpRegistry()
    expect(reg.persistedCount).toBe(0)
  })

  it('hydrates trusted directory via realpath and handles decrypt failure per-server without crashing', async () => {
    const wsDir = join(tmpRoot, 'project')
    await mkdir(wsDir)
    await saveScopeDirectory({ scopeId: 'room-2', directory: wsDir, optimizedAtMs: 1234 })
    await savePersistedServer({
      targetScope: 'scope',
      scopeId: 'room-2',
      source: 'manual',
      server: {
        name: 'srv',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { 'X-Key': 'secret' },
        enabled: true,
        needsConfig: false,
        unresolvedVars: []
      }
    })

    state.decryptShouldFail = true
    const reg = await loadMcpRegistry()
    const scoped = reg.scopes.get('room-2')
    expect(scoped?.directory).toBe(wsDir)
    expect(scoped?.trusted).toBe(true)
    const srv = scoped?.servers.get('srv')
    expect(srv?.decryptError).toMatch(/无法解密/)
    expect(srv?.config.needsConfig).toBe(true)

    await removePersistedServer({ targetScope: 'scope', scopeId: 'room-2', serverName: 'srv' })
    const afterRemove = await loadMcpRegistry()
    expect(afterRemove.scopes.get('room-2')?.servers.size).toBe(0)
  })
})
