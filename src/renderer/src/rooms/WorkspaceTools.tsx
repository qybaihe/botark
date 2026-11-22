import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckCircle2,
  ClipboardPaste,
  Code2,
  FolderOpen,
  Import,
  Link2,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
  Unlink,
  X
} from 'lucide-react'
import type {
  McpConfigScope,
  McpServerConfigInput,
  McpTransportType,
  WorkspaceRequest,
  WorkspaceServerView,
  WorkspaceTool,
  WorkspaceView
} from '@shared/workspace'
import { ArkMcpNodeSvg, ArkWorkspaceVaultSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { Dialog } from '@/components/ui/Dialog'
import { Field, TextInput } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { MENU_SURFACE } from '@/components/ui/Menu'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { usePrefsStore } from '@/store/prefsStore'

export interface WorkspaceToolsProps {
  scope: string
  recipient: string
  append: (text: string) => void
  hermesAccount?: string
  variant?: 'popover' | 'inspector'
}

type StudioTab = 'file' | 'folder' | 'mcp'

interface SchemaPropertySpec {
  key: string
  type: string
  description?: string
  required: boolean
}

interface KvRow {
  id: string
  key: string
  value: string
}

const WORKSPACE_SYNC_EVENT = 'botark:workspace-updated'

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
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
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

function formatArgsText(args?: string[]): string {
  if (!args?.length) return ''
  return args
    .map((a) => (/\s/.test(a) || !a ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
}

function extractScalarFields(tool: WorkspaceTool | undefined): SchemaPropertySpec[] | null {
  if (!tool?.inputSchema || typeof tool.inputSchema !== 'object') return []
  const props = tool.inputSchema['properties']
  if (!props || typeof props !== 'object') return []
  const reqSet = new Set(
    Array.isArray(tool.inputSchema['required'])
      ? (tool.inputSchema['required'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  )
  const out: SchemaPropertySpec[] = []
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    const spec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const type = typeof spec['type'] === 'string' ? spec['type'] : 'string'
    if (type === 'object' || type === 'array') return null
    out.push({
      key,
      type,
      description: typeof spec['description'] === 'string' ? spec['description'] : undefined,
      required: reqSet.has(key)
    })
  }
  return out
}

function transportLabel(srv: WorkspaceServerView): string {
  const t = srv.resolvedTransport ?? srv.transport
  if (t === 'stdio') return 'stdio'
  if (t === 'sse') return 'SSE'
  if (t === 'streamable-http') return 'HTTP'
  return srv.command ? 'stdio' : 'HTTP/SSE'
}

function McpServerFormDialog({
  open,
  onOpenChange,
  initialServer,
  defaultCwd,
  scopeId,
  busy,
  onSave
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialServer?: WorkspaceServerView
  defaultCwd?: string
  scopeId: string
  busy: boolean
  onSave: (
    payload: McpServerConfigInput,
    options: { previousName?: string; autoStart: boolean }
  ) => Promise<void>
}) {
  const locale = usePrefsStore((s) => s.locale)
  const L = (zh: string, en: string) => (locale === 'en' ? en : zh)

  const isEdit = Boolean(initialServer)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransportType>('stdio')
  const [targetScope, setTargetScope] = useState<McpConfigScope>('scope')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [cwd, setCwd] = useState('')
  const [url, setUrl] = useState('')
  const [kvRows, setKvRows] = useState<KvRow[]>([])
  const [keepSecrets, setKeepSecrets] = useState(true)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (!open) return
    setFormError('')
    if (initialServer) {
      setName(initialServer.name)
      const resolved =
        initialServer.resolvedTransport ??
        (initialServer.transport && initialServer.transport !== 'auto'
          ? initialServer.transport
          : initialServer.command
            ? 'stdio'
            : 'streamable-http')
      setTransport(resolved)
      setTargetScope(initialServer.scope ?? (scopeId === '__global__' ? 'global' : 'scope'))
      setCommand(initialServer.command ?? '')
      setArgsText(formatArgsText(initialServer.args))
      setCwd(initialServer.cwd ?? '')
      setUrl(initialServer.url ?? '')
      setKvRows([])
      setKeepSecrets(true)
    } else {
      setName('')
      setTransport('stdio')
      setTargetScope(scopeId === '__global__' ? 'global' : 'scope')
      setCommand('')
      setArgsText('')
      setCwd('')
      setUrl('')
      setKvRows([])
      setKeepSecrets(false)
    }
  }, [open, initialServer, scopeId])

  const existingSecretKeys =
    transport === 'stdio' ? initialServer?.envKeys ?? [] : initialServer?.headerKeys ?? []

  const addKvRow = () => {
    setKvRows((prev) => [...prev, { id: `${Date.now()}_${prev.length}`, key: '', value: '' }])
  }

  const submit = async (autoStart: boolean) => {
    setFormError('')
    const trimmedName = name.trim()
    if (!trimmedName) {
      setFormError(L('请输入服务名称', 'Server name is required'))
      return
    }
    const kvMap: Record<string, string> = {}
    for (const row of kvRows) {
      const k = row.key.trim()
      if (!k) continue
      kvMap[k] = row.value
    }
    const hasNewKv = Object.keys(kvMap).length > 0

    let payload: McpServerConfigInput
    if (transport === 'stdio') {
      if (!command.trim()) {
        setFormError(L('请输入启动命令（如 npx / uvx / node）', 'Command is required (e.g. npx, uvx, node)'))
        return
      }
      payload = {
        name: trimmedName,
        transport: 'stdio',
        command: command.trim(),
        args: parseArgsText(argsText),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(hasNewKv ? { env: kvMap } : !isEdit || !keepSecrets ? { env: {} } : {}),
        targetScope: scopeId === '__global__' ? 'global' : targetScope,
        keepExistingSecrets: isEdit ? keepSecrets : false
      }
    } else {
      const trimmedUrl = url.trim()
      if (!trimmedUrl) {
        setFormError(L('请输入服务 URL', 'Server URL is required'))
        return
      }
      try {
        const parsed = new URL(trimmedUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setFormError(L('仅支持 http:// 或 https:// 协议', 'Only http:// and https:// URLs are supported'))
          return
        }
      } catch {
        setFormError(L('URL 格式无效，请检查协议与主机地址', 'Invalid URL format'))
        return
      }
      payload = {
        name: trimmedName,
        transport,
        url: trimmedUrl,
        ...(hasNewKv ? { headers: kvMap } : !isEdit || !keepSecrets ? { headers: {} } : {}),
        targetScope: scopeId === '__global__' ? 'global' : targetScope,
        keepExistingSecrets: isEdit ? keepSecrets : false
      }
    }

    try {
      await onSave(payload, {
        previousName: initialServer?.name,
        autoStart
      })
      onOpenChange(false)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? L('编辑 MCP 服务', 'Edit MCP Server') : L('添加 MCP 服务', 'Add MCP Server')}
      description={L(
        '配置 stdio 本地命令或 Streamable HTTP / SSE 远程 MCP 端点',
        'Configure a local stdio command or remote Streamable HTTP / SSE MCP endpoint'
      )}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {L('取消', 'Cancel')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void submit(false)}>
            {L('保存', 'Save')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit(true)}>
            {busy && <Loader2 className="animate-spin" />}
            {L('保存并启动', 'Save & Start')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={L('服务名称', 'Server Name')}>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. context7 / @org/mcp"
              className="h-8 text-[12.5px]"
            />
          </Field>
          {scopeId !== '__global__' && !isEdit && (
            <Field label={L('作用域', 'Scope')}>
              <SegmentedControl<McpConfigScope>
                value={targetScope}
                onValueChange={setTargetScope}
                size="sm"
                fullWidth
                options={[
                  { value: 'scope', label: L('当前工作区', 'Workspace') },
                  { value: 'global', label: L('全局复用', 'Global') }
                ]}
              />
            </Field>
          )}
        </div>

        <Field label={L('传输协议', 'Transport')}>
          <SegmentedControl<McpTransportType>
            value={transport}
            onValueChange={setTransport}
            size="sm"
            fullWidth
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'streamable-http', label: 'Streamable HTTP' },
              { value: 'sse', label: 'SSE' }
            ]}
          />
        </Field>

        {transport === 'stdio' ? (
          <>
            <Field label={L('启动命令', 'Command')}>
              <TextInput
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx / uvx / node / python"
                className="h-8 font-mono text-[12px]"
              />
            </Field>
            <Field
              label={L('命令参数', 'Arguments')}
              hint={L('空格分隔参数，含空格的参数请用引号包裹', 'Space-separated arguments; quote values with spaces')}
            >
              <TextInput
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem ."
                className="h-8 font-mono text-[12px]"
              />
            </Field>
            <Field label={L('工作目录 (可选)', 'Working Directory (optional)')}>
              <TextInput
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={defaultCwd || L('默认继承当前工作区目录', 'Inherits bound workspace directory')}
                className="h-8 font-mono text-[12px]"
              />
            </Field>
          </>
        ) : (
          <Field label={L('服务 URL', 'Endpoint URL')}>
            <TextInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="h-8 font-mono text-[12px]"
            />
          </Field>
        )}

        <div className="flex flex-col gap-2 rounded-xl border border-line bg-sunken/35 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-ink">
              {transport === 'stdio' ? L('环境变量 (env)', 'Environment Variables') : L('请求头 (headers)', 'HTTP Headers')}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={addKvRow} className="h-6 px-2 text-[11px]">
              <Plus className="size-3" />
              {L('添加一项', 'Add')}
            </Button>
          </div>

          {isEdit && existingSecretKeys.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface px-2 py-1.5 text-[11px]">
              <span className="truncate text-ink-secondary">
                {L('已加密保存：', 'Saved encrypted: ')}
                <span className="font-mono text-ink">{existingSecretKeys.join(', ')}</span>
              </span>
              <label className="flex shrink-0 items-center gap-1.5 text-ink-secondary">
                <SwitchPill size="sm" checked={keepSecrets} onCheckedChange={setKeepSecrets} />
                <span>{L('保留原值', 'Keep')}</span>
              </label>
            </div>
          )}

          {kvRows.map((row) => (
            <div key={row.id} className="flex items-center gap-1.5">
              <TextInput
                value={row.key}
                onChange={(e) =>
                  setKvRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                }
                placeholder={transport === 'stdio' ? 'API_KEY' : 'Authorization'}
                className="h-7 flex-1 font-mono text-[11.5px]"
              />
              <TextInput
                type="password"
                value={row.value}
                onChange={(e) =>
                  setKvRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                }
                placeholder={transport === 'stdio' ? 'value' : 'Bearer ...'}
                className="h-7 flex-1 font-mono text-[11.5px]"
              />
              <button
                type="button"
                aria-label={L('移除', 'Remove')}
                onClick={() => setKvRows((prev) => prev.filter((r) => r.id !== row.id))}
                className="press-icon grid size-7 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-hover hover:text-status-error"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>

        {formError && (
          <p role="alert" className="rounded-lg bg-status-error/10 px-2.5 py-1.5 text-[12px] text-status-error-ink">
            {formError}
          </p>
        )}
      </div>
    </Dialog>
  )
}

function McpPasteJsonDialog({
  open,
  onOpenChange,
  scopeId,
  busy,
  onImportJson
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scopeId: string
  busy: boolean
  onImportJson: (rawJson: string, targetScope: McpConfigScope, autoStart: boolean) => Promise<void>
}) {
  const locale = usePrefsStore((s) => s.locale)
  const L = (zh: string, en: string) => (locale === 'en' ? en : zh)
  const [rawJson, setRawJson] = useState('')
  const [targetScope, setTargetScope] = useState<McpConfigScope>('scope')
  const [autoStart, setAutoStart] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open) return
    setErr('')
    setRawJson('')
    setTargetScope(scopeId === '__global__' ? 'global' : 'scope')
    setAutoStart(true)
  }, [open, scopeId])

  const submit = async () => {
    setErr('')
    if (!rawJson.trim()) {
      setErr(L('请粘贴 MCP JSON 配置内容', 'Please paste MCP JSON configuration'))
      return
    }
    try {
      await onImportJson(rawJson, scopeId === '__global__' ? 'global' : targetScope, autoStart)
      onOpenChange(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={L('粘贴 MCP JSON 配置', 'Paste MCP JSON Config')}
      description={L(
        '支持 Claude mcpServers、VS Code servers、JSONC 注释或单个服务对象',
        'Supports mcpServers, VS Code servers, JSONC comments, or a single server object'
      )}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {L('取消', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />}
            {L('解析并导入', 'Import JSON')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {scopeId !== '__global__' && (
          <Field label={L('导入作用域', 'Target Scope')}>
            <SegmentedControl<McpConfigScope>
              value={targetScope}
              onValueChange={setTargetScope}
              size="sm"
              fullWidth
              options={[
                { value: 'scope', label: L('当前工作区', 'Workspace') },
                { value: 'global', label: L('全局复用', 'Global') }
              ]}
            />
          </Field>
        )}

        <textarea
          rows={8}
          value={rawJson}
          onChange={(e) => setRawJson(e.target.value)}
          placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'}
          className="w-full resize-y rounded-xl border border-line-strong bg-sunken/40 px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent-300"
        />

        <label className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
          <span>{L('导入后自动尝试启动已启用的服务', 'Auto-start enabled servers after import')}</span>
          <SwitchPill size="sm" checked={autoStart} onCheckedChange={setAutoStart} />
        </label>

        {err && (
          <p role="alert" className="rounded-lg bg-status-error/10 px-2.5 py-1.5 text-[12px] text-status-error-ink">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  )
}

function WorkspaceStudioBody({
  scope,
  recipient,
  append,
  hermesAccount,
  state,
  setState,
  onAfterAppend,
  onClose,
  onModalOpenChange
}: {
  scope: string
  recipient: string
  append: (text: string) => void
  hermesAccount?: string
  state: WorkspaceView | undefined
  setState: (next: WorkspaceView) => void
  onAfterAppend?: () => void
  onClose?: () => void
  onModalOpenChange?: (open: boolean) => void
}) {
  const locale = usePrefsStore((s) => s.locale)
  const L = (zh: string, en: string) => (locale === 'en' ? en : zh)

  const bridge = getBridge()?.workspace
  const [tab, setTab] = useState<StudioTab>('file')
  const hasUserSwitchedTabRef = useRef(false)
  const [path, setPath] = useState('.')
  const [range, setRange] = useState('')
  const [mcpTool, setMcpTool] = useState<string>('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [rawJsonMode, setRawJsonMode] = useState(false)
  const [argsJson, setArgsJson] = useState('{}')
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  const [formOpen, setFormOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<WorkspaceServerView | undefined>()
  const [pasteOpen, setPasteOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [expandedError, setExpandedError] = useState<string | null>(null)

  useEffect(() => {
    onModalOpenChange?.(formOpen || pasteOpen)
  }, [formOpen, pasteOpen, onModalOpenChange])

  useEffect(() => {
    if (!hasUserSwitchedTabRef.current && state) {
      setTab('file')
    }
  }, [state])

  const externalTools = useMemo(
    () => (state?.tools ?? []).filter((t) => t.name.includes('__')),
    [state?.tools]
  )

  useEffect(() => {
    if (!externalTools.some((t) => t.name === mcpTool)) {
      setMcpTool(externalTools[0]?.name ?? '')
      setFieldValues({})
      setArgsJson('{}')
    }
  }, [externalTools, mcpTool])

  const selectedMcpSpec = useMemo(
    () => externalTools.find((t) => t.name === mcpTool),
    [externalTools, mcpTool]
  )
  const scalarFields = useMemo(() => extractScalarFields(selectedMcpSpec), [selectedMcpSpec])

  if (!bridge) return null

  const publishState = (next: WorkspaceView) => {
    setState(next)
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_SYNC_EVENT, { detail: { scope, state: next } })
    )
  }

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setHint('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Refresh view so any server-side `lastError` captured during failed start is visible
      try {
        const refreshed = await bridge.manage(scope, { op: 'status' })
        publishState(refreshed)
      } catch {
        /* ignore refresh error */
      }
    } finally {
      setBusy(false)
    }
  }

  const manage = (
    request: Exclude<WorkspaceRequest, { op: 'run' }>,
    onResult?: (next: WorkspaceView) => void
  ) =>
    act(async () => {
      const next = await bridge.manage(scope, request)
      publishState(next)
      onResult?.(next)
    })

  const handleBind = () =>
    manage({ op: 'bind' }, (next) => {
      if (next.canceled || !next.directory) return
      setTab('file')
      setHint(L('工作区已就绪，可以开始对话。', 'Workspace ready. You can start chatting.'))
      onClose?.()
    })

  const handleImportFile = () =>
    manage({ op: 'import' }, (next) => {
      if (next.canceled) return
      const count = next.importedCount ?? 0
      if (count > 0) {
        hasUserSwitchedTabRef.current = true
        setTab('mcp')
        setHint(L(`已导入 ${count} 个 MCP 服务`, `Imported ${count} MCP server(s)`))
      } else {
        setError(L('未发现可导入的 MCP 服务配置', 'No importable MCP servers found'))
      }
    })

  const handleHermesConnect = () => {
    if (!hermesAccount) return
    void manage({ op: 'hermes', accountId: hermesAccount }, (next) => {
      if (next.canceled) return
      setHint(L('已将工作区接入 Hermes', 'Connected workspace to Hermes'))
    })
  }

  const handleSaveServer = async (
    payload: McpServerConfigInput,
    options: { previousName?: string; autoStart: boolean }
  ) => {
    setBusy(true)
    setError('')
    setHint('')
    try {
      const req: Exclude<WorkspaceRequest, { op: 'run' }> = options.previousName
        ? {
            op: 'update',
            previousName: options.previousName,
            server: payload,
            autoStart: options.autoStart
          }
        : {
            op: 'upsert',
            server: payload,
            autoStart: options.autoStart
          }
      const next = await bridge.manage(scope, req)
      publishState(next)
      hasUserSwitchedTabRef.current = true
      setTab('mcp')
      setHint(
        options.autoStart
          ? L(`已保存并启动「${payload.name}」`, `Saved & started "${payload.name}"`)
          : L(`已保存「${payload.name}」`, `Saved "${payload.name}"`)
      )
    } catch (e) {
      const refreshed = await bridge.manage(scope, { op: 'status' }).catch(() => undefined)
      if (refreshed) publishState(refreshed)
      throw e
    } finally {
      setBusy(false)
    }
  }

  const handleImportJson = async (
    rawJson: string,
    targetScope: McpConfigScope,
    autoStart: boolean
  ) => {
    setBusy(true)
    setError('')
    setHint('')
    try {
      const next = await bridge.manage(scope, {
        op: 'importJson',
        rawJson,
        targetScope,
        autoStart
      })
      publishState(next)
      hasUserSwitchedTabRef.current = true
      setTab('mcp')
      const count = next.importedCount ?? 0
      setHint(L(`已导入 ${count} 个 MCP 服务`, `Imported ${count} MCP server(s)`))
    } catch (e) {
      const refreshed = await bridge.manage(scope, { op: 'status' }).catch(() => undefined)
      if (refreshed) publishState(refreshed)
      throw e
    } finally {
      setBusy(false)
    }
  }

  const runReadOrList = (op: 'read' | 'list') =>
    act(async () => {
      const targetPath = path.trim() || '.'
      const lines =
        range.trim() && op === 'read' ? /^(\d+)\s*-\s*(\d+)$/.exec(range.trim()) : null
      if (
        range.trim() &&
        op === 'read' &&
        (!lines || +lines[1]! < 1 || +lines[2]! < +lines[1]!)
      ) {
        throw new Error(L('行号格式如 1-80', 'Line range format e.g. 1-80'))
      }
      let result = await bridge.run(scope, op, { path: targetPath }, recipient)
      if (lines) {
        result = result
          .split('\n')
          .slice(+lines[1]! - 1, +lines[2]!)
          .join('\n')
      }
      const label =
        op === 'read'
          ? `@file ${targetPath}${lines ? `:${lines[1]}-${lines[2]}` : ''}`
          : `@folder ${targetPath}`
      append(`[${label}]\n${result}`)
      onAfterAppend?.()
    })

  const runCustomMcpTool = () =>
    act(async () => {
      if (!mcpTool) return
      let parsedArgs: Record<string, unknown> = {}
      if (!rawJsonMode && scalarFields !== null) {
        for (const f of scalarFields) {
          const raw = (fieldValues[f.key] ?? '').trim()
          if (!raw) {
            if (f.required) throw new Error(L(`请填写 ${f.key}`, `${f.key} is required`))
            continue
          }
          if (f.type === 'number' || f.type === 'integer') {
            const num = Number(raw)
            if (Number.isNaN(num)) throw new Error(L(`${f.key} 需为数字`, `${f.key} must be a number`))
            parsedArgs[f.key] = num
          } else if (f.type === 'boolean') {
            parsedArgs[f.key] = raw === 'true' || raw === '1'
          } else {
            parsedArgs[f.key] = raw
          }
        }
      } else {
        try {
          parsedArgs = JSON.parse(argsJson || '{}') as Record<string, unknown>
        } catch {
          throw new Error(L('JSON 格式有误', 'Invalid JSON format'))
        }
      }
      const result = await bridge.run(scope, mcpTool, parsedArgs, recipient)
      append(`[${mcpTool}]\n${result}`)
      onAfterAppend?.()
    })

  const servers = state?.servers ?? []
  const runningCount = servers.filter((s) => s.running).length

  return (
    <div className="flex flex-col gap-2.5">
      {onClose && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArkWorkspaceVaultSvg active={Boolean(state?.directory) || runningCount > 0} className="size-4 text-accent-600" />
            <span className="text-[13px] font-semibold tracking-tight text-ink">
              {L('本地工作区', 'Local Workspace')}
            </span>
          </div>
          <IconButton label={L('关闭', 'Close')} onClick={onClose} className="-mr-1 size-7">
            <X />
          </IconButton>
        </div>
      )}

      {/* Workspace Directory & One-Click Optimize / Ready Card */}
      <div className="rounded-xl border border-line bg-sunken/45 p-2.5">
        {state?.directory ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-status-online" />
                <span
                  className="truncate font-mono text-[11.5px] font-medium text-ink"
                  title={state.directory}
                >
                  {state.directory}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void handleBind()}
                  className="h-6 px-2 text-[11px]"
                >
                  {L('更换', 'Change')}
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  title={L('解除目录绑定（保留 MCP 配置）', 'Unbind directory (keeps MCP servers)')}
                  aria-label={L('解除绑定', 'Unbind')}
                  onClick={() =>
                    void manage({ op: 'unbind' }, () =>
                      setHint(L('已解除目录绑定，MCP 服务配置已保留', 'Directory unbound; MCP servers preserved'))
                    )
                  }
                  className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-status-error"
                >
                  <Unlink className="size-3.5" />
                </button>
              </div>
            </div>

            <p className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
              <CheckCircle2 className="size-3 text-status-online" />
              {L('工作区已就绪，可以开始对话。', 'Workspace ready. You can start chatting.')}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-ink-secondary">
              {L('选择项目目录，就可以在群聊中使用文件工具。', 'Choose a project folder to use file tools in this room.')}
            </span>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void handleBind()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
              {L('选择目录', 'Choose Folder')}
            </Button>
          </div>
        )}
      </div>

      {/* Mode Switcher — Always Visible Even Without Bound Directory */}
      <SegmentedControl<StudioTab>
        value={tab}
        onValueChange={(next) => {
          hasUserSwitchedTabRef.current = true
          setTab(next)
        }}
        fullWidth
        size="xs"
        aria-label={L('工作区模式', 'Workspace mode')}
        options={[
          { value: 'file', label: L('文件', 'File') },
          { value: 'folder', label: L('目录', 'Folder') },
          {
            value: 'mcp',
            label: 'MCP',
            badge:
              servers.length > 0 ? (
                <span className="rounded-full bg-accent-50 px-1.5 text-[10px] font-semibold text-accent-600 tabular-nums">
                  {runningCount}/{servers.length}
                </span>
              ) : undefined
          }
        ]}
      />

      {tab === 'file' &&
        (state?.directory ? (
          <div className="flex items-center gap-1.5 animate-veil-in">
            <TextInput
              aria-label={L('相对路径', 'Relative path')}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="src/App.tsx"
              className="h-8 min-w-0 flex-1 font-mono text-[12px]"
            />
            <TextInput
              aria-label={L('摘录行号', 'Line range')}
              value={range}
              onChange={(e) => setRange(e.target.value)}
              placeholder="1-80"
              className="h-8 w-20 shrink-0 font-mono text-[12px]"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !path.trim()}
              onClick={() => void runReadOrList('read')}
              className="h-8 px-3"
            >
              {busy ? <Loader2 className="animate-spin" /> : L('插入', 'Insert')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-[11.5px] text-ink-muted">
            <span>{L('选择工作区目录后可插入文件内容', 'Bind a workspace folder to insert file excerpts')}</span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleBind()}>
              {L('选择目录', 'Bind')}
            </Button>
          </div>
        ))}

      {tab === 'folder' &&
        (state?.directory ? (
          <div className="flex items-center gap-1.5 animate-veil-in">
            <TextInput
              aria-label={L('目录相对路径', 'Directory relative path')}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="."
              className="h-8 min-w-0 flex-1 font-mono text-[12px]"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void runReadOrList('list')}
              className="h-8 px-3"
            >
              {busy ? <Loader2 className="animate-spin" /> : L('插入目录树', 'Insert Tree')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-[11.5px] text-ink-muted">
            <span>{L('选择工作区目录后可插入目录树', 'Bind a workspace folder to insert folder tree')}</span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleBind()}>
              {L('选择目录', 'Bind')}
            </Button>
          </div>
        ))}

      {tab === 'mcp' && (
        <div className="flex flex-col gap-2 animate-veil-in">
          {/* MCP Action Toolbar — Always Available */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditingServer(undefined)
                setFormOpen(true)
              }}
              className="h-7 px-2 text-[11px]"
            >
              <Plus className="size-3" />
              {L('添加服务', 'Add')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setPasteOpen(true)}
              className="h-7 px-2 text-[11px]"
            >
              <ClipboardPaste className="size-3" />
              {L('粘贴 JSON', 'Paste JSON')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void handleImportFile()}
              className="h-7 px-2 text-[11px]"
            >
              <Import className="size-3" />
              {L('导入 .json', 'Import .json')}
            </Button>
            {hermesAccount && state?.directory && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void handleHermesConnect()}
                className="h-7 px-2 text-[11px]"
              >
                <Link2 className="size-3" />
                {L('接入 Hermes', 'Hermes')}
              </Button>
            )}
          </div>

          {servers.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line py-3 text-center text-[11.5px] text-ink-muted">
              {L('尚未配置 MCP 服务，点击「添加服务」或「粘贴 JSON」即可开始', 'No MCP servers yet. Click Add or Paste JSON to get started.')}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {servers.map((srv) => {
                const detailText = srv.command
                  ? `${srv.command} ${(srv.args ?? []).join(' ')}`.trim()
                  : srv.url ?? ''
                const isConfirming = confirmDelete === srv.name
                const isErrExpanded = expandedError === srv.name
                return (
                  <div
                    key={`${srv.scope ?? 'scope'}:${srv.name}`}
                    className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface/85 px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <ArkMcpNodeSvg
                          className={cn(
                            'size-3.5 shrink-0',
                            srv.running
                              ? 'text-status-online'
                              : srv.lastError
                                ? 'text-status-error'
                                : 'text-ink-faint'
                          )}
                        />
                        <span className="truncate text-[12px] font-medium text-ink" title={srv.name}>
                          {srv.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-hover px-1.5 py-0.5 text-[9.5px] font-medium text-ink-secondary">
                          {transportLabel(srv)}
                        </span>
                        {srv.scope === 'global' && (
                          <span className="shrink-0 rounded-full bg-sunken px-1.5 py-0.5 text-[9.5px] text-ink-muted">
                            {L('全局', 'Global')}
                          </span>
                        )}
                        {(srv.running || (srv.toolCount ?? 0) > 0) && (
                          <span className="shrink-0 rounded-full bg-accent-50 px-1.5 py-0.5 text-[9.5px] font-medium text-accent-600 tabular-nums">
                            {srv.toolCount ?? 0} {L('工具', 'tools')}
                          </span>
                        )}
                      </div>
                      <SwitchPill
                        size="sm"
                        checked={srv.running}
                        disabled={busy}
                        aria-label={`${srv.running ? L('停止', 'Stop') : L('启动', 'Start')} ${srv.name}`}
                        onCheckedChange={() =>
                          void manage({
                            op: srv.running ? 'stop' : 'start',
                            server: srv.name,
                            targetScope: srv.scope
                          })
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted"
                        title={detailText}
                      >
                        {detailText || L('未指定命令或地址', 'No endpoint')}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {(srv.running || srv.lastError) && (
                          <button
                            type="button"
                            disabled={busy}
                            title={L('重启服务', 'Restart')}
                            aria-label={`${L('重启', 'Restart')} ${srv.name}`}
                            onClick={() =>
                              void manage(
                                { op: 'restart', server: srv.name, targetScope: srv.scope },
                                () => setHint(L(`已重启「${srv.name}」`, `Restarted "${srv.name}"`))
                              )
                            }
                            className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
                          >
                            <RotateCw className="size-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          title={L('编辑配置', 'Edit')}
                          aria-label={`${L('编辑', 'Edit')} ${srv.name}`}
                          onClick={() => {
                            setEditingServer(srv)
                            setFormOpen(true)
                          }}
                          className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
                        >
                          <Pencil className="size-3" />
                        </button>
                        {isConfirming ? (
                          <Button
                            size="sm"
                            variant="danger-confirm"
                            disabled={busy}
                            onClick={() => {
                              setConfirmDelete(null)
                              void manage(
                                { op: 'remove', server: srv.name, targetScope: srv.scope },
                                () => setHint(L(`已移除「${srv.name}」`, `Removed "${srv.name}"`))
                              )
                            }}
                            className="h-5.5 px-1.5 text-[10px]"
                          >
                            {L('确认删除', 'Confirm')}
                          </Button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            title={L('删除服务', 'Remove')}
                            aria-label={`${L('删除', 'Remove')} ${srv.name}`}
                            onClick={() => setConfirmDelete(srv.name)}
                            className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-status-error"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    {srv.lastError && (
                      <button
                        type="button"
                        onClick={() => setExpandedError(isErrExpanded ? null : srv.name)}
                        className={cn(
                          'w-full rounded-lg bg-status-error/10 px-2 py-1 text-left font-mono text-[10.5px] leading-4 text-status-error-ink break-all',
                          !isErrExpanded && 'line-clamp-3'
                        )}
                        title={L('点击展开/收起完整错误', 'Click to expand/collapse error')}
                      >
                        {srv.lastError}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {externalTools.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-2.5">
              <div className="flex items-center gap-1.5">
                <Select
                  size="xs"
                  aria-label={L('工作区工具', 'Workspace tool')}
                  value={mcpTool}
                  onValueChange={(next) => {
                    setMcpTool(next)
                    setFieldValues({})
                    setArgsJson('{}')
                  }}
                  className="flex-1"
                  options={externalTools.map((t) => ({
                    value: t.name,
                    label: t.name,
                    description: t.description
                  }))}
                />
                {scalarFields !== null && scalarFields.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRawJsonMode((v) => !v)}
                    title={rawJsonMode ? L('切换表单', 'Form view') : L('切换 JSON', 'JSON view')}
                    className="press-icon grid size-7 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-hover hover:text-ink"
                  >
                    <Code2 className="size-3.5" />
                  </button>
                )}
              </div>

              {!rawJsonMode && scalarFields !== null ? (
                scalarFields.map((f) => (
                  <TextInput
                    key={f.key}
                    value={fieldValues[f.key] ?? ''}
                    onChange={(e) =>
                      setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                    placeholder={`${f.key}${f.required ? ' *' : ''}`}
                    className="h-8 font-mono text-[12px]"
                  />
                ))
              ) : (
                <textarea
                  aria-label={L('工具参数 JSON', 'Tool arguments JSON')}
                  value={argsJson}
                  rows={2}
                  onChange={(e) => setArgsJson(e.target.value)}
                  placeholder='{"key": "value"}'
                  className="w-full resize-none rounded-lg border border-line-strong bg-sunken/40 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent-300"
                />
              )}

              <Button
                size="sm"
                variant="primary"
                disabled={busy || !mcpTool}
                onClick={() => void runCustomMcpTool()}
                className="w-full"
              >
                {busy ? <Loader2 className="animate-spin" /> : <Play />}
                {L('运行并插入', 'Run & Insert')}
              </Button>
            </div>
          )}
        </div>
      )}

      {hint && <p className="text-[11px] text-status-online-ink">{hint}</p>}
      {error && (
        <p role="alert" className="text-[11px] text-status-error">
          {error}
        </p>
      )}

      <McpServerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initialServer={editingServer}
        defaultCwd={state?.directory}
        scopeId={scope}
        busy={busy}
        onSave={handleSaveServer}
      />

      <McpPasteJsonDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        scopeId={scope}
        busy={busy}
        onImportJson={handleImportJson}
      />
    </div>
  )
}

export function WorkspaceTools({
  scope,
  recipient,
  append,
  hermesAccount,
  variant = 'popover'
}: WorkspaceToolsProps) {
  const locale = usePrefsStore((s) => s.locale)
  const L = (zh: string, en: string) => (locale === 'en' ? en : zh)

  const bridge = getBridge()?.workspace
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<WorkspaceView>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const modalOpenRef = useRef(false)
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null)

  const refresh = useCallback(() => {
    if (!bridge) return
    void bridge
      .manage(scope, { op: 'status' })
      .then((v) => setState(v))
      .catch(() => undefined)
  }, [bridge, scope])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  useEffect(() => {
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; state: WorkspaceView }>).detail
      if (detail?.scope === scope && detail.state) {
        setState(detail.state)
      }
    }
    window.addEventListener(WORKSPACE_SYNC_EVENT, onSync)
    return () => window.removeEventListener(WORKSPACE_SYNC_EVENT, onSync)
  }, [scope])

  useLayoutEffect(() => {
    if (!open || variant !== 'popover' || !triggerRef.current) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const panelWidth = 376
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12))
      const bottom = Math.max(12, window.innerHeight - rect.top + 10)
      setCoords({ left, bottom })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [open, variant])

  useEffect(() => {
    if (!open || variant !== 'popover') return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (modalOpenRef.current) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      if (
        target.closest('[data-radix-popper-content-wrapper]') ||
        target.closest('[role="dialog"]')
      ) {
        return
      }
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modalOpenRef.current) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, variant])

  if (!bridge) return null

  if (variant === 'inspector') {
    return (
      <div className="px-4 py-3">
        <WorkspaceStudioBody
          scope={scope}
          recipient={recipient}
          append={append}
          hermesAccount={hermesAccount}
          state={state}
          setState={setState}
        />
      </div>
    )
  }

  const runningCount = (state?.servers ?? []).filter((s) => s.running).length
  const totalCount = state?.servers.length ?? 0
  const active = Boolean(state?.directory) || runningCount > 0
  const triggerTitle = state?.directory
    ? L(
        `工作区：${state.directory}${totalCount ? ` · ${runningCount}/${totalCount} MCP` : ''}`,
        `Workspace: ${state.directory}${totalCount ? ` · ${runningCount}/${totalCount} MCP` : ''}`
      )
    : runningCount > 0
      ? L(`MCP：${runningCount}/${totalCount} 运行中`, `MCP: ${runningCount}/${totalCount} running`)
      : L('本地工作区', 'Local Workspace')

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={L('本地工作区', 'Local Workspace')}
        title={triggerTitle}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'no-drag press-icon relative grid size-8 shrink-0 place-items-center rounded-full transition-colors outline-none',
          open
            ? 'bg-active text-ink'
            : active
              ? 'text-ink hover:bg-hover'
              : 'text-ink-secondary hover:bg-hover hover:text-ink'
        )}
      >
        <ArkWorkspaceVaultSvg active={active} />
        {active && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-status-online ring-2 ring-surface"
          />
        )}
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={L('本地工作区', 'Local Workspace')}
            style={{ left: coords.left, bottom: coords.bottom }}
            className={cn(
              'no-drag fixed z-40 max-h-[min(560px,calc(100vh-84px))] w-[min(376px,calc(100vw-24px))] overflow-y-auto p-3',
              MENU_SURFACE,
              'animate-pop-lift shadow-dialog'
            )}
          >
            <WorkspaceStudioBody
              scope={scope}
              recipient={recipient}
              append={append}
              hermesAccount={hermesAccount}
              state={state}
              setState={setState}
              onAfterAppend={() => setOpen(false)}
              onClose={() => setOpen(false)}
              onModalOpenChange={(v) => {
                modalOpenRef.current = v
              }}
            />
          </div>,
          document.body
        )}
    </>
  )
}
