/**
 * Interactive Google Antigravity login via BrowserWindow + isolated persist partition.
 *
 * Opens https://antigravity.google.com/ (redirects to Google Sign-In when signed out).
 * Uses a clean desktop Chrome User-Agent so Google OAuth never rejects the window.
 * Success is verified via live `GetUserProfile` RPC (`aicode.clients6.google.com`).
 * Never prints cookie or auth-header values.
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
import { listAntigravityCookieNames, probeAntigravitySession } from './antigravityClient'
import {
  ANTIGRAVITY_ORIGIN,
  isAllowedAntigravityUrl
} from './antigravityProtocol'

const loginWindows = new Map<string, BrowserWindow>()

export type AntigravityLoginSuccess = {
  accountId: string
  signedIn: true
  handle: string
  displayName?: string
  planDisplayName?: string
  sessionCookieNames: string[]
}

export type AntigravityLoginEvent =
  | AntigravityLoginSuccess
  | { accountId: string; signedIn: false; windowClosed?: boolean }

export type AntigravityLoginListener = (event: AntigravityLoginEvent) => void

let loginListener: AntigravityLoginListener | undefined

export function onAntigravityLoginEvent(listener: AntigravityLoginListener): () => void {
  loginListener = listener
  return () => {
    if (loginListener === listener) loginListener = undefined
  }
}

function emit(event: AntigravityLoginEvent): void {
  try {
    loginListener?.(event)
  } catch (error) {
    console.error('[antigravity] login listener failed', error)
  }
}

function isAuthTriggerCookie(name: string): boolean {
  return (
    name === 'SAPISID' ||
    name === '__Secure-1PAPISID' ||
    name === '__Secure-3PAPISID' ||
    name === 'SID' ||
    name === '__Secure-1PSID' ||
    name === '__Secure-3PSID'
  )
}

export async function openAntigravityLoginWindow(accountId: string, parent?: BrowserWindow): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  await applyProxyToPartition(accountId)

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  installGoogleOAuthHeaderGuard(ses)

  // Already signed in on this partition?
  const already = await probeAntigravitySession(accountId)
  if (already.signedIn) {
    const cookieNames = await listAntigravityCookieNames(accountId)
    emit({
      accountId,
      signedIn: true,
      handle: already.profile.email,
      displayName: already.profile.email.split('@')[0] || 'Antigravity',
      planDisplayName: already.profile.planDisplayName,
      sessionCookieNames: cookieNames
    })
    return
  }

  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '使用 Google Antigravity 登录',
    backgroundColor: '#1f1f1f',
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

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        void shell.openExternal(`${ANTIGRAVITY_ORIGIN}/`)
        return { action: 'deny' }
      }
      if (isAllowedAntigravityUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'Google 登录',
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
        void shell.openExternal(`${ANTIGRAVITY_ORIGIN}/`)
        return
      }
      if (!isAllowedAntigravityUrl(url) && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
  }

  attachNavigationGuards(win.webContents, win)

  let settling = false
  let checking = false

  const finishIfSignedIn = async (): Promise<void> => {
    if (settling || checking || win.isDestroyed()) return
    checking = true
    try {
      const probe = await probeAntigravitySession(accountId)
      if (!probe.signedIn || settling || win.isDestroyed()) return
      settling = true
      const cookieNames = await listAntigravityCookieNames(accountId)
      emit({
        accountId,
        signedIn: true,
        handle: probe.profile.email,
        displayName: probe.profile.email.split('@')[0] || 'Antigravity',
        planDisplayName: probe.profile.planDisplayName,
        sessionCookieNames: cookieNames
      })
      closeChildPopups()
      try {
        if (!win.isDestroyed()) win.close()
      } catch {
        /* ignore */
      }
    } finally {
      checking = false
    }
  }

  let handedOffToBrowser = false
  const maybeShowGoogleFallbackBanner = async (wc: WebContents): Promise<void> => {
    if (settling || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser) {
        handedOffToBrowser = true
        void shell.openExternal(`${ANTIGRAVITY_ORIGIN}/`)
      }
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: 'Google 登录受限或需要通行密钥',
          detail: '请尝试更换网络代理后重新打开登录窗口，或点击右侧在系统浏览器打开 Antigravity 核对账号状态。',
          buttonLabel: '在系统浏览器打开',
          actionUrl: 'botark-external://open'
        }),
        true
      )
    } catch {
      /* ignore transient navigation states */
    }
  }

  const onNav = (wc: WebContents) => {
    void finishIfSignedIn()
    void maybeShowGoogleFallbackBanner(wc)
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
      void finishIfSignedIn()
    })
  }
  win.webContents.on('did-create-window', trackChildWindow)

  const onCookie = (
    _event: unknown,
    cookie: { name: string },
    _cause: string,
    removed: boolean
  ) => {
    if (!removed && isAuthTriggerCookie(cookie.name)) {
      void finishIfSignedIn()
    }
  }
  ses.cookies.on('changed', onCookie)

  const poll = setInterval(() => {
    if (win.isDestroyed() || settling) {
      clearInterval(poll)
      return
    }
    void finishIfSignedIn()
  }, 1500)

  win.on('closed', () => {
    clearInterval(poll)
    ses.cookies.off('changed', onCookie)
    closeChildPopups()
    const wasTracked = loginWindows.get(accountId) === win
    if (wasTracked) loginWindows.delete(accountId)
    if (!wasTracked || settling) return
    void (async () => {
      const probe = await probeAntigravitySession(accountId)
      if (probe.signedIn) {
        const cookieNames = await listAntigravityCookieNames(accountId)
        emit({
          accountId,
          signedIn: true,
          handle: probe.profile.email,
          displayName: probe.profile.email.split('@')[0] || 'Antigravity',
          planDisplayName: probe.profile.planDisplayName,
          sessionCookieNames: cookieNames
        })
        return
      }
      emit({ accountId, signedIn: false, windowClosed: true })
    })()
  })

  try {
    await win.loadURL(ANTIGRAVITY_ORIGIN)
  } catch (error) {
    const code = (error as { errno?: number })?.errno
    if (code !== -3) {
      console.error('[antigravity] openLogin load failed', error)
    }
  }
}

export function closeAntigravityLoginWindow(accountId: string): void {
  const win = loginWindows.get(accountId)
  loginWindows.delete(accountId)
  if (win && !win.isDestroyed()) win.destroy()
}
