import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, LogOut, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { createId } from '@shared/id'
import type { DsBotAuthStatus, DsBotTransportMode } from '@shared/ipc'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import { DsBotConnectForm } from './DsBotConnectForm'

const MODE_BADGE: Record<DsBotTransportMode, string> = {
  mcp: 'MCP HTTP',
  relay: 'Noise 加密中继',
  channel: 'DSH Web SSE'
}

export function DsBotAccountsSettingsPanel() {
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const selectBot = useBotStore((s) => s.selectBot)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const syncDsBotAccountBots = useBotStore((s) => s.syncDsBotAccountBots)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)

  const dsAccounts = Object.values(accounts).filter((a) => a.platformId === 'ds-bot')
  const dsBots = bots.filter((b) => b.platformId === 'ds-bot')

  const [metaMap, setMetaMap] = useState<Record<string, DsBotAuthStatus>>({})
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [newAccountId, setNewAccountId] = useState(() => createId('acc'))
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()

  const refreshMeta = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.listAccounts) return
    try {
      const list = await dsBot.listAccounts()
      const next: Record<string, DsBotAuthStatus> = {}
      for (const item of list) next[item.accountId] = item
      setMetaMap(next)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshMeta()
  }, [refreshMeta])

  const handleConnected = async (status: DsBotAuthStatus) => {
    setError(undefined)
    const isEdit = Boolean(editingAccountId)
    try {
      const count = await syncDsBotAccountBots(status.accountId, {
        includeDismissed: true,
        selectFirst: !isEdit
      })
      setHint(
        isEdit
          ? `已更新 DS Bot 连接并同步 ${count} 个 Bot / 群聊`
          : `已接入 DS Bot「${status.displayName || status.hostName || 'DS Bot'}」，自动同步 ${count} 个 Bot / 群聊到侧栏`
      )
      setEditingAccountId(null)
      setNewAccountId(createId('acc'))
      await refreshMeta()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleResync = async (accountId: string) => {
    setSyncingId(accountId)
    setError(undefined)
    setHint(undefined)
    try {
      await connectAccount(accountId)
      const count = await syncDsBotAccountBots(accountId, { includeDismissed: true })
      setHint(`已重新同步该 DS Bot 团队下的 ${count} 个 Bot / 群聊`)
      await refreshMeta()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncingId(null)
    }
  }

  const handleRemoveAccount = async (accountId: string) => {
    const ownedBots = dsBots.filter((b) => b.accountIds.includes(accountId))
    await signOutAccount(accountId)
    for (const bot of ownedBots) {
      await removeBot(bot.id)
    }
    await refreshMeta()
    setHint('已断开并移除该 DS Bot 实例')
  }

  const editingMeta = editingAccountId ? metaMap[editingAccountId] : undefined

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">DS Bot 团队接入管理</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            原生接入开源 Fei-Craft/DS-Bot，支持自动展开团队全部 Bot 与群聊、实时流式、审批与长期记忆
          </p>
        </div>
      </div>

      {hint && (
        <div className="flex items-center gap-2 rounded-xl border border-status-online/30 bg-status-online/8 px-3.5 py-2.5 text-[12.5px] text-status-online-ink">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{hint}</span>
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-status-error/30 bg-status-error/8 px-3.5 py-2.5 text-[12.5px] text-status-error">
          {error}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <DsBotConnectForm
          key={editingAccountId ?? newAccountId}
          accountId={editingAccountId ?? newAccountId}
          initialMode={editingMeta?.mode ?? 'mcp'}
          initialDisplayName={editingMeta?.displayName ?? ''}
          initialEndpointUrl={editingMeta?.baseUrl}
          isEdit={Boolean(editingAccountId)}
          hasExistingSecret={Boolean(editingMeta?.hasSecret)}
          onConnected={(st) => void handleConnected(st)}
          onCancel={editingAccountId ? () => setEditingAccountId(null) : undefined}
        />
      </div>

      {dsAccounts.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <h3 className="text-[13px] font-semibold text-ink-secondary">
            已连接的 DS Bot 团队（{dsAccounts.length}）
          </h3>
          {dsAccounts.map((acc) => {
            const meta = metaMap[acc.id]
            const ownedBots = dsBots.filter((b) => b.accountIds.includes(acc.id))
            const isSyncing = syncingId === acc.id
            return (
              <div
                key={acc.id}
                className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-4 shadow-soft"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <StatusDot status={acc.status} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-semibold text-ink">
                          {acc.label || acc.displayName || meta?.hostName || 'DS Bot'}
                        </span>
                        {meta?.mode && (
                          <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[10.5px] font-medium text-accent-600">
                            {MODE_BADGE[meta.mode]}
                          </span>
                        )}
                        {meta?.version && (
                          <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">
                            v{meta.version}
                          </span>
                        )}
                      </div>
                      <p className="truncate font-mono text-[11.5px] text-ink-muted">
                        {acc.handle || meta?.baseUrl || meta?.relayServer || acc.id} · {ownedBots.length} 个已同步对话
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={isSyncing}
                      onClick={() => void handleResync(acc.id)}
                    >
                      <RefreshCw className={cn('size-3.5', isSyncing && 'animate-spin')} />
                      同步团队
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingAccountId(acc.id)}
                    >
                      <Pencil className="size-3.5" />
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void signOutAccount(acc.id)}
                    >
                      <LogOut className="size-3.5" />
                      断开
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-status-error hover:bg-status-error/10"
                      onClick={() => void handleRemoveAccount(acc.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {ownedBots.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 border-t border-line/70 pt-2.5">
                    {ownedBots.map((bot) => (
                      <button
                        key={bot.id}
                        type="button"
                        onClick={() => selectBot(bot.id)}
                        className="rounded-lg border border-line bg-main px-2.5 py-1 text-[12px] text-ink hover:bg-hover"
                      >
                        {bot.selectedAgentId?.startsWith('room:') ? '👥 ' : '🐋 '}
                        {bot.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
