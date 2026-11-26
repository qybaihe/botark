import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  handle: vi.fn(),
  userDataDir: ''
}))

vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: { handle: mocks.handle },
  dialog: { showMessageBox: mocks.confirm },
  app: {
    getPath: () => mocks.userDataDir,
    isReady: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('enc:')) throw new Error('invalid ciphertext')
      return s.slice(4)
    }
  }
}))

vi.mock('../hermes/hermesStore', () => ({
  getHermesAccount: () => ({ baseUrl: 'http://localhost:8080' }),
  listHermesAccountRecords: () => [],
  readLocalHermesEnv: () => ({
    baseUrl: 'http://127.0.0.1:8642',
    host: '127.0.0.1',
    port: 8642,
    hasApiKey: false
  })
}))

import {
  registerWorkspacePortalIpc,
  setWorkspacePortalIdleTimeoutMs,
  setWorkspacePortalTunnelEnabled,
  stopWorkspacePortals
} from './workspacePortal'
import { registerWorkspaceIpc, stopWorkspaces } from './hub'

const sender = { mainFrame: {} }
const win = { webContents: sender }
let root: string
let tempBase: string

async function workspaceOp(scope: string, request: Record<string, unknown>): Promise<unknown> {
  const handler = mocks.handle.mock.calls.find((call) => call[0] === 'botark:workspace')![1]
  return handler({ sender, senderFrame: sender.mainFrame }, scope, request)
}

async function bindRoot(scope: string, directory: string): Promise<void> {
  await workspaceOp(scope, { op: 'bind', directory })
}

async function portalRequest(
  request: { op: 'open' | 'close' | 'status'; scope: string },
  eventOverride?: { sender: unknown; senderFrame: unknown }
): Promise<{
  running: boolean
  root?: string
  publicUrl?: string
  entryUrl?: string
  localUrl?: string
  error?: string
}> {
  const handler = mocks.handle.mock.calls.find((call) => call[0] === 'botark:workspace-portal')![1]
  return handler(eventOverride ?? { sender, senderFrame: sender.mainFrame }, request)
}

describe('workspace portal', () => {
  beforeEach(async () => {
    mocks.handle.mockReset()
    mocks.confirm.mockReset()
    mocks.confirm.mockResolvedValue({ response: 1 })
    tempBase = await mkdtemp(join(tmpdir(), 'botark-portal-'))
    root = join(tempBase, 'ws')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'notes.txt'), 'hello portal\n', 'utf-8')
    await writeFile(join(root, '.env'), 'SECRET_TOKEN=supersecret\n', 'utf-8')
    await writeFile(join(root, '.env.example'), 'SECRET_TOKEN=changeme\n', 'utf-8')
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'config'), '[core]\n', 'utf-8')
    await mkdir(join(root, 'docs', 'nested'), { recursive: true })
    await writeFile(join(root, 'docs', 'guide.md'), '# guide\n', 'utf-8')
    await writeFile(join(root, 'docs', 'nested', 'deep.txt'), 'deep text\n', 'utf-8')
    mocks.userDataDir = tempBase
    setWorkspacePortalTunnelEnabled(false)
    setWorkspacePortalIdleTimeoutMs(15 * 60 * 1000)
    registerWorkspaceIpc(() => win as unknown as BrowserWindow)
    registerWorkspacePortalIpc(() => win as unknown as BrowserWindow)
  })

  afterEach(async () => {
    setWorkspacePortalIdleTimeoutMs(15 * 60 * 1000)
    await stopWorkspacePortals()
    await stopWorkspaces()
    await rm(tempBase, { recursive: true, force: true })
  })

  it('rejects IPC calls from non-main frames or foreign senders', async () => {
    await expect(
      portalRequest({ op: 'status', scope: 'room-1' }, { sender: {}, senderFrame: sender.mainFrame })
    ).rejects.toThrow('Desktop window required')
    await expect(
      portalRequest({ op: 'status', scope: 'room-1' }, { sender, senderFrame: {} })
    ).rejects.toThrow('Desktop window required')
  })

  it('serves workspace index, nested /browse without duplicated prefix, /search, and /raw', async () => {
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    expect(state.running).toBe(true)
    expect(state.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const tok = tokenOf(state)
    const index = await fetch(`${state.localUrl}/?token=${tok}`)
    expect(index.status).toBe(200)
    const indexText = await index.text()
    expect(indexText).toContain('notes.txt')
    expect(indexText).toContain('.env.example')
    expect(indexText).not.toContain('path=.env&')
    expect(indexText).not.toContain('.git/')

    const browse = await fetch(`${state.localUrl}/browse?path=docs&token=${tok}`)
    expect(browse.status).toBe(200)
    const browseText = await browse.text()
    expect(browseText).toContain('/raw?path=docs%2Fguide.md')
    expect(browseText).not.toContain('docs%2Fdocs%2F')

    const search = await fetch(`${state.localUrl}/search?q=deep&token=${tok}`)
    expect(search.status).toBe(200)
    const searchText = await search.text()
    expect(searchText).toContain('docs/nested/deep.txt')

    const raw = await fetch(`${state.localUrl}/raw?path=docs/guide.md&token=${tok}`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain('# guide')

    const catalog = await fetch(`${state.localUrl}/api/catalog?token=${tok}`)
    expect(catalog.status).toBe(200)
    const catalogJson = await catalog.json()
    expect(catalogJson).not.toHaveProperty('token')
  })

  it('blocks sensitive credential files and .git paths with 403', async () => {
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    const tok = tokenOf(state)

    expect((await fetch(`${state.localUrl}/raw?path=.env&token=${tok}`)).status).toBe(403)
    expect((await fetch(`${state.localUrl}/raw?path=.git/config&token=${tok}`)).status).toBe(403)
    expect((await fetch(`${state.localUrl}/browse?path=.git&token=${tok}`)).status).toBe(403)
    expect((await fetch(`${state.localUrl}/write?path=.env&token=${tok}`)).status).toBe(403)

    const writeEnv = await fetch(`${state.localUrl}/write`, {
      method: 'POST',
      body: new URLSearchParams({ path: '.env', text: 'PWNED=1', token: tok })
    })
    expect(writeEnv.status).toBe(403)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(await readFile(join(root, '.env'), 'utf-8')).toBe('SECRET_TOKEN=supersecret\n')
  })

  it('rejects requests without a valid token', async () => {
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    const res = await fetch(`${state.localUrl}/raw?path=notes.txt`)
    expect(res.status).toBe(401)
    const bad = await fetch(`${state.localUrl}/raw?path=notes.txt&token=wrong-token`)
    expect(bad.status).toBe(401)
  })

  it('asks a human before writing and applies or declines accordingly', async () => {
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    const tok = tokenOf(state)

    const okRes = await fetch(`${state.localUrl}/write`, {
      method: 'POST',
      body: new URLSearchParams({ path: 'notes.txt', text: 'changed by portal\n', token: tok })
    })
    expect(okRes.status).toBe(200)
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('changed by portal\n')

    mocks.confirm.mockResolvedValueOnce({ response: 0 })
    const denyRes = await fetch(`${state.localUrl}/write`, {
      method: 'POST',
      body: new URLSearchParams({ path: 'notes.txt', text: 'denied\n', token: tok })
    })
    expect(denyRes.status).toBe(400)
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('changed by portal\n')
  })

  it('closes the portal automatically when the workspace root changes or is unbound', async () => {
    await bindRoot('room-1', root)
    const first = await portalRequest({ op: 'open', scope: 'room-1' })
    expect(first.running).toBe(true)

    const root2 = join(tempBase, 'ws2')
    await mkdir(root2, { recursive: true })
    await writeFile(join(root2, 'second.txt'), 'from ws2\n', 'utf-8')
    await bindRoot('room-1', root2)

    // Root change listener closes the old portal immediately
    const statusAfterRebind = await portalRequest({ op: 'status', scope: 'room-1' })
    expect(statusAfterRebind.running).toBe(false)

    const second = await portalRequest({ op: 'open', scope: 'room-1' })
    expect(second.running).toBe(true)
    const raw = await fetch(`${second.localUrl}/raw?path=second.txt&token=${tokenOf(second)}`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain('from ws2')

    await workspaceOp('room-1', { op: 'unbind' })
    const statusAfterUnbind = await portalRequest({ op: 'status', scope: 'room-1' })
    expect(statusAfterUnbind.running).toBe(false)
  })

  it('auto-closes idle portals after the configured timeout', async () => {
    setWorkspacePortalIdleTimeoutMs(80)
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    expect(state.running).toBe(true)

    await new Promise((r) => setTimeout(r, 150))
    const after = await portalRequest({ op: 'status', scope: 'room-1' })
    expect(after.running).toBe(false)
  })

  it('requires explicit user consent before starting a public tunnel and never leaks 127.0.0.1', async () => {
    setWorkspacePortalTunnelEnabled(true)
    mocks.confirm.mockResolvedValueOnce({ response: 0 })
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(state.running).toBe(false)
    expect(state.entryUrl).toBeUndefined()
    expect(state.localUrl).toBeUndefined()
  })

  it('refuses to escape the bound workspace', async () => {
    await bindRoot('room-1', root)
    const state = await portalRequest({ op: 'open', scope: 'room-1' })
    const res = await fetch(
      `${state.localUrl}/raw?path=${encodeURIComponent('../outside.txt')}&token=${tokenOf(state)}`
    )
    expect(res.status).toBe(500)
  })
})

function tokenOf(state: { entryUrl?: string }): string {
  const url = new URL(state.entryUrl ?? 'http://127.0.0.1')
  return url.searchParams.get('token') ?? ''
}
