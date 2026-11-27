import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import {
  GEMINI_BASE_URL, GEMINI_MODEL, type GeminiConfig, type GeminiDraft, type GeminiMessage,
  type GeminiModel, type GeminiSession
} from '@shared/gemini'
import { createMutex } from '@shared/proxyPool'
import { deleteVaultSecret, getVaultSecret, listVaultKeys, setVaultSecret } from '../securityVault'

const prefix = 'internal.gemini.'
const withConfigLock = createMutex()
type Credentials = GeminiConfig & { apiKey: string }
export const fallbackModels: GeminiModel[] = ['gemini-2.5-pro', GEMINI_MODEL, 'gemini-2.5-flash-lite']
  .map((id) => ({ id, label: id, thinking: true }))

function vaultKey(accountId: string) {
  if (typeof accountId !== 'string' || !/^[\w-]{1,100}$/.test(accountId)) throw new Error('Invalid Gemini account ID')
  return prefix + accountId
}

export function listAccounts() {
  return listVaultKeys(prefix).map((key) => key.slice(prefix.length))
}

export async function credentials(accountId: string): Promise<Credentials | null> {
  const key = vaultKey(accountId)
  const value = await getVaultSecret(key)
  if (!value && listVaultKeys(key).includes(key)) throw new Error('无法解密 Gemini 凭据')
  return value ? JSON.parse(value) : null
}

export function publicConfig({ apiKey: _secret, ...config }: Credentials): GeminiConfig {
  return config
}

export function resolveDraft(current: Credentials | null, draft: GeminiDraft = {}): Credentials {
  const url = new URL((draft.baseUrl ?? current?.baseUrl)?.trim() || GEMINI_BASE_URL)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) throw new Error('Gemini 地址需要 HTTPS 或本机 HTTP')
  const baseUrl = url.href.replace(/\/+$/, '').replace(/\/v1beta$/, '')
  const apiKey = draft.apiKey?.trim() || current?.apiKey
  if (apiKey && /[^!-~]/.test(apiKey)) throw new Error('Invalid Gemini API key format')
  if (!apiKey || (current && baseUrl !== current.baseUrl && !draft.apiKey?.trim())) {
    throw new Error('请为此 Gemini API 地址输入 API Key')
  }
  const model = draft.model ?? current?.model ?? GEMINI_MODEL
  if (!/^[\w.-]+$/.test(model) || model === '.' || model === '..') throw new Error('Invalid Gemini model')
  const temperature = draft.temperature ?? current?.temperature
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error('Gemini temperature must be between 0 and 2')
  }
  return {
    baseUrl, apiKey, model, temperature,
    systemInstruction: draft.systemInstruction ?? current?.systemInstruction ?? '',
    enableSearchGrounding: draft.enableSearchGrounding ?? current?.enableSearchGrounding ?? false,
    showThinking: draft.showThinking ?? current?.showThinking ?? false,
    models: current?.models ?? fallbackModels
  }
}

export function configure(accountId: string, draft: GeminiDraft, verify?: (config: Credentials) => Promise<GeminiModel[]>) {
  return withConfigLock(async () => {
    const config = resolveDraft(await credentials(accountId), draft)
    if (verify && (draft.apiKey || draft.baseUrl !== undefined)) {
      config.models = await verify(config)
      if (!config.models.some((model) => model.id === config.model)) throw new Error('所选 Gemini 模型不可用')
    }
    await setVaultSecret(vaultKey(accountId), JSON.stringify(config))
    return publicConfig(config)
  })
}

export function clearAuth(accountId: string) {
  return withConfigLock(async () => {
    const keys = accountId === '*' ? listVaultKeys(prefix) : [vaultKey(accountId)]
    for (const key of keys) await deleteVaultSecret(key)
    return { signedIn: false as const }
  })
}

export interface ContentPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
}
export interface Content {
  role: 'user' | 'model'
  parts: ContentPart[]
}

let database: DatabaseSync | undefined
function historyDb() {
  if (!database) {
    const path = join(app.getPath('userData'), 'gemini-sessions.sqlite')
    const db = new DatabaseSync(path)
    try {
      if (process.platform !== 'win32') chmodSync(path, 0o600)
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL, usage TEXT
        );
        CREATE INDEX IF NOT EXISTS sessions_by_account ON sessions(account, updated);
        CREATE TABLE IF NOT EXISTS messages (
          session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, message TEXT NOT NULL, content TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session);
      `)
      database = db
    } catch (error) {
      db.close()
      throw error
    }
  }
  return database
}
export function closeHistory() {
  database?.close()
  database = undefined
}
export function createSession(accountId: string, title = 'Gemini'): GeminiSession {
  vaultKey(accountId)
  const session = { id: randomUUID(), title, updatedAt: Date.now() }
  historyDb().prepare('INSERT INTO sessions(id, account, title, updated) VALUES(?, ?, ?, ?)')
    .run(session.id, accountId, title, session.updatedAt)
  return session
}
export function listSessions(accountId: string): GeminiSession[] {
  return historyDb().prepare('SELECT id, title, updated, usage FROM sessions WHERE account = ? ORDER BY updated DESC, rowid DESC')
    .all(accountId).map((r) => ({
      id: String(r.id), title: String(r.title), updatedAt: Number(r.updated),
      ...(r.usage ? { usage: JSON.parse(String(r.usage)) } : {})
    }))
}
function requireSession(accountId: string, sessionId: string) {
  if (!historyDb().prepare('SELECT 1 FROM sessions WHERE account = ? AND id = ?').get(accountId, sessionId)) {
    throw new Error('Gemini session not found')
  }
}
export function getHistory(accountId: string, sessionId: string): GeminiMessage[] {
  requireSession(accountId, sessionId)
  return historyDb().prepare('SELECT message FROM messages WHERE session = ? ORDER BY rowid').all(sessionId)
    .map((r) => JSON.parse(String(r.message)))
}
export function getContents(accountId: string, sessionId: string): Content[] {
  requireSession(accountId, sessionId)
  return historyDb().prepare('SELECT content FROM messages WHERE session = ? ORDER BY rowid').all(sessionId)
    .map((r) => JSON.parse(String(r.content)))
}
export function renameSession(accountId: string, sessionId: string, title: string) {
  if (!title.trim()) throw new Error('Gemini session title required')
  requireSession(accountId, sessionId)
  historyDb().prepare('UPDATE sessions SET title = ? WHERE account = ? AND id = ?').run(title.trim(), accountId, sessionId)
}
export function clearHistory(accountId: string) {
  if (accountId === '*') historyDb().exec('DELETE FROM sessions')
  else historyDb().prepare('DELETE FROM sessions WHERE account = ?').run(accountId)
}
export function deleteSession(accountId: string, sessionId: string) {
  historyDb().prepare('DELETE FROM sessions WHERE account = ? AND id = ?').run(accountId, sessionId)
}
/** Commit the pair together. Aborted and truncated turns never enter the next request. */
export function appendTurn(accountId: string, sessionId: string, turn: { message: GeminiMessage; content: Content }[]) {
  requireSession(accountId, sessionId)
  const db = historyDb()
  db.exec('BEGIN')
  try {
    const insert = db.prepare('INSERT INTO messages(session, message, content) VALUES(?, ?, ?)')
    for (const { message, content } of turn) insert.run(sessionId, JSON.stringify(message), JSON.stringify(content))
    db.prepare('UPDATE sessions SET updated = ?, usage = ? WHERE id = ?')
      .run(Date.now(), JSON.stringify(turn.at(-1)?.message.usage ?? null), sessionId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
