import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Globe, KeyRound, Link2, RefreshCw, ShieldCheck } from 'lucide-react'
import { getPlatform } from '@adapters/platforms'
import type { DsBotAuthStatus, DsBotLocalDetection, DsBotTransportMode } from '@shared/ipc'
import { Button } from '@/components/ui/Button'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'

interface DsBotConnectFormProps {
  accountId: string
  initialMode?: DsBotTransportMode
  initialDisplayName?: string
  initialEndpointUrl?: string
  isEdit?: boolean
  hasExistingSecret?: boolean
  submitLabel?: string
  onConnected: (status: DsBotAuthStatus) => void
  onCancel?: () => void
}

const MODE_OPTIONS: Array<{
  id: DsBotTransportMode
  label: string
  badge: string
  icon: typeof KeyRound
  summary: string
}> = [
  {
    id: 'mcp',
    label: 'MCP Token',
    badge: '最简接入',
    icon: KeyRound,
    summary: '在 DS Bot → Settings → MCP access 开启并创建 Token，支持本机或远程 URL'
  },
  {
    id: 'relay',
    label: '加密配对链接',
    badge: '全功能 · 桌面端推荐',
    icon: ShieldCheck,
    summary: '在 DS Bot → Settings → Phone 复制配对链接，Noise_IK 端到端加密，支持流式、审批、记忆与发图'
  },
  {
    id: 'channel',
    label: 'DSH Web / Docker',
    badge: '全功能 · 自托管',
    icon: Globe,
    summary: '粘贴 `dsh web` 或 Docker 输出的带 `?token=...` 链接（自动换取 30 天签名 Cookie 并开启实时 SSE）'
  }
]

export function DsBotConnectForm({
  accountId,
  initialMode = 'mcp',
  initialDisplayName = '',
  initialEndpointUrl,
  isEdit = false,
  hasExistingSecret = false,
  submitLabel,
  onConnected,
  onCancel
}: DsBotConnectFormProps) {
  const [mode, setMode] = useState<DsBotTransportMode>(initialMode)
  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [mcpUrl, setMcpUrl] = useState(
    initialMode === 'mcp' && initialEndpointUrl ? initialEndpointUrl : 'http://127.0.0.1:8797/mcp'
  )
  const [channelUrl, setChannelUrl] = useState(
    initialMode === 'channel' && initialEndpointUrl ? initialEndpointUrl : 'http://127.0.0.1:3080'
  )
  const [secret, setSecret] = useState('')
  const [pairingUri, setPairingUri] = useState('')
  const [localInfo, setLocalInfo] = useState<DsBotLocalDetection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const detectLocal = useCallback(async (fillDefaults: boolean) => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.detectLocal) return
    setDetecting(true)
    try {
      const info = await dsBot.detectLocal()
      setLocalInfo(info)
      if (fillDefaults && !initialEndpointUrl) {
        if (info.mcpUrl) setMcpUrl(info.mcpUrl)
        if (info.channelUrl) setChannelUrl(info.channelUrl)
      }
    } catch {
      /* ignore */
    } finally {
      setDetecting(false)
    }
  }, [initialEndpointUrl])

  useEffect(() => {
    void detectLocal(!isEdit)
  }, [detectLocal, isEdit])

  const activeSpec = MODE_OPTIONS.find((item) => item.id === mode) ?? MODE_OPTIONS[0]!

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.configure) {
      setError('需要在 Electron 桌面端中连接 DS Bot')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const status = await dsBot.configure({
        accountId,
        mode,
        displayName: displayName.trim() || undefined,
        endpointUrl: mode === 'mcp' ? mcpUrl.trim() : mode === 'channel' ? channelUrl.trim() : undefined,
        secret: secret.trim() || undefined,
        pairingUri: mode === 'relay' ? pairingUri.trim() || undefined : undefined,
        keepExistingSecret: isEdit && hasExistingSecret && !secret.trim()
      })
      if (!status.signedIn) {
        setError(status.error || '无法连接到 DS Bot，请检查地址和凭据')
        return
      }
      onConnected(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PlatformGlyph platform={getPlatform('ds-bot')} size="sm" className="size-4" />
          <span className="text-[13.5px] font-semibold text-ink">
            {isEdit ? '编辑 DS Bot 连接' : '连接 DS Bot 团队'}
          </span>
        </div>
        <button
          type="button"
          disabled={detecting}
          onClick={() => void detectLocal(true)}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-main px-2.5 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-hover hover:text-ink"
        >
          <RefreshCw className={cn('size-3', detecting && 'animate-spin')} />
          检测本机
        </button>
      </div>

      {localInfo && (localInfo.mcpReachable || localInfo.channelReachable) && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-status-online/25 bg-status-online/8 px-3 py-2 text-[12px] text-status-online-ink">
          <CheckCircle2 className="size-3.5 shrink-0" />
          <span>
            {localInfo.mcpReachable
              ? `已检测到本机 DS Bot MCP（端口 ${localInfo.mcpPort}）`
              : `已检测到本机 DS Bot 服务（端口 ${localInfo.channelPort}）`}
          </span>
        </div>
      )}

      {/* Connection mode selector */}
      <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-sunken p-1">
        {MODE_OPTIONS.map((opt) => {
          const Icon = opt.icon
          const selected = mode === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setMode(opt.id)
                setError(undefined)
              }}
              className={cn(
                'press flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-center transition-colors',
                selected
                  ? 'bg-surface text-ink shadow-soft ring-1 ring-line'
                  : 'text-ink-secondary hover:bg-hover/60 hover:text-ink'
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              <span className="text-[12px] font-medium leading-tight">{opt.label}</span>
            </button>
          )
        })}
      </div>

      <p className="rounded-lg bg-sunken/60 px-3 py-2 text-[11.5px] leading-4 text-ink-secondary">
        <span className="mr-1.5 inline-block rounded bg-accent-50 px-1.5 py-0.5 text-[10.5px] font-medium text-accent-600">
          {activeSpec.badge}
        </span>
        {activeSpec.summary}
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-ink-secondary">团队 / 实例名称（可选）</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="例如：My DS Bot / Home NAS"
          className="h-9 rounded-lg border border-line bg-main px-3 text-[13px] text-ink outline-none focus:border-accent-600"
        />
      </label>

      {mode === 'mcp' && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">MCP 地址（本机端口或远程 URL）</span>
            <input
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
              placeholder="http://127.0.0.1:8797/mcp 或 https://dsbot.example.com/mcp"
              spellCheck={false}
              required
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">
              MCP Bearer Token {isEdit && hasExistingSecret ? '（留空沿用已加密保存的 Token）' : ''}
            </span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="dsb_..."
              spellCheck={false}
              required={!isEdit || !hasExistingSecret}
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
        </>
      )}

      {mode === 'relay' && (
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
            <Link2 className="size-3.5" aria-hidden />
            DS Bot 配对链接 {isEdit && hasExistingSecret ? '（留空沿用当前已配对设备）' : ''}
          </span>
          <textarea
            value={pairingUri}
            onChange={(e) => setPairingUri(e.target.value)}
            placeholder="dsbot://pair?v=1&server=wss://relay.dsbot.app/v1/link&host=...&key=...&code=..."
            spellCheck={false}
            rows={3}
            required={!isEdit || !hasExistingSecret}
            className="rounded-lg border border-line bg-main px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-600"
          />
        </label>
      )}

      {mode === 'channel' && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">
              DSH Web / Docker 地址（可直接粘贴含 ?token=... 的首次登录 URL）
            </span>
            <input
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              placeholder="http://127.0.0.1:3080/?token=..."
              spellCheck={false}
              required
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-ink-secondary">
              Cookie（可选：若 URL 不含 ?token=... 时填写）
            </span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={isEdit && hasExistingSecret ? '留空沿用已保存的签名 Cookie' : '留空自动通过 ?token= 换取'}
              spellCheck={false}
              className="h-9 rounded-lg border border-line bg-main px-3 font-mono text-[12.5px] text-ink outline-none focus:border-accent-600"
            />
          </label>
        </>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-status-error/30 bg-status-error/8 px-3 py-2 text-[12px] text-status-error">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          {busy ? '正在验证并同步团队…' : submitLabel || (isEdit ? '保存并重新连接' : '连接并同步全部 Bot')}
        </Button>
      </div>
    </form>
  )
}
