/**
 * System-browser login hand-off for Cue (`cue.im`), using Cue's own desktop login flow.
 *
 * cue.im supports a "sign in from the desktop app" mode: open
 * `/login?from=desktop&desktopAgents=1&agentsScheme=<scheme>&nonce=<n>` in a normal browser,
 * and after a successful sign-in its `/login-success` page navigates to
 * `<scheme>://oauth/desktop-callback` with the session token and the same nonce in its query.
 *
 *
 * The page only accepts `cue` (the official Cue desktop app) and `cuedev`. BotArk registers
 * itself for `cuedev` so it never takes over the official app's `cue://` links, and accepts a
 * callback only when it carries a nonce that BotArk issued for a pending login.
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { app, shell } from 'electron'
import { decodeJwtClaims, persistCueTokens } from './cueAuth'

export const CUE_DESKTOP_SCHEME = 'cuedev'
const CUE_WEB = 'https://cue.im'
const PENDING_TTL_MS = 30 * 60 * 1000

type Pending = { accountId: string; expiresAt: number }
const pending = new Map<string, Pending>()

export type CueHandoffSignedIn = {
  accountId: string
  signedIn: true
  handle?: string
  displayName?: string
  accountSlot?: string
}

export function buildCueBrowserLoginUrl(nonce: string, scheme = CUE_DESKTOP_SCHEME): string {
  const flow = new URLSearchParams({ desktopAgents: '1', agentsScheme: scheme, nonce })
  const params = new URLSearchParams({
    from: 'desktop',
    desktopAgents: '1',
    agentsScheme: scheme,
    nonce,
    redirectUrl: `${CUE_WEB}/login-success?${flow.toString()}`
  })
  return `${CUE_WEB}/login?${params.toString()}`
}

export function parseCueDesktopCallback(
  raw: string,
  scheme = CUE_DESKTOP_SCHEME
): { token: string; nonce: string } | null {
  if (typeof raw !== 'string' || !raw.toLowerCase().startsWith(`${scheme}://`)) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== `${scheme}:`) return null
    const route = `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase()
    if (route !== 'oauth/desktop-callback') return null
    const token = url.searchParams.get('token')?.trim() ?? ''
    const nonce = url.searchParams.get('nonce')?.trim() ?? ''
    if (!token || !nonce || /\s/.test(token)) return null
    return { token, nonce }
  } catch {
    return null
  }
}

/** Remember a pending browser login and return its one-time nonce. */
export function issueCueLoginNonce(accountId: string, now = Date.now()): string {
  for (const [key, value] of pending) {
    if (value.expiresAt <= now || value.accountId === accountId) pending.delete(key)
  }
  const nonce = randomBytes(16).toString('hex')
  pending.set(nonce, { accountId, expiresAt: now + PENDING_TTL_MS })
  return nonce
}

/** Consume a nonce once; returns the account it was issued for, or null if unknown/expired. */
export function consumeCueLoginNonce(nonce: string, now = Date.now()): string | null {
  const entry = pending.get(nonce)
  if (!entry) return null
  pending.delete(nonce)
  return entry.expiresAt > now ? entry.accountId : null
}

export function findCueCallbackArg(argv: readonly string[] | undefined): string | undefined {
  return argv?.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${CUE_DESKTOP_SCHEME}://`))
}

function ensureProtocolRegistered(): void {
  try {
    if (app.isDefaultProtocolClient?.(CUE_DESKTOP_SCHEME)) return
    if (process.defaultApp && process.argv.length >= 2 && process.argv[1]) {
      app.setAsDefaultProtocolClient(CUE_DESKTOP_SCHEME, process.execPath, [resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(CUE_DESKTOP_SCHEME)
    }
  } catch (err) {
    console.warn('[cue] could not register desktop callback scheme', err instanceof Error ? err.message : err)
  }
}

/** Open cue.im in the user's default browser; the session comes back through `cuedev://`. */
export async function startCueBrowserLogin(accountId: string): Promise<void> {
  ensureProtocolRegistered()
  const nonce = issueCueLoginNonce(accountId)
  await shell.openExternal(buildCueBrowserLoginUrl(nonce))
}

let signedInListener: ((event: CueHandoffSignedIn) => void) | undefined

export function onCueHandoffSignedIn(listener: (event: CueHandoffSignedIn) => void): void {
  signedInListener = listener
}

/** Handle a `cuedev://oauth/desktop-callback` URL. Returns true when it signed an account in. */
export async function handleCueDesktopCallbackUrl(raw: string): Promise<boolean> {
  const parsed = parseCueDesktopCallback(raw)
  if (!parsed) return false
  const accountId = consumeCueLoginNonce(parsed.nonce)
  if (!accountId) {
    console.warn('[cue] ignored a desktop callback with an unknown or expired login request')
    return false
  }
  const claims = decodeJwtClaims(parsed.token)
  const auth = await persistCueTokens(accountId, {
    accessToken: parsed.token,
    cookieHeader: `cue_session_id=${parsed.token}`,
    cookieNames: ['cue_session_id'],
    cookies: [
      { name: 'cue_session_id', value: parsed.token, domain: '.cue.im', path: '/' },
      { name: 'session_id', value: parsed.token, domain: '.manus.im', path: '/' }
    ],
    handle: claims.handle,
    displayName: claims.displayName,
    accountSlot: claims.handle,
    expiresAtMs: claims.expiresAtMs,
    authKind: 'session'
  })
  signedInListener?.({
    accountId,
    signedIn: true,
    handle: auth.handle,
    displayName: auth.displayName,
    accountSlot: auth.accountSlot
  })
  return true
}
