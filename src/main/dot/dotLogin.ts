import { BrowserWindow, session as electronSession, shell, type WebContents } from 'electron'
import { getAppWindowIcon } from '../appIcon'
import {
  attachGoogleOAuthWebContentsGuard,
  buildGoogleFallbackBannerScript,
  buildGoogleFirefoxCompatUa,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText,
  setGoogleFirefoxCompatMode
} from '../googleOAuthUaGuard'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import { DOT_ORIGIN, getStoredDotAccount, trySyncFromElectronPartition } from './dotClient'

const DOT_LOGIN_URL = `${DOT_ORIGIN}/dots`

const ALLOWED_DOT_HOST =
  /^(?:[\w-]+\.)*(?:chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com|auth0\.com|google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|youtube\.com|apple\.com|icloud\.com|live\.com|microsoftonline\.com|cloudflare\.com)$/i

function dotHostAllowed(url: string): boolean {
  if (!url || url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return ALLOWED_DOT_HOST.test(parsed.hostname)
  } catch {
    return false
  }
}

export type DotLoginEvent =
  | {
      accountId: string
      signedIn: true
      handle?: string
      displayName?: string
      planType?: string
      chatgptAccountId?: string
    }
  | {
      accountId: string
      signedIn: false
      windowClosed?: boolean
    }

const loginWindows = new Map<string, BrowserWindow>()
const loginChildWindows = new Map<string, Set<BrowserWindow>>()
const loginListeners = new Set<(event: DotLoginEvent) => void>()

export function onDotLoginEvent(listener: (event: DotLoginEvent) => void): () => void {
  loginListeners.add(listener)
  return () => loginListeners.delete(listener)
}

function emitLogin(event: DotLoginEvent): void {
  for (const listener of loginListeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[dot] login listener failed', err)
    }
  }
}

export async function openDotLoginWindow(
  accountId: string,
  parent?: BrowserWindow
): Promise<void> {
  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  // Enforce per-account proxy BEFORE loading chatgpt.com/dots (fail-closed on unreadable proxy).
  await applyProxyToPartition(accountId)

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  installGoogleOAuthHeaderGuard(ses)
  const windowIcon = getAppWindowIcon()
  const win = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    title: '使用 ChatGPT Dot 登录 (chatgpt.com/dots)',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  let captured = false
  let handedOffToBrowser = false
  let lastBlockCheckAt = 0

  const maybeShowGoogleFallbackBanner = async (wc: WebContents): Promise<void> => {
    if (captured || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      if (!/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(currentUrl)) return
      const now = Date.now()
      if (now - lastBlockCheckAt < 150) return
      lastBlockCheckAt = now
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      if (!handedOffToBrowser) {
        handedOffToBrowser = true
        void shell.openExternal(DOT_LOGIN_URL)
      }
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: 'Google 登录受限或需要通行密钥',
          detail: '可尝试兼容模式重试，或在系统浏览器打开 chatgpt.com/dots 登录后粘贴 AT/RT 凭据导入。',
          buttonLabel: '在系统浏览器打开',
          actionUrl: 'botark-external://open',
          secondaryActions: [
            { label: '尝试兼容模式重试', actionUrl: 'botark-action://retry-firefox-ua' },
            { label: '返回 Dot 登录页', actionUrl: 'botark-action://back-to-login' }
          ]
        }),
        true
      )
    } catch {
      /* ignore transient navigation states */
    }
  }

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    attachGoogleOAuthWebContentsGuard(wc, ses)

    const retryWithFirefoxUa = () => {
      setGoogleFirefoxCompatMode(ses, true)
      if (!wc.isDestroyed()) {
        wc.setUserAgent(buildGoogleFirefoxCompatUa())
        if (/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(wc.getURL())) {
          void wc.loadURL(DOT_LOGIN_URL).catch(() => undefined)
        } else {
          wc.reload()
        }
      }
    }

    const backToLogin = () => {
      setGoogleFirefoxCompatMode(ses, false)
      closeChildPopups()
      if (!win.isDestroyed()) {
        void win.loadURL(DOT_LOGIN_URL).catch(() => undefined)
      }
    }

    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        void shell.openExternal(DOT_LOGIN_URL)
        return { action: 'deny' }
      }
      if (url === 'botark-action://retry-firefox-ua') {
        retryWithFirefoxUa()
        return { action: 'deny' }
      }
      if (url === 'botark-action://back-to-login') {
        backToLogin()
        return { action: 'deny' }
      }
      if (dotHostAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'ChatGPT Dot 安全登录',
            autoHideMenuBar: true,
            ...(windowIcon ? { icon: windowIcon } : {}),
            parent: parentForChild.isDestroyed() ? undefined : parentForChild,
            webPreferences: {
              partition,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true
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
        void shell.openExternal(DOT_LOGIN_URL)
        return
      }
      if (url === 'botark-action://retry-firefox-ua') {
        event.preventDefault()
        retryWithFirefoxUa()
        return
      }
      if (url === 'botark-action://back-to-login') {
        event.preventDefault()
        backToLogin()
        return
      }
      if (!dotHostAllowed(url) && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })
  }

  attachNavigationGuards(win.webContents, win)

  const pollSession = async () => {
    if (captured || win.isDestroyed()) return
    const synced = await trySyncFromElectronPartition(accountId).catch(() => undefined)
    if (synced && synced.accessToken) {
      captured = true
      emitLogin({
        accountId,
        signedIn: true,
        handle: synced.email || synced.chatgptAccountId || accountId,
        displayName: synced.displayName || synced.email?.split('@')[0] || 'Dot',
        planType: synced.planType,
        chatgptAccountId: synced.chatgptAccountId
      })
      closeChildPopups()
      if (!win.isDestroyed()) win.close()
    }
  }

  const interval = setInterval(() => {
    void pollSession()
  }, 1800)

  const onNav = (wc: WebContents) => {
    void pollSession()
    void maybeShowGoogleFallbackBanner(wc)
  }

  win.webContents.on('did-finish-load', () => onNav(win.webContents))
  win.webContents.on('did-navigate', () => onNav(win.webContents))
  win.webContents.on('did-navigate-in-page', () => onNav(win.webContents))
  win.webContents.on('did-redirect-navigation', () => onNav(win.webContents))

  const trackChildWindow = (childWin: BrowserWindow) => {
    childPopups.add(childWin)
    attachNavigationGuards(childWin.webContents, childWin)
    childWin.webContents.on('did-finish-load', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate', () => onNav(childWin.webContents))
    childWin.webContents.on('did-navigate-in-page', () => onNav(childWin.webContents))
    childWin.webContents.on('did-redirect-navigation', () => onNav(childWin.webContents))
    childWin.webContents.on('did-create-window', (nested) => trackChildWindow(nested))
    childWin.on('closed', () => {
      childPopups.delete(childWin)
      void pollSession()
    })
  }
  win.webContents.on('did-create-window', trackChildWindow)

  win.on('closed', () => {
    clearInterval(interval)
    closeChildPopups()
    loginChildWindows.delete(accountId)
    loginWindows.delete(accountId)
    if (!captured) {
      const existing = getStoredDotAccount(accountId)
      if (existing?.accessToken) {
        emitLogin({
          accountId,
          signedIn: true,
          handle: existing.email || existing.chatgptAccountId || accountId,
          displayName: existing.displayName || existing.email?.split('@')[0] || 'Dot',
          planType: existing.planType,
          chatgptAccountId: existing.chatgptAccountId
        })
      } else {
        emitLogin({
          accountId,
          signedIn: false,
          windowClosed: true
        })
      }
    }
  })

  await win.loadURL(DOT_LOGIN_URL)
}

export async function cancelDotLogin(accountId: string): Promise<void> {
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
    win.destroy()
  }
  if (!getStoredDotAccount(accountId)?.accessToken) {
    try {
      const ses = electronSession.fromPartition(partitionForAccount(accountId))
      await ses.clearStorageData()
    } catch {
      /* ignore */
    }
  }
}
