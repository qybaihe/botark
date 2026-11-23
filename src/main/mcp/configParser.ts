import { basename } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { McpServerConfigInput, McpTransportType } from '@shared/workspace'

export interface ParsedMcpServer {
  name: string
  transport: McpTransportType | 'auto'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  needsConfig: boolean
  unresolvedVars: string[]
}

export interface ParseConfigOptions {
  workspaceRoot?: string
  fallbackName?: string
  skipServerNames?: Set<string>
  skipLoopbackUrls?: Set<string>
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/
const VAR_RE = /\$\{([^}]+)\}/g

/**
 * Strip UTF-8 BOM, JSONC line/block comments outside string literals,
 * and trailing commas before `}` or `]`.
 */
export function stripJsonCommentsAndBom(raw: string): string {
  const src = (raw ?? '').replace(/^\uFEFF/, '')
  let out = ''
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    const next = src[i + 1]

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false
        out += ch
      }
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      } else if (ch === '\n' || ch === '\r') {
        out += ch
      }
      continue
    }

    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }

    out += ch
  }

  // Second string-aware pass to remove trailing commas before `}` or `]`
  let cleaned = ''
  inString = false
  escaped = false
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!
    if (inString) {
      cleaned += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      cleaned += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j]!)) j++
      if (out[j] === '}' || out[j] === ']') {
        continue
      }
    }
    cleaned += ch
  }
  return cleaned.trim()
}

export function validateServerName(raw: string): string {
  const name = (raw ?? '').trim()
  if (!name) throw new Error('MCP 服务名称不能为空')
  if (name.length > 128) throw new Error(`MCP 服务名称过长（最多 128 字符）：${name.slice(0, 32)}…`)
  if (CONTROL_CHAR_RE.test(name)) throw new Error(`MCP 服务名称包含非法控制字符：${name}`)
  return name
}

export function sanitizeToolPrefix(name: string): string {
  const trimmed = (name ?? '').trim()
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && !trimmed.includes('__')) {
    return trimmed
  }
  const sanitized = trimmed
    .replace(/__+/g, '_')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized || 'mcp'
}

export function allocateToolPrefix(name: string, used: Set<string>): string {
  const base = sanitizeToolPrefix(name)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}_${suffix++}`
  }
  used.add(candidate)
  return candidate
}

function expandWorkspaceVars(
  value: string,
  workspaceRoot?: string,
  unresolved?: Set<string>
): string {
  return value.replace(VAR_RE, (full, expr: string) => {
    const key = expr.trim()
    if (key === 'workspaceFolder' && workspaceRoot) return workspaceRoot
    if (key === 'workspaceFolderBasename' && workspaceRoot) return basename(workspaceRoot)
    unresolved?.add(full)
    return full
  })
}

function normalizeStringRecord(
  raw: unknown,
  fieldLabel: string,
  serverName: string,
  workspaceRoot?: string,
  unresolved?: Set<string>
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`无效的 MCP ${fieldLabel} 配置（${serverName}）：必须为键值对对象`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim()
    if (!key) continue
    if (typeof v === 'string') {
      out[key] = expandWorkspaceVars(v, workspaceRoot, unresolved)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = String(v)
    } else if (v === null || v === undefined) {
      continue
    } else {
      throw new Error(`无效的 MCP ${fieldLabel}.${key} 值（${serverName}）`)
    }
  }
  return Object.keys(out).length ? out : undefined
}

function normalizeTransport(
  rawType: unknown,
  hasCommand: boolean,
  hasSseUrl: boolean,
  serverName: string
): McpTransportType | 'auto' {
  if (rawType === undefined || rawType === null || rawType === '') {
    if (hasCommand) return 'stdio'
    if (hasSseUrl) return 'sse'
    return 'auto'
  }
  if (typeof rawType !== 'string') {
    throw new Error(`无效的 MCP 传输类型（${serverName}）`)
  }
  const lower = rawType.trim().toLowerCase()
  if (lower === 'auto') return hasCommand ? 'stdio' : 'auto'
  if (lower === 'stdio') return 'stdio'
  if (lower === 'sse') return 'sse'
  if (
    lower === 'http' ||
    lower === 'streamable-http' ||
    lower === 'streamablehttp' ||
    lower === 'streamable_http'
  ) {
    return 'streamable-http'
  }
  throw new Error(`不支持的 MCP 传输类型（${serverName}）：${rawType}`)
}

function validateHttpUrl(rawUrl: string, serverName: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new Error(`无效的 MCP 服务 URL（${serverName}）：URL 不能为空`)
  }
  const testTarget = trimmed.replace(VAR_RE, 'placeholder')
  let parsed: URL
  try {
    parsed = new URL(testTarget)
  } catch {
    throw new Error(`无效的 MCP 服务 URL（${serverName}）：${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`无效的 MCP 服务 URL 协议（${serverName}）：仅支持 http/https`)
  }
  return trimmed
}

export function normalizeServerEntry(
  rawName: string,
  rawConfig: unknown,
  options?: { workspaceRoot?: string }
): ParsedMcpServer {
  const name = validateServerName(rawName)
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error(`无效的 MCP 配置（${name}）：配置项必须为对象`)
  }
  const cfg = rawConfig as Record<string, unknown>
  const unresolved = new Set<string>()
  const root = options?.workspaceRoot

  const rawCmd = cfg['command']
  const hasCommandProp = rawCmd !== undefined && rawCmd !== null
  const rawUrlVal = cfg['url'] ?? cfg['httpUrl'] ?? cfg['serverUrl'] ?? cfg['sseUrl']
  const hasUrlProp = rawUrlVal !== undefined && rawUrlVal !== null
  const hasSseUrl = typeof cfg['sseUrl'] === 'string' && cfg['sseUrl'].trim().length > 0

  const transport = normalizeTransport(
    cfg['type'] ?? cfg['transport'],
    hasCommandProp,
    hasSseUrl,
    name
  )

  let command: string | undefined
  let args: string[] | undefined
  let cwd: string | undefined
  let env: Record<string, string> | undefined
  let url: string | undefined
  let headers: Record<string, string> | undefined

  if (transport === 'stdio' || (hasCommandProp && !hasUrlProp)) {
    if (typeof rawCmd !== 'string' || !rawCmd.trim()) {
      throw new Error(`无效的 MCP 命令（${name}）：command 不能为空`)
    }
    command = expandWorkspaceVars(rawCmd.trim(), root, unresolved)
    if (cfg['args'] !== undefined && cfg['args'] !== null) {
      if (!Array.isArray(cfg['args'])) {
        throw new Error(`无效的 MCP 参数（${name}）：args 必须为数组`)
      }
      args = cfg['args'].map((item, idx) => {
        if (typeof item === 'string') return expandWorkspaceVars(item, root, unresolved)
        if (typeof item === 'number' || typeof item === 'boolean') return String(item)
        throw new Error(`无效的 MCP 参数 args[${idx}]（${name}）`)
      })
    }
    if (cfg['cwd'] !== undefined && cfg['cwd'] !== null && cfg['cwd'] !== '') {
      if (typeof cfg['cwd'] !== 'string') {
        throw new Error(`无效的 MCP 工作目录 cwd（${name}）`)
      }
      const expandedCwd = expandWorkspaceVars(cfg['cwd'].trim(), root, unresolved)
      if (expandedCwd) cwd = expandedCwd
    }
    env = normalizeStringRecord(cfg['env'], 'env', name, root, unresolved)
  } else if (hasUrlProp) {
    if (typeof rawUrlVal !== 'string') {
      throw new Error(`无效的 MCP 服务 URL（${name}）：url 必须为字符串`)
    }
    const expandedUrl = expandWorkspaceVars(rawUrlVal, root, unresolved)
    url = validateHttpUrl(expandedUrl, name)
    headers = normalizeStringRecord(cfg['headers'], 'headers', name, root, unresolved)
  } else {
    throw new Error(`无效的 MCP 配置（${name}）：缺少 command 或 url`)
  }

  const enabled = cfg['disabled'] === true || cfg['enabled'] === false ? false : true
  const unresolvedVars = [...unresolved]

  return {
    name,
    transport,
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(headers !== undefined ? { headers } : {}),
    enabled,
    needsConfig: unresolvedVars.length > 0,
    unresolvedVars
  }
}

export function normalizeServerInput(
  input: McpServerConfigInput,
  workspaceRoot?: string
): ParsedMcpServer {
  return normalizeServerEntry(
    input.name,
    {
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      enabled: input.enabled
    },
    { workspaceRoot }
  )
}

function isServerLikeObject(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const obj = v as Record<string, unknown>
  return (
    'command' in obj ||
    'url' in obj ||
    'httpUrl' in obj ||
    'serverUrl' in obj ||
    'sseUrl' in obj
  )
}

function extractServerMap(
  parsed: unknown,
  fallbackName?: string
): Array<[string, unknown]> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP 配置根节点必须是 JSON 对象')
  }
  const obj = parsed as Record<string, unknown>

  const namedContainers = ['mcpServers', 'servers', 'mcp_servers'] as const
  for (const key of namedContainers) {
    if (key in obj && obj[key] !== undefined) {
      const container = obj[key]
      if (!container || typeof container !== 'object' || Array.isArray(container)) {
        throw new Error(`${key} 必须为对象`)
      }
      const entries = Object.entries(container as Record<string, unknown>)
      if (!entries.length) {
        throw new Error(`${key} 中未包含任何 MCP 服务`)
      }
      return entries
    }
  }

  // Single server config object `{ name?, command|url, ... }`
  if (isServerLikeObject(obj)) {
    const rawName = typeof obj['name'] === 'string' && obj['name'].trim()
      ? obj['name']
      : fallbackName || 'custom-mcp'
    return [[rawName, obj]]
  }

  // Bare server map `{ myServer: { command|url, ... }, ... }`
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return []
  }
  if (entries.length > 0 && entries.every(([, v]) => isServerLikeObject(v))) {
    return entries
  }

  throw new Error('缺少 mcpServers / servers 对象或有效的 MCP 服务配置')
}

function isLoopbackBotarkUrl(url: string | undefined, skipUrls?: Set<string>): boolean {
  if (!url) return false
  if (skipUrls?.has(url)) return true
  try {
    const u = new URL(url)
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    if (isLocal && u.pathname === '/mcp' && skipUrls && skipUrls.size > 0) {
      return skipUrls.has(url)
    }
  } catch {
    /* ignore */
  }
  return false
}

export function parseMcpConfigObject(
  parsed: unknown,
  options?: ParseConfigOptions
): ParsedMcpServer[] {
  const entries = extractServerMap(parsed, options?.fallbackName)
  const out: ParsedMcpServer[] = []
  for (const [rawName, rawCfg] of entries) {
    const trimmedName = rawName.trim()
    if (options?.skipServerNames?.has(trimmedName)) continue
    const normalized = normalizeServerEntry(rawName, rawCfg, {
      workspaceRoot: options?.workspaceRoot
    })
    if (isLoopbackBotarkUrl(normalized.url, options?.skipLoopbackUrls)) continue
    out.push(normalized)
  }
  return out
}

export function parseMcpConfigText(
  rawText: string,
  options?: ParseConfigOptions
): ParsedMcpServer[] {
  const stripped = stripJsonCommentsAndBom(rawText)
  if (!stripped) throw new Error('MCP 配置内容为空')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return parseMcpConfigObject(parsed, options)
}

export function parseHermesYamlMcpServers(
  rawYaml: string,
  options?: ParseConfigOptions
): ParsedMcpServer[] {
  const parsed = parseYaml(rawYaml) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const obj = parsed as Record<string, unknown>
  const mcpServers = obj['mcp_servers']
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return []
  const skipNames = new Set<string>(['botark_workspace', ...(options?.skipServerNames ?? [])])
  const out: ParsedMcpServer[] = []
  for (const [rawName, rawCfg] of Object.entries(mcpServers as Record<string, unknown>)) {
    const trimmedName = rawName.trim()
    if (!trimmedName || skipNames.has(trimmedName)) continue
    const normalized = normalizeServerEntry(trimmedName, rawCfg, {
      workspaceRoot: options?.workspaceRoot
    })
    if (isLoopbackBotarkUrl(normalized.url, options?.skipLoopbackUrls)) continue
    out.push(normalized)
  }
  return out
}
