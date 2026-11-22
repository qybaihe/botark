import { Globe, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/components/ui/Status'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'

export function CueOverviewSection({ bot, account }: { bot: Bot; account?: BotAccount }) {
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const toggleWebSession = useBotStore((s) => s.toggleWebSession)
  const webSessionOpen = useBotStore((s) => s.webSessionOpen)

  if (!account) return null

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-hairline">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent-600" />
          <span className="text-[13px] font-semibold text-ink">Cue · Manus 智能体</span>
        </div>
        <StatusBadge status={account.status} />
      </div>
      <p className="text-[12px] text-ink-secondary">
        当前绑定账号：<span className="font-medium text-ink">{account.handle || account.displayName || account.id}</span>
        {bot.selectedAgentId ? ` · Agent: ${bot.selectedAgentId}` : ''}
      </p>
      {account.statusDetail && (
        <p className="text-[11.5px] text-status-error">{account.statusDetail}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => toggleWebSession()}>
          <Globe className="size-3.5" />
          {webSessionOpen ? '返回原生对话' : '打开 Cue 网页会话'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void syncCueAccountBots(account.id)}>
          <RefreshCw className="size-3.5" />
          同步 Agent
        </Button>
        {account.status !== 'online' && (
          <Button size="sm" variant="primary" onClick={() => void openCueLogin(account.id, false)}>
            重新登录
          </Button>
        )}
      </div>
    </div>
  )
}
