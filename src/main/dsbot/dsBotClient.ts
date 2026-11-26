/**
 * Unified Main-Process Client for `Fei-Craft/DS-Bot`.
 *
 * Supports all three official DS-Bot protocols transparently:
 * 1. `channel`: Direct DSH Web / Docker / Desktop HTTP + SSE (`/api/bot` & `/api/bot/feed`)
 * 2. `relay`: End-to-end encrypted Phone/Remote Link (`Noise_IK_25519_ChaChaPoly_SHA256` WebSocket relay)
 * 3. `mcp`: Official DS-Bot MCP Streamable HTTP Server (`POST /mcp`, Bearer token)
 */
import { randomUUID } from 'node:crypto'
import type {
  DsBotApprovalView,
  DsBotHistoryMessage,
  DsBotLocalDetection,
  DsBotMainEvent,
  DsBotMemoryEntry,
  DsBotMemoryView,
  DsBotModelInfo,
  DsBotQuestionView,
  DsBotScheduleItem,
  DsBotTargetInfo,
  DsBotUsageSummary
} from '@shared/ipc'
import { loadAccountProxyUrl } from '../muse/accountProxy'
import { proxyFetch, proxyWsAgent } from '../proxyTransport'
import {
  deviceIdForPublicKey,
  generateX25519KeyPair,
  parseDsBotPairingUri,
  randomBase64UrlToken
} from './dsBotNoise'
import { DsBotRelayClient, type DsBotRelayEvent } from './dsBotRelay'
import {
  detectLocalDsBotDiskConfig,
  getDsBotAccount,
  normalizeDsBotChannelUrl,
  normalizeDsBotMcpUrl,
  type ResolvedDsBotAccount
} from './dsBotStore'

export class DsBotApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message)
    this.name = 'DsBotApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

export interface DsBotAttachmentInput {
  name: string
  mimeType: string
  dataBase64: string
}

export interface DsBotSendCallbacks {
  onAccepted?: () => void
  onDelta?: (payload: { messageId: string; text: string; done: boolean }) => void
  onActivity?: (act: { code: string; text?: string; emoji?: string; busy: boolean }) => void
}

export interface DsBotProbeResult {
  authenticated: boolean
  version?: string
  hostName?: string
  botCount: number
  groupCount: number
  bots: DsBotTargetInfo[]
  groups: DsBotTargetInfo[]
  /** Returned when `channel` mode exchanged a `?token=...` URL for a signed session cookie. */
  exchangedCookie?: string
  /** Returned when `relay` mode completed initial pairing with a new client identity. */
  pairedIdentity?: {
    relayServer: string
    hostDeviceId: string
    hostKey: string
    hostName?: string
    deviceId: string
    publicKey: string
    privateKey: string
    accessToken: string
  }
  error?: string
}

const STAGED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MCP_WAIT_MAX_ROUNDS = 8
const MCP_WAIT_TIMEOUT_SECONDS = 25
const NATIVE_REPLY_TIMEOUT_MS = 180_000
const NATIVE_POLL_MS = 1_500

export function toDsBotAgentId(kind: 'bot' | 'room', rawId: string): string {
  return `${kind}:${rawId}`
}

export function parseDsBotAgentId(agentId: string): { kind: 'bot' | 'room'; rawId: string } {
  const trimmed = (agentId ?? '').trim()
  if (trimmed.startsWith('room:')) {
    return { kind: 'room', rawId: trimmed.slice('room:'.length) }
  }
  if (trimmed.startsWith('bot:')) {
    return { kind: 'bot', rawId: trimmed.slice('bot:'.length) }
  }
  return { kind: 'bot', rawId: trimmed }
}

type EventBroadcaster = (event: DsBotMainEvent) => void
let globalBroadcaster: EventBroadcaster | null = null

export function setDsBotEventBroadcaster(fn: EventBroadcaster | null): void {
  globalBroadcaster = fn
}

function broadcastEvent(event: DsBotMainEvent): void {
  globalBroadcaster?.(event)
}

interface ActiveTurnTracker {
  accountId: string
  agentId: string
  targetKind: 'bot' | 'room'
  rawTargetId: string
  conversationId: string
  requestId: string
  messageId: string
  controller: AbortController
  streamText: string
  attemptId?: string
  done: boolean
  resolveText?: (text: string) => void
  onDelta?: DsBotSendCallbacks['onDelta']
  onActivity?: DsBotSendCallbacks['onActivity']
}

const activeRelays = new Map<string, DsBotRelayClient>()
const activeChannelFeeds = new Map<string, AbortController>()
const activeTurns = new Map<string, ActiveTurnTracker>()
const accountBotNameMap = new Map<string, Map<string, string>>()

function trackBotNames(accountId: string, targets: DsBotTargetInfo[]): void {
  const map = new Map<string, string>()
  for (const t of targets) {
    if (t.kind === 'bot') map.set(t.rawId, t.name)
  }
  accountBotNameMap.set(accountId, map)
}

function activeTurnsForTarget(accountId: string, kind: 'bot' | 'room', rawTargetId: string): ActiveTurnTracker[] {
  const out: ActiveTurnTracker[] = []
  for (const turn of activeTurns.values()) {
    if (turn.accountId === accountId && turn.targetKind === kind && turn.rawTargetId === rawTargetId && !turn.done) {
      out.push(turn)
    }
  }
  return out
}

function requireAccount(accountId: string): ResolvedDsBotAccount {
  const acc = getDsBotAccount(accountId)
  if (!acc) {
    throw new DsBotApiError('DS Bot 账号尚未配置，请先在设置中连接', 401, 'not_configured')
  }
  return acc
}

function parseSetCookies(headers: Headers): string | undefined {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  const rawList =
    typeof withGetSetCookie.getSetCookie === 'function'
      ? withGetSetCookie.getSetCookie()
      : (() => {
          const single = headers.get('set-cookie')
          return single ? single.split(/,(?=\s*[^;=,\s]+=)/g) : []
        })()
  const pairs: string[] = []
  for (const entry of rawList) {
    const first = entry.split(';')[0]?.trim()
    if (first && first.includes('=')) pairs.push(first)
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

async function exchangeChannelTokenIfNeeded(
  rawUrl: string,
  proxyUrl: string | undefined,
  existingCookie?: string
): Promise<{ baseUrl: string; cookie?: string }> {
  const { baseUrl, initialToken } = normalizeDsBotChannelUrl(rawUrl)
  if (!initialToken) {
    return { baseUrl, cookie: existingCookie }
  }
  const authUrl = `${baseUrl}/?token=${encodeURIComponent(initialToken)}`
  const res = await proxyFetch(proxyUrl, authUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: existingCookie ? { cookie: existingCookie } : undefined,
    signal: AbortSignal.timeout(12_000)
  })
  const cookie = parseSetCookies(res.headers) || existingCookie
  return { baseUrl, cookie }
}

async function channelPost<T = unknown>(
  baseUrl: string,
  cookie: string | undefined,
  endpoint: string,
  payload: unknown,
  proxyUrl: string | undefined,
  signal?: AbortSignal
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/bot`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  }
  if (cookie) headers['cookie'] = cookie

  const res = await proxyFetch(proxyUrl, url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ endpoint, payload: payload ?? {} }),
    signal: signal ?? AbortSignal.timeout(25_000)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const msg =
      res.status === 401 || res.status === 403
        ? `DS Bot 鉴权失败（HTTP ${res.status}），请重新粘贴带 ?token= 的链接或有效 Cookie`
        : `DS Bot HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`
    throw new DsBotApiError(msg, res.status, `HTTP_${res.status}`, text)
  }

  const parsed = (await res.json()) as {
    ok?: boolean
    value?: T
    error?: { code?: string; message?: string }
  }
  if (!parsed?.ok) {
    throw new DsBotApiError(
      parsed?.error?.message || `DS Bot ${endpoint} 调用失败`,
      400,
      parsed?.error?.code || 'bot/error',
      parsed?.error
    )
  }
  return parsed.value as T
}

async function mcpJsonRpc<T = unknown>(
  mcpUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  proxyUrl: string | undefined,
  signal?: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  }
  if (token) headers['authorization'] = `Bearer ${token}`

  const res = await proxyFetch(proxyUrl, mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params
    }),
    signal: signal ?? AbortSignal.timeout(60_000)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const msg =
      res.status === 401
        ? 'DS Bot MCP Token 无效或已被撤销（HTTP 401）'
        : res.status === 403
          ? 'DS Bot MCP 拒绝访问（HTTP 403，请确认 Host 头为本机或反向代理已转发 Host）'
          : `DS Bot MCP HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`
    throw new DsBotApiError(msg, res.status, `HTTP_${res.status}`, text)
  }

  const body = (await res.json()) as {
    result?: T
    error?: { code?: number; message?: string }
  }
  if (body?.error) {
    throw new DsBotApiError(
      body.error.message || `DS Bot MCP ${method} error`,
      400,
      String(body.error.code ?? 'mcp_error'),
      body.error
    )
  }
  return body.result as T
}

async function mcpCallTool<T = unknown>(
  mcpUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  proxyUrl: string | undefined,
  signal?: AbortSignal
): Promise<T> {
  const result = await mcpJsonRpc<{
    isError?: boolean
    structuredContent?: T
    content?: Array<{ type?: string; text?: string }>
  }>(mcpUrl, token, 'tools/call', { name, arguments: args }, proxyUrl, signal)

  if (result?.isError) {
    const msg = result.content?.find((c) => typeof c.text === 'string')?.text || `DS Bot MCP ${name} failed`
    throw new DsBotApiError(msg, 400, 'mcp_tool_error', result)
  }
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((c) => typeof c.text === 'string')?.text ?? ''
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    return { text } as unknown as T
  }
}

async function ensureRelayClient(account: ResolvedDsBotAccount): Promise<DsBotRelayClient> {
  const existing = activeRelays.get(account.accountId)
  if (existing?.connected) return existing

  if (!account.relayServer || !account.hostDeviceId || !account.hostKey || !account.deviceId || !account.publicKey || !account.privateKey || !account.accessToken) {
    throw new DsBotApiError('DS Bot 加密配对信息不完整，请重新粘贴配对链接', 401, 'incomplete_relay')
  }

  const proxyUrl = await loadAccountProxyUrl(account.accountId).catch(() => undefined)
  const agent = proxyUrl ? proxyWsAgent(proxyUrl) : undefined
  const client = new DsBotRelayClient({
    host: {
      server: account.relayServer,
      hostDeviceId: account.hostDeviceId,
      hostKey: account.hostKey
    },
    identity: {
      deviceId: account.deviceId,
      publicKey: account.publicKey,
      privateKey: account.privateKey,
      accessToken: account.accessToken
    },
    clientName: 'BotArk Desktop',
    agent
  })

  client.onEvent((ev) => handleNativeFeedEvent(account.accountId, ev))
  client.onClose(() => {
    if (activeRelays.get(account.accountId) === client) {
      activeRelays.delete(account.accountId)
    }
  })

  await client.connect()
  activeRelays.set(account.accountId, client)
  return client
}

function handleNativeFeedEvent(accountId: string, ev: DsBotRelayEvent): void {
  const data = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>

  if (ev.event === 'stream') {
    const botId = typeof data.botId === 'string' ? data.botId : ''
    if (!botId) return
    const phase = typeof data.phase === 'string' ? data.phase : undefined
    const delta = typeof data.text === 'string' ? data.text : ''
    const attemptId = typeof data.attemptId === 'string' ? data.attemptId : undefined
    const turns = activeTurnsForTarget(accountId, 'bot', botId)

    for (const turn of turns) {
      if (phase === 'start') {
        turn.attemptId = attemptId
        turn.onActivity?.({ code: 'dsbot_streaming', text: '正在输出回复…', busy: true })
      } else if (delta) {
        if (!turn.attemptId || !attemptId || turn.attemptId === attemptId) {
          turn.streamText += delta
          turn.onDelta?.({ messageId: turn.messageId, text: turn.streamText, done: false })
        }
      } else if (phase === 'end') {
        if (turn.streamText.trim()) {
          turn.done = true
          turn.onDelta?.({ messageId: turn.messageId, text: turn.streamText, done: true })
          turn.resolveText?.(turn.streamText)
        }
      }
    }
    return
  }

  if (ev.event === 'message') {
    const botId = typeof data.botId === 'string' ? data.botId : ''
    const item = (data.item && typeof data.item === 'object' ? data.item : null) as Record<string, unknown> | null
    if (!botId || !item) return
    if (item.kind === 'bot' && typeof item.text === 'string' && item.text.trim()) {
      const turns = activeTurnsForTarget(accountId, 'bot', botId)
      if (turns.length > 0) {
        for (const turn of turns) {
          turn.streamText = item.text as string
          turn.done = true
          turn.onDelta?.({ messageId: turn.messageId, text: turn.streamText, done: true })
          turn.resolveText?.(turn.streamText)
        }
      } else {
        // Proactive/background DS Bot message when no turn was initiated from BotArk
        broadcastEvent({
          type: 'stream',
          accountId,
          agentId: toDsBotAgentId('bot', botId),
          messageId: `ds_${botId}_${String(item.seq ?? Date.now())}`,
          text: item.text as string,
          done: true
        })
      }
    }
    return
  }

  if (ev.event === 'revision') {
    broadcastEvent({ type: 'roster_changed', accountId })
    return
  }

  if (ev.event === 'live') {
    void listDsBotWaiting(accountId)
      .then((waiting) => {
        broadcastEvent({
          type: 'approvals',
          accountId,
          pending: waiting.approvals,
          questions: waiting.questions
        })
      })
      .catch(() => undefined)
  }
}

export function startDsBotChannelFeed(accountId: string): void {
  if (activeChannelFeeds.has(accountId)) return
  const account = getDsBotAccount(accountId)
  if (!account || account.mode !== 'channel' || !account.baseUrl) return

  const controller = new AbortController()
  activeChannelFeeds.set(accountId, controller)

  void (async () => {
    try {
      const proxyUrl = await loadAccountProxyUrl(accountId).catch(() => undefined)
      const feedUrl = `${account.baseUrl!.replace(/\/+$/, '')}/api/bot/feed`
      const headers: Record<string, string> = { accept: 'text/event-stream' }
      if (account.secret) headers['cookie'] = account.secret
      const res = await proxyFetch(proxyUrl, feedUrl, {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = 'message'
      let dataLines: string[] = []

      while (!controller.signal.aborted) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line === '') {
            if (dataLines.length > 0) {
              const raw = dataLines.join('\n')
              let parsed: unknown = raw
              try {
                parsed = JSON.parse(raw)
              } catch {
                /* keep raw */
              }
              handleNativeFeedEvent(accountId, { event: currentEvent, data: parsed })
            }
            currentEvent = 'message'
            dataLines = []
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
        }
      }
    } catch {
      /* feed closed or aborted */
    } finally {
      if (activeChannelFeeds.get(accountId) === controller) {
        activeChannelFeeds.delete(accountId)
      }
    }
  })()
}

export function stopDsBotLiveConnection(accountId: string): void {
  if (accountId === '*') {
    for (const [, ctrl] of activeChannelFeeds) ctrl.abort()
    activeChannelFeeds.clear()
    for (const [, relay] of activeRelays) relay.close()
    activeRelays.clear()
    return
  }
  activeChannelFeeds.get(accountId)?.abort()
  activeChannelFeeds.delete(accountId)
  activeRelays.get(accountId)?.close()
  activeRelays.delete(accountId)
}

async function callNativeEndpoint<T = unknown>(
  account: ResolvedDsBotAccount,
  endpoint: string,
  payload: unknown = {},
  signal?: AbortSignal
): Promise<T> {
  if (account.mode === 'channel') {
    if (!account.baseUrl) throw new DsBotApiError('DS Bot Web 地址未配置', 400, 'missing_url')
    const proxyUrl = await loadAccountProxyUrl(account.accountId).catch(() => undefined)
    startDsBotChannelFeed(account.accountId)
    return channelPost<T>(account.baseUrl, account.secret, endpoint, payload, proxyUrl, signal)
  }
  if (account.mode === 'relay') {
    const relay = await ensureRelayClient(account)
    return relay.callBot<T>(endpoint, payload, { signal })
  }
  throw new DsBotApiError('当前使用 MCP 模式连接，该高级能力需要通过 DSH Web 或加密配对链接使用', 400, 'mcp_mode_readonly')
}

function mapNativeStateToTargets(state: Record<string, unknown>): {
  bots: DsBotTargetInfo[]
  groups: DsBotTargetInfo[]
} {
  const work = (state.work && typeof state.work === 'object' ? state.work : {}) as Record<string, unknown>
  const workBots = (work.bots && typeof work.bots === 'object' ? work.bots : {}) as Record<string, unknown>
  const workRooms = (work.rooms && typeof work.rooms === 'object' ? work.rooms : {}) as Record<string, unknown>

  const rawBots = Array.isArray(state.bots) ? (state.bots as Array<Record<string, unknown>>) : []
  const botNameById = new Map<string, string>()
  const bots: DsBotTargetInfo[] = []
  for (const b of rawBots) {
    const id = typeof b.id === 'string' ? b.id : ''
    if (!id || b.hidden === true) continue
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : id
    botNameById.set(id, name)
    const avatar = (b.avatar && typeof b.avatar === 'object' ? b.avatar : undefined) as
      | { shape?: string; image?: string }
      | undefined
    bots.push({
      id: toDsBotAgentId('bot', id),
      rawId: id,
      kind: 'bot',
      name,
      role: typeof b.role === 'string' ? b.role : undefined,
      model: typeof b.model === 'string' ? b.model : typeof b.appliedModel === 'string' ? b.appliedModel : undefined,
      color: typeof b.color === 'string' ? b.color : undefined,
      avatarShape: typeof avatar?.shape === 'string' ? avatar.shape : undefined,
      avatarImage: typeof avatar?.image === 'string' ? avatar.image : undefined,
      main: b.main === true || state.mainBotId === id,
      working: Boolean(workBots[id]),
      sessionId: typeof b.sessionId === 'string' ? b.sessionId : undefined,
      workDir: typeof b.workDir === 'string' ? b.workDir : undefined,
      preview: typeof b.preview === 'string' ? b.preview : undefined,
      lastAt: typeof b.lastAt === 'number' ? b.lastAt : undefined
    })
  }

  const rawRooms = Array.isArray(state.rooms) ? (state.rooms as Array<Record<string, unknown>>) : []
  const groups: DsBotTargetInfo[] = []
  for (const r of rawRooms) {
    const id = typeof r.id === 'string' ? r.id : ''
    if (!id || r.hidden === true) continue
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id
    const memberIds = Array.isArray(r.members) ? r.members.map(String) : []
    const memberNames = memberIds.map((m) => botNameById.get(m) ?? m)
    const activeRoomWork = workRooms[id]
    groups.push({
      id: toDsBotAgentId('room', id),
      rawId: id,
      kind: 'room',
      name,
      members: memberNames,
      working: Array.isArray(activeRoomWork) && activeRoomWork.length > 0,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
      workDir: typeof r.workDir === 'string' ? r.workDir : undefined,
      preview: typeof r.preview === 'string' ? r.preview : undefined,
      lastAt: typeof r.lastAt === 'number' ? r.lastAt : undefined
    })
  }

  return { bots, groups }
}

export async function detectLocalDsBot(): Promise<DsBotLocalDetection> {
  const disk = detectLocalDsBotDiskConfig()

  const probePort = async (url: string, isMcp: boolean): Promise<boolean> => {
    try {
      const res = await fetch(url, {
        method: isMcp ? 'POST' : 'GET',
        headers: isMcp ? { 'content-type': 'application/json' } : undefined,
        body: isMcp ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }) : undefined,
        signal: AbortSignal.timeout(1_500)
      })
      // DS Bot MCP responds 401 when listening without token; DSH web responds 200/302/401
      return res.status > 0 && res.status < 500
    } catch {
      return false
    }
  }

  const [mcpReachable, channelReachable] = await Promise.all([
    probePort(disk.mcpUrl, true),
    disk.channelUrl ? probePort(disk.channelUrl, false) : Promise.resolve(false)
  ])

  return {
    mcpReachable,
    mcpUrl: disk.mcpUrl,
    mcpPort: disk.mcpPort,
    mcpEnabledInConfig: disk.mcpEnabledInConfig,
    ...(disk.mcpConfigPath ? { mcpConfigPath: disk.mcpConfigPath } : {}),
    channelReachable,
    ...(disk.channelUrl ? { channelUrl: disk.channelUrl } : {}),
    ...(disk.channelPort !== undefined ? { channelPort: disk.channelPort } : {}),
    ...(disk.dataDir ? { dataDir: disk.dataDir } : {})
  }
}

export async function probeDsBotConnection(args: {
  accountId: string
  mode: 'mcp' | 'channel' | 'relay'
  endpointUrl?: string
  secret?: string
  pairingUri?: string
  existingRelay?: {
    relayServer: string
    hostDeviceId: string
    hostKey: string
    hostName?: string
    deviceId: string
    publicKey: string
    privateKey: string
    accessToken: string
  }
}): Promise<DsBotProbeResult> {
  const proxyUrl = await loadAccountProxyUrl(args.accountId).catch(() => undefined)

  try {
    if (args.mode === 'mcp') {
      const mcpUrl = normalizeDsBotMcpUrl(args.endpointUrl ?? '')
      const token = (args.secret ?? '').trim()
      if (!token) {
        return {
          authenticated: false,
          botCount: 0,
          groupCount: 0,
          bots: [],
          groups: [],
          error: '请填写 DS Bot MCP Access Token（在 DS Bot → Settings → MCP access 中创建）'
        }
      }
      const init = await mcpJsonRpc<{ serverInfo?: { version?: string } }>(
        mcpUrl,
        token,
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'BotArk', version: '1.0.0' }
        },
        proxyUrl
      )
      const [botsRaw, groupsRaw] = await Promise.all([
        mcpCallTool<{ bots?: Array<{ id: string; name: string; role?: string; main?: boolean; working?: boolean }> }>(
          mcpUrl,
          token,
          'list_bots',
          {},
          proxyUrl
        ),
        mcpCallTool<{ groups?: Array<{ id: string; name: string; members?: string[] }> }>(
          mcpUrl,
          token,
          'list_groups',
          {},
          proxyUrl
        )
      ])
      const bots: DsBotTargetInfo[] = (botsRaw?.bots ?? []).map((b) => ({
        id: toDsBotAgentId('bot', b.id),
        rawId: b.id,
        kind: 'bot',
        name: b.name || b.id,
        role: b.role,
        main: b.main === true,
        working: b.working === true
      }))
      const groups: DsBotTargetInfo[] = (groupsRaw?.groups ?? []).map((g) => ({
        id: toDsBotAgentId('room', g.id),
        rawId: g.id,
        kind: 'room',
        name: g.name || g.id,
        members: Array.isArray(g.members) ? g.members : []
      }))
      trackBotNames(args.accountId, bots)
      return {
        authenticated: true,
        version: init?.serverInfo?.version,
        botCount: bots.length,
        groupCount: groups.length,
        bots,
        groups
      }
    }

    if (args.mode === 'channel') {
      const { baseUrl, cookie } = await exchangeChannelTokenIfNeeded(
        args.endpointUrl ?? '',
        proxyUrl,
        args.secret?.trim() || undefined
      )
      const [hello, state] = await Promise.all([
        channelPost<{ plugin?: { version?: string } }>(baseUrl, cookie, 'hello', { api: [1] }, proxyUrl).catch(() => null),
        channelPost<Record<string, unknown>>(baseUrl, cookie, 'state', { locale: 'zh' }, proxyUrl)
      ])
      const { bots, groups } = mapNativeStateToTargets(state)
      trackBotNames(args.accountId, bots)
      return {
        authenticated: true,
        version: hello?.plugin?.version || (typeof state.version === 'string' ? state.version : undefined),
        botCount: bots.length,
        groupCount: groups.length,
        bots,
        groups,
        ...(cookie ? { exchangedCookie: cookie } : {})
      }
    }

    // Relay mode (either fresh pairing via pairingUri, or reconnecting existing identity)
    const agent = proxyUrl ? proxyWsAgent(proxyUrl) : undefined
    let relayInfo = args.existingRelay
    let pairingCode: string | undefined

    if (args.pairingUri?.trim()) {
      const offer = parseDsBotPairingUri(args.pairingUri)
      const keys = generateX25519KeyPair()
      const deviceId = deviceIdForPublicKey(keys.publicKey)
      const accessToken = randomBase64UrlToken(32)
      pairingCode = offer.code
      relayInfo = {
        relayServer: offer.server,
        hostDeviceId: offer.hostDeviceId,
        hostKey: offer.hostKey,
        hostName: offer.name || undefined,
        deviceId,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        accessToken
      }
    }

    if (!relayInfo) {
      return {
        authenticated: false,
        botCount: 0,
        groupCount: 0,
        bots: [],
        groups: [],
        error: '请粘贴 DS Bot 配对链接（dsbot://pair?...）'
      }
    }

    // Reuse existing live relay when re-checking without a fresh pairing URI
    const existingLive = !pairingCode ? activeRelays.get(args.accountId) : undefined
    const client =
      existingLive?.connected
        ? existingLive
        : new DsBotRelayClient({
            host: {
              server: relayInfo.relayServer,
              hostDeviceId: relayInfo.hostDeviceId,
              hostKey: relayInfo.hostKey
            },
            identity: {
              deviceId: relayInfo.deviceId,
              publicKey: relayInfo.publicKey,
              privateKey: relayInfo.privateKey,
              accessToken: relayInfo.accessToken
            },
            clientName: 'BotArk Desktop',
            pairingCode,
            agent
          })

    if (!client.connected) {
      client.onEvent((ev) => handleNativeFeedEvent(args.accountId, ev))
      client.onClose(() => {
        if (activeRelays.get(args.accountId) === client) {
          activeRelays.delete(args.accountId)
        }
      })
      await client.connect()
      activeRelays.get(args.accountId)?.close()
      activeRelays.set(args.accountId, client)
    }

    const [hello, state] = await Promise.all([
      client.callBot<{ plugin?: { version?: string } }>('hello', { api: [1] }).catch(() => null),
      client.callBot<Record<string, unknown>>('state', { locale: 'zh', avatars: 'ref' })
    ])
    const { bots, groups } = mapNativeStateToTargets(state)
    trackBotNames(args.accountId, bots)
    const hostName = client.remoteHostName || relayInfo.hostName
    return {
      authenticated: true,
      version: hello?.plugin?.version || (typeof state.version === 'string' ? state.version : undefined),
      hostName,
      botCount: bots.length,
      groupCount: groups.length,
      bots,
      groups,
      ...(pairingCode
        ? {
            pairedIdentity: {
              ...relayInfo,
              hostName
            }
          }
        : {})
    }
  } catch (error) {
    return {
      authenticated: false,
      botCount: 0,
      groupCount: 0,
      bots: [],
      groups: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function getDsBotTeamState(accountId: string): Promise<Record<string, unknown>> {
  const account = requireAccount(accountId)
  if (account.mode === 'mcp') {
    const targets = await listDsBotTargets(accountId)
    return {
      mode: 'mcp',
      bots: targets.filter((t) => t.kind === 'bot'),
      rooms: targets.filter((t) => t.kind === 'room')
    }
  }
  return callNativeEndpoint<Record<string, unknown>>(account, 'state', { locale: 'zh', avatars: 'ref' })
}

export async function listDsBotTargets(accountId: string): Promise<DsBotTargetInfo[]> {
  const account = requireAccount(accountId)
  const proxyUrl = await loadAccountProxyUrl(accountId).catch(() => undefined)

  if (account.mode === 'mcp') {
    const [botsRaw, groupsRaw] = await Promise.all([
      mcpCallTool<{ bots?: Array<{ id: string; name: string; role?: string; main?: boolean; working?: boolean }> }>(
        account.baseUrl!,
        account.secret ?? '',
        'list_bots',
        {},
        proxyUrl
      ),
      mcpCallTool<{ groups?: Array<{ id: string; name: string; members?: string[] }> }>(
        account.baseUrl!,
        account.secret ?? '',
        'list_groups',
        {},
        proxyUrl
      )
    ])
    const bots: DsBotTargetInfo[] = (botsRaw?.bots ?? []).map((b) => ({
      id: toDsBotAgentId('bot', b.id),
      rawId: b.id,
      kind: 'bot',
      name: b.name || b.id,
      role: b.role,
      main: b.main === true,
      working: b.working === true
    }))
    const groups: DsBotTargetInfo[] = (groupsRaw?.groups ?? []).map((g) => ({
      id: toDsBotAgentId('room', g.id),
      rawId: g.id,
      kind: 'room',
      name: g.name || g.id,
      members: Array.isArray(g.members) ? g.members : []
    }))
    const all = [...bots, ...groups]
    trackBotNames(accountId, bots)
    return all
  }

  const state = await callNativeEndpoint<Record<string, unknown>>(account, 'state', {
    locale: 'zh',
    avatars: 'ref'
  })
  const { bots, groups } = mapNativeStateToTargets(state)
  trackBotNames(accountId, bots)
  return [...bots, ...groups]
}

export async function listDsBotModels(accountId: string): Promise<{
  models: DsBotModelInfo[]
  defaultModel?: string
}> {
  const account = requireAccount(accountId)
  if (account.mode === 'mcp') {
    return { models: [] }
  }
  const state = await callNativeEndpoint<Record<string, unknown>>(account, 'state', { locale: 'zh', avatars: 'ref' })
  const rawModels = Array.isArray(state.models) ? (state.models as Array<Record<string, unknown>>) : []
  const models: DsBotModelInfo[] = rawModels
    .filter((m) => typeof m.ref === 'string' && m.ref)
    .map((m) => ({
      ref: String(m.ref),
      name: typeof m.name === 'string' && m.name ? m.name : String(m.ref),
      provider: typeof m.provider === 'string' ? m.provider : undefined,
      providerName: typeof m.providerName === 'string' ? m.providerName : undefined
    }))
  return {
    models,
    defaultModel: typeof state.defaultModel === 'string' ? state.defaultModel : undefined
  }
}

function normalizeNativeItems(
  items: unknown[],
  prefix: string
): DsBotHistoryMessage[] {
  const out: DsBotHistoryMessage[] = []
  let idx = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const kind = String(item.kind ?? '')
    const text =
      typeof item.text === 'string'
        ? item.text
        : Array.isArray(item.texts)
          ? item.texts.filter((x): x is string => typeof x === 'string').join('\n\n')
          : ''
    if (!text.trim()) continue
    if (kind !== 'user' && kind !== 'bot' && kind !== 'post') continue
    const id = String(item.id ?? item.seq ?? `${prefix}_${idx++}`)
    const createdAt = typeof item.time === 'number' && Number.isFinite(item.time) ? item.time : Date.now()
    const senderName = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined
    out.push({
      id: `${prefix}_${id}`,
      role: kind === 'user' ? 'user' : 'assistant',
      text,
      createdAt,
      ...(senderName ? { senderName } : {})
    })
  }
  return out
}

export async function getDsBotHistory(accountId: string, agentId: string): Promise<DsBotHistoryMessage[]> {
  const account = requireAccount(accountId)
  const target = parseDsBotAgentId(agentId)
  const proxyUrl = await loadAccountProxyUrl(accountId).catch(() => undefined)

  if (account.mode === 'mcp') {
    const res = await mcpCallTool<{
      messages?: Array<{ kind?: string; from?: string; text?: string; time?: number }>
    }>(
      account.baseUrl!,
      account.secret ?? '',
      'read_chat',
      target.kind === 'room' ? { group: target.rawId } : { bot: target.rawId },
      proxyUrl
    )
    const rows = Array.isArray(res?.messages) ? res.messages : []
    return rows
      .filter((m) => typeof m.text === 'string' && m.text.trim().length > 0 && (m.kind === 'user' || m.kind === 'bot' || m.kind === 'post'))
      .map((m, idx) => ({
        id: `dsmcp_${target.rawId}_${m.time ?? idx}_${idx}`,
        role: m.kind === 'user' ? ('user' as const) : ('assistant' as const),
        text: m.text!,
        createdAt: typeof m.time === 'number' && Number.isFinite(m.time) ? m.time : Date.now(),
        ...(m.from ? { senderName: m.from } : {})
      }))
  }

  if (target.kind === 'room') {
    const page = await callNativeEndpoint<{ items?: unknown[] }>(account, 'room-chat', {
      roomId: target.rawId
    })
    return normalizeNativeItems(Array.isArray(page?.items) ? page.items : [], `dsroom_${target.rawId}`)
  }

  const page = await callNativeEndpoint<{ items?: unknown[] }>(account, 'chat', {
    botId: target.rawId
  })
  return normalizeNativeItems(Array.isArray(page?.items) ? page.items : [], `dsbot_${target.rawId}`)
}

function formatMcpReplies(
  messages: Array<{ kind?: string; from?: string; text?: string }>,
  isGroup: boolean
): string {
  const parts: string[] = []
  for (const m of messages) {
    const text = (m.text ?? '').trim()
    if (!text) continue
    if (isGroup && m.from) {
      parts.push(`**${m.from}**：${text}`)
    } else {
      parts.push(text)
    }
  }
  return parts.join('\n\n')
}

export async function sendDsBotMessage(args: {
  accountId: string
  agentId: string
  botId?: string
  requestId?: string
  text: string
  attachments?: DsBotAttachmentInput[]
  callbacks?: DsBotSendCallbacks
}): Promise<{ messageId: string; replyText: string; noReply?: boolean }> {
  const account = requireAccount(args.accountId)
  const target = parseDsBotAgentId(args.agentId)
  const requestId = args.requestId || randomUUID()
  const messageId = `ds_${target.rawId}_${Date.now()}_${randomUUID().slice(0, 6)}`
  const controller = new AbortController()
  const proxyUrl = await loadAccountProxyUrl(args.accountId).catch(() => undefined)

  const tracker: ActiveTurnTracker = {
    accountId: args.accountId,
    agentId: args.agentId,
    targetKind: target.kind,
    rawTargetId: target.rawId,
    conversationId: args.botId || args.agentId,
    requestId,
    messageId,
    controller,
    streamText: '',
    done: false,
    onDelta: args.callbacks?.onDelta,
    onActivity: args.callbacks?.onActivity
  }
  activeTurns.set(requestId, tracker)

  try {
    if (account.mode === 'mcp') {
      const sendRes = await mcpCallTool<{ sent?: boolean; after?: number }>(
        account.baseUrl!,
        account.secret ?? '',
        target.kind === 'room' ? 'send_to_group' : 'send_to_bot',
        target.kind === 'room'
          ? { group: target.rawId, text: args.text }
          : { bot: target.rawId, text: args.text },
        proxyUrl,
        controller.signal
      )
      args.callbacks?.onAccepted?.()
      args.callbacks?.onActivity?.({ code: 'dsbot_working', text: 'DS Bot 正在思考…', busy: true })

      let after = typeof sendRes?.after === 'number' ? sendRes.after : Date.now()
      const collected: Array<{ kind?: string; from?: string; text?: string; time?: number }> = []
      const seenKeys = new Set<string>()

      for (let round = 0; round < MCP_WAIT_MAX_ROUNDS; round += 1) {
        if (controller.signal.aborted) {
          throw new DOMException('DS Bot run cancelled', 'AbortError')
        }
        const waitRes = await mcpCallTool<{
          done?: boolean
          working?: boolean
          messages?: Array<{ kind?: string; from?: string; text?: string; time?: number }>
          after?: number
        }>(
          account.baseUrl!,
          account.secret ?? '',
          'wait_for_reply',
          {
            ...(target.kind === 'room' ? { group: target.rawId } : { bot: target.rawId }),
            after,
            timeoutSeconds: MCP_WAIT_TIMEOUT_SECONDS
          },
          proxyUrl,
          controller.signal
        )
        if (typeof waitRes?.after === 'number' && waitRes.after > after) {
          after = waitRes.after
        }
        for (const msg of waitRes?.messages ?? []) {
          const key = `${msg.time ?? ''}|${msg.from ?? ''}|${msg.text ?? ''}`
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            collected.push(msg)
          }
        }
        const combined = formatMcpReplies(collected, target.kind === 'room')
        if (combined) {
          tracker.streamText = combined
          args.callbacks?.onDelta?.({ messageId, text: combined, done: Boolean(waitRes?.done) })
        }
        if (waitRes?.done) break
      }

      args.callbacks?.onActivity?.({ code: 'idle', busy: false })
      const finalText = tracker.streamText.trim()
      if (finalText) {
        args.callbacks?.onDelta?.({ messageId, text: finalText, done: true })
        return { messageId, replyText: finalText }
      }
      return { messageId, replyText: '', noReply: true }
    }

    // Native Channel or Relay mode: stage supported images first
    const stagedImageIds: string[] = []
    for (const att of args.attachments ?? []) {
      if (!STAGED_IMAGE_MIMES.has(att.mimeType) || !att.dataBase64) continue
      const staged = await callNativeEndpoint<{ id?: string }>(
        account,
        'stage-image',
        { mediaType: att.mimeType, data: att.dataBase64 },
        controller.signal
      )
      if (staged?.id) stagedImageIds.push(staged.id)
    }

    const sentAt = Date.now()
    const streamSettled = new Promise<string>((resolve) => {
      tracker.resolveText = resolve
    })

    await callNativeEndpoint(
      account,
      'send',
      {
        sessionId: target.rawId,
        text: args.text,
        ...(stagedImageIds.length > 0 ? { images: stagedImageIds } : {})
      },
      controller.signal
    )
    args.callbacks?.onAccepted?.()
    args.callbacks?.onActivity?.({ code: 'dsbot_working', text: 'DS Bot 正在思考…', busy: true })

    // Wait for either live SSE/Relay completion OR fallback poll completion (handles group chats & fast replies)
    const pollForCompletion = async (): Promise<string> => {
      const deadline = Date.now() + NATIVE_REPLY_TIMEOUT_MS
      let idleStreak = 0
      while (!tracker.done && !controller.signal.aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, NATIVE_POLL_MS))
        if (tracker.done || controller.signal.aborted) break

        if (target.kind === 'room') {
          const page = await callNativeEndpoint<{ items?: Array<Record<string, unknown>>; running?: boolean }>(
            account,
            'room-chat',
            { roomId: target.rawId },
            controller.signal
          ).catch(() => null)
          if (!page) continue
          const fresh = (page.items ?? []).filter(
            (item) =>
              (item.kind === 'bot' || item.kind === 'post') &&
              typeof item.text === 'string' &&
              item.text.trim().length > 0 &&
              (typeof item.time === 'number' ? item.time >= sentAt - 1000 : false)
          )
          const text = fresh
            .map((item) => {
              const who = typeof item.name === 'string' && item.name ? `**${item.name}**：` : ''
              return `${who}${String(item.text)}`
            })
            .join('\n\n')
          if (text && text !== tracker.streamText) {
            tracker.streamText = text
            args.callbacks?.onDelta?.({ messageId, text, done: false })
          }
          if (!page.running) {
            idleStreak += 1
            if (text || idleStreak >= 2) {
              tracker.done = true
              if (text) args.callbacks?.onDelta?.({ messageId, text, done: true })
              return text
            }
          } else {
            idleStreak = 0
          }
        } else {
          const [state, page] = await Promise.all([
            callNativeEndpoint<Record<string, unknown>>(account, 'state', { locale: 'zh', avatars: 'ref' }, controller.signal).catch(() => null),
            callNativeEndpoint<{ items?: Array<Record<string, unknown>> }>(account, 'chat', { botId: target.rawId }, controller.signal).catch(() => null)
          ])
          if (tracker.done) break
          const workBots = ((state?.work as Record<string, unknown> | undefined)?.bots ?? {}) as Record<string, unknown>
          const isWorking = Boolean(workBots[target.rawId])
          const fresh = (page?.items ?? []).filter(
            (item) =>
              item.kind === 'bot' &&
              typeof item.text === 'string' &&
              item.text.trim().length > 0 &&
              (typeof item.time === 'number' ? item.time >= sentAt - 1000 : false)
          )
          const text = fresh.map((item) => String(item.text)).join('\n\n')
          if (text && !tracker.streamText) {
            tracker.streamText = text
            args.callbacks?.onDelta?.({ messageId, text, done: false })
          }
          if (!isWorking) {
            idleStreak += 1
            if (text || tracker.streamText || idleStreak >= 2) {
              const out = text || tracker.streamText
              tracker.done = true
              if (out) args.callbacks?.onDelta?.({ messageId, text: out, done: true })
              return out
            }
          } else {
            idleStreak = 0
          }
        }
      }
      return tracker.streamText
    }

    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new DOMException('DS Bot run cancelled', 'AbortError')),
        { once: true }
      )
    })

    const replyText = await Promise.race([streamSettled, pollForCompletion(), abortPromise])
    tracker.done = true
    args.callbacks?.onActivity?.({ code: 'idle', busy: false })
    if (replyText.trim()) {
      return { messageId, replyText }
    }
    return { messageId, replyText: '', noReply: true }
  } finally {
    tracker.done = true
    activeTurns.delete(requestId)
  }
}

export async function stopDsBotRun(accountId: string, agentId?: string, requestId?: string): Promise<void> {
  for (const [id, turn] of activeTurns) {
    if (accountId !== '*' && turn.accountId !== accountId) continue
    if (requestId && id !== requestId) continue
    if (agentId && turn.agentId !== agentId) continue
    turn.done = true
    turn.controller.abort()
    activeTurns.delete(id)
  }
  if (accountId === '*') return

  const account = getDsBotAccount(accountId)
  if (!account || account.mode === 'mcp') return
  if (agentId) {
    const target = parseDsBotAgentId(agentId)
    if (target.kind === 'room') {
      await callNativeEndpoint(account, 'stop-room-work', { roomId: target.rawId }).catch(() => undefined)
    } else {
      await callNativeEndpoint(account, 'stop-chat', { botId: target.rawId }).catch(() => undefined)
    }
  }
}

export function cancelAllDsBotRuns(accountId: string): void {
  for (const [id, turn] of activeTurns) {
    if (accountId !== '*' && turn.accountId !== accountId) continue
    turn.done = true
    turn.controller.abort()
    activeTurns.delete(id)
  }
  stopDsBotLiveConnection(accountId)
}

export async function listDsBotWaiting(accountId: string): Promise<{
  approvals: DsBotApprovalView[]
  questions: DsBotQuestionView[]
}> {
  const account = requireAccount(accountId)
  const proxyUrl = await loadAccountProxyUrl(accountId).catch(() => undefined)

  if (account.mode === 'mcp') {
    const res = await mcpCallTool<{
      waiting?: Array<{ kind?: string; bot?: string; group?: string; tool?: string; reason?: string; question?: string }>
    }>(account.baseUrl!, account.secret ?? '', 'list_waiting', {}, proxyUrl)
    const approvals: DsBotApprovalView[] = []
    const questions: DsBotQuestionView[] = []
    for (const [idx, item] of (res?.waiting ?? []).entries()) {
      if (item.kind === 'approval') {
        approvals.push({
          id: `mcp_approval_${idx}_${item.tool ?? 'tool'}`,
          botName: item.bot,
          roomName: item.group,
          tool: item.tool || 'tool',
          reason: item.reason,
          answerable: false
        })
      } else if (item.kind === 'question') {
        questions.push({
          id: `mcp_question_${idx}`,
          sessionId: '',
          botName: item.bot,
          question: item.question || '',
          answerable: false
        })
      }
    }
    return { approvals, questions }
  }

  const state = await callNativeEndpoint<Record<string, unknown>>(account, 'state', {
    locale: 'zh',
    avatars: 'ref'
  })
  const { bots, groups } = mapNativeStateToTargets(state)
  const botById = new Map(bots.map((b) => [b.rawId, b]))
  const botBySession = new Map(bots.filter((b) => b.sessionId).map((b) => [b.sessionId!, b]))
  const roomById = new Map(groups.map((g) => [g.rawId, g]))

  const work = (state.work && typeof state.work === 'object' ? state.work : {}) as Record<string, unknown>
  const rawApprovals = Array.isArray(work.approvals) ? (work.approvals as Array<Record<string, unknown>>) : []
  const approvals: DsBotApprovalView[] = rawApprovals
    .filter((a) => typeof a.id === 'string' && a.id)
    .map((a) => {
      const botId = typeof a.botId === 'string' ? a.botId : undefined
      const roomId = typeof a.roomId === 'string' ? a.roomId : undefined
      const detailObj = a.detail && typeof a.detail === 'object' ? (a.detail as { text?: string; code?: string }) : undefined
      return {
        id: String(a.id),
        botId,
        botName: botId ? botById.get(botId)?.name : undefined,
        roomId,
        roomName: roomId ? roomById.get(roomId)?.name : undefined,
        sessionId: typeof a.sessionId === 'string' ? a.sessionId : undefined,
        tool: typeof a.tool === 'string' ? a.tool : 'tool',
        reason: typeof a.reason === 'string' ? a.reason : undefined,
        detail: detailObj?.code || detailObj?.text,
        at: typeof a.at === 'number' ? a.at : undefined,
        answerable: a.answerable !== false
      }
    })

  const rawQuestions =
    state.questions && typeof state.questions === 'object'
      ? (state.questions as Record<string, Record<string, unknown>>)
      : {}
  const questions: DsBotQuestionView[] = Object.entries(rawQuestions)
    .filter(([, q]) => q && typeof q.id === 'string')
    .map(([sessionId, q]) => {
      const bot = botBySession.get(sessionId) ?? botById.get(sessionId)
      return {
        id: String(q.id),
        sessionId,
        botId: bot?.rawId,
        botName: bot?.name,
        question: typeof q.question === 'string' ? q.question : '',
        detail: typeof q.detail === 'string' ? q.detail : undefined,
        options: Array.isArray(q.options)
          ? (q.options as Array<{ label?: unknown }>)
              .filter((o) => typeof o?.label === 'string')
              .map((o) => ({ label: String(o.label) }))
          : undefined,
        multiSelect: q.multiSelect === true,
        answerable: true
      }
    })

  return { approvals, questions }
}

export async function decideDsBotApproval(
  accountId: string,
  approvalId: string,
  choice: 'allow' | 'reject'
): Promise<void> {
  const account = requireAccount(accountId)
  await callNativeEndpoint(account, 'approval-answer', { id: approvalId, choice })
}

export async function answerDsBotQuestion(
  accountId: string,
  sessionId: string,
  questionId: string,
  answer: string
): Promise<void> {
  const account = requireAccount(accountId)
  await callNativeEndpoint(account, 'answer-question', { sessionId, questionId, answer })
}

export async function getDsBotMemory(accountId: string, agentId: string): Promise<DsBotMemoryView> {
  const account = requireAccount(accountId)
  if (account.mode === 'mcp') {
    return { entries: [], memoryEnabled: false }
  }
  const target = parseDsBotAgentId(agentId)
  const payload = target.kind === 'room' ? { roomId: target.rawId } : { botId: target.rawId }
  const res = await callNativeEndpoint<Record<string, unknown>>(account, 'memory-view', payload)
  const rawSummary = res?.summary
  const summary =
    typeof rawSummary === 'string'
      ? rawSummary
      : rawSummary && typeof rawSummary === 'object' && typeof (rawSummary as { text?: unknown }).text === 'string'
        ? String((rawSummary as { text?: unknown }).text)
        : null
  const rawEntries = Array.isArray(res?.entries) ? (res.entries as Array<Record<string, unknown>>) : []
  const entries: DsBotMemoryEntry[] = rawEntries
    .filter((e) => typeof e.text === 'string' && e.text.trim())
    .map((e) => ({
      scope: typeof e.scope === 'string' ? e.scope : 'own',
      topic: typeof e.topic === 'string' ? e.topic : undefined,
      text: String(e.text),
      pinned: e.pinned === true,
      added: typeof e.added === 'string' ? e.added : undefined
    }))
  return { summary, entries, memoryEnabled: true }
}

export async function addDsBotMemory(
  accountId: string,
  agentId: string,
  text: string,
  scope?: string,
  topic?: string
): Promise<DsBotMemoryView> {
  const account = requireAccount(accountId)
  const target = parseDsBotAgentId(agentId)
  const payload = {
    ...(target.kind === 'room' ? { roomId: target.rawId } : { botId: target.rawId }),
    text,
    ...(scope ? { scope } : {}),
    ...(topic ? { topic } : {})
  }
  await callNativeEndpoint(account, 'memory-add', payload)
  return getDsBotMemory(accountId, agentId)
}

export async function forgetDsBotMemory(
  accountId: string,
  agentId: string,
  text: string,
  scope?: string,
  topic?: string
): Promise<DsBotMemoryView> {
  const account = requireAccount(accountId)
  const target = parseDsBotAgentId(agentId)
  const payload = {
    ...(target.kind === 'room' ? { roomId: target.rawId } : { botId: target.rawId }),
    text,
    ...(scope ? { scope } : {}),
    ...(topic ? { topic } : {})
  }
  await callNativeEndpoint(account, 'memory-forget', payload)
  return getDsBotMemory(accountId, agentId)
}

export async function listDsBotSchedules(accountId: string): Promise<{
  available: boolean
  canPause: boolean
  tasks: DsBotScheduleItem[]
}> {
  const account = requireAccount(accountId)
  if (account.mode === 'mcp') {
    return { available: false, canPause: false, tasks: [] }
  }
  const res = await callNativeEndpoint<{
    available?: boolean
    canPause?: boolean
    tasks?: Array<Record<string, unknown>>
  }>(account, 'schedules', {})
  const canPause = res?.canPause === true
  const tasks: DsBotScheduleItem[] = (res?.tasks ?? [])
    .filter((t) => typeof t.id === 'string' && t.id)
    .map((t) => ({
      id: String(t.id),
      sessionId: typeof t.sessionId === 'string' ? t.sessionId : '',
      title: typeof t.title === 'string' ? t.title : 'Scheduled task',
      prompt: typeof t.prompt === 'string' ? t.prompt : '',
      kind: typeof t.kind === 'string' ? t.kind : undefined,
      state: typeof t.state === 'string' ? t.state : 'scheduled',
      status: typeof t.status === 'string' ? t.status : undefined,
      scheduledAt: typeof t.scheduledAt === 'string' ? t.scheduledAt : undefined,
      botId: typeof t.botId === 'string' ? t.botId : undefined,
      roomId: typeof t.roomId === 'string' ? t.roomId : undefined,
      canPause
    }))
  return { available: res?.available !== false, canPause, tasks }
}

export async function toggleDsBotSchedule(
  accountId: string,
  scheduleId: string,
  sessionId: string,
  active: boolean
): Promise<void> {
  const account = requireAccount(accountId)
  await callNativeEndpoint(account, 'schedule-pause', { id: scheduleId, sessionId, active })
}

export async function deleteDsBotSchedule(
  accountId: string,
  scheduleId: string,
  sessionId: string
): Promise<void> {
  const account = requireAccount(accountId)
  await callNativeEndpoint(account, 'schedule-delete', { id: scheduleId, sessionId })
}

export async function getDsBotUsage(accountId: string, agentId: string): Promise<DsBotUsageSummary | null> {
  const account = requireAccount(accountId)
  if (account.mode === 'mcp') return null
  const target = parseDsBotAgentId(agentId)
  if (target.kind !== 'bot') return null
  return callNativeEndpoint<DsBotUsageSummary>(account, 'usage-summary', { botId: target.rawId })
}

export async function setDsBotModel(accountId: string, agentId: string, model: string): Promise<unknown> {
  const account = requireAccount(accountId)
  const target = parseDsBotAgentId(agentId)
  if (target.kind !== 'bot') {
    throw new DsBotApiError('群聊不支持单独切换模型，请选择具体的 Bot 成员', 400, 'room_model_unsupported')
  }
  return callNativeEndpoint(account, 'update-bot', { id: target.rawId, model })
}

export async function createDsBotMember(
  accountId: string,
  args: { name: string; role?: string; model?: string; instructions?: string }
): Promise<unknown> {
  const account = requireAccount(accountId)
  const created = await callNativeEndpoint(account, 'create-bot', {
    name: args.name.trim(),
    ...(args.role?.trim() ? { role: args.role.trim() } : {}),
    ...(args.model?.trim() ? { model: args.model.trim() } : {}),
    ...(args.instructions?.trim() ? { instructions: args.instructions.trim() } : {})
  })
  broadcastEvent({ type: 'roster_changed', accountId })
  return created
}
