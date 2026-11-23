import { dsBotServer } from '@shared/dsBotMcp'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  FolderOpen,
  Import,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Sparkles,
  Trash2,
  Unlink
} from 'lucide-react'
import type {
  McpServerConfigInput,
  McpTransportType,
  WorkspaceRequest,
  WorkspaceServerView,
  WorkspaceView
} from '@shared/workspace'
import { ArkMcpNodeSvg, ArkWorkspaceVaultSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { Dialog } from '@/components/ui/Dialog'
import { Field, TextInput } from '@/components/ui/Field'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useRooms } from '@/rooms/roomStore'
import { usePrefsStore } from '@/store/prefsStore'

export interface McpSettingsSectionProps {
  /** Default `'__global__'` for global MCP servers; optionally switchable to any room scope */
  initialScope?: string
  /** Optional callback after servers or workspace readiness change */
  onUpdated?: (view: WorkspaceView) => void
}

function parseArgsText(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) args.push(current)
  return args
}

function parseKeyValueLines(raw: string, mode: 'env' | 'headers'): Record<string, string> | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(mode === 'env' ? '环境变量 JSON 必须是对象' : '请求头 JSON 必须是对象')
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k.trim() && v !== undefined && v !== null) out[k.trim()] = String(v)
    }
    return Object.keys(out).length ? out : undefined
  }
  const out: Record<string, string> = {}
  const sep = mode === 'env' ? '=' : ':'
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(sep)
    if (idx <= 0) {
      throw new Error(
        mode === 'env' ? `环境变量行格式应为 KEY=VALUE：${line}` : `请求头行格式应为 Key: Value：${line}`
      )
    }
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return Object.keys(out).length ? out : undefined
}

export function McpSettingsSection({
  initialScope = '__global__',
  onUpdated
}: McpSettingsSectionProps = {}) {
  const locale = usePrefsStore((s) => s.locale)
  const L = (zh: string, en: string) => (locale === 'en' ? en : zh)

  const rooms = useRooms((s) => s.rooms)
  const [scope, setScope] = useState(initialScope)
  const [view, setView] = useState<WorkspaceView>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // Add/Edit Dialog state
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<WorkspaceServerView | undefined>()
  const [formName, setFormName] = useState('')
  const [formTransport, setFormTransport] = useState<McpTransportType>('stdio')
  const [formCommand, setFormCommand] = useState('')
  const [formArgs, setFormArgs] = useState('')
  const [formCwd, setFormCwd] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formSecrets, setFormSecrets] = useState('')
  const [keepSecrets, setKeepSecrets] = useState(true)
  const [formError, setFormError] = useState<string>()

  const [dsBotOpen, setDsBotOpen] = useState(false)
  const [dsBotToken, setDsBotToken] = useState('')
  const [dsBotPort, setDsBotPort] = useState('8797')

  // JSON Paste Dialog state
  const [pasteOpen, setPasteOpen] = useState(false)
  const [rawJson, setRawJson] = useState('')
  const [pasteAutoStart, setPasteAutoStart] = useState(true)
  const [pasteError, setPasteError] = useState<string>()

  const refresh = useCallback(async () => {
    const bridge = getBridge()?.workspace
    if (!bridge) return
    setLoading(true)
    try {
      const next = await bridge.manage(scope, { op: 'status' })
      setView(next)
      onUpdated?.(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [scope, onUpdated])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runManage = async (
    request: Exclude<WorkspaceRequest, { op: 'run' }>,
    onDone?: (next: WorkspaceView) => void
  ) => {
    const bridge = getBridge()?.workspace
    if (!bridge) {
      setError(L('需要在 Electron 桌面端中管理 MCP 服务', 'Electron desktop bridge unavailable'))
      return
    }
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const next = await bridge.manage(scope, request)
      setView(next)
      onUpdated?.(next)
      onDone?.(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      const refreshed = await bridge.manage(scope, { op: 'status' }).catch(() => undefined)
      if (refreshed) setView(refreshed)
    } finally {
      setBusy(false)
    }
  }

  const scopeType = scope === '__global__' ? 'global' : 'scope'
  const existingDsBot = view?.servers.find((s) => s.name === 'ds-bot' && s.scope === scopeType)

  async function connectDsBot() {
    try {
      const server = dsBotServer(Number(dsBotPort), dsBotToken, scopeType)
      setFormError(undefined)
      await runManage({ op: 'upsert', server, autoStart: true }, (next) => {
        const connected = next.servers.find((s) => s.name === server.name && s.scope === scopeType)
        if (!connected?.running) {
          setFormError(connected?.lastError || L('DS Bot 连接失败', 'Could not connect to DS Bot'))
          return
        }
        setDsBotToken('')
        setDsBotOpen(false)
      })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  const openCreate = () => {
    setEditing(undefined)
    setFormName('')
    setFormTransport('stdio')
    setFormCommand('')
    setFormArgs('')
    setFormCwd('')
    setFormUrl('')
    setFormSecrets('')
    setKeepSecrets(false)
    setFormError(undefined)
    setFormOpen(true)
  }

  const openEdit = (srv: WorkspaceServerView) => {
    setEditing(srv)
    setFormName(srv.name)
    const resolved =
      srv.resolvedTransport ??
      (srv.transport && srv.transport !== 'auto'
        ? srv.transport
        : srv.command
          ? 'stdio'
          : 'streamable-http')
    setFormTransport(resolved)
    setFormCommand(srv.command ?? '')
    setFormArgs((srv.args ?? []).join(' '))
    setFormCwd(srv.cwd ?? '')
    setFormUrl(srv.url ?? '')
    setFormSecrets('')
    setKeepSecrets(true)
    setFormError(undefined)
    setFormOpen(true)
  }

  const handleSaveForm = async (autoStart: boolean) => {
    const bridge = getBridge()?.workspace
    if (!bridge) return
    setFormError(undefined)
    const cleanName = formName.trim()
    if (!cleanName) {
      setFormError(L('请输入服务名称', 'Server name is required'))
      return
    }
    let parsedSecrets: Record<string, string> | undefined
    try {
      parsedSecrets = parseKeyValueLines(
        formSecrets,
        formTransport === 'stdio' ? 'env' : 'headers'
      )
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
      return
    }

    const targetScope = editing?.scope ?? (scope === '__global__' ? 'global' : 'scope')
    let server: McpServerConfigInput
    if (formTransport === 'stdio') {
      if (!formCommand.trim()) {
        setFormError(L('请输入启动命令', 'Command is required'))
        return
      }
      server = {
        name: cleanName,
        transport: 'stdio',
        command: formCommand.trim(),
        args: parseArgsText(formArgs),
        ...(formCwd.trim() ? { cwd: formCwd.trim() } : {}),
        ...(parsedSecrets ? { env: parsedSecrets } : !editing || !keepSecrets ? { env: {} } : {}),
        targetScope,
        keepExistingSecrets: editing ? keepSecrets : false
      }
    } else {
      const cleanUrl = formUrl.trim()
      if (!cleanUrl) {
        setFormError(L('请输入服务 URL', 'URL is required'))
        return
      }
      server = {
        name: cleanName,
        transport: formTransport,
        url: cleanUrl,
        ...(parsedSecrets
          ? { headers: parsedSecrets }
          : !editing || !keepSecrets
            ? { headers: {} }
            : {}),
        targetScope,
        keepExistingSecrets: editing ? keepSecrets : false
      }
    }

    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const next = await bridge.manage(
        scope,
        editing
          ? { op: 'update', previousName: editing.name, server, autoStart }
          : { op: 'upsert', server, autoStart }
      )
      setView(next)
      onUpdated?.(next)
      setFormOpen(false)
      setHint(
        autoStart
          ? L(`已保存并启动 MCP 服务「${cleanName}」`, `Saved & started "${cleanName}"`)
          : L(`已保存 MCP 服务「${cleanName}」`, `Saved "${cleanName}"`)
      )
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
      const refreshed = await bridge.manage(scope, { op: 'status' }).catch(() => undefined)
      if (refreshed) setView(refreshed)
    } finally {
      setBusy(false)
    }
  }

  const handleImportJson = async () => {
    const bridge = getBridge()?.workspace
    if (!bridge) return
    setPasteError(undefined)
    if (!rawJson.trim()) {
      setPasteError(L('请粘贴 mcpServers / servers JSON 配置', 'Please paste JSON config'))
      return
    }
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const next = await bridge.manage(scope, {
        op: 'importJson',
        rawJson,
        targetScope: scope === '__global__' ? 'global' : 'scope',
        autoStart: pasteAutoStart
      })
      setView(next)
      onUpdated?.(next)
      setPasteOpen(false)
      setRawJson('')
      setHint(L(`已导入 ${next.importedCount ?? 0} 个 MCP 服务`, `Imported ${next.importedCount ?? 0} MCP server(s)`))
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const servers = view?.servers ?? []
  const runningCount = servers.filter((s) => s.running).length
  const externalTools = useMemo(
    () => (view?.tools ?? []).filter((t) => t.name.includes('__')),
    [view?.tools]
  )

  const scopeOptions = useMemo(
    () => [
      { value: '__global__', label: L('全局默认 (__global__)', 'Global (__global__)') },
      ...rooms.map((r) => ({
        value: r.id,
        label: L(`群聊 · ${r.title}`, `Room · ${r.title}`)
      }))
    ],
    [rooms, locale]
  )

  return (
    <div className="flex flex-col gap-5 animate-veil-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">
            {L('全局 MCP 与工作区工具', 'MCP Servers & Workspace Tools')}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            {L(
              '无需提前绑定目录即可管理全局与工作区 MCP 服务、导入 JSON、启停诊断及一键就绪',
              'Manage global and scoped MCP servers, JSON imports, diagnostics, and one-click workspace readiness'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="xs"
            variant="pill"
            aria-label={L('切换作用域', 'Select scope')}
            value={scope}
            onValueChange={setScope}
            options={scopeOptions}
          />
          <Button size="sm" variant="secondary" disabled={loading || busy} onClick={() => void refresh()}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            {L('刷新', 'Refresh')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPasteOpen(true)}>
            <ClipboardPaste className="size-3.5" />
            {L('粘贴 JSON', 'Paste JSON')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy || loading || !view} onClick={() => {
            if (existingDsBot) return openEdit(existingDsBot)
            setDsBotPort('8797')
            setFormError(undefined)
            setError(undefined)
            setDsBotOpen(true)
          }}>DS Bot</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={openCreate}>
            <Plus className="size-3.5" />
            {L('添加服务', 'Add Server')}
          </Button>
        </div>
      </div>

      {hint && (
        <div className="flex items-center gap-2 rounded-xl border border-status-online/30 bg-status-online/8 px-3.5 py-2.5 text-[12.5px] text-status-online-ink">
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{hint}</span>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-status-error/30 bg-status-error/8 px-3.5 py-2.5 text-[12.5px] text-status-error"
        >
          {error}
        </div>
      )}

      {/* Summary & Workspace Readiness Card */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-4 shadow-soft">
        <div className="flex flex-wrap items-center gap-5">
          <div>
            <div className="text-[11px] text-ink-muted">{L('已配置服务', 'Configured')}</div>
            <div className="text-[20px] font-semibold text-ink tabular-nums">{servers.length}</div>
          </div>
          <div>
            <div className="text-[11px] text-ink-muted">{L('运行中', 'Running')}</div>
            <div className="text-[20px] font-semibold text-status-online-ink tabular-nums">
              {runningCount}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-ink-muted">{L('可用 MCP 工具', 'MCP Tools')}</div>
            <div className="text-[20px] font-semibold text-accent-600 tabular-nums">
              {externalTools.length}
            </div>
          </div>
          {view?.directory && (
            <div className="min-w-0 max-w-[260px]">
              <div className="text-[11px] text-ink-muted">{L('已绑定工作区', 'Bound Directory')}</div>
              <div className="truncate font-mono text-[12px] text-ink" title={view.directory}>
                {view.directory}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void runManage({ op: 'import', targetScope: scope === '__global__' ? 'global' : 'scope' }, (next) => {
                if (next.canceled) return
                const count = next.importedCount ?? 0
                if (count > 0) setHint(L(`已从文件导入 ${count} 个 MCP 服务`, `Imported ${count} MCP server(s)`))
                else setError(L('未发现可导入的 MCP 服务配置', 'No importable MCP servers found'))
              })
            }
          >
            <Import className="size-3.5" />
            {L('从 .json 导入', 'Import .json')}
          </Button>

          {view?.directory ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void runManage({ op: 'unbind' }, () =>
                  setHint(L('已解除工作区目录绑定，MCP 服务保留', 'Directory unbound; servers kept'))
                )
              }
            >
              <Unlink className="size-3.5" />
              {L('解除绑定', 'Unbind')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void runManage({ op: 'bind' }, (next) => {
                  if (!next.canceled && next.directory) {
                    setHint(L(`已绑定目录：${next.directory}`, `Bound directory: ${next.directory}`))
                  }
                })
              }
            >
              <FolderOpen className="size-3.5" />
              {L('绑定目录', 'Bind Folder')}
            </Button>
          )}

          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void runManage(
                {
                  op: 'optimizeReady',
                  autoStart: true,
                  includeUserConfigs: true,
                  bindIfMissing: scope !== '__global__'
                },
                (next) => {
                  if (!next.canceled && next.lastReport) {
                    setHint(next.lastReport.summary)
                  }
                }
              )
            }
          >
            <Sparkles className="size-3.5" />
            {L('一键探测并就绪', 'Detect & Ready')}
          </Button>
        </div>
      </div>

      {/* Server List Card */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <ArkWorkspaceVaultSvg className="size-8 text-ink-faint" />
            <div className="text-[13.5px] font-medium text-ink">
              {L('当前作用域暂无 MCP 服务', 'No MCP servers configured in this scope')}
            </div>
            <p className="max-w-md text-[12px] text-ink-muted">
              {L(
                '支持手动配置 stdio / Streamable HTTP / SSE，或直接粘贴 Claude mcpServers / VS Code servers JSON。',
                'Add stdio, Streamable HTTP, or SSE servers manually, or paste Claude mcpServers / VS Code servers JSON.'
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" onClick={openCreate}>
                <Plus className="size-3.5" />
                {L('手动添加 MCP', 'Add MCP')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPasteOpen(true)}>
                <ClipboardPaste className="size-3.5" />
                {L('粘贴 mcpServers JSON', 'Paste JSON')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {servers.map((srv) => {
              const serverTools = externalTools.filter(
                (t) =>
                  t.name.startsWith(`${srv.name}__`) ||
                  t.name.startsWith(
                    `${srv.name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp'}__`
                  )
              )
              const expanded = Boolean(expandedTools[srv.name])
              const isConfirming = confirmDelete === srv.name
              const secretCount = (srv.envKeys?.length ?? 0) + (srv.headerKeys?.length ?? 0)
              return (
                <div key={`${srv.scope ?? 'scope'}:${srv.name}`} className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <ArkMcpNodeSvg
                        className={cn(
                          'size-4 shrink-0',
                          srv.running
                            ? 'text-status-online'
                            : srv.lastError
                              ? 'text-status-error'
                              : 'text-ink-faint'
                        )}
                      />
                      <span className="truncate text-[14px] font-semibold text-ink">{srv.name}</span>
                      <StatusBadge
                        status={srv.running ? 'online' : srv.lastError ? 'error' : 'offline'}
                        label={
                          srv.running
                            ? L('运行中', 'Running')
                            : srv.lastError
                              ? L('异常', 'Error')
                              : L('已停止', 'Stopped')
                        }
                      />
                      <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                        {srv.resolvedTransport ?? srv.transport ?? (srv.command ? 'stdio' : 'auto')}
                      </span>
                      <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
                        {srv.scope === 'global' ? L('全局', 'Global') : L('作用域', 'Scoped')}
                      </span>
                      {secretCount > 0 && (
                        <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
                          {L(`已加密 ${secretCount} 项密钥`, `${secretCount} encrypted`)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <SwitchPill
                        size="sm"
                        checked={srv.running}
                        disabled={busy}
                        aria-label={`${srv.running ? L('停止', 'Stop') : L('启动', 'Start')} ${srv.name}`}
                        onCheckedChange={() =>
                          void runManage({
                            op: srv.running ? 'stop' : 'start',
                            server: srv.name,
                            targetScope: srv.scope
                          })
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title={L('重启', 'Restart')}
                        onClick={() =>
                          void runManage(
                            { op: 'restart', server: srv.name, targetScope: srv.scope },
                            () => setHint(L(`已重启「${srv.name}」`, `Restarted "${srv.name}"`))
                          )
                        }
                        className="h-7 px-2"
                      >
                        <RotateCw className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title={L('编辑', 'Edit')}
                        onClick={() => openEdit(srv)}
                        className="h-7 px-2"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      {isConfirming ? (
                        <Button
                          size="sm"
                          variant="danger-confirm"
                          disabled={busy}
                          onClick={() => {
                            setConfirmDelete(null)
                            void runManage(
                              { op: 'remove', server: srv.name, targetScope: srv.scope },
                              () => setHint(L(`已删除「${srv.name}」`, `Removed "${srv.name}"`))
                            )
                          }}
                          className="h-7 px-2 text-[11px]"
                        >
                          {L('确认删除', 'Confirm')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          title={L('删除', 'Remove')}
                          onClick={() => setConfirmDelete(srv.name)}
                          className="h-7 px-2 hover:text-status-error"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-muted">
                    <span className="truncate font-mono">
                      {srv.command
                        ? `${srv.command} ${(srv.args ?? []).join(' ')}`.trim()
                        : srv.url}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedTools((prev) => ({ ...prev, [srv.name]: !prev[srv.name] }))
                      }
                      className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent-600 hover:underline"
                    >
                      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      {srv.toolCount ?? serverTools.length} {L('个工具', 'tools')}
                    </button>
                  </div>

                  {srv.lastError && (
                    <div className="rounded-lg border border-status-error/25 bg-status-error/8 px-2.5 py-1.5 font-mono text-[11.5px] text-status-error break-all">
                      {srv.lastError}
                    </div>
                  )}

                  {expanded && (
                    <div className="rounded-xl border border-line bg-sunken/35 p-2.5">
                      {serverTools.length === 0 ? (
                        <span className="text-[11.5px] text-ink-muted">
                          {srv.running
                            ? L('该服务未声明 tools 能力或当前无可用工具', 'Server reported 0 tools')
                            : L('启动服务后将自动拉取可用工具列表', 'Start the server to list its tools')}
                        </span>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {serverTools.map((t) => {
                            const sep = t.name.indexOf('__')
                            const shortName = sep >= 0 ? t.name.slice(sep + 2) : t.name
                            return (
                              <li key={t.name} className="flex items-baseline gap-2 text-[11.5px]">
                                <span className="font-mono font-medium text-ink">{shortName}</span>
                                {t.description && (
                                  <span className="truncate text-ink-muted">{t.description}</span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={dsBotOpen} onOpenChange={(next) => {
        if (busy) return
        setDsBotOpen(next)
        if (!next) setDsBotToken('')
      }} title={L('连接 DS Bot 团队', 'Connect a DS Bot team')}
        footer={<Button variant="primary" disabled={busy || !dsBotToken.trim()} onClick={() => void connectDsBot()}>
          {L('保存并连接', 'Save and connect')}
        </Button>}>
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-secondary">{L(
            '在 DS Bot 的「设置 → MCP 访问」启用本机服务，为 BotArk 创建客户端并选择可访问的 Bot 和群聊。',
            'Enable MCP access in DS Bot settings. Create a BotArk client and select the bots and groups it can reach.'
          )}</p>
          <Field htmlFor="ds-bot-port" label={L('本机端口', 'Local port')}>
            <TextInput id="ds-bot-port" type="number" min={1024} max={65535} value={dsBotPort} onChange={(e) => setDsBotPort(e.target.value)} />
          </Field>
          <Field htmlFor="ds-bot-token" label={L('客户端令牌', 'Client token')}>
            <TextInput id="ds-bot-token" type="password" autoComplete="off" value={dsBotToken} onChange={(e) => setDsBotToken(e.target.value)} />
          </Field>
          {(formError || error) && <p role="alert" className="text-[12px] text-status-error">{formError || error}</p>}
        </div>
      </Dialog>
      {/* Add / Edit Server Dialog */}
      <Dialog
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing ? L('编辑 MCP 服务', 'Edit MCP Server') : L('添加 MCP 服务', 'Add MCP Server')}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFormOpen(false)}>
              {L('取消', 'Cancel')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleSaveForm(false)}>
              {L('保存', 'Save')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleSaveForm(true)}>
              {busy && <Loader2 className="animate-spin" />}
              {L('保存并启动', 'Save & Start')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={L('服务名称', 'Server Name')}>
            <TextInput
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. context7"
            />
          </Field>

          <Field label={L('传输协议', 'Transport')}>
            <SegmentedControl<McpTransportType>
              value={formTransport}
              onValueChange={setFormTransport}
              fullWidth
              options={[
                { value: 'stdio', label: 'stdio' },
                { value: 'streamable-http', label: 'Streamable HTTP' },
                { value: 'sse', label: 'SSE' }
              ]}
            />
          </Field>

          {formTransport === 'stdio' ? (
            <>
              <Field label={L('启动命令', 'Command')}>
                <TextInput
                  value={formCommand}
                  onChange={(e) => setFormCommand(e.target.value)}
                  placeholder="npx / uvx / node"
                  className="font-mono"
                />
              </Field>
              <Field label={L('参数', 'Arguments')}>
                <TextInput
                  value={formArgs}
                  onChange={(e) => setFormArgs(e.target.value)}
                  placeholder="-y @upstash/context7-mcp"
                  className="font-mono"
                />
              </Field>
              <Field label={L('工作目录 (可选)', 'Working Directory (optional)')}>
                <TextInput
                  value={formCwd}
                  onChange={(e) => setFormCwd(e.target.value)}
                  placeholder={view?.directory || L('默认目录', 'Default')}
                  className="font-mono"
                />
              </Field>
              <Field
                label={L('环境变量 (每行 KEY=VALUE 或 JSON)', 'Environment Variables (KEY=VALUE per line or JSON)')}
                hint={
                  editing?.envKeys?.length
                    ? L(`已加密保存：${editing.envKeys.join(', ')}`, `Saved encrypted: ${editing.envKeys.join(', ')}`)
                    : undefined
                }
              >
                <textarea
                  rows={3}
                  value={formSecrets}
                  onChange={(e) => setFormSecrets(e.target.value)}
                  placeholder={
                    editing
                      ? L('留空保留已加密环境变量', 'Leave blank to keep saved encrypted env')
                      : 'API_KEY=...'
                  }
                  className="w-full rounded-xl border border-line-strong bg-sunken/40 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-300"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label={L('服务 URL', 'URL')}>
                <TextInput
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="font-mono"
                />
              </Field>
              <Field
                label={L('请求头 (每行 Key: Value 或 JSON)', 'Headers (Key: Value per line or JSON)')}
                hint={
                  editing?.headerKeys?.length
                    ? L(`已加密保存：${editing.headerKeys.join(', ')}`, `Saved encrypted: ${editing.headerKeys.join(', ')}`)
                    : undefined
                }
              >
                <textarea
                  rows={3}
                  value={formSecrets}
                  onChange={(e) => setFormSecrets(e.target.value)}
                  placeholder={
                    editing
                      ? L('留空保留已加密请求头', 'Leave blank to keep saved encrypted headers')
                      : 'Authorization: Bearer ...'
                  }
                  className="w-full rounded-xl border border-line-strong bg-sunken/40 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-300"
                />
              </Field>
            </>
          )}

          {editing && (
            <label className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
              <span>{L('保留未重新输入的已加密密钥', 'Keep existing encrypted secrets when blank')}</span>
              <SwitchPill size="sm" checked={keepSecrets} onCheckedChange={setKeepSecrets} />
            </label>
          )}

          {formError && (
            <p role="alert" className="rounded-lg bg-status-error/10 px-2.5 py-1.5 text-[12px] text-status-error-ink">
              {formError}
            </p>
          )}
        </div>
      </Dialog>

      {/* Paste JSON Dialog */}
      <Dialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        title={L('粘贴 MCP JSON 配置', 'Paste MCP JSON Config')}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPasteOpen(false)}>
              {L('取消', 'Cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleImportJson()}>
              {busy && <Loader2 className="animate-spin" />}
              {L('导入配置', 'Import')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <textarea
            rows={8}
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            placeholder={'{\n  "mcpServers": {\n    "my-server": { "command": "npx", "args": ["-y", "@org/mcp"] }\n  }\n}'}
            className="w-full rounded-xl border border-line-strong bg-sunken/40 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-300"
          />
          <label className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
            <span>{L('导入后自动启动已启用的服务', 'Auto-start enabled servers after import')}</span>
            <SwitchPill size="sm" checked={pasteAutoStart} onCheckedChange={setPasteAutoStart} />
          </label>
          {pasteError && (
            <p role="alert" className="rounded-lg bg-status-error/10 px-2.5 py-1.5 text-[12px] text-status-error-ink">
              {pasteError}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  )
}
