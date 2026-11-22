/**
 * Stable per-account deviceId (`x-client-id`) for Cue by Manus (`cue.im` / `api.manus.im`).
 * Persisted under `userData/cue-device-ids.json` via atomic JSON writes.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'

type DeviceIdStore = Record<string, string>

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storePath(): string {
  return join(app.getPath('userData'), 'cue-device-ids.json')
}

function readStore(): DeviceIdStore {
  const raw = readJsonFile<Record<string, unknown>>(
    storePath(),
    {},
    (r) => Boolean(r) && typeof r === 'object' && !Array.isArray(r)
  )
  const out: DeviceIdStore = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && UUID_V4_RE.test(v.trim())) {
      out[k] = v.trim()
    }
  }
  return out
}

function writeStore(store: DeviceIdStore): void {
  writeJsonAtomic(storePath(), store)
}

/** Return existing UUIDv4 for accountId or create + persist one. */
export function getOrCreateCueDeviceId(accountId: string): string {
  const store = readStore()
  const existing = store[accountId]
  if (existing && UUID_V4_RE.test(existing)) return existing
  const id = randomUUID()
  store[accountId] = id
  writeStore(store)
  return id
}

export function peekCueDeviceId(accountId: string): string | undefined {
  try {
    return readStore()[accountId]
  } catch {
    return undefined
  }
}

export function resetCueDeviceId(accountId: string): string {
  const store = readStore()
  const id = randomUUID()
  store[accountId] = id
  writeStore(store)
  return id
}

export const getOrCreateCueMachineId = getOrCreateCueDeviceId
export const peekCueMachineId = peekCueDeviceId
