/**
 * Isolated per-account BrowserWindow login for Cue by Manus (`cue.im` / `app.cue.im`).
 *
 * Enforces per-account proxy fail-closed before window creation, installs
 * domain-scoped `installGoogleOAuthHeaderGuard(ses)` (preserving Cloudflare Turnstile),
 * keeps OAuth popups in-partition with `window.opener`, auto-falls back to system
 * browser on Google block/passkey prompts, and guards `cancelCueLogin` against
 * wiping already-authenticated sessions.
 */
import { BrowserWindow, session as electronSession, shell, type WebContents } from 'electron'
import {
  buildGoogleFallbackBannerScript,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText
} from '../googleOAuthUaGuard'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import {
  decodeJwtClaims,
  hasValidCueAuth,
  looksLikeCueSessionCookie,
  persistCueTokens
} from './cueAuth'

export const CUE_LOGIN_URL = 'https://cue.im/login'

const ALLOWED_CUE_OAUTH_HOST =
  /^(?:[\w-]+\.)*(?:cue\.im|manus\.im|manus\.ai|google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|youtube\.com|apple\.com|icloud\.com|microsoft\.com|live\.com|cloudflare\.com)$/i

const loginWindows = new Map<string, BrowserWindow>()
const loginChildWindows = new Map<string, Set<BrowserWindow>>()

export type CueLoginEvent =
  | {
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
      accountSlot?: string
    }
  | {
      accountId: string
      signedIn: false
      windowClosed?: boolean
    }

export type CueLoginListener = (event: CueLoginEvent) => void

let loginListener: CueLoginListener | undefined

export function onCueLoginEvent(listener: CueLoginListener): () => void {
  loginListener = listener
  return () => {
    if (loginListener === listener) loginListener = undefined
  }
}

function emitLogin(event: CueLoginEvent): void {
  try {
    loginListener?.(event)
  } catch (err) {
    console.error('[cue] login listener error', err)
  }
}

function hostAllowed(url: string): boolean {
  if (!url || url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return ALLOWED_CUE_OAUTH_HOST.test(parsed.hostname)
  } catch {
    return false
  }
}

export async function tryCapturePartitionCookies(
  accountId: string,
  wc?: WebContents
): Promise<{
  captured: boolean
  handle?: string
  displayName?: string
  accountSlot?: string
}> {
  try {
    const ses = electronSession.fromPartition(partitionForAccount(accountId))
    const cookies = await ses.cookies.get({})
    const sessionCookies = cookies.filter((c) => looksLikeCueSessionCookie(c.name) && Boolean(c.value))
    if (sessionCookies.length === 0) return { captured: false }
    const primary =
      sessionCookies.find((c) => c.name === 'cue_session_id' || c.name === 'session_id') ??
      sessionCookies[0]!
    const jwtClaims = decodeJwtClaims(primary.value)
    let handle = jwtClaims.handle
    let displayName = jwtClaims.displayName
    let accountSlot = jwtClaims.handle

    if (wc && !wc.isDestroyed()) {
      try {
        const rawUser = await wc.executeJavaScript(
          `(() => { try { return localStorage.getItem('UserService.userInfo') || ''; } catch { return ''; } })()`,
          true
        )
        if (typeof rawUser === 'string' && rawUser.trim().startsWith('{')) {
          const parsed = JSON.parse(rawUser) as Record<string, unknown>
          const u =
            parsed['value'] && typeof parsed['value'] === 'object'
              ? (parsed['value'] as Record<string, unknown>)
              : parsed
          const email = typeof u['email'] === 'string' && u['email'].trim() ? u['email'].trim() : undefined
          const name =
            (typeof u['name'] === 'string' && u['name'].trim()) ||
            (typeof u['nickname'] === 'string' && u['nickname'].trim()) ||
            undefined
          const uid =
            (typeof u['clientUserId'] === 'string' && u['clientUserId'].trim()) ||
            (typeof u['userId'] === 'string' && u['userId'].trim()) ||
            (typeof u['id'] === 'string' && u['id'].trim()) ||
            undefined
          handle = email || handle || uid
          displayName = name || displayName || (email ? email.split('@')[0] : undefined)
          accountSlot = uid || email || accountSlot
        }
      } catch {
        /* ignore cross-origin or transient frame state */
      }
    }

    const auth = await persistCueTokens(accountId, {
      accessToken: primary.value,
      cookieHeader: sessionCookies.map((c) => `${c.name}=${c.value}`).join('; '),
      cookieNames: sessionCookies.map((c) => c.name),
      cookies: sessionCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.cue.im',
        path: c.path || '/'
      })),
      handle,
      displayName,
      accountSlot,
      expiresAtMs: jwtClaims.expiresAtMs,
      authKind: 'session'
    })
    return {
      captured: true,
      handle: auth.handle,
      displayName: auth.displayName,
      accountSlot: auth.accountSlot
    }
  } catch {
    return { captured: false }
  }
}

export async function openCueLoginWindow(
  accountId: string,
  parent?: BrowserWindow,
  opts?: { openInBrowser?: boolean }
): Promise<void> {
  // Fail-closed: enforce account proxy BEFORE any BrowserWindow or network activity.
  await applyProxyToPartition(accountId)

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  installGoogleOAuthHeaderGuard(ses)

  if (opts?.openInBrowser) {
    await shell.openExternal(CUE_LOGIN_URL)
    return
  }

  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '使用 Cue 登录',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  loginWindows.set(accountId, win)

  const childPopups = new Set<BrowserWindow>()
  loginChildWindows.set(accountId, childPopups)
  const closeChildPopups = () => {
    for (const child of childPopups) {
      try {
        if (!child.isDestroyed()) child.close()
      } catch {
        /* ignore */
      }
    }
    childPopups.clear()
  }

  let settling = false
  let handedOffToBrowser = false

  const finishIfCaptured = async (wc?: WebContents): Promise<void> => {
    if (settling || win.isDestroyed()) return
    const res = await tryCapturePartitionCookies(accountId, wc ?? win.webContents)
    if (!res.captured) return
    settling = true
    emitLogin({
      accountId,
      signedIn: true,
      handle: res.handle,
      displayName: res.displayName,
      accountSlot: res.accountSlot
    })
    closeChildPopups()
    try {
      if (!win.isDestroyed()) win.close()
    } catch {
      /* ignore */
    }
  }

  const maybeFallbackOnGoogleBlock = async (wc: WebContents): Promise<void> => {
    if (settling || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser) {
        handedOffToBrowser = true
        void shell.openExternal(CUE_LOGIN_URL)
      }
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: 'Google 登录受限或需要通行密钥',
          detail: '已在系统浏览器打开 Cue 登录页，完成后可回到 BotArk 使用「粘贴凭据导入」。',
          buttonLabel: '在系统浏览器打开',
          actionUrl: 'botark-external://open'
        }),
        true
      )
    } catch {
      /* ignore */
    }
  }

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        void shell.openExternal(CUE_LOGIN_URL)
        return { action: 'deny' }
      }
      if (hostAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'Cue 安全登录',
            autoHideMenuBar: true,
            parent: parentForChild.isDestroyed() ? undefined : parentForChild,
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      }
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      if (url === 'botark-external://open') {
        event.preventDefault()
        void shell.openExternal(CUE_LOGIN_URL)
        return
      }
      if (!hostAllowed(url) && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
  }

  attachNavigationGuards(win.webContents, win)

  const onNav = (wc: WebContents) => {
    void finishIfCaptured(wc)
    void maybeFallbackOnGoogleBlock(wc)
  }

  win.webContents.on('did-finish-load', () => onNav(win.webContents))
  win.webContents.on('did-navigate', () => onNav(win.webContents))
  win.webContents.on('did-redirect-navigation', () => onNav(win.webContents))

  const trackChildWindow = (childWin: BrowserWindow) => {
    childPopups.add(childWin)
    attachNavigationGuards(childWin.webContents, childWin)
    childWin.webContents.on('did-finish-load', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate', () => onNav(childWin.webContents))
    childWin.webContents.on('did-redirect-navigation', () => onNav(childWin.webContents))
    childWin.webContents.on('did-create-window', (nested) => trackChildWindow(nested))
    childWin.on('closed', () => {
      childPopups.delete(childWin)
      void finishIfCaptured()
    })
  }
  win.webContents.on('did-create-window', trackChildWindow)

  const onCookie = (_event: unknown, cookie: { name: string }, _cause: string, removed: boolean) => {
    if (!removed && looksLikeCueSessionCookie(cookie.name)) {
      void finishIfCaptured()
    }
  }
  ses.cookies.on('changed', onCookie)

  win.on('closed', () => {
    ses.cookies.off('changed', onCookie)
    closeChildPopups()
    loginChildWindows.delete(accountId)
    loginWindows.delete(accountId)
    void (async () => {
      if (settling) return
      if (await hasValidCueAuth(accountId)) {
        emitLogin({ accountId, signedIn: true })
        return
      }
      emitLogin({ accountId, signedIn: false, windowClosed: true })
    })()
  })

  try {
    await win.loadURL(CUE_LOGIN_URL)
  } catch {
    /* ignore navigation abort in test/mock environments */
  }
}

export async function cancelCueLogin(accountId: string): Promise<void> {
  const win = loginWindows.get(accountId)
  loginWindows.delete(accountId)
  const children = loginChildWindows.get(accountId)
  loginChildWindows.delete(accountId)
  if (children) {
    for (const child of children) {
      try {
        if (!child.isDestroyed()) child.destroy()
      } catch {
        /* ignore */
      }
    }
    children.clear()
  }
  if (win && !win.isDestroyed()) {
    try {
      win.destroy()
    } catch {
      /* ignore */
    }
  }
  // Never wipe partition storage or saved tokens if valid credentials already exist!
  const alreadyValid = await hasValidCueAuth(accountId)
  if (!alreadyValid) {
    try {
      const ses = electronSession.fromPartition(partitionForAccount(accountId))
      await ses.clearStorageData().catch(() => undefined)
    } catch {
      /* ignore */
    }
  }
}

export function hasOpenCueLogin(accountId: string): boolean {
  const win = loginWindows.get(accountId)
  return Boolean(win && !win.isDestroyed())
}
