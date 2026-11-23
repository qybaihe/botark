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
import {
  decodeJwtClaims,
  hasValidCueAuth,
  looksLikeCueSessionCookie,
  persistCueTokens
} from './cueAuth'
import { startCueBrowserLogin } from './cueDesktopHandoff'

export const CUE_LOGIN_URL = 'https://cue.im/login'

const ALLOWED_CUE_OAUTH_HOST =
  /^(?:[\w-]+\.)*(?:cue\.im|manus\.im|manus\.ai|manuscdn\.com|google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|youtube\.com|apple\.com|icloud\.com|microsoft\.com|microsoftonline\.com|msftauth\.net|msauth\.net|live\.com|cloudflare\.com|hcaptcha\.com|stripe\.com|chromiumapp\.org)$/i

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

    const auth = await persistCueTokens(
      accountId,
      {
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
      },
      { skipPartitionCookieWrite: true }
    )
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
    await startCueBrowserLogin(accountId)
    return
  }

  const existing = loginWindows.get(accountId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const windowIcon = getAppWindowIcon()
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '使用 Cue 登录',
    backgroundColor: '#18181b',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
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
  let capturing = false
  let lastBlockCheckAt = 0

  const handOffToBrowser = () => {
    void startCueBrowserLogin(accountId).catch((err) =>
      console.warn('[cue] browser hand-off failed', err instanceof Error ? err.message : err)
    )
  }

  const finishIfCaptured = async (wc?: WebContents): Promise<void> => {
    if (settling || capturing || win.isDestroyed()) return
    capturing = true
    try {
      const res = await tryCapturePartitionCookies(accountId, wc ?? win.webContents)
      if (!res.captured || settling || win.isDestroyed()) return
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
    } finally {
      capturing = false
    }
  }

  const maybeFallbackOnGoogleBlock = async (wc: WebContents): Promise<void> => {
    if (settling || wc.isDestroyed()) return
    try {
      const currentUrl = wc.getURL()
      // Never execute injected check scripts on non-Google origins (keeps Cue / Turnstile 100% smooth)
      if (!/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(currentUrl)) return
      const now = Date.now()
      if (now - lastBlockCheckAt < 150) return
      lastBlockCheckAt = now
      const bodyText = await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)
      if (!isGoogleBlockedOrPasskeyText(bodyText, currentUrl)) return
      // Never open the system browser on our own: a passkey page is normal (Windows Hello
      // works here), and stealing focus while its dialog is up makes the ceremony fail.
      await wc.executeJavaScript(
        buildGoogleFallbackBannerScript({
          title: '通行密钥无法完成时，可改用系统浏览器或密码登录',
          detail:
            '若 Windows 安全中心提示「使用通行密钥登录时出现问题」(密钥状态无效 0x8009000B)，可点「取消」在 Google 页面改用密码登录，或点击右侧「在系统浏览器登录」（Chrome / Edge 登录后会自动回到 BotArk）。',
          buttonLabel: '在系统浏览器登录',
          actionUrl: 'botark-external://open',
          secondaryActions: [
            { label: '尝试兼容模式重试', actionUrl: 'botark-action://retry-firefox-ua' },
            { label: '改用邮箱验证码登录', actionUrl: 'botark-action://back-to-login' }
          ]
        }),
        true
      )
    } catch {
      /* ignore */
    }
  }

  const attachNavigationGuards = (wc: WebContents, parentForChild: BrowserWindow) => {
    attachGoogleOAuthWebContentsGuard(wc, ses)

    const retryWithFirefoxUa = () => {
      setGoogleFirefoxCompatMode(ses, true)
      if (!wc.isDestroyed()) {
        wc.setUserAgent(buildGoogleFirefoxCompatUa())
        if (/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(wc.getURL())) {
          void wc.loadURL(CUE_LOGIN_URL).catch(() => undefined)
        } else {
          wc.reload()
        }
      }
    }

    const backToEmailLogin = () => {
      setGoogleFirefoxCompatMode(ses, false)
      closeChildPopups()
      if (!win.isDestroyed()) {
        void win.loadURL(CUE_LOGIN_URL).catch(() => undefined)
      }
    }

    wc.setWindowOpenHandler(({ url }) => {
      if (url === 'botark-external://open') {
        handOffToBrowser()
        return { action: 'deny' }
      }
      if (url === 'botark-action://retry-firefox-ua') {
        retryWithFirefoxUa()
        return { action: 'deny' }
      }
      if (url === 'botark-action://back-to-login') {
        backToEmailLogin()
        return { action: 'deny' }
      }
      if (hostAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            title: 'Cue 安全登录',
            backgroundColor: '#18181b',
            autoHideMenuBar: true,
            ...(windowIcon ? { icon: windowIcon } : {}),
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
        handOffToBrowser()
        return
      }
      if (url === 'botark-action://retry-firefox-ua') {
        event.preventDefault()
        retryWithFirefoxUa()
        return
      }
      if (url === 'botark-action://back-to-login') {
        event.preventDefault()
        backToEmailLogin()
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

  // cue.im takes several seconds to commit its first response; until then the window
  // would stay an empty dark rectangle. Paint a local loading page first (it stays on
  // screen until cue.im commits), then navigate. Fire non-blocking so the renderer UI
  // never hangs waiting for cue.im chunks + Turnstile.
  void (async () => {
    try {
      await win.loadURL(CUE_LOADING_PAGE_URL)
    } catch {
      /* ignore: the real page load below is what matters */
    }
    if (win.isDestroyed()) return
    await win.loadURL(CUE_LOGIN_URL).catch(() => {
      /* ignore navigation abort in test/mock environments */
    })
  })()
}

const CUE_LOADING_PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>使用 Cue 登录</title>
<style>html,body{margin:0;height:100%;background:#18181b;color:#e4e4e7;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.s{width:28px;height:28px;border-radius:50%;border:3px solid #3f3f46;border-top-color:#e4e4e7;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}p{margin:0;color:#a1a1aa;font-size:13px}</style></head>
<body><div class="s"></div><div>正在打开 Cue 登录页…</div><p>首次连接 cue.im 可能需要几秒钟</p></body></html>`

export const CUE_LOADING_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(CUE_LOADING_PAGE_HTML)}`

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

/** Close an embedded login window after the account signed in some other way (browser hand-off). */
export function closeCueLoginWindow(accountId: string): void {
  const win = loginWindows.get(accountId)
  if (win && !win.isDestroyed()) {
    try {
      win.close()
    } catch {
      /* ignore */
    }
  }
}

export function hasOpenCueLogin(accountId: string): boolean {
  const win = loginWindows.get(accountId)
  return Boolean(win && !win.isDestroyed())
}
