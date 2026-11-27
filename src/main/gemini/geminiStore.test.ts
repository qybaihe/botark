import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VAULT_CHANNELS } from '@shared/ipc'
import { registerVaultIpc } from '../securityVault'
import * as store from './geminiStore'

let dir: string
let available = true
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const encrypt = vi.fn((s: string) => Buffer.from(s).map((v) => v ^ 0x45))
vi.mock('electron', () => ({
  app: { getPath: () => dir }, ipcMain: { handle: (key: string, fn: (...args: unknown[]) => unknown) => handlers.set(key, fn) },
  safeStorage: {
    isEncryptionAvailable: () => available, encryptString: (value: string) => encrypt(value),
    decryptString: (bytes: Buffer) => bytes.map((b) => b ^ 0x45).toString()
  }
}))
vi.mock('../webContentsViewManager', () => ({}))
vi.mock('../muse/accountProxy', () => ({}))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gemini-test-')); available = true })
afterEach(() => { store.closeHistory(); rmSync(dir, { recursive: true, force: true }) })

describe('Gemini account storage', () => {
  it('uses private encrypted vault entries and returns only public config', async () => {
    const config = await store.configure('account', { apiKey: 'private-api-key' })
    expect(config).toMatchObject({ model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com' })
    expect(config).not.toHaveProperty('apiKey')
    expect(encrypt).toHaveBeenCalled()
    expect(readFileSync(join(dir, 'bothub-vault.json'), 'utf8')).not.toContain('private-api-key')
    registerVaultIpc()
    await expect(handlers.get(VAULT_CHANNELS.getSecret)!(null, 'internal.gemini.account')).rejects.toThrow('Private')
    await Promise.all([store.configure('account', { showThinking: true }), store.configure('account', { temperature: 0 })])
    expect(await store.credentials('account')).toMatchObject({ apiKey: 'private-api-key', showThinking: true, temperature: 0 })
    await expect(store.configure('account', { baseUrl: 'https://other.test' })).rejects.toThrow('API Key')
    available = false
    await expect(store.configure('new', { apiKey: 'private' })).rejects.toThrow()
    expect(store.listAccounts()).toEqual(['account'])
    await store.clearAuth('*')
    expect(store.listAccounts()).toEqual([])
  })
  it('rejects unsafe endpoints and model paths', () => {
    for (const baseUrl of ['http://remote.test', 'https://user:pass@host.test', 'https://host.test?key=x']) {
      expect(() => store.resolveDraft(null, { apiKey: 'key', baseUrl })).toThrow()
    }
    expect(() => store.resolveDraft(null, { apiKey: 'key', model: '../foo' })).toThrow()
  })
})
it('persists ordered per-account sessions, wire parts and last-turn usage across restarts', () => {
  const { id } = store.createSession('first')
  store.createSession('second')
  store.appendTurn('first', id, [
    { message: { id: 'u', role: 'user', text: 'Hi', createdAt: 1 }, content: { role: 'user', parts: [{ text: 'Hi' }] } },
    { message: { id: 'm', role: 'bot', text: 'Hello', createdAt: 2, usage: { totalTokenCount: 9 } },
      content: { role: 'model', parts: [{ text: 'Hello', thoughtSignature: 'signed' }] } }
  ])
  store.renameSession('first', id, 'New title')
  store.closeHistory()
  expect(store.listSessions('first')).toEqual([expect.objectContaining({ title: 'New title', usage: { totalTokenCount: 9 } })])
  expect(store.getHistory('first', id).map((m) => m.id)).toEqual(['u', 'm'])
  expect(store.getContents('first', id)[1].parts[0].thoughtSignature).toBe('signed')
  expect(() => store.getHistory('second', id)).toThrow()
  store.deleteSession('second', id)
  store.deleteSession('first', id)
  expect(store.listSessions('first')).toEqual([])
  expect(store.listSessions('second')).toHaveLength(1)
  expect(() => store.appendTurn('first', id, [])).toThrow()
})
