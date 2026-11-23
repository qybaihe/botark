import { useEffect, useRef } from 'react'
import { getPlatform } from '@adapters/platforms'
import { AlertCircle, ArrowLeft, ExternalLink, Globe, RotateCw } from 'lucide-react'
import { ArkShieldVaultSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useWebSessionView } from '@/hooks/useWebSessionView'
import { getBridge } from '@/lib/bridge'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'
import { t } from '@/lib/i18n'

interface WebSessionPaneProps {
  bot: Bot
  account: BotAccount
}

/**
 * Region covered by the native WebContentsView for the bot's active account,
 * with a top in-app navigation bar so users can jump into Cloud Browser /
 * Cloud Computer / Secure Vault cards and return to native chat in one click.
 */
export function WebSessionPane({ bot, account }: WebSessionPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const platform = getPlatform(bot.platformId)
  const targetUrl = useBotStore((s) => s.webSessionTargetUrl)
  const closeWebSession = useBotStore((s) => s.closeWebSession)
  const activeUrl = targetUrl || platform.homeUrl
  const viewId = `${bot.id}::${account.id}`

  const state = useWebSessionView({
    botId: bot.id,
    accountId: account.id,
    url: activeUrl,
    label: `${platform.name} · ${account.displayName}`,
    containerRef
  })
  const connectAccount = useBotStore((s) => s.connectAccount)

  // While the user interacts or logs in inside WebSessionPane, periodically probe account status
  // when offline/error so the header capsule & sidebar status dot immediately update to online.
  useEffect(() => {
    if (state.status !== 'ready') return
    if (account.status !== 'offline' && account.status !== 'error') return
    void connectAccount(account.id)
    const timer = setInterval(() => {
      const latest = useBotStore.getState().accounts[account.id]
      if (!latest || (latest.status !== 'offline' && latest.status !== 'error')) {
        clearInterval(timer)
        return
      }
      if (!latest.pending) {
        void useBotStore.getState().connectAccount(account.id)
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [state.status, account.id, account.status, connectAccount])

  const reloadView = () => {
    void getBridge()?.webViews?.navigate?.(viewId).then(() => connectAccount(account.id)).catch(() => undefined)
  }

  const openPopupWindow = () => {
    if (!activeUrl) return
    void getBridge()?.webViews?.openInPartition?.({
      accountId: account.id,
      url: activeUrl,
      title: `${platform.name} · ${account.displayName}`
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Sleek In-App Partition Control Strip (never covered by WebContentsView) */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line/60 bg-main px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button size="sm" variant="secondary" onClick={closeWebSession} className="h-7 px-2.5 text-[12px]">
            <ArrowLeft className="size-3.5" />
            返回原生对话
          </Button>
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface px-2.5 py-0.5 text-[11.5px] text-ink-secondary ring-1 ring-line/60">
            <ArkShieldVaultSvg className="size-3 text-status-online" />
            <span className="truncate">
              独立隔离会话 · {platform.name}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton size="sm" label="刷新原生页面" onClick={reloadView}>
            <RotateCw className="size-3.5" />
          </IconButton>
          <IconButton size="sm" label="在应用内独立安全窗口打开" onClick={openPopupWindow}>
            <ExternalLink className="size-3.5" />
          </IconButton>
        </div>
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="flex max-w-sm animate-veil-in flex-col items-center gap-2 px-6 text-center text-[13px] text-ink-muted">
          {state.status === 'unsupported' && (
            <>
              <Globe className="size-5 text-ink-faint" aria-hidden />
              <p>{t('Web sessions open in the desktop app')}</p>
            </>
          )}
          {state.status === 'loading' && (
            <p className="shimmer-text">{t('Opening {name}…', { name: platform.name })}</p>
          )}
          {state.status === 'error' && (
            <p className="flex items-center gap-2 text-status-error">
              <AlertCircle className="size-4" aria-hidden /> {state.message}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
