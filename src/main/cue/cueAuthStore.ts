import { createHash } from 'node:crypto'

export type CueAuthKind = 'oauth' | 'api-key' | 'session' | 'mock'

export interface CueMainAuth {
  accountId: string
  accessToken?: string
  refreshToken?: string
  apiKey?: string
  cookieHeader?: string
  cookieNames?: string[]
  accountSlot?: string
  handle?: string
  displayName?: string
  baseUrl?: string
  deviceId: string
  authKind: CueAuthKind
  expiresAtMs?: number
  accountFingerprint: string
}

const byAccount = new Map<string, CueMainAuth>()

export function computeCueAccountFingerprint(input: {
  accountId: string
  accessToken?: string
  apiKey?: string
  cookieHeader?: string
  handle?: string
}): string {
  const material = [
    input.accountId,
    input.accessToken ?? '',
    input.apiKey ?? '',
    input.cookieHeader ?? '',
    input.handle ?? ''
  ].join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 24)
}

export function setCueMainAuth(auth: CueMainAuth): void {
  byAccount.set(auth.accountId, auth)
}

export function getCueMainAuth(accountId: string): CueMainAuth | undefined {
  return byAccount.get(accountId)
}

export function clearCueMainAuth(accountId?: string): void {
  if (!accountId || accountId === '*') {
    byAccount.clear()
    return
  }
  byAccount.delete(accountId)
}

export function listCueMainAuth(): CueMainAuth[] {
  return [...byAccount.values()]
}
