import { useCallback, useEffect, useRef, useState } from 'react'
import type { GrokServiceId } from '@shared/ipc'
import { adapterRegistry } from '@adapters/registry'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'

async function callGrok(
  accountId: string,
  method: string,
  params: Record<string, unknown> = {},
  service?: GrokServiceId
): Promise<unknown> {
  const grok = getBridge()?.grok
  if (!grok?.rpc) throw new Error('Grok IPC unavailable')
  const res = await grok.rpc({ accountId, op: 'call', service, method, params })
  if (!res.ok) throw new Error(res.message || `HTTP ${res.status}`)
  return res.data
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/**
 * Grok Bot Account Login & Credential Import Card for the Right-Side Inspector.
 * Shown automatically when the Grok account is offline or needs re-authentication,
 * and offers 1-click Bot roster sync when online.
 */
export function GrokAccountAuthSection({ accountId }: { accountId: string }) {
  const account = useBotStore((s) => s.accounts[accountId])
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const setGrokAccessToken = useBotStore((s) => s.setGrokAccessToken)
  const syncGrokAccountBots = useBotStore((s) => s.syncGrokAccountBots)
  const botCount = useBotStore(
    (s) => s.bots.filter((b) => b.platformId === 'grok' && b.accountIds.includes(accountId)).length
  )

  const [showPaste, setShowPaste] = useState(false)
  const [rawToken, setRawToken] = useState('')
  const [rawRefresh, setRawRefresh] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [hint, setHint] = useState<string>()

  const isOnline = account?.status === 'online' || account?.status === 'busy'

  const handleImport = async () => {
    if (!rawToken.trim()) return
    setBusy(true)
    setErr(undefined)
    setHint(undefined)
    try {
      await setGrokAccessToken(
        accountId,
        rawToken.trim(),
        undefined,
        undefined,
        rawRefresh.trim() || undefined
      )
      const latest = useBotStore.getState().accounts[accountId]
      if (latest?.status === 'error') {
        setErr(latest.statusDetail || '凭据验证失败')
        return
      }
      setRawToken('')
      setRawRefresh('')
      setShowPaste(false)
      setHint('凭据已生效，已自动同步该账号下的全部 Bot')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSyncAll = async () => {
    setBusy(true)
    setErr(undefined)
    setHint(undefined)
    try {
      const total = await syncGrokAccountBots(accountId, { includeDismissed: true })
      setHint(`已同步 ${total} 个 Bot 到左侧列表`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (isOnline && !showPaste && !hint && !err) {
    return (
      <Section
        title="Grok 账号"
        action={
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleSyncAll()}>
            同步全部 Bot ({botCount})
          </Button>
        }
      >
        <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-secondary">
          <span className="truncate font-mono text-[11.5px] text-ink">
            {account?.handle || account?.displayName || '已连接'}
          </span>
          <button
            type="button"
            onClick={() => setShowPaste(true)}
            className="shrink-0 text-[11.5px] text-ink-muted hover:text-ink"
          >
            更换凭据
          </button>
        </div>
      </Section>
    )
  }

  return (
    <Section title="Grok Bot 账号登录与导入">
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || account?.pending}
            onClick={() => void openGrokLogin(accountId, false)}
          >
            登录窗口
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || account?.pending}
            onClick={() => void openGrokLogin(accountId, true)}
          >
            默认浏览器授权
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setShowPaste((v) => !v)}
          >
            {showPaste ? '收起' : '粘贴凭据'}
          </Button>
        </div>

        {(showPaste || !isOnline) && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <textarea
              value={rawToken}
              onChange={(e) => setRawToken(e.target.value)}
              placeholder="粘贴 Access Token (eyJ...)、Cookie (WorkosCursorSessionToken=...)、JSON 或 API Key…"
              rows={2}
              spellCheck={false}
              className="block w-full resize-none rounded-lg border border-line bg-surface p-2 font-mono text-[11.5px] text-ink outline-none focus:border-accent-600"
            />
            {rawToken.trim() && (
              <div className="flex items-center gap-1.5">
                <TextInput
                  value={rawRefresh}
                  onChange={(e) => setRawRefresh(e.target.value)}
                  placeholder="可选：Refresh Token"
                  className="flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !rawToken.trim()}
                  onClick={() => void handleImport()}
                >
                  {busy ? '导入中…' : '导入并同步'}
                </Button>
              </div>
            )}
          </div>
        )}

        {account?.status === 'error' && account.statusDetail && !err && (
          <p className="text-[12px] text-status-error">{account.statusDetail}</p>
        )}
        {err && <p className="text-[12px] text-status-error">{err}</p>}
        {hint && <p className="text-[12px] text-status-online-ink">{hint}</p>}
      </div>
    </Section>
  )
}

/**
 * 0. Grok Bot Agent & Room Roster Manager + Template Recipe Import/Export + Full-Text Search
 * (`CreateGrokBotAgent`, `UpdateGrokBotAgent`, `DuplicateGrokBotAgent`, `DeleteGrokBotAgent`,
 *  `CreateGrokBotRoom`, `SearchGrokBotTranscripts`, `exportRecipe` / `importRecipe`)
 */
export function GrokAgentsAndRoomsSection({
  accountId,
  agentId,
  botId
}: {
  accountId: string
  agentId?: string
  botId: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const setSelectedAgent = useBotStore((s) => s.setSelectedAgent)
  const selectBot = useBotStore((s) => s.selectBot)
  const syncGrokAccountBots = useBotStore((s) => s.syncGrokAccountBots)
  const addBot = useBotStore((s) => s.addBot)
  const accounts = useBotStore((s) => s.accounts)

  const [agents, setAgents] = useState<
    Array<{ id: string; name: string; isGroup: boolean; description?: string }>
  >([])
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [roomName, setRoomName] = useState('')
  const [roomMemberIds, setRoomMemberIds] = useState<string[]>([])
  const [composerDrawer, setComposerDrawer] = useState<'none' | 'agent' | 'room'>('none')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ id: string; snippet: string }>>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()
  const recipeInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const adapter = adapterRegistry.get('grok') as {
        refreshAgents?: (id: string) => Promise<
          Array<{ id: string; name: string; isGroup?: boolean; description?: string }>
        >
      }
      const list = (await adapter?.refreshAgents?.(accountId)) ?? []
      setAgents(
        list.map((a) => ({
          id: a.id,
          name: a.name,
          isGroup: Boolean(a.isGroup),
          description: a.description
        }))
      )
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const createAgent = async () => {
    if (!newName.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const newId = crypto.randomUUID()
      await callGrok(accountId, 'CreateGrokBotAgent', {
        legacy_agent_id: newId,
        agent_id: newId,
        name: newName.trim(),
        title: newName.trim(),
        description: newDesc.trim(),
        avatar_shape: 'sparkle',
        avatar_color: 'violet',
        harness: 2, // TEMPORAL
        create_intent: 1, // FRESH
        create_caller: 5 // PRODUCT_CREATE
      })
      setNewName('')
      setNewDesc('')
      setComposerDrawer('none')
      await refresh()
      await syncGrokAccountBots(accountId, { includeDismissed: true })
      const createdBot = useBotStore
        .getState()
        .bots.find((b) => b.platformId === 'grok' && b.selectedAgentId === newId)
      if (createdBot) selectBot(createdBot.id)
      else setSelectedAgent(botId, newId)
      setHint('已创建新 Bot 并同步到左侧列表')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const duplicateCurrent = async () => {
    if (!agentId) return
    setBusy(true)
    setError(undefined)
    try {
      const dupId = crypto.randomUUID()
      await callGrok(accountId, 'DuplicateGrokBotAgent', {
        source_agent_id: agentId,
        agent_id: dupId
      })
      await refresh()
      await syncGrokAccountBots(accountId, { includeDismissed: true })
      const dupBot = useBotStore
        .getState()
        .bots.find((b) => b.platformId === 'grok' && b.selectedAgentId === dupId)
      if (dupBot) selectBot(dupBot.id)
      setHint('已克隆为独立 Bot 并同步到左侧列表')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteAgent = async (targetId: string) => {
    setBusy(true)
    setError(undefined)
    try {
      await callGrok(accountId, 'DeleteGrokBotAgent', { id: targetId })
      await refresh()
      setHint('已删除该 Agent')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pinAgentAsSidebarBot = (a: { id: string; name: string }) => {
    const acc = accounts[accountId]
    const createdBotId = `bot_grok_${a.id.slice(0, 8)}_${Date.now().toString(36)}`
    addBot({
      id: createdBotId,
      platformId: 'grok',
      name: a.name,
      emoji: '✦',
      accounts: [
        {
          key: accountId,
          accountId,
          displayName: acc?.displayName || 'Grok account',
          handle: acc?.handle || accountId
        }
      ],
      background: false
    })
    setTimeout(() => setSelectedAgent(createdBotId, a.id), 30)
  }

  const createRoom = async () => {
    if (!roomName.trim() || roomMemberIds.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      const roomId = crypto.randomUUID()
      await callGrok(accountId, 'CreateGrokBotRoom', {
        agent_id: roomId,
        name: roomName.trim(),
        description: 'BotArk Group Room',
        member_agent_ids: roomMemberIds,
        human_member_user_ids: []
      })
      setRoomName('')
      setRoomMemberIds([])
      setComposerDrawer('none')
      await refresh()
      await syncGrokAccountBots(accountId, { includeDismissed: true })
      const roomBot = useBotStore
        .getState()
        .bots.find((b) => b.platformId === 'grok' && b.selectedAgentId === roomId)
      if (roomBot) selectBot(roomBot.id)
      setHint('已创建群聊房间并同步到左侧列表')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const exportRecipe = async () => {
    if (!agentId) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    setBusy(true)
    try {
      const res = await grok.rpc({ accountId, op: 'exportRecipe', agentId })
      if (!res.ok) throw new Error(res.message)
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: 'application/json;charset=utf-8'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `grokbot-recipe-${agentId.slice(0, 8)}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
      setHint('已导出当前 Agent Recipe JSON')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onRecipeSelected = async (file: File | undefined) => {
    if (!file) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    setBusy(true)
    setError(undefined)
    try {
      const recipeJson = await file.text()
      const res = await grok.rpc({ accountId, op: 'importRecipe', recipeJson })
      if (!res.ok) throw new Error(res.message)
      const out = asObj(res.data)
      await refresh()
      if (typeof out?.['agentId'] === 'string') {
        setSelectedAgent(botId, out['agentId'])
      }
      setHint('已成功导入 Recipe 并创建新 Agent')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runSearch = async () => {
    if (!searchQuery.trim()) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await grok.rpc({
        accountId,
        op: 'searchTranscripts',
        query: searchQuery.trim(),
        agentId,
        limit: 12
      })
      if (!res.ok) throw new Error(res.message)
      const d = asObj(res.data) || {}
      const matches = Array.isArray(d['messageMatches'] ?? d['message_matches'])
        ? ((d['messageMatches'] ?? d['message_matches']) as unknown[])
        : []
      setSearchResults(
        matches.map((m, i) => {
          const r = asObj(m) || {}
          return {
            id: str(r['entryId'] ?? r['entry_id'] ?? i),
            snippet: str(r['snippet'] ?? r['text'] ?? JSON.stringify(r))
          }
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Agents · 房间 · 配方"
      count={agents.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2.5 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-ink-secondary">{hint}</p>}

        {/* Agent Roster */}
        {agents.length > 0 && (
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-surface p-1.5">
            {agents.map((a) => {
              const active = a.id === agentId
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-1.5 rounded-md px-2 py-1 hover:bg-hover/60"
                >
                  <button
                    type="button"
                    onClick={() => setSelectedAgent(botId, a.id)}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    <span className={active ? 'font-semibold text-accent-600' : 'text-ink'}>
                      {a.isGroup ? `👥 ${a.name}` : a.name}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => pinAgentAsSidebarBot(a)}
                      title="作为独立会话固定到左侧栏"
                      className="rounded px-1.5 py-0.5 text-[10.5px] text-ink-secondary hover:bg-hover hover:text-ink"
                    >
                      独立栏
                    </button>
                    {agents.length > 1 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void deleteAgent(a.id)}
                        className="rounded px-1 text-[10.5px] text-ink-muted hover:text-status-error"
                      >
                        删除
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {/* Compact Agent & Room Action Bar + On-Demand Drawers */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface/60 p-2">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant={composerDrawer === 'agent' ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() =>
                setComposerDrawer((cur) => (cur === 'agent' ? 'none' : 'agent'))
              }
            >
              + 新建 Agent
            </Button>
            {agents.filter((a) => !a.isGroup).length >= 2 && (
              <Button
                size="sm"
                variant={composerDrawer === 'room' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() =>
                  setComposerDrawer((cur) => (cur === 'room' ? 'none' : 'room'))
                }
              >
                + 群聊房间
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !agentId}
              onClick={() => void duplicateCurrent()}
            >
              克隆当前
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !agentId}
              onClick={() => void exportRecipe()}
            >
              导出配方
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => recipeInputRef.current?.click()}
            >
              导入配方
            </Button>
            <input
              ref={recipeInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                void onRecipeSelected(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>

          {composerDrawer === 'agent' && (
            <div className="mt-1 flex animate-veil-in flex-col gap-1.5 border-t border-line/70 pt-2">
              <p className="text-[11px] font-medium text-ink-secondary">新建 Grok Agent</p>
              <TextInput
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Agent 名称 (如 Research Copilot)"
                className="h-7 text-[12px]"
              />
              <TextInput
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="职责描述 (可选)"
                className="h-7 text-[12px]"
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setComposerDrawer('none')}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !newName.trim()}
                  onClick={() => void createAgent()}
                >
                  立即创建
                </Button>
              </div>
            </div>
          )}

          {composerDrawer === 'room' && agents.filter((a) => !a.isGroup).length >= 2 && (
            <div className="mt-1 flex animate-veil-in flex-col gap-1.5 border-t border-line/70 pt-2">
              <p className="text-[11px] font-medium text-ink-secondary">创建多 Bot 群聊房间 (Room)</p>
              <TextInput
                autoFocus
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="群聊房间名称…"
                className="h-7 text-[12px]"
              />
              <div className="flex flex-wrap gap-1">
                {agents
                  .filter((a) => !a.isGroup)
                  .map((a) => {
                    const picked = roomMemberIds.includes(a.id)
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() =>
                          setRoomMemberIds((prev) =>
                            picked ? prev.filter((x) => x !== a.id) : [...prev, a.id]
                          )
                        }
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          picked
                            ? 'border-accent bg-accent-50 text-accent-600'
                            : 'border-line text-ink-secondary'
                        }`}
                      >
                        {a.name}
                      </button>
                    )
                  })}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setComposerDrawer('none')}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !roomName.trim() || roomMemberIds.length === 0}
                  onClick={() => void createRoom()}
                >
                  创建房间
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Transcript Search */}
        <div className="flex gap-1.5">
          <TextInput
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索云端抄本记录…"
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !searchQuery.trim()}
            onClick={() => void runSearch()}
          >
            搜索
          </Button>
        </div>
        {searchResults.length > 0 && (
          <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-lg bg-sunken p-2 text-[11px]">
            {searchResults.map((r) => (
              <li key={r.id} className="line-clamp-2 text-ink-secondary">
                {r.snippet}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 1. Grok Bot Sessions & Conversation Controls
 * (`ListGrokBotAgentSessions`, `StartFreshGrokBotConversation`, `RollBackGrokBotConversation`)
 */
export function GrokSessionsSection({
  accountId,
  agentId,
  botId
}: {
  accountId: string
  agentId?: string
  botId: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const setSelectedAgent = useBotStore((s) => s.setSelectedAgent)
  const [sessions, setSessions] = useState<
    Array<{ sessionId: string; kind: string; updatedAtMs: number }>
  >([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()

  const refresh = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const raw = await callGrok(accountId, 'ListGrokBotAgentSessions', { agent_id: agentId })
      const o = asObj(raw) || {}
      const list = Array.isArray(o['sessions']) ? o['sessions'] : []
      setSessions(
        list.map((s) => {
          const r = asObj(s) || {}
          return {
            sessionId: str(r['sessionId'] ?? r['session_id']),
            kind: str(r['kind'] ?? 'main'),
            updatedAtMs: Number(r['updatedAtMs'] ?? r['updated_at_ms'] ?? 0)
          }
        })
      )
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const startFresh = async () => {
    if (!agentId) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      await callGrok(accountId, 'StartFreshGrokBotConversation', { agent_id: agentId })
      setHint('已开启新对话')
      setSelectedAgent(botId, agentId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const rollBack = async () => {
    if (!agentId) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      await callGrok(accountId, 'RollBackGrokBotConversation', { agent_id: agentId })
      setHint('已回滚上一轮对话')
      setSelectedAgent(botId, agentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="会话与控制"
      count={sessions.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-ink-secondary">{hint}</p>}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !agentId}
            onClick={() => void startFresh()}
          >
            + 开启新对话
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !agentId}
            onClick={() => void rollBack()}
          >
            回滚上一轮
          </Button>
        </div>
        {sessions.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {sessions.slice(0, 6).map((s) => (
              <li
                key={s.sessionId || 'main'}
                className="flex items-center justify-between rounded-md px-2 py-1 text-[11.5px] hover:bg-hover/60"
              >
                <span className="truncate text-ink">{s.sessionId || 'main'}</span>
                <span className="text-ink-muted">{s.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 1b. Grok Bot Tasks & Live Subagents
 * (`ListGrokBotAgentTasks`, `MarkGrokBotAgentTaskDone`, `ListGrokBotSubagents`)
 */
export function GrokTasksAndSubagentsSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [tasks, setTasks] = useState<
    Array<{ id: string; title: string; status: string; done: boolean }>
  >([])
  const [subagents, setSubagents] = useState<Array<{ id: string; title: string; state: string }>>(
    []
  )
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    try {
      const [tRaw, sRaw] = await Promise.all([
        callGrok(accountId, 'ListGrokBotAgentTasks', {
          agent_id: agentId,
          include_recently_done: true
        }).catch(() => null),
        callGrok(accountId, 'ListGrokBotSubagents', { agent_id: agentId }).catch(() => null)
      ])
      const tList = Array.isArray(asObj(tRaw)?.['tasks'])
        ? (asObj(tRaw)!['tasks'] as unknown[])
        : []
      setTasks(
        tList
          .map((item, idx) => {
            const r = asObj(item) || {}
            const st = str(r['status'] ?? r['state'])
            return {
              id: str(r['taskId'] ?? r['task_id'] ?? r['id'] ?? idx),
              title: str(r['title'] ?? r['description'] ?? r['name']),
              status: st,
              done: Boolean(r['done'] ?? r['isDone'] ?? /done|completed/i.test(st))
            }
          })
          .filter((x) => x.title)
      )

      const sList = Array.isArray(asObj(sRaw)?.['subagents'])
        ? (asObj(sRaw)!['subagents'] as unknown[])
        : []
      setSubagents(
        sList
          .map((item, idx) => {
            const r = asObj(item) || {}
            return {
              id: str(r['subagentId'] ?? r['subagent_id'] ?? r['sessionId'] ?? idx),
              title: str(r['title'] ?? r['goal'] ?? r['name'] ?? 'Subagent'),
              state: str(r['status'] ?? r['activity'] ?? 'running')
            }
          })
          .filter((x) => x.title)
      )
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const markDone = async (taskId: string) => {
    if (!agentId) return
    await callGrok(accountId, 'MarkGrokBotAgentTaskDone', {
      agent_id: agentId,
      task_id: taskId
    }).catch(() => undefined)
    await refresh()
  }

  return (
    <Section
      title="后台任务与子代理"
      count={tasks.length + subagents.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {subagents.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-medium text-ink-secondary">运行中子代理</p>
            {subagents.map((sa) => (
              <div
                key={sa.id}
                className="flex items-center justify-between rounded-md bg-accent-50/60 px-2 py-1 text-[11.5px]"
              >
                <span className="truncate font-medium text-ink">🤖 {sa.title}</span>
                <span className="text-accent-600">{sa.state}</span>
              </div>
            ))}
          </div>
        )}
        {tasks.length === 0 && subagents.length === 0 ? (
          <EmptyLine>当前无运行中任务或子代理</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-2 py-1.5"
              >
                <span className={`min-w-0 truncate ${task.done ? 'text-ink-muted line-through' : 'text-ink'}`}>
                  {task.title}
                </span>
                {!task.done && (
                  <Button size="sm" variant="ghost" onClick={() => void markDone(task.id)}>
                    完成
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 2. Grok Bot Automations & Routines
 * (`ListGrokBotAgentAutomations`, `ListGrokBotAgentRoutines`, `SetGrokBotAgentAutomationEnabled`, `DeleteGrokBotAgentAutomation`)
 */
export function GrokAutomationsSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [items, setItems] = useState<
    Array<{
      id: string
      name: string
      schedule: string
      isEnabled: boolean
      isRoutine?: boolean
      prompt?: string
    }>
  >([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const [autoRaw, routineRaw] = await Promise.all([
        callGrok(accountId, 'ListGrokBotAgentAutomations', { agent_id: agentId }).catch(() => null),
        callGrok(accountId, 'ListGrokBotAgentRoutines', { agent_id: agentId }).catch(() => null)
      ])
      const list = Array.isArray(asObj(autoRaw)?.['automations'])
        ? (asObj(autoRaw)!['automations'] as unknown[])
        : []
      const routines = Array.isArray(asObj(routineRaw)?.['routines'])
        ? (asObj(routineRaw)!['routines'] as unknown[])
        : []
      const parsed: typeof items = []
      const seen = new Set<string>()

      for (const item of list) {
        const row = asObj(item) || {}
        let rec = row
        if (typeof row['recordJson'] === 'string' || typeof row['record_json'] === 'string') {
          try {
            rec = {
              ...row,
              ...(JSON.parse(str(row['recordJson'] ?? row['record_json'])) as Record<
                string,
                unknown
              >)
            }
          } catch {
            /* ignore */
          }
        }
        const id = str(rec['id'] ?? row['automationId'] ?? row['automation_id'])
        if (!id || seen.has(id)) continue
        seen.add(id)
        parsed.push({
          id,
          name: str(rec['name'] ?? rec['title'] ?? id),
          schedule: str(rec['triggerDescription'] ?? rec['schedule'] ?? 'Scheduled'),
          isEnabled: rec['isEnabled'] !== false && rec['is_enabled'] !== false,
          prompt: str(rec['prompt']) || undefined
        })
      }

      for (const r of routines) {
        const row = asObj(r) || {}
        const id = str(row['automationId'] ?? row['automation_id'] ?? row['id'])
        if (!id || seen.has(id)) continue
        seen.add(id)
        parsed.push({
          id,
          name: str(row['name'] ?? row['title'] ?? id),
          schedule: str(row['scheduleDescription'] ?? row['schedule'] ?? 'Routine'),
          isEnabled: row['isEnabled'] !== false && row['is_enabled'] !== false,
          isRoutine: true
        })
      }

      setItems(parsed)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const toggleEnabled = async (id: string, isEnabled: boolean, isRoutine?: boolean) => {
    if (!agentId) return
    setBusyId(id)
    try {
      await callGrok(
        accountId,
        isRoutine ? 'SetGrokBotAgentRoutineEnabled' : 'SetGrokBotAgentAutomationEnabled',
        {
          agent_id: agentId,
          automation_id: id,
          is_enabled: isEnabled
        }
      )
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const removeAutomation = async (id: string) => {
    if (!agentId) return
    setBusyId(id)
    try {
      await callGrok(accountId, 'DeleteGrokBotAgentAutomation', {
        agent_id: agentId,
        automation_id: id
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <Section
      title="定时任务与例程"
      count={items.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2">
        {error && <p className="text-[12px] text-status-error">{error}</p>}
        {items.length === 0 ? (
          <EmptyLine>暂无定时任务或例程</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {items.map((a) => (
              <li
                key={a.id}
                className="rounded-lg border border-line bg-surface p-2.5 text-[12px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">{a.name}</span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-ink-secondary">
                    {a.isEnabled ? t('Active') : t('Paused')}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted">{a.schedule}</p>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === a.id}
                    onClick={() => void toggleEnabled(a.id, !a.isEnabled, a.isRoutine)}
                  >
                    {a.isEnabled ? '暂停' : '启用'}
                  </Button>
                  {!a.isRoutine && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === a.id}
                      onClick={() => void removeAutomation(a.id)}
                    >
                      {t('Delete')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 3. Grok Bot Cloud Memories & Skills
 * (`ListGrokBotUserBotMemories`, `ListGrokBotAgentSkills`, `AddGrokBotAgentSkill`, `UpdateGrokBotAgentSkill`, `RemoveGrokBotAgentSkill`)
 */
export function GrokMemoriesAndSkillsSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [memories, setMemories] = useState<Array<{ factId: string; text: string }>>([])
  const [skills, setSkills] = useState<Array<{ name: string; description: string; body: string }>>(
    []
  )
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillContent, setNewSkillContent] = useState('')
  const [editingSkill, setEditingSkill] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const [memRaw, skRaw] = await Promise.all([
        callGrok(accountId, 'ListGrokBotUserBotMemories', { agent_id: agentId }).catch(() => null),
        callGrok(accountId, 'ListGrokBotAgentSkills', { agent_id: agentId }).catch(() => null)
      ])
      const mObj = asObj(memRaw) || {}
      const mList = Array.isArray(mObj['memories']) ? mObj['memories'] : []
      setMemories(
        mList
          .map((m, idx) => {
            const r = asObj(m) || {}
            return {
              factId: str(r['factId'] ?? r['fact_id'] ?? idx),
              text: str(r['text'] ?? r['content'])
            }
          })
          .filter((x) => x.text)
      )

      const sObj = asObj(skRaw) || {}
      const sList = Array.isArray(sObj['skills']) ? sObj['skills'] : []
      setSkills(
        sList
          .map((s) => {
            const r = asObj(s) || {}
            return {
              name: str(r['name'] ?? r['id']),
              description: str(r['description']),
              body: str(r['body'] ?? r['content'])
            }
          })
          .filter((x) => x.name)
      )
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const saveSkill = async () => {
    if (!agentId || !newSkillName.trim() || !newSkillContent.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      if (editingSkill) {
        await callGrok(accountId, 'UpdateGrokBotAgentSkill', {
          agent_id: agentId,
          name: newSkillName.trim(),
          content: newSkillContent.trim()
        })
      } else {
        await callGrok(accountId, 'AddGrokBotAgentSkill', {
          agent_id: agentId,
          name: newSkillName.trim(),
          content: newSkillContent.trim()
        })
      }
      setEditingSkill(null)
      setNewSkillName('')
      setNewSkillContent('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeSkill = async (name: string) => {
    if (!agentId) return
    setBusy(true)
    try {
      await callGrok(accountId, 'RemoveGrokBotAgentSkill', { agent_id: agentId, name })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section
        title="云端记忆"
        count={memories.length || undefined}
        action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
      >
        <div className="flex flex-col gap-1.5">
          {memories.length === 0 ? (
            <EmptyLine>暂无云端记忆</EmptyLine>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {memories.map((m) => (
                <li
                  key={m.factId}
                  className="rounded-lg bg-hover/50 px-2.5 py-1.5 text-[12px] text-ink"
                >
                  {m.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        title="技能"
        count={skills.length || undefined}
        action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
      >
        <div className="flex flex-col gap-2">
          {error && <p className="text-[12px] text-status-error">{error}</p>}
          <div className="flex flex-col gap-1.5">
            <TextInput
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
              disabled={Boolean(editingSkill)}
              placeholder="技能名称 (如 code-review)"
              aria-label="Skill name"
              className="h-7 text-[12px]"
            />
            <textarea
              value={newSkillContent}
              onChange={(e) => setNewSkillContent(e.target.value)}
              placeholder="技能指令内容…"
              rows={2}
              className="w-full resize-none rounded-lg border border-line bg-canvas p-2 text-[12px] text-ink outline-none"
            />
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !newSkillName.trim() || !newSkillContent.trim()}
                onClick={() => void saveSkill()}
              >
                {editingSkill ? '保存修改' : '添加技能'}
              </Button>
              {editingSkill && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingSkill(null)
                    setNewSkillName('')
                    setNewSkillContent('')
                  }}
                >
                  取消
                </Button>
              )}
            </div>
          </div>
          {skills.length === 0 ? (
            <EmptyLine>暂无技能</EmptyLine>
          ) : (
            <ul className="flex flex-col gap-1 border-t border-line pt-2">
              {skills.map((s) => (
                <li
                  key={s.name}
                  className="flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 text-[12px] hover:bg-hover/60"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{s.name}</p>
                    {s.description && (
                      <p className="text-[11px] text-ink-secondary">{s.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditingSkill(s.name)
                        setNewSkillName(s.name)
                        setNewSkillContent(s.body)
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void removeSkill(s.name)}
                    >
                      {t('Delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </>
  )
}

/**
 * 3b. Grok Bot MCP & Connectors (User MCP + Agent Custom MCP + Email Inbox)
 * (`GetGrokBotUserMcpSettings`, `SetGrokBotUserMcpSettings`,
 *  `GetGrokBotAgentCustomMcp`, `UpdateGrokBotAgentCustomMcp`,
 *  `CreateGrokBotEmailInbox`, `ListGrokBotEmailThreads`)
 */
function extractAgentMcpItems(raw: Record<string, unknown> | null): Array<{ name: string; detail: string }> {
  if (!raw) return []
  const listKeys = ['customMcps', 'custom_mcps', 'servers', 'mcpServers', 'mcp_servers'] as const
  for (const key of listKeys) {
    const val = raw[key]
    if (Array.isArray(val)) {
      return val.map((item, idx) => {
        const obj = asObj(item) || {}
        const name = str(obj['name'] ?? obj['serverName'] ?? obj['id'] ?? `mcp-${idx + 1}`)
        const detail = str(obj['url'] ?? obj['command'] ?? obj['endpoint'] ?? '')
        return { name, detail }
      })
    }
    const objMap = asObj(val)
    if (objMap) {
      return Object.entries(objMap).map(([k, v]) => {
        const entry = asObj(v) || {}
        const detail = str(entry['url'] ?? entry['command'] ?? entry['endpoint'] ?? '')
        return { name: k, detail }
      })
    }
  }
  return []
}

function detectAgentMcpPayloadKey(raw: Record<string, unknown> | null): string {
  if (!raw) return 'mcp_servers'
  for (const key of ['customMcps', 'custom_mcps', 'servers', 'mcpServers', 'mcp_servers'] as const) {
    if (key in raw) return key
  }
  return 'mcp_servers'
}

export function GrokConnectorsAndMcpSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [mcpSummary, setMcpSummary] = useState<string>('')
  const [mcpUnsupported, setMcpUnsupported] = useState(false)
  const [userMcpRaw, setUserMcpRaw] = useState<Record<string, unknown> | null>(null)
  const [userMcpJson, setUserMcpJson] = useState('')
  const [showUserEditor, setShowUserEditor] = useState(false)

  const [agentMcpRaw, setAgentMcpRaw] = useState<Record<string, unknown> | null>(null)
  const [agentMcpItems, setAgentMcpItems] = useState<Array<{ name: string; detail: string }>>([])
  const [agentMcpJson, setAgentMcpJson] = useState('')
  const [showAgentEditor, setShowAgentEditor] = useState(false)
  const [customMcpName, setCustomMcpName] = useState('')
  const [customMcpEndpoint, setCustomMcpEndpoint] = useState('')

  const [emailThreads, setEmailThreads] = useState<Array<{ id: string; subject: string }>>([])
  const [inboxUsername, setInboxUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [mcpRes, agentMcpRes, mailRes] = await Promise.allSettled([
        callGrok(accountId, 'GetGrokBotUserMcpSettings', {}),
        agentId
          ? callGrok(accountId, 'GetGrokBotAgentCustomMcp', { agent_id: agentId })
          : Promise.resolve(null),
        callGrok(accountId, 'ListGrokBotEmailThreads', { limit: 8 })
      ])

      const errors: string[] = []

      if (mcpRes.status === 'fulfilled') {
        setMcpUnsupported(false)
        const topObj = asObj(mcpRes.value)
        setUserMcpRaw(topObj)
        const settings = asObj(topObj?.['settings']) ?? topObj
        if (settings) {
          const keys = Object.keys(settings)
          setMcpSummary(
            keys.length ? `已同步 MCP 配置 (${keys.slice(0, 3).join(', ')})` : '已启用默认 MCP'
          )
          setUserMcpJson(JSON.stringify(settings, null, 2))
        } else {
          setMcpSummary('已连接云端 MCP 设置')
          setUserMcpJson('{}')
        }
      } else {
        setUserMcpRaw(null)
        const cleaned = cleanSidebarError(mcpRes.reason)
        if (cleaned) {
          errors.push(`MCP 设置加载失败：${cleaned}`)
          setMcpUnsupported(false)
        } else {
          setMcpUnsupported(true)
        }
      }

      if (agentId) {
        if (agentMcpRes.status === 'fulfilled') {
          const rawObj = asObj(agentMcpRes.value)
          setAgentMcpRaw(rawObj)
          setAgentMcpItems(extractAgentMcpItems(rawObj))
          setAgentMcpJson(JSON.stringify(rawObj ?? {}, null, 2))
        } else {
          setAgentMcpRaw(null)
          setAgentMcpItems([])
          const cleaned = cleanSidebarError(agentMcpRes.reason)
          if (cleaned) errors.push(`Agent 自定义 MCP 加载失败：${cleaned}`)
        }
      } else {
        setAgentMcpRaw(null)
        setAgentMcpItems([])
      }

      if (mailRes.status === 'fulfilled') {
        const threads = Array.isArray(asObj(mailRes.value)?.['threads'])
          ? (asObj(mailRes.value)!['threads'] as unknown[])
          : []
        setEmailThreads(
          threads.map((th, i) => {
            const r = asObj(th) || {}
            return {
              id: str(r['threadId'] ?? r['thread_id'] ?? i),
              subject: str(r['subject'] ?? r['snippet'] ?? 'Email Thread')
            }
          })
        )
      } else {
        const cleaned = cleanSidebarError(mailRes.reason)
        if (cleaned) errors.push(`专属邮箱加载失败：${cleaned}`)
      }

      if (errors.length > 0) {
        setError(errors.join('；'))
      }
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status, agentId])

  const saveUserMcpSettings = async () => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const parsed = JSON.parse(userMcpJson || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('用户 MCP 设置必须是 JSON 对象')
      }
      const payload =
        userMcpRaw && 'settings' in userMcpRaw && !('settings' in (parsed as Record<string, unknown>))
          ? { settings: parsed }
          : (parsed as Record<string, unknown>)
      await callGrok(accountId, 'SetGrokBotUserMcpSettings', payload)
      setHint('已保存 Grok 用户 MCP 设置')
      setShowUserEditor(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const addQuickAgentCustomMcp = async () => {
    if (!agentId) return
    const name = customMcpName.trim()
    const endpoint = customMcpEndpoint.trim()
    if (!name || !endpoint) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const key = detectAgentMcpPayloadKey(agentMcpRaw)
      const currentVal = agentMcpRaw?.[key]
      const entry = /^https?:\/\//i.test(endpoint) ? { url: endpoint } : { command: endpoint }
      let nextContainer: unknown
      if (Array.isArray(currentVal)) {
        nextContainer = [...currentVal, { name, ...entry }]
      } else {
        const map = asObj(currentVal) ? { ...asObj(currentVal)! } : {}
        map[name] = entry
        nextContainer = map
      }
      await callGrok(accountId, 'UpdateGrokBotAgentCustomMcp', {
        agent_id: agentId,
        [key]: nextContainer
      })
      setCustomMcpName('')
      setCustomMcpEndpoint('')
      setHint(`已更新 Agent 自定义 MCP「${name}」`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveAgentCustomMcpJson = async () => {
    if (!agentId) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const parsed = JSON.parse(agentMcpJson || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Agent 自定义 MCP 配置必须是 JSON 对象')
      }
      await callGrok(accountId, 'UpdateGrokBotAgentCustomMcp', {
        agent_id: agentId,
        ...(parsed as Record<string, unknown>)
      })
      setHint('已保存 Agent 自定义 MCP 配置')
      setShowAgentEditor(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const createInbox = async () => {
    if (!inboxUsername.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await callGrok(accountId, 'CreateGrokBotEmailInbox', {
        username: inboxUsername.trim(),
        display_name: inboxUsername.trim()
      })
      const inbox = asObj(asObj(res)?.['inbox'])
      setInboxUsername('')
      setHint(inbox?.['email'] ? `已开通专属邮箱：${str(inbox['email'])}` : '已请求创建专属收件箱')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="连接器 · MCP · 专属邮箱"
      count={agentMcpItems.length + emailThreads.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && (
          <p role="alert" className="rounded-md bg-status-error/10 px-2 py-1 text-[11.5px] text-status-error">
            {error}
          </p>
        )}
        {hint && <p className="text-[11.5px] text-status-online-ink">{hint}</p>}

        {/* User Cloud MCP Settings */}
        {mcpUnsupported ? (
          <p className="rounded-md bg-hover/40 px-2 py-1 text-[11.5px] text-ink-muted">
            该账号暂不支持云端 MCP 接口或未启用
          </p>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-line/70 bg-hover/30 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11.5px] text-ink">
                {mcpSummary || '云端用户 MCP 设置'}
              </span>
              <button
                type="button"
                onClick={() => setShowUserEditor((v) => !v)}
                className="shrink-0 text-[11px] font-medium text-accent-600 hover:underline"
              >
                {showUserEditor ? '收起' : '编辑设置'}
              </button>
            </div>
            {showUserEditor && (
              <div className="flex flex-col gap-1.5">
                <textarea
                  rows={4}
                  value={userMcpJson}
                  onChange={(e) => setUserMcpJson(e.target.value)}
                  className="w-full rounded-md border border-line bg-main px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent-300"
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveUserMcpSettings()}>
                    保存用户 MCP 设置
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Per-Agent Custom MCP */}
        {agentId && (
          <div className="flex flex-col gap-1.5 rounded-md border border-line/70 bg-hover/30 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium text-ink">
                Agent 自定义 MCP ({agentMcpItems.length})
              </span>
              <button
                type="button"
                onClick={() => setShowAgentEditor((v) => !v)}
                className="shrink-0 text-[11px] font-medium text-accent-600 hover:underline"
              >
                {showAgentEditor ? '收起 JSON' : '编辑 JSON'}
              </button>
            </div>

            {agentMcpItems.length > 0 && (
              <ul className="flex flex-col gap-1">
                {agentMcpItems.map((item) => (
                  <li key={item.name} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-medium text-ink">{item.name}</span>
                    {item.detail && <span className="truncate font-mono text-ink-muted">{item.detail}</span>}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-1">
              <TextInput
                value={customMcpName}
                onChange={(e) => setCustomMcpName(e.target.value)}
                placeholder="名称"
                className="h-7 w-24 text-[11.5px]"
              />
              <TextInput
                value={customMcpEndpoint}
                onChange={(e) => setCustomMcpEndpoint(e.target.value)}
                placeholder="https://... 或启动命令"
                className="h-7 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !customMcpName.trim() || !customMcpEndpoint.trim()}
                onClick={() => void addQuickAgentCustomMcp()}
              >
                添加
              </Button>
            </div>

            {showAgentEditor && (
              <div className="flex flex-col gap-1.5">
                <textarea
                  rows={4}
                  value={agentMcpJson}
                  onChange={(e) => setAgentMcpJson(e.target.value)}
                  className="w-full rounded-md border border-line bg-main px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent-300"
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveAgentCustomMcpJson()}>
                    保存 Agent MCP
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-1.5">
          <TextInput
            value={inboxUsername}
            onChange={(e) => setInboxUsername(e.target.value)}
            placeholder="申请 Bot 邮箱前缀 (如 my-bot)"
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !inboxUsername.trim()}
            onClick={() => void createInbox()}
          >
            开通邮箱
          </Button>
        </div>
        {emailThreads.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-line pt-1.5">
            {emailThreads.map((th) => (
              <li key={th.id} className="truncate text-[11.5px] text-ink-secondary">
                ✉️ {th.subject}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 4. Grok Bot Library Files + Upload + AgentStore Docs
 * (`ListGrokBotAgentFiles`, `ListGrokBotUserStoreFiles`, `ListGrokBotLibraryDocs`,
 *  `BeginGrokBotAgentFileUpload` / `FinishGrokBotAgentFileUpload`, `DeleteGrokBotAgentFile`)
 */
export function GrokFilesSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)
  const [files, setFiles] = useState<
    Array<{ name: string; path: string; sizeBytes: number; storeRef?: string }>
  >([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const [aRaw, uRaw, dRaw] = await Promise.all([
        callGrok(accountId, 'ListGrokBotAgentFiles', { agent_id: agentId, page_token: '' }).catch(
          () => null
        ),
        callGrok(accountId, 'ListGrokBotUserStoreFiles', { agent_id: agentId }).catch(() => null),
        callGrok(accountId, 'ListGrokBotLibraryDocs', { agent_id: agentId }).catch(() => null)
      ])
      const aList = Array.isArray(asObj(aRaw)?.['files'])
        ? (asObj(aRaw)!['files'] as unknown[])
        : []
      const uList = Array.isArray(asObj(uRaw)?.['files'])
        ? (asObj(uRaw)!['files'] as unknown[])
        : []
      const dList = Array.isArray(asObj(dRaw)?.['docs'])
        ? (asObj(dRaw)!['docs'] as unknown[])
        : []

      const merged: Array<{ name: string; path: string; sizeBytes: number; storeRef?: string }> = [
        ...aList,
        ...uList
      ]
        .map((f) => {
          const r = asObj(f) || {}
          return {
            name: str(r['name'] ?? r['path']),
            path: str(r['path'] ?? r['name']),
            sizeBytes: Number(r['sizeBytes'] ?? r['size_bytes'] ?? 0)
          }
        })
        .filter((x) => x.name)

      for (const doc of dList) {
        const r = asObj(doc) || {}
        const storeId = str(r['storeId'] ?? r['store_id'])
        const docPath = str(r['relativePath'] ?? r['relative_path'] ?? r['documentId'] ?? r['id'])
        const title = str(r['title'] ?? docPath)
        if (storeId && docPath) {
          merged.push({
            name: `📄 ${title}`,
            path: docPath,
            sizeBytes: 0,
            storeRef: `grokstore://${storeId}/${docPath}`
          })
        }
      }

      setFiles(merged)
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const uploadFile = async (file: File | undefined) => {
    if (!file || !agentId) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    setUploading(true)
    setError(undefined)
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const res = await grok.rpc({
        accountId,
        op: 'uploadAgentFile',
        agentId,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64: btoa(bin)
      })
      if (!res.ok) throw new Error(res.message)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const removeFile = async (name: string) => {
    if (!agentId) return
    try {
      await callGrok(accountId, 'DeleteGrokBotAgentFile', { agent_id: agentId, name })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Section
      title={t('Documents and Files')}
      count={files.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2">
        {error && <p className="text-[12px] text-status-error">{error}</p>}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={uploading || !agentId}
            onClick={() => uploadInputRef.current?.click()}
          >
            {uploading ? '上传中…' : '+ 上传文件到 Agent 存储'}
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              void uploadFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
        {files.length === 0 ? (
          <EmptyLine>{t('Files the bot creates show up here')}</EmptyLine>
        ) : (
          <ul className="divide-y divide-line">
            {files.map((f) => (
              <li
                key={f.storeRef || f.path}
                className="flex items-center justify-between gap-2 py-2 text-[12px]"
              >
                <button
                  type="button"
                  onClick={() =>
                    setActiveDocument({
                      accountId,
                      title: f.name.replace(/^📄\s*/, ''),
                      path: f.storeRef || `grokatt://${f.path}`,
                      platformId: 'grok',
                      agentId
                    })
                  }
                  className="min-w-0 flex-1 truncate text-left font-medium text-ink hover:text-accent-600"
                >
                  {f.name}
                </button>
                {!f.storeRef && (
                  <Button size="sm" variant="ghost" onClick={() => void removeFile(f.name)}>
                    {t('Delete')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 5. Grok Bot Members & Access Invites
 * (`ListGrokBotAgentAccessInvites`, `CreateGrokBotAgentAccessInvite`, `AcceptGrokBotAgentAccessInvite`)
 */
export function GrokMembersSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [invites, setInvites] = useState<Array<{ email: string; expiresAtMs: number }>>([])
  const [email, setEmail] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const raw = await callGrok(accountId, 'ListGrokBotAgentAccessInvites', {
        agent_id: agentId
      })
      const o = asObj(raw) || {}
      const list = Array.isArray(o['invites']) ? o['invites'] : []
      setInvites(
        list
          .map((i) => {
            const r = asObj(i) || {}
            return {
              email: str(r['email']),
              expiresAtMs: Number(r['expiresAtMs'] ?? r['expires_at_ms'] ?? 0)
            }
          })
          .filter((x) => x.email)
      )
    } catch {
      setInvites([])
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const sendInvite = async () => {
    if (!agentId || !email.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await callGrok(accountId, 'CreateGrokBotAgentAccessInvite', {
        agent_id: agentId,
        email: email.trim(),
        send_email: true,
        language: 'zh-CN'
      })
      const o = asObj(res) || {}
      const url = str(o['inviteUrl'] ?? o['invite_url'])
      setEmail('')
      setHint(url ? `已创建邀请链接：${url}` : '邀请已发送')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const acceptInvite = async () => {
    if (!inviteCode.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      await callGrok(accountId, 'AcceptGrokBotAgentAccessInvite', { code: inviteCode.trim() })
      setInviteCode('')
      setHint('已接受共享 Bot 邀请')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="成员与共享"
      count={invites.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="break-all text-ink-secondary">{hint}</p>}

        <div className="flex gap-1.5">
          <TextInput
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="输入受邀邮箱…"
            aria-label="Invite email"
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !email.trim()}
            onClick={() => void sendInvite()}
          >
            邀请
          </Button>
        </div>

        <div className="flex gap-1.5">
          <TextInput
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="粘贴邀请码…"
            aria-label="Invite code"
            className="h-7 flex-1 font-mono text-[12px]"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !inviteCode.trim()}
            onClick={() => void acceptInvite()}
          >
            接受
          </Button>
        </div>

        {invites.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-line pt-2">
            {invites.map((i) => (
              <li
                key={i.email}
                className="flex items-center justify-between rounded-md px-2 py-1 text-ink"
              >
                <span className="truncate">{i.email}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 6. Grok Bot Cloud SandBox Computer (`GetSandBoxRunState`, `EnsureSandBox`, `RecreateSandBox`, VNC & Gateway)
 */
export function GrokComputerSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [runState, setRunState] = useState<string>('UNKNOWN')
  const [boxDetail, setBoxDetail] = useState<{
    podId?: string
    cluster?: string
    vncUrl?: string
    gatewayUrl?: string
  } | null>(null)
  const [showVnc, setShowVnc] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const stateRes = await callGrok(accountId, 'GetSandBoxRunState', {}, 'sandbox').catch(() =>
        callGrok(accountId, 'GetSandBoxRunState', {})
      )
      const stObj = asObj(stateRes) || {}
      const rawState = stObj['state']
      const stateLabel =
        rawState === 3 || rawState === 'SAND_BOX_RUN_STATE_RUNNING'
          ? 'RUNNING (运行中)'
          : rawState === 2 || rawState === 'SAND_BOX_RUN_STATE_HIBERNATED'
            ? 'HIBERNATED (休眠)'
            : rawState === 4 || rawState === 'SAND_BOX_RUN_STATE_STARTING'
              ? 'STARTING (启动中)'
              : rawState === 1 || rawState === 'SAND_BOX_RUN_STATE_ABSENT'
                ? 'ABSENT (未分配)'
                : str(rawState || 'STANDBY')
      setRunState(stateLabel)
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    if (status === 'online' || status === 'busy') void refresh()
  }, [refresh, status])

  const wakeSandBox = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const res = await callGrok(
        accountId,
        'EnsureSandBox',
        { wake: true, supports_asleep_box: true },
        'sandbox'
      ).catch(() => callGrok(accountId, 'EnsureSandBox', { wake: true }))
      const o = asObj(res) || {}
      setBoxDetail({
        podId: str(o['podId'] ?? o['pod_id']) || undefined,
        cluster: str(o['cluster']) || undefined,
        vncUrl: str(o['vncUrl'] ?? o['vnc_url']) || undefined,
        gatewayUrl: str(o['gatewayUrl'] ?? o['gateway_url']) || undefined
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const recreateSandBox = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await callGrok(
        accountId,
        'RecreateSandBox',
        { preserve_data: true, force: false, acknowledge_terminal_upgrade_schedule: true },
        'sandbox'
      )
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="云端沙盒电脑 (SandBox VM)"
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2.5 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        <div className="flex items-center justify-between">
          <span className="font-medium text-ink">沙盒运行状态</span>
          <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
            {runState}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void wakeSandBox()}>
            {busy ? '唤醒中…' : '唤醒并连接沙盒'}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void recreateSandBox()}>
            保留数据重建
          </Button>
          {boxDetail?.vncUrl && (
            <Button size="sm" variant="primary" onClick={() => setShowVnc((v) => !v)}>
              {showVnc ? '收起远程桌面' : '预览 VNC 桌面'}
            </Button>
          )}
        </div>

        {boxDetail && (
          <div className="rounded-lg border border-line bg-sunken p-2 text-[11px] text-ink-secondary">
            {boxDetail.cluster && <p>Cluster: {boxDetail.cluster}</p>}
            {boxDetail.podId && <p className="truncate">Pod: {boxDetail.podId}</p>}
            {boxDetail.gatewayUrl && <p className="truncate">Gateway: {boxDetail.gatewayUrl}</p>}
          </div>
        )}

        {showVnc && boxDetail?.vncUrl && (
          <div className="overflow-hidden rounded-xl border border-line bg-black">
            <iframe
              src={boxDetail.vncUrl}
              title="Grok Bot SandBox VNC"
              className="h-56 w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        )}
      </div>
    </Section>
  )
}
