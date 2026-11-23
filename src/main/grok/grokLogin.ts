import { BrowserWindow, session as electronSession, shell, type WebContents } from 'electron'
import { getAppWindowIcon } from '../appIcon'
import {
  attachGoogleOAuthWebContentsGuard,
  buildGoogleFallbackBannerScript,
  GOOGLE_BLOCK_CHECK_SCRIPT,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText
} from '../googleOAuthUaGuard'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import { setGrokMainAuth } from './grokAuthStore'
import { getOrCreateGrokMachineId } from './grokMachineId'
import {
  createPkce,
  createSandPollWake,
  extractAccountHandleFromJwt,
  parseWorkosCookieOrToken,
  persistSandTokens,
  pollSandAuth,
  sandLoginUrl
} from './grokSandAuth'

const TOKEN_COOKIE_NAMES = new Set([
  'WorkosCursorSessionToken',
  'workos_cursor_session_token',
  'WorkosCursorSessionToken.sig'
])

const DEEP_LINK_SCHEME = /^(sand|grokbot|cursor):/i

const CONFIRM_SELECTORS = [
  'Yes, log in',
  'Yes, Log In',
  'Yes, sign in',
  'Confirm',
  'Authorize'
]

interface ActiveLoginFlight {
  win?: BrowserWindow
  cancel: (silent?: boolean) => void
  wake: () => void
}

const activeLogins = new Map<string, ActiveLoginFlight>()

export type GrokAuthCaptured = {
  accountId: string
  signedIn: true
  accountSlot?: string
  teamId?: string
  machineId: string
  authKind?: 'cursor' | 'xai' | 'web'
}

export type GrokLoginClosedWithoutAuth = {
  accountId: string
  signedIn: false
  windowClosed: true
}

export type GrokAuthCaptureEvent = GrokAuthCaptured | GrokLoginClosedWithoutAuth
export type GrokAuthCaptureListener = (event: GrokAuthCaptureEvent) => void

let captureListener: GrokAuthCaptureListener | undefined

export function onGrokAuthCaptured(listener: GrokAuthCaptureListener): () => void {
  captureListener = listener
  return () => {
    if (captureListener === listener) captureListener = undefined
  }
}

/** Decode WorkosCursorSessionToken → JWT (Bearer accessToken). */
export function accessTokenFromWorkosCookie(
  raw: string
): { accessToken: string; accountSlot?: string } | null {
  return parseWorkosCookieOrToken(raw)
}

export function cancelGrokLogin(accountId: string): void {
  const flight = activeLogins.get(accountId)
  if (!flight) return
  activeLogins.delete(accountId)
  flight.cancel(true)
}

/**
 * Open Grok Bot official PKCE login (`loginDeepControl?redirectTarget=sand`) and poll
 * `api2.cursor.sh/auth/poll` via `proxyFetch` (system-proxy & per-account-proxy aware).
 *
 * - Default (`openInBrowser: false`): opens a clean, zero-bounce BrowserWindow sharing
 *   the account's partition, keeps OAuth popups (Google / X / GitHub / Apple) inside
 *   the same partition without jumping to external browsers, blocks `sand://` / `grokbot://`
 *   from launching external apps, and auto-clicks "Yes, log in" once authenticated.
 * - Optional (`openInBrowser: true`): opens the PKCE URL in the user's default system
 *   browser (ideal when already signed in on Safari/Chrome) while polling `/auth/poll`.
 */
export async function openGrokLoginWindow(
  accountId: string,
  parent?: BrowserWindow,
  opts: { openInBrowser?: boolean } = {}
): Promise<void> {
  const existing = activeLogins.get(accountId)
  if (existing && !opts.openInBrowser && existing.win && !existing.win.isDestroyed()) {
    existing.win.show()
    existing.win.focus()
    existing.wake()
    return
  }
  if (existing) {
    existing.cancel(true)
    activeLogins.delete(accountId)
  }

  // Enforce per-account proxy (or system proxy mode) BEFORE loading any network URL.
  await applyProxyToPartition(accountId)

  const partition = partitionForAccount(accountId)
  const ses = electronSession.fromPartition(partition)
  installGoogleOAuthHeaderGuard(ses)
  const machineId = getOrCreateGrokMachineId(accountId)
  const { verifier, challenge, uuid } = createPkce()
  const deepUrl = sandLoginUrl(challenge, uuid)
  const pollWake = createSandPollWake()

  let settling = false
  let aborted = false
  let silentAbort = false
  let fallbackCookieToken: { accessToken: string; accountSlot?: string } | null = null
  const childPopups = new Set<BrowserWindow>()
  let autoConfirmTimer: ReturnType<typeof setInterval> | undefined

  let win: BrowserWindow | undefined

  const cleanupTimersAndPopups = () => {
    if (autoConfirmTimer) {
      clearInterval(autoConfirmTimer)
      autoConfirmTimer = undefined
    }
    for (const child of childPopups) {
      if (!child.isDestroyed()) child.close()
    }
    childPopups.clear()
  }

  const finish = (
    accessToken: string,
    finishOpts: {
      refreshToken?: string
      accountSlot?: string
      teamId?: string
      xaiIssuer?: string
      xaiClientId?: string
      expiresAtMs?: number
      authKind?: 'cursor' | 'xai' | 'web'
      fromPkce?: boolean
    } = {}
  ): void => {
    if (settling || aborted) return
    if (!accessToken || accessToken.length < 20) return
    settling = true
    activeLogins.delete(accountId)
    cleanupTimersAndPopups()

    const resolvedSlot =
      extractAccountHandleFromJwt(accessToken) ?? finishOpts.accountSlot

    setGrokMainAuth({
      accountId,
      accessToken,
      accountSlot: resolvedSlot,
      teamId: finishOpts.teamId,
      machineId
    })
    if (finishOpts.fromPkce || finishOpts.refreshToken || finishOpts.authKind) {
      void persistSandTokens(accountId, {
        accessToken,
        refreshToken: finishOpts.refreshToken,
        authId: resolvedSlot,
        selectedTeamId: finishOpts.teamId,
        xaiIssuer: finishOpts.xaiIssuer,
        xaiClientId: finishOpts.xaiClientId,
        expiresAtMs: finishOpts.expiresAtMs,
        authKind: finishOpts.authKind ?? 'cursor'
      }).catch((err) => console.warn('[grok] safeStorage persist failed', err))
    }

    const payload: GrokAuthCaptured = {
      accountId,
      signedIn: true,
      accountSlot: resolvedSlot,
      teamId: finishOpts.teamId,
      machineId,
      authKind: finishOpts.authKind ?? (finishOpts.fromPkce ? 'cursor' : 'web')
    }
    try {
      captureListener?.(payload)
    } catch (error) {
      console.error('[grok] auth capture listener failed', error)
    }
    if (win && !win.isDestroyed()) win.close()
  }

  const cancel = (silent = false) => {
    if (aborted || settling) return
    silentAbort = silent
    aborted = true
    pollWake.wake()
    cleanupTimersAndPopups()
    if (win && !win.isDestroyed()) {
      win.close()
    } else if (!silent) {
      try {
        captureListener?.({ accountId, signedIn: false, windowClosed: true })
      } catch {
        /* ignore */
      }
    }
  }

  // Primary path: official PKCE /auth/poll via account/system proxy
  void pollSandAuth(uuid, verifier, {
    accountId,
    isAborted: () => aborted || settling,
    maxAttempts: 180,
    wake: pollWake
  })
    .then((tokens) => {
      finish(tokens.accessToken, {
        refreshToken: tokens.refreshToken,
        accountSlot: tokens.authId,
        teamId: tokens.selectedTeamId,
        xaiIssuer: tokens.xaiIssuer,
        xaiClientId: tokens.xaiClientId,
        expiresAtMs: tokens.expiresAtMs,
        authKind: tokens.authKind ?? 'cursor',
        fromPkce: true
      })
    })
    .catch(() => {
      if (!settling && !silentAbort && fallbackCookieToken) {
        finish(fallbackCookieToken.accessToken, {
          accountSlot: fallbackCookieToken.accountSlot,
          authKind: 'web'
        })
      }
    })

  // System default browser mode: open external browser + poll in background
  if (opts.openInBrowser) {
    activeLogins.set(accountId, {
      cancel,
      wake: () => pollWake.wake()
    })
    await shell.openExternal(deepUrl)
    return
  }

  const windowIcon = getAppWindowIcon()
  win = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 680,
    minHeight: 540,
    title: '登录 Grok Bot',
    backgroundColor: '#f7f7f8',
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

  activeLogins.set(accountId, {
    win,
    cancel,
    wake: () => pollWake.wake()
  })

  const guardDeepLinks = (wc: WebContents): void => {
    const intercept = (event: Electron.Event, url: string) => {
      if (DEEP_LINK_SCHEME.test(url)) {
        // Prevent macOS from launching external Grok Bot.app / Cursor.app!
        event.preventDefault()
        pollWake.wake()
      }
    }
    wc.on('will-navigate', intercept)
    wc.on('will-redirect', intercept)
  }

  guardDeepLinks(win.webContents)
  attachGoogleOAuthWebContentsGuard(win.webContents, ses)

  // Keep OAuth popups (Google, X, Apple, GitHub, WorkOS) inside the same partition
  // as clean child windows so `window.opener` works natively without external browser bounces.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (DEEP_LINK_SCHEME.test(url)) {
      pollWake.wake()
      return { action: 'deny' }
    }
    if (url === 'about:blank' || /^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          title: '安全授权',
          ...(windowIcon ? { icon: windowIcon } : {}),
          parent: win && !win.isDestroyed() ? win : undefined,
          autoHideMenuBar: true,
          webPreferences: {
            partition,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      }
    }
    return { action: 'deny' }
  })

  let handedOffToBrowser = false
  let lastBlockCheckAt = 0
  const maybeFallbackOnGoogleBlock = async (
    wc: WebContents,
    childWin?: BrowserWindow
  ): Promise<void> => {
    if (handedOffToBrowser || settling || aborted || wc.isDestroyed()) return
    try {
      const url = wc.getURL()
      if (!/^https:\/\/accounts\.(?:google|youtube)\.com\//i.test(url)) return
      const now = Date.now()
      if (now - lastBlockCheckAt < 150) return
      lastBlockCheckAt = now
      const bodyText = (await wc.executeJavaScript(GOOGLE_BLOCK_CHECK_SCRIPT, true)) as string
      if (!isGoogleBlockedOrPasskeyText(bodyText, url)) return
      if (!handedOffToBrowser && !settling && !aborted) {
        handedOffToBrowser = true
        void shell.openExternal(deepUrl)
        if (childWin && !childWin.isDestroyed()) {
          try {
            childWin.close()
          } catch {
            /* ignore */
          }
        }
        if (win && !win.isDestroyed()) {
          void win.webContents
            .executeJavaScript(
              buildGoogleFallbackBannerScript({
                title: '已自动切换至系统默认浏览器完成 Google 授权',
                detail: '请在系统浏览器中完成登录并确认授权，完成后 BotArk 将自动同步账号与 Bot。'
              }),
              true
            )
            .catch(() => undefined)
        }
      }
    } catch {
      /* ignore */
    }
  }

  win.webContents.on('did-create-window', (childWin) => {
    childPopups.add(childWin)
    guardDeepLinks(childWin.webContents)
    attachGoogleOAuthWebContentsGuard(childWin.webContents, ses)
    const onChildNav = () => {
      void maybeFallbackOnGoogleBlock(childWin.webContents, childWin)
    }
    childWin.webContents.on('did-finish-load', onChildNav)
    childWin.webContents.on('did-navigate', onChildNav)
    childWin.webContents.on('did-navigate-in-page', onChildNav)
    childWin.webContents.on('did-redirect-navigation', onChildNav)
    childWin.on('closed', () => {
      childPopups.delete(childWin)
      pollWake.wake()
    })
  })

  const checkCookiesAndAutoConfirm = async (): Promise<void> => {
    if (settling || aborted || !win || win.isDestroyed()) return
    try {
      const cookies = await ses.cookies.get({})
      for (const cookie of cookies) {
        if (
          !TOKEN_COOKIE_NAMES.has(cookie.name) &&
          !/workos.*session|cursor.*session/i.test(cookie.name)
        ) {
          continue
        }
        if (cookie.name.endsWith('.sig')) continue
        const parsed = accessTokenFromWorkosCookie(cookie.value)
        if (parsed) {
          fallbackCookieToken = parsed
          break
        }
      }
    } catch {
      /* ignore */
    }

    // Auto-click "Yes, log in" when landing on loginDeepControl confirmation page
    try {
      const currentUrl = win.webContents.getURL()
      if (/\/loginDeepControl/i.test(currentUrl)) {
        const clicked = (await win.webContents.executeJavaScript(
          `(() => {
            const wanted = ${JSON.stringify(CONFIRM_SELECTORS)};
            const els = Array.from(document.querySelectorAll('button, a, [role=button], input[type=submit]'));
            for (const el of els) {
              if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
              const txt = (el.innerText || el.value || el.textContent || '').trim();
              if (!txt) continue;
              const lower = txt.toLowerCase();
              if (
                lower.includes('yes, log in') ||
                lower.includes('yes, sign in') ||
                wanted.some((w) => lower === w.toLowerCase())
              ) {
                if (el.dataset.bothubClicked === '1') return '';
                el.dataset.bothubClicked = '1';
                el.click();
                return txt;
              }
            }
            return '';
          })()`,
          true
        )) as string
        if (clicked) {
          setTimeout(() => pollWake.wake(), 250)
          setTimeout(() => pollWake.wake(), 900)
        }
      }
    } catch {
      /* page still loading */
    }
  }

  win.webContents.on('did-finish-load', () => {
    pollWake.wake()
    void checkCookiesAndAutoConfirm()
    if (win && !win.isDestroyed()) void maybeFallbackOnGoogleBlock(win.webContents)
  })
  win.webContents.on('did-navigate', () => {
    pollWake.wake()
    void checkCookiesAndAutoConfirm()
    if (win && !win.isDestroyed()) void maybeFallbackOnGoogleBlock(win.webContents)
  })
  win.webContents.on('did-redirect-navigation', () => {
    pollWake.wake()
    if (win && !win.isDestroyed()) void maybeFallbackOnGoogleBlock(win.webContents)
  })

  autoConfirmTimer = setInterval(() => {
    void checkCookiesAndAutoConfirm()
  }, 900)

  win.on('closed', () => {
    const wasSettling = settling
    const wasSilent = silentAbort
    aborted = true
    activeLogins.delete(accountId)
    cleanupTimersAndPopups()
    pollWake.wake()

    if (!wasSettling && !wasSilent && fallbackCookieToken) {
      // Allow fallback cookie token when user logged in and closed window manually
      aborted = false
      finish(fallbackCookieToken.accessToken, {
        accountSlot: fallbackCookieToken.accountSlot,
        authKind: 'web'
      })
      return
    }
    if (!wasSettling && !wasSilent) {
      try {
        captureListener?.({ accountId, signedIn: false, windowClosed: true })
      } catch (err) {
        console.error('[grok] auth close listener failed', err)
      }
    }
  })

  await win.loadURL(deepUrl)
}
