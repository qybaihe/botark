import { registerSlackIpc, stopSlack } from './slack/slackIpc'
import { registerWorkspaceIpc, stopWorkspaces } from './mcp/hub'
import { registerWorkspacePortalIpc, stopWorkspacePortals } from './mcp/workspacePortal'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, autoUpdater, BrowserWindow, shell } from 'electron'
import { attachWebViewManager, registerWebViewIpc } from './webViewIpc'
import { attachMuseSessionManager, disposeAllMuseManagers, registerMuseIpc } from './muse/museIpc'
import { registerUpdaterIpc, startAutoUpdater } from './updater'
import { registerGrokIpc } from './grok/grokIpc'
import { stopGrokAccountWatch } from './grok/grokWatchManager'
import { registerHarkIpc } from './hark/harkIpc'
import { cancelHarkWatch } from './hark/harkClient'
import { registerDotIpc } from './dot/dotIpc'
import { closeCelsiusWatcher } from './dot/dotClient'
import { registerHermesIpc } from './hermes/hermesIpc'
import { cancelAllHermesRuns } from './hermes/hermesClient'
import { registerAntigravityIpc } from './antigravity/antigravityIpc'
import { cancelAllAntigravityRuns } from './antigravity/antigravityClient'
import { registerCueIpc } from './cue/cueIpc'
import { findCueCallbackArg, handleCueDesktopCallbackUrl } from './cue/cueDesktopHandoff'
import { stopCueAccountWatch } from './cue/cueWatchManager'
import { registerGeminiIpc, disposeGeminiIpc } from './gemini/geminiIpc'
import { registerDsBotIpc } from './dsbot/dsBotIpc'
import { cancelAllDsBotRuns } from './dsbot/dsBotClient'
import { registerMobileSyncIpc, stopMobileSyncServer } from './mobileSync/mobileSyncIpc'
import { applyAllStoredProxies } from './muse/accountProxy'
import { closeAllLocalProxyBridges } from './localProxyBridge'
import { hardenVaultFilePermissions, registerVaultIpc } from './securityVault'
import { getAppWindowIcon } from './appIcon'

try {
  app.commandLine?.appendSwitch?.('disable-blink-features', 'AutomationControlled')
} catch {
  /* ignore in test environments */
}

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null
let quitting = false
let readyForDeepLinks = false
const pendingCueCallbacks: string[] = []

if (isMac) {
  autoUpdater.on('before-quit-for-update', () => {
    quitting = true
  })
}

function dispatchCueCallback(rawUrl: string): void {
  if (!readyForDeepLinks) {
    pendingCueCallbacks.push(rawUrl)
    return
  }
  void handleCueDesktopCallbackUrl(rawUrl).catch((err) =>
    console.error('[cue] desktop callback failed', err instanceof Error ? err.message : err)
  )
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

// macOS delivers `cuedev://oauth/desktop-callback?...` via `open-url` instead of `second-instance`.
app.on('open-url', (event, url) => {
  if (!url.toLowerCase().startsWith('cuedev://')) return
  event.preventDefault()
  dispatchCueCallback(url)
})

// Seamless upgrade from legacy "bothub" userData directory: if an existing user
// already has accounts/sessions in Application Support/bothub and no new botark
// directory yet, preserve their exact userData directory automatically.
try {
  const appData = app.getPath('appData')
  const newUserData = join(appData, 'botark')
  const legacyUserData = join(appData, 'bothub')
  const legacyHasData =
    existsSync(join(legacyUserData, 'Partitions')) ||
    existsSync(join(legacyUserData, 'grok-sand-tokens.json'))
  const newHasData =
    existsSync(join(newUserData, 'Partitions')) ||
    existsSync(join(newUserData, 'grok-sand-tokens.json')) ||
    existsSync(join(newUserData, 'cue-tokens.json'))
  if (existsSync(legacyUserData) && (legacyHasData || !existsSync(newUserData)) && !newHasData) {
    app.setPath('userData', legacyUserData)
  }
} catch {
  /* ignore */
}

// Two instances share userData and race on every JSON store and on
// Chromium's profile; hand the second launch over to the first.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows delivers `cuedev://oauth/desktop-callback?...` (Cue browser login) as an argv entry.
    const cueCallback = findCueCallbackArg(argv)
    if (cueCallback) {
      dispatchCueCallback(cueCallback)
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (Array.isArray(argv) && argv.includes('--open-grok-login')) {
      void mainWindow.webContents
        .executeJavaScript("window.dispatchEvent(new CustomEvent('bothub:open-grok-login'))")
        .catch(() => undefined)
    }
  })
}

// A stray rejection or transient socket error in a timer/proxy/IPC handler
// should be logged cleanly instead of crashing the whole desktop workspace.
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : typeof reason
  console.error('[bothub] unhandled rejection:', text.slice(0, 300))
})
process.on('uncaughtException', (error) => {
  console.error('[bothub] uncaught exception:', `${error.name}: ${error.message}`.slice(0, 300))
})

function createMainWindow(): BrowserWindow {
  const windowIcon = getAppWindowIcon()
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 620,
    show: false,
    title: 'BotArk',
    backgroundColor: '#f7f7f8',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 28 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Built-in PDF viewer for previewed PDFs (blob: iframes in NativeDocumentDialog).
      plugins: true
    }
  })

  // Embedded platform web sessions (hidden until the renderer attaches one).
  const views = attachWebViewManager(win)
  attachMuseSessionManager(win, views)

  const showMainWindow = (): void => {
    if (win.isDestroyed()) return
    if (!win.isVisible()) win.show()
  }
  win.once('ready-to-show', showMainWindow)
  win.webContents.once('did-finish-load', showMainWindow)
  setTimeout(showMainWindow, 1500)

  // macOS: the red button hides the window instead of destroying it. A
  // re-created window used to start a second Muse session manager while the
  // old one kept its timers and gateways running (one leak per reopen).
  win.on('close', (event) => {
    if (isMac && !quitting) {
      event.preventDefault()
      // Hiding a fullscreen window leaves an empty black Space behind.
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => win.hide())
        win.setFullScreen(false)
      } else {
        win.hide()
      }
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Never open new Electron windows from the renderer; hand http(s) links to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The app is a single page: block navigations (e.g. a file dropped onto the
  // window) that would replace the UI. Reloads are not affected.
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  // Self-heal if Chromium's renderer process crashes or runs out of memory.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[bothub] renderer gone:', details.reason, 'exitCode=', details.exitCode)
    if (!quitting && !win.isDestroyed() && details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (!quitting && !win.isDestroyed()) win.webContents.reload()
      }, 600)
    }
  })
  win.on('unresponsive', () => {
    console.warn('[bothub] main window became unresponsive')
  })

  const wantGrokLogin = process.argv.includes('--open-grok-login')
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    const targetUrl = wantGrokLogin
      ? `${devUrl}${devUrl.includes('?') ? '&' : '?'}openGrokLogin=1`
      : devUrl
    void win.loadURL(targetUrl)
  } else {
    void win.loadFile(
      join(__dirname, '../renderer/index.html'),
      wantGrokLogin ? { query: { openGrokLogin: '1' } } : undefined
    )
  }

  return win
}

let shutdownStarted = false
let shutdownFinished = false

app.on('before-quit', (event) => {
  quitting = true
  if (shutdownFinished) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  stopGrokAccountWatch('*')
  closeCelsiusWatcher('*')
  cancelHarkWatch('*')
  cancelAllHermesRuns('*')
  cancelAllAntigravityRuns('*')
  disposeGeminiIpc()
  cancelAllDsBotRuns('*')
  stopCueAccountWatch('*')
  disposeAllMuseManagers()
  const cleanup = Promise.allSettled([
    stopSlack(),
    stopWorkspaces(),
    stopWorkspacePortals(),
    stopMobileSyncServer(),
    closeAllLocalProxyBridges()
  ])
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2500)
    timer.unref?.()
  })
  void Promise.race([cleanup, deadline]).finally(() => {
    shutdownFinished = true
    app.quit()
  })
})

app.whenReady().then(async () => {
  if (!gotLock) return
  hardenVaultFilePermissions()
  // Finish restoring the Chromium partitions before starting account clients.
  await applyAllStoredProxies()
  registerWebViewIpc()
  registerMuseIpc()
  registerUpdaterIpc()
  registerGrokIpc()
  registerHarkIpc()
  registerDotIpc()
  registerHermesIpc()
  registerAntigravityIpc()
  registerCueIpc()
  registerGeminiIpc(() => mainWindow)
  registerDsBotIpc()
  registerMobileSyncIpc()
  registerVaultIpc()
  registerWorkspaceIpc(() => mainWindow)
  registerWorkspacePortalIpc(() => mainWindow)
  registerSlackIpc(() => mainWindow)
  mainWindow = createMainWindow()
  readyForDeepLinks = true
  const initialCueCallback = findCueCallbackArg(process.argv)
  if (initialCueCallback) pendingCueCallbacks.push(initialCueCallback)
  while (pendingCueCallbacks.length > 0) {
    const nextUrl = pendingCueCallbacks.shift()
    if (nextUrl) dispatchCueCallback(nextUrl)
  }
  startAutoUpdater()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    else mainWindow = createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
