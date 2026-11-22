/**
 * Interactive Hark login via BrowserWindow + account persist partition.
 *
 * Opens app.hark.com/login (Continue with Google → auth.hark.com → Google).
 * Success: GET /api/auth/get-session returns a valid session. Cookies only
 * trigger a probe: they can appear before OAuth finishes or outlive a session.
 * Never prints cookie/token values.
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
  extractHandle,
  HARK_LOGIN_URL,
  listSessionCookieNames,
  looksLikeSessionCookie,
  type HarkAuthSession
} from './harkClient'
import { probeHarkSession } from './harkSession'

const ALLOWED_HOST =
  /^(?:[\w-]+\.)*(?:hark\.com|google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|youtube\.com|chromiumapp\.org|apple\.com|icloud\.com|cloudflare\.com)$/i

const loginWindows = new Map<string, BrowserWindow>()
const loginChildWindows = new Map<string, Set<BrowserWindow>>()

export type HarkLoginSuccess = {
  accountId: string
  signedIn: true
  handle?: string
  displayName?: string
  sessionCookieNames: string[]
}

export type HarkLoginEvent =
  | HarkLoginSuccess
  | { accountId: string; signedIn: false; windowClosed?: boolean }

export type HarkLoginListener = (event: HarkLoginEvent) => void

let loginListener: HarkLoginListener | undefined

export function onHarkLoginEvent(listener: HarkLoginListener): () => void {
  loginListener = listener
  return () => {
    if (loginListener === listener) loginListener = undefined
  }
}

function emit(event: HarkLoginEvent): void {
  try {
    loginListener?.(event)
  } catch (error) {
    console.error('[hark] login listener failed', error)
  }
}

function hostAllowed(url: string): boolean {
  if (!url || url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return ALLOWED_HOST.test(parsed.hostname)
  } catch {
    return false
  }
}

async function probeSignedIn(accountId: string): Promise<{
  session: HarkAuthSession
  cookieNames: string[]
} | null> {
  const probe = await probeHarkSession(accountId)
  if (!('signedIn' in probe)) {
    return { session: probe.session, cookieNames: await listSessionCookieNames(accountId) }
  }
  return null
}

export async function openHarkLoginWindow(accountId: string, parent?: BrowserWindow): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  // Enforce per-account proxy BEFORE probing session or loading app.hark.com/login (fail-closed).
  await applyProxyToPartition(accountId)

  // Already signed in on this partition?
  const already = await probeSignedIn(accountId)
  if (already) {
    const { handle, displayName } = extractHandle(already.session)
    emit({
      accountId,
      signedIn: true,
      handle,
      displayName,
      sessionCookieNames: already.cookieNames
    })
    return
  }

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  installGoogleOAuthHeaderGuard(ses)

  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '使用 Hark 登录',
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

  const maybeShowGoogleFallbackBanner = async (wc: WebContents): Promise<void> => {
    if (settling || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser) {
        handedOffToBrowser = true
        void shell.openExternal(HARK_LOGIN_URL)
      }
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: 'Google 登录受限或需要通行密钥',
          detail: '可点击右侧在系统浏览器打开 Hark 完成登录，然后回到 BotArk 使用「粘贴凭据导入」。',
          buttonLabel: '在系统浏览器打开',
          actionUrl: 'botark-external://open'
        }),
        true
      )
    } catch {
      /* ignore transient navigation states */
    }
  }

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        void shell.openExternal(HARK_LOGIN_URL)
        return { action: 'deny' }
      }
      if (hostAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'Hark 安全登录',
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
        void shell.openExternal(HARK_LOGIN_URL)
        return
      }
      if (!hostAllowed(url) && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
  }

  attachNavigationGuards(win.webContents, win)

  const finish = async (): Promise<void> => {
    if (settling || win.isDestroyed()) return
    const hit = await probeSignedIn(accountId)
    if (!hit) return
    settling = true
    const { handle, displayName } = extractHandle(hit.session)
    // Emit BEFORE close so add-bot advances to Name (same race Muse fixed).
    emit({
      accountId,
      signedIn: true,
      handle,
      displayName,
      sessionCookieNames: hit.cookieNames
    })
    closeChildPopups()
    try {
      if (!win.isDestroyed()) win.close()
    } catch {
      /* ignore */
    }
  }

  const onNav = (wc: WebContents): void => {
    void finish()
    void maybeShowGoogleFallbackBanner(wc)
  }
  win.webContents.on('did-finish-load', () => onNav(win.webContents))
  win.webContents.on('did-navigate', () => onNav(win.webContents))
  win.webContents.on('did-navigate-in-page', () => void finish())
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
      void finish()
    })
  }
  win.webContents.on('did-create-window', trackChildWindow)

  const onCookie = (
    _event: unknown,
    cookie: { name: string },
    _cause: string,
    removed: boolean
  ): void => {
    if (!removed && looksLikeSessionCookie(cookie.name)) void finish()
  }
  ses.cookies.on('changed', onCookie)

  const poll = setInterval(() => {
    if (win.isDestroyed() || settling) {
      clearInterval(poll)
      return
    }
    void finish()
  }, 1200)

  win.on('closed', () => {
    clearInterval(poll)
    ses.cookies.off('changed', onCookie)
    closeChildPopups()
    loginChildWindows.delete(accountId)
    loginWindows.delete(accountId)
    void (async () => {
      if (settling) return
      const hit = await probeSignedIn(accountId)
      if (hit) {
        const { handle, displayName } = extractHandle(hit.session)
        emit({
          accountId,
          signedIn: true,
          handle,
          displayName,
          sessionCookieNames: hit.cookieNames
        })
        return
      }
      emit({ accountId, signedIn: false, windowClosed: true })
    })()
  })

  try {
    await win.loadURL(HARK_LOGIN_URL)
  } catch (error) {
    console.error('[hark] openLogin load failed', error)
  }
}

export async function cancelHarkLogin(accountId: string): Promise<void> {
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
  if (win && !win.isDestroyed()) win.destroy()
  try {
    const existingCookies = await listSessionCookieNames(accountId)
    const alreadyValid = existingCookies.length > 0 && Boolean(await probeSignedIn(accountId))
    if (!alreadyValid) {
      const ses = electronSession.fromPartition(partitionForAccount(accountId))
      await ses.clearStorageData()
    }
  } catch (error) {
    console.error('[hark] clear partition failed', error)
  }
}

export function hasOpenHarkLogin(accountId: string): boolean {
  const win = loginWindows.get(accountId)
  return Boolean(win && !win.isDestroyed())
}
