import {
  BrowserWindow,
  session as electronSession,
  shell,
  WebContentsView,
  type Rectangle
} from 'electron'
import type {
  CreateWebViewRequest,
  OpenInPartitionRequest,
  WebViewBounds,
  WebViewInfo
} from '@shared/ipc'
import { applyProxyToPartition } from './muse/accountProxy'
import { installGoogleOAuthHeaderGuard } from './googleOAuthUaGuard'

/**
 * Manages embedded platform web sessions for one window.
 *
 * Memory & Session Discipline:
 * - Only ONE WebContentsView is attached at a time; switching bots swaps the
 *   active view cleanly inside the same window.
 * - Detached views immediately enable `backgroundThrottling` and enter an LRU
 *   idle hibernation queue (keeping at most 1 warm detached view for 90s).
 *   Older idle views close their Chromium renderer process while preserving
 *   100% of their `persist:bothub-account-*` cookies & storage on disk.
 * - Popups (`window.open`) inside embedded views open in an authenticated
 *   in-app child BrowserWindow sharing the exact same account partition & proxy,
 *   never leaking or bouncing out to an unauthenticated OS browser.
 */

const IDLE_HIBERNATE_MS = 90_000
const MAX_WARM_DETACHED_VIEWS = 1

interface ManagedView {
  info: Omit<WebViewInfo, 'attached'>
  view: WebContentsView
  lastUsedAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  pinned?: boolean
}

export function webViewId(botId: string, accountId: string): string {
  return `${botId}::${accountId}`
}

export function partitionForAccount(accountId: string): string {
  return `persist:bothub-account-${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function placeholderPage(label: string, partition: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(label)}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#fafafb;color:#4a4a56;
       font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .card{max-width:380px;padding:28px 32px;text-align:center;background:#fff;border:1px solid #ebebef;
        border-radius:16px;box-shadow:0 6px 16px -6px rgb(23 23 28 / .08)}
  h1{margin:12px 0 6px;font-size:15px;color:#17171c}
  code{font:11px ui-monospace,Menlo,monospace;background:#f1f1f4;padding:2px 6px;border-radius:6px}
  .glyph{width:44px;height:44px;margin:0 auto;display:grid;place-items:center;border-radius:12px;
         background:#f4f4ff;color:#5f56df;font-weight:600;font-size:18px}
</style></head><body><div class="card">
  <div class="glyph">◎</div>
  <h1>${escapeHtml(label)}</h1>
  <p>This is an embedded WebContentsView running in its own session partition <code>${escapeHtml(partition)}</code>.</p>
</div></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function toRectangle(bounds: WebViewBounds): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  }
}

export class WebContentsViewManager {
  private readonly views = new Map<string, ManagedView>()
  private readonly childWindows = new Set<BrowserWindow>()
  private attachedId: string | null = null

  constructor(private readonly window: BrowserWindow) {
    window.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.detachAll()
    })
    window.on('closed', () => this.destroyAll())
  }

  create(request: CreateWebViewRequest): WebViewInfo {
    const viewId = webViewId(request.botId, request.accountId)
    const existing = this.views.get(viewId)
    if (existing) {
      existing.lastUsedAt = Date.now()
      if (request.url && isHttpUrl(request.url) && request.url !== existing.info.url) {
        existing.info.url = request.url
        if (!existing.view.webContents.isDestroyed()) {
          void existing.view.webContents.loadURL(request.url).catch(() => {})
        }
      }
      return this.describe(existing)
    }

    if (request.url !== undefined && !isHttpUrl(request.url)) {
      throw new Error(`Refusing to load non-http(s) URL: ${request.url}`)
    }

    const partition = partitionForAccount(request.accountId)
    const ses = electronSession.fromPartition(partition)
    installGoogleOAuthHeaderGuard(ses)
    void applyProxyToPartition(request.accountId).catch(() => {})

    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true
      }
    })
    view.setBackgroundColor('#ffffff')

    // Keep popups (cloud browser, vault login, OAuth) inside the account's isolated BotArk partition
    // and preserve `window.opener` via same-partition child BrowserWindows.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'about:blank' || isHttpUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1060,
            height: 740,
            minWidth: 680,
            minHeight: 480,
            parent: this.window.isDestroyed() ? undefined : this.window,
            title: 'BotArk 安全会话窗口',
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      }
      if (/^mailto:/i.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    view.webContents.on('did-create-window', (childWin) => {
      this.trackChildWindow(childWin, partition)
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    view.webContents.on('did-navigate', (_event, url) => {
      const m = this.views.get(viewId)
      if (m && isHttpUrl(url)) m.info.url = url
    })

    const url = request.url ?? placeholderPage(request.label ?? 'Web session', partition)
    void view.webContents.loadURL(url).catch((error: unknown) => {
      console.error(`[web-view ${viewId}] failed to load`, error)
    })

    const managed: ManagedView = {
      info: {
        viewId,
        botId: request.botId,
        accountId: request.accountId,
        partition,
        url: request.url ?? 'about:placeholder'
      },
      view,
      lastUsedAt: Date.now()
    }
    this.views.set(viewId, managed)
    this.evictExcessDetachedViews()
    return this.describe(managed)
  }

  /** Pin or unpin a view from automatic idle hibernation (used only for active DOM hook fallbacks). */
  setPinned(viewId: string, pinned: boolean): void {
    const managed = this.views.get(viewId)
    if (!managed) return
    managed.pinned = pinned
    if (pinned) {
      this.clearIdleTimer(managed)
      if (!managed.view.webContents.isDestroyed()) {
        managed.view.webContents.setBackgroundThrottling(false)
      }
    } else if (this.attachedId !== viewId) {
      this.scheduleIdleHibernate(managed)
    }
  }

  attach(viewId: string, bounds: WebViewBounds): WebViewInfo {
    const managed = this.require(viewId)
    this.clearIdleTimer(managed)
    managed.lastUsedAt = Date.now()
    if (!managed.view.webContents.isDestroyed()) {
      managed.view.webContents.setBackgroundThrottling(false)
    }
    if (this.attachedId && this.attachedId !== viewId) this.detach(this.attachedId)
    if (this.attachedId !== viewId) {
      this.window.contentView.addChildView(managed.view)
      this.attachedId = viewId
    }
    managed.view.setBounds(toRectangle(bounds))
    return this.describe(managed)
  }

  resize(viewId: string, bounds: WebViewBounds): void {
    if (this.attachedId !== viewId) return
    this.views.get(viewId)?.view.setBounds(toRectangle(bounds))
  }

  detach(viewId: string): void {
    const managed = this.views.get(viewId)
    if (!managed || this.attachedId !== viewId) return
    this.window.contentView.removeChildView(managed.view)
    this.attachedId = null
    managed.lastUsedAt = Date.now()
    if (!managed.pinned && !managed.view.webContents.isDestroyed()) {
      managed.view.webContents.setBackgroundThrottling(true)
    }
    this.evictExcessDetachedViews()
    this.scheduleIdleHibernate(managed)
  }

  detachAll(): void {
    if (this.attachedId) this.detach(this.attachedId)
  }

  navigate(viewId: string, url?: string): WebViewInfo {
    const managed = this.require(viewId)
    managed.lastUsedAt = Date.now()
    if (!managed.view.webContents.isDestroyed()) {
      if (url && isHttpUrl(url)) {
        managed.info.url = url
        void managed.view.webContents.loadURL(url).catch(() => {})
      } else {
        managed.view.webContents.reload()
      }
    }
    return this.describe(managed)
  }

  /**
   * Open an authenticated in-app child BrowserWindow sharing the account's isolated
   * partition & proxy — used for cloud browser views, credential vault forms, and OAuth popups.
   */
  async openInPartition(request: OpenInPartitionRequest): Promise<void> {
    if (!isHttpUrl(request.url)) return
    await applyProxyToPartition(request.accountId).catch(() => {})
    const partition = partitionForAccount(request.accountId)
    const ses = electronSession.fromPartition(partition)
    installGoogleOAuthHeaderGuard(ses)

    const popup = new BrowserWindow({
      width: 1060,
      height: 740,
      minWidth: 680,
      minHeight: 480,
      parent: this.window.isDestroyed() ? undefined : this.window,
      title: request.title || 'BotArk 安全会话窗口',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.trackChildWindow(popup, partition)

    await popup.loadURL(request.url).catch((err) => {
      console.warn('[web-view] openInPartition failed:', err instanceof Error ? err.message : err)
    })
  }

  private trackChildWindow(popup: BrowserWindow, partition: string): void {
    this.childWindows.add(popup)
    popup.on('closed', () => {
      this.childWindows.delete(popup)
    })
    popup.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'about:blank' || isHttpUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 540,
            height: 700,
            minWidth: 420,
            minHeight: 480,
            parent: popup.isDestroyed() ? (this.window.isDestroyed() ? undefined : this.window) : popup,
            title: 'BotArk 安全会话窗口',
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: {
              partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false
            }
          }
        }
      }
      if (/^mailto:/i.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    popup.webContents.on('did-create-window', (nested) => {
      this.trackChildWindow(nested, partition)
    })
    popup.webContents.on('will-navigate', (event, url) => {
      if (url !== 'about:blank' && !isHttpUrl(url)) {
        event.preventDefault()
      }
    })
  }

  destroy(viewId: string): void {
    const managed = this.views.get(viewId)
    if (!managed) return
    this.clearIdleTimer(managed)
    if (!this.window.isDestroyed()) this.detachIfAttached(viewId, managed)
    this.views.delete(viewId)
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close()
  }

  getView(viewId: string): WebContentsView | undefined {
    return this.views.get(viewId)?.view
  }

  async clearPartition(accountId: string): Promise<void> {
    const doomed = [...this.views.entries()].filter(([, m]) => m.info.accountId === accountId)
    for (const [viewId] of doomed) this.destroy(viewId)
    const partition = partitionForAccount(accountId)
    const ses = electronSession.fromPartition(partition)
    await ses.clearStorageData()
    await ses.clearCache()
  }

  destroyAll(): void {
    for (const popup of [...this.childWindows]) {
      if (!popup.isDestroyed()) popup.close()
    }
    this.childWindows.clear()
    for (const viewId of [...this.views.keys()]) this.destroy(viewId)
    this.attachedId = null
  }

  list(): WebViewInfo[] {
    return [...this.views.values()].map((managed) => this.describe(managed))
  }

  private detachIfAttached(viewId: string, managed: ManagedView): void {
    if (this.attachedId !== viewId) return
    this.window.contentView.removeChildView(managed.view)
    this.attachedId = null
  }

  private clearIdleTimer(managed: ManagedView): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer)
      managed.idleTimer = undefined
    }
  }

  private scheduleIdleHibernate(managed: ManagedView): void {
    this.clearIdleTimer(managed)
    if (managed.pinned) return
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = undefined
      if (this.attachedId !== managed.info.viewId && !managed.pinned) {
        this.destroy(managed.info.viewId)
      }
    }, IDLE_HIBERNATE_MS)
    managed.idleTimer.unref?.()
  }

  private evictExcessDetachedViews(): void {
    const candidates = [...this.views.values()]
      .filter((m) => m.info.viewId !== this.attachedId && !m.pinned)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    for (const stale of candidates.slice(MAX_WARM_DETACHED_VIEWS)) {
      this.destroy(stale.info.viewId)
    }
  }

  private require(viewId: string): ManagedView {
    const managed = this.views.get(viewId)
    if (!managed) throw new Error(`Unknown web view: ${viewId}`)
    return managed
  }

  private describe(managed: ManagedView): WebViewInfo {
    return { ...managed.info, attached: this.attachedId === managed.info.viewId }
  }
}
