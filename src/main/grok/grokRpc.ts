import { BrowserWindow } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import type { GrokRequest } from '../../adapters/grokbot/grokRequests'
import {
  GROK_CHANNELS,
  type GrokMainEvent,
  type GrokRpcRequest,
  type GrokRpcResponse,
  type MuseMediaPartView,
  type MuseOptionWidgetView,
  type MuseRichWidgetView,
  type MuseToolCallView
} from '@shared/ipc'
import { inferMediaMime } from '../mediaMime'
import { GrokConnectClient, GrokConnectError } from './connectClient'
import { getOrCreateGrokMachineId } from './grokMachineId'
import {
  activeGrokCredentialSignal,
  forceRefreshSandAccessToken,
  getValidGrokCredential,
  grokCredentialRevision,
  grokFetcherForAccount
} from './grokSandAuth'
import { asObj, str, type ParsedGrokTranscriptEntry } from './grokTranscriptDecoder'
import {
  compareGrokEntries, GrokEntryRevisions, grokRows, grokSeq, hydrateGrokEntry,
  isGrokSendAnchor, matchesGrokScope, readGrokTranscriptGap, transcriptEntries
} from './grokTranscriptWatch'
import {
  ensureGrokAccountWatch,
  getGrokAccountWatch,
  stopGrokAccountWatch
} from './grokWatchManager'

export function broadcastGrokEvent(event: GrokMainEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(GROK_CHANNELS.event, event)
  }
}

export async function clientForGrokAccount(
  accountId: string,
  timeZone?: string
): Promise<GrokConnectClient> {
  const revision = grokCredentialRevision(accountId)
  const credential = await getValidGrokCredential(accountId)
  if (!credential || revision !== grokCredentialRevision(accountId)) {
    throw new GrokConnectError(401, 'Not signed in (no current Grok credential)', 'not-connected')
  }
  return new GrokConnectClient({
    auth: {
      accessToken: credential.tokens.accessToken,
      teamId: credential.tokens.selectedTeamId,
      accountSlot: credential.tokens.authId,
      machineId: credential.machineId || getOrCreateGrokMachineId(accountId)
    },
    fetchImpl: grokFetcherForAccount(accountId),
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  })
}

function fail(error: unknown): GrokRpcResponse {
  if (error instanceof Error && error.name === 'AbortError') {
    return { ok: false, status: 0, code: 'aborted', message: error.message }
  }
  if (error instanceof GrokConnectError) {
    return {
      ok: false,
      status: error.status,
      code: error.code,
      message: error.message,
      body: error.body.slice(0, 2000)
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, status: 0, message }
}

const GROK_REPLY_SETTLE_MS = 12_000
const GROK_REPLY_HISTORY_INTERVAL_MS = 4_000
const GROK_REPLY_HISTORY_TIMEOUT_MS = 6_000
const GROK_REPLY_HISTORY_MAX_PAGES = 8

function followsGrokEntry(
  entry: ParsedGrokTranscriptEntry,
  previous: ParsedGrokTranscriptEntry,
  order: number | undefined,
  previousOrder: number | undefined
): boolean {
  const seq = grokSeq(entry.seq)
  const previousSeq = grokSeq(previous.seq)
  if (seq > 0n && previousSeq > 0n) return seq > previousSeq
  const updated = grokSeq(entry.updatedSeq)
  const previousUpdated = grokSeq(previous.updatedSeq)
  if (updated > 0n && previousUpdated > 0n) return updated > previousUpdated
  if (previous.hasTimestamp && entry.hasTimestamp && entry.createdAtMs !== previous.createdAtMs) {
    return entry.createdAtMs > previous.createdAtMs
  }
  return Boolean(previous.requestId && entry.requestId === previous.requestId) ||
    (previousOrder !== undefined && order !== undefined && order > previousOrder)
}

interface GrokReplyBubble {
  messageId: string
  text: string
  widgets?: MuseOptionWidgetView[]
  richWidgets?: MuseRichWidgetView[]
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
}

export async function watchUntilReply(
  client: GrokConnectClient,
  args: {
    accountId: string
    conversationId?: string
    agentId: string
    sessionId: string
    afterUpdatedSeq?: string
    afterMessageId?: string
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<Partial<GrokReplyBubble> & {
  text: string
  messages: GrokReplyBubble[]
  echoEntryId?: string
  turnFailed?: { code: string; summary: string }
}> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), args.timeoutMs ?? 90_000)
  const revision = grokCredentialRevision(args.accountId)
  const credentialSignal = activeGrokCredentialSignal(args.accountId)
  const signal = AbortSignal.any([ac.signal, credentialSignal, ...(args.signal ? [args.signal] : [])])
  const { accountId, agentId, sessionId } = args
  const watchHandle = getGrokAccountWatch(accountId)
  const streamsInBackground = watchHandle?.watchesSession(agentId, sessionId) ?? false
  const revisions = new GrokEntryRevisions()
  const bubbles = new Map<string, { entry: ParsedGrokTranscriptEntry; bubble: GrokReplyBubble }>()
  const collectedTools = new Map<string, MuseToolCallView>()
  const pending = new Map<string, ParsedGrokTranscriptEntry>()
  const afterSeq = grokSeq(args.afterUpdatedSeq)
  const sentId = args.afterMessageId
  let cursor = afterSeq
  let generation = 0
  let anchor: ParsedGrokTranscriptEntry | undefined
  let anchorOrder: number | undefined
  let nextPrompt: { entry: ParsedGrokTranscriptEntry; order?: number } | undefined
  let received = 0
  const entryOrder = new Map<string, number>()
  let echoEntryId: string | undefined
  let nextAnchorLookupAt = 0
  let turnFailed: { code: string; summary: string } | undefined
  let isAgentRunning = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  const assertCurrent = () => {
    signal.throwIfAborted()
    if (revision !== grokCredentialRevision(accountId)) throw new DOMException('Grok credentials changed', 'AbortError')
  }
  const matchesScope = (row: Record<string, unknown>) => matchesGrokScope(row, agentId, sessionId)
  const isAnchor = (entry: ParsedGrokTranscriptEntry) => Boolean(
    (sentId && isGrokSendAnchor(entry, sentId)) || (echoEntryId && isGrokSendAnchor(entry, echoEntryId))
  )
  const armSettle = (ms: number) => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => ac.abort(), ms)
  }

  const lookupEchoEntryId = async (readSignal: AbortSignal): Promise<string | undefined> => {
    if (!sentId) return undefined
    try {
      const status = asObj(await client.getSendStatus({ agentId, sessionId, messageId: sentId }, readSignal))
      readSignal.throwIfAborted()
      return str(status?.['echoEntryId'] ?? status?.['echo_entry_id']) || undefined
    } catch {
      readSignal.throwIfAborted()
      return undefined
    }
  }

  const readTurnHistory = async (readSignal: AbortSignal, lookupEchoFirst = false) => {
    let echoId = echoEntryId
    if (lookupEchoFirst && !echoId) echoId = await lookupEchoEntryId(readSignal)
    const matches = (entry: ParsedGrokTranscriptEntry) => isAnchor(entry) ||
      Boolean(echoId && entry.entryId === echoId)
    const page = await readGrokTranscriptGap(client, { agentId, sessionId }, {
      floor: 0n, stopAt: matches, signal: readSignal, maxPages: GROK_REPLY_HISTORY_MAX_PAGES
    })
    let index = page.entries.findIndex(matches)
    if (index < 0 && !echoId && !lookupEchoFirst) {
      echoId = await lookupEchoEntryId(readSignal)
      index = page.entries.findIndex(matches)
    }
    const entry = page.entries[index]
    const prompt = entry?.bodyOmitted ? await hydrateGrokEntry(client, agentId, sessionId, entry, readSignal) : entry
    const verified = prompt?.role === 'user' && matches(prompt)
    return { echoId, generation: page.generation, entries: verified ? [prompt, ...page.entries.slice(index + 1)] : [] }
  }

  const acceptEntries = async (entries: ParsedGrokTranscriptEntry[], advanceCursor = true, readSignal = signal) => {
    const hydrated: Array<{ entry: ParsedGrokTranscriptEntry; order: number }> = []
    for (const entry of entries) {
      assertCurrent()
      const seq = grokSeq(entry.updatedSeq)
      if (advanceCursor && seq > cursor) cursor = seq
      const parsed = await hydrateGrokEntry(client, agentId, sessionId, entry, readSignal)
      assertCurrent()
      const order = ++received
      hydrated.push({ entry: parsed, order })
      if (isAnchor(parsed)) {
        if (!anchor || anchorOrder === undefined) {
          anchor = parsed
          anchorOrder = order
        } else if (!advanceCursor && parsed.entryId === anchor.entryId) {
          anchorOrder = order
        }
      }
    }
    for (const { entry, order } of hydrated) {
      if (entry.role !== 'assistant' && entry.role !== 'tool') continue
      const updated = grokSeq(entry.updatedSeq)
      if (updated > 0n && updated <= afterSeq) continue
      if (revisions.accept(entry)) {
        pending.set(entry.entryId, entry)
        entryOrder.set(entry.entryId, order)
        if (pending.size > 2048) {
          const oldest = pending.keys().next().value!
          pending.delete(oldest)
          entryOrder.delete(oldest)
        }
      } else if (!advanceCursor && pending.has(entry.entryId)) {
        entryOrder.set(entry.entryId, order)
      }
    }
    if (sentId && !anchor && pending.size && Date.now() >= nextAnchorLookupAt) {
      const history = await readTurnHistory(readSignal, true).catch(() => undefined)
      nextAnchorLookupAt = Date.now() + 1000
      assertCurrent()
      echoEntryId ??= history?.echoId
      anchor = history?.entries[0]
      const following = history?.entries.slice(1).find((entry) => entry.role === 'user')
      if (following) nextPrompt = { entry: following }
    }
    if (sentId && !anchor) return false
    if (anchor) {
      for (const candidate of hydrated) {
        const { entry, order } = candidate
        if (entry.role !== 'user' || isAnchor(entry) || !followsGrokEntry(entry, anchor, order, anchorOrder)) continue
        if (!nextPrompt || nextPrompt.entry.entryId === entry.entryId ||
            followsGrokEntry(nextPrompt.entry, entry, nextPrompt.order, order)) nextPrompt = candidate
      }
    }

    let receivedReply = false
    for (const entry of [...pending.values()].sort(compareGrokEntries)) {
      pending.delete(entry.entryId)
      const order = entryOrder.get(entry.entryId)
      entryOrder.delete(entry.entryId)
      if (anchor?.requestId && entry.requestId && anchor.requestId !== entry.requestId) continue
      if (anchor && !followsGrokEntry(entry, anchor, order, anchorOrder)) continue
      const matchesRequest = Boolean(anchor?.requestId && entry.requestId === anchor.requestId)
      if (nextPrompt && !matchesRequest && !followsGrokEntry(nextPrompt.entry, entry, nextPrompt.order, order)) continue
      if (entry.role === 'tool' && entry.toolCall) {
        collectedTools.set(entry.toolCall.id, entry.toolCall)
        continue
      }
      const media = await watchHandle?.resolveMediaUrls(client, agentId, sessionId, entry.media, readSignal) ?? entry.media
      assertCurrent()
      if (!entry.text && !entry.widgets?.length && !entry.richWidgets?.length && !media?.length) continue
      const messageId = `grok_${entry.entryId}`
      const bubble = {
        messageId, text: entry.text, widgets: entry.widgets, richWidgets: entry.richWidgets, media,
        tools: collectedTools.size ? [...collectedTools.values()] : undefined
      }
      bubbles.set(messageId, { entry, bubble })
      receivedReply = true
      if (!streamsInBackground) broadcastGrokEvent({
        type: 'stream', accountId, conversationId: args.conversationId, agentId,
        sessionId: sessionId || undefined, ...bubble, done: !entry.isStreaming
      })
      if (entry.isStreaming) clearTimeout(settleTimer)
      else armSettle(isAgentRunning ? GROK_REPLY_SETTLE_MS : 2_200)
    }
    return receivedReply
  }

  const resetGeneration = (next: number) => {
    generation = next
    cursor = 0n
    revisions.clear()
    pending.clear()
    entryOrder.clear()
    bubbles.clear()
    collectedTools.clear()
    anchor = undefined
    anchorOrder = undefined
    nextPrompt = undefined
    nextAnchorLookupAt = 0
    clearTimeout(settleTimer)
  }

  let applied = Promise.resolve()
  const applyInOrder = (update: () => Promise<void>) => {
    const next = applied.then(update)
    applied = next.catch(() => undefined)
    return next
  }

  let historyTimer: ReturnType<typeof setTimeout> | undefined
  let historyTask: Promise<void> | undefined
  const scheduleHistoryRead = () => {
    if (!sentId || signal.aborted || turnFailed || historyTask) return
    clearTimeout(historyTimer)
    historyTimer = setTimeout(() => {
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(GROK_REPLY_HISTORY_TIMEOUT_MS)])
      // The request runs alongside the live stream. Only applying results needs to be ordered.
      historyTask = readTurnHistory(readSignal).then((history) => applyInOrder(async () => {
        assertCurrent()
        readSignal.throwIfAborted()
        if (turnFailed || (history.generation !== undefined && generation !== 0 && history.generation !== generation)) return
        echoEntryId ??= history.echoId
        if (history.entries.length) await acceptEntries(history.entries, false, readSignal)
      })).catch(() => undefined).finally(() => {
        historyTask = undefined
        scheduleHistoryRead()
      })
    }, GROK_REPLY_HISTORY_INTERVAL_MS)
  }

  try {
    let failures = 0
    let gapFloor: bigint | undefined
    let lastBackfilled: bigint | undefined
    scheduleHistoryRead()
    while (!signal.aborted && !turnFailed) {
      assertCurrent()
      let reconnect = false
      try {
        if (gapFloor !== undefined) {
          const result = await readGrokTranscriptGap(client, { agentId, sessionId }, { floor: gapFloor, signal })
          await applyInOrder(async () => {
            if (result.generation !== undefined && result.generation > generation) resetGeneration(result.generation)
            await acceptEntries(result.entries)
            const watermark = grokSeq(result.watermark)
            if (watermark > cursor) cursor = watermark
          })
          gapFloor = undefined
        }
        for await (const frame of client.watchTranscripts({
          cursors: [{ agent_id: agentId, generation, after_updated_seq: cursor.toString(), session_id: sessionId }],
          includeUnlistedAgents: false
        }, signal)) {
          let endStream = false
          await applyInOrder(async () => {
            assertCurrent()
            const tf = asObj(frame['turn_failed'] ?? frame['turnFailed'])
            if (tf && matchesScope(tf)) {
              const related = str(tf['messageId'] ?? tf['message_id'] ?? tf['clientNonce'] ?? tf['client_nonce'])
              if (related && sentId && related !== sentId && related !== echoEntryId && related !== anchor?.entryId) return
              turnFailed = {
                code: str(tf['code'] ?? 'TURN_FAILED'),
                summary: str(tf['summary'] ?? 'Grok Bot 执行该轮对话失败')
              }
              if (!streamsInBackground) broadcastGrokEvent({
                type: 'turn_failed', accountId, agentId, sessionId: sessionId || undefined,
                turnId: str(tf['turnId'] ?? tf['turn_id']) || undefined, ...turnFailed
              })
              endStream = true
              return
            }
            const state = asObj(frame['agent_state'] ?? frame['agentState'])
            if (state && matchesScope(state)) {
              isAgentRunning = Boolean(state['isRunning'] ?? state['is_running']) ||
                Boolean(state['isComposingMessage'] ?? state['is_composing_message'])
              if (isAgentRunning) clearTimeout(settleTimer)
              else if ([...bubbles.values()].some(({ entry }) => !entry.isStreaming)) armSettle(1_800)
            }
            const cleared = asObj(frame['cleared'])
            if (cleared && matchesScope(cleared)) {
              const next = Number(cleared['newGeneration'] ?? cleared['new_generation'])
              if (Number.isSafeInteger(next) && next > generation) resetGeneration(next)
            }
            const expired = asObj(frame['cursor_too_old'] ?? frame['cursorTooOld'])
            if (expired && matchesScope(expired)) {
              gapFloor = cursor
              if (lastBackfilled !== cursor) {
                lastBackfilled = cursor
                cursor = 0n
                reconnect = true
              }
              endStream = true
              return
            }
            const rows = grokRows(frame)
            if (!rows || !matchesScope(rows)) return
            const frameGeneration = Number(rows['generation'] ?? generation)
            if (!Number.isSafeInteger(frameGeneration) || frameGeneration < generation) return
            if (frameGeneration > generation) {
              if (generation !== 0) resetGeneration(frameGeneration)
              else generation = frameGeneration
            }
            if (await acceptEntries(transcriptEntries(rows, agentId, sessionId))) scheduleHistoryRead()
          })
          if (endStream) break
        }
      } catch (error) {
        if (signal.aborted) break
        assertCurrent()
        if (error instanceof GrokConnectError && (error.status === 401 || error.status === 403)) throw error
      }
      if (signal.aborted || turnFailed) break
      if (!reconnect) {
        const ms = Math.min(20_000, Math.round(1_200 * Math.pow(1.7, failures++)))
        await delay(ms, undefined, { signal }).catch(() => undefined)
      }
    }
    args.signal?.throwIfAborted()
    if (revision !== grokCredentialRevision(accountId)) throw new DOMException('Grok credentials changed', 'AbortError')
    const messages = [...bubbles.values()].filter(({ entry }) => !entry.isStreaming)
      .sort((a, b) => compareGrokEntries(a.entry, b.entry)).map(({ bubble }) => bubble)
    return { ...messages.at(-1), text: messages.at(-1)?.text ?? '', messages, turnFailed, echoEntryId }
  } finally {
    ac.abort()
    clearTimeout(timer)
    clearTimeout(settleTimer)
    clearTimeout(historyTimer)
    await historyTask
  }
}

async function downloadGrokArtifact(
  accountId: string,
  client: GrokConnectClient,
  req: Extract<GrokRpcRequest, { op: 'downloadAttachment' }>
): Promise<{ dataBase64: string; mimeType: string; text?: string; filename?: string }> {
  const fetcher = grokFetcherForAccount(accountId)

  // 1. Group chat document
  if (req.groupChatId && req.storeId && req.documentId) {
    const doc = await client.unary<Record<string, unknown>, Record<string, unknown>>(
      'ReadGrokBotGroupChatDocument',
      {
        group_chat_id: req.groupChatId,
        store_id: req.storeId,
        document_id: req.documentId
      }
    )
    const content = String(doc['content'] ?? '')
    return {
      dataBase64: Buffer.from(content, 'utf8').toString('base64'),
      mimeType: 'text/markdown',
      text: content,
      filename: req.name || `${req.documentId}.md`
    }
  }

  // 2. AgentStore file (`grokstore://<storeId>/<relativePath>`)
  const rawPath = (req.path ?? '').trim()
  if (req.storeId || rawPath.startsWith('grokstore://')) {
    let storeId = req.storeId ?? ''
    let relPath = req.documentId ?? rawPath
    if (rawPath.startsWith('grokstore://')) {
      const rest = rawPath.slice('grokstore://'.length)
      const slashIdx = rest.indexOf('/')
      if (slashIdx > 0) {
        storeId = rest.slice(0, slashIdx)
        relPath = rest.slice(slashIdx + 1)
      }
    }
    if (storeId && relPath) {
      const fileRes = await client.unary<Record<string, unknown>, Record<string, unknown>>(
        'ReadAgentStoreFile',
        {
          store_id: storeId,
          relative_path: relPath
        },
        'agentstore'
      )
      const content = String(fileRes['content'] ?? '')
      return {
        dataBase64: Buffer.from(content, 'utf8').toString('base64'),
        mimeType: relPath.endsWith('.html') ? 'text/html' : 'text/markdown',
        text: content,
        filename: req.name || relPath.split('/').pop() || 'document.md'
      }
    }
  }

  // 3. Direct URL or attachment alias/path via `ResolveGrokBotAttachmentReads`
  let targetUrl = req.url?.trim() || ''
  let hintedMime = ''
  if (!targetUrl && rawPath) {
    if (/^https?:\/\//i.test(rawPath)) {
      targetUrl = rawPath
    } else if (req.agentId) {
      const cleanPath = rawPath.replace(/^grokatt:\/\//i, '')
      const resolved = await client.resolveAttachmentReads({
        agentId: req.agentId,
        sessionId: req.sessionId,
        paths: [cleanPath]
      })
      const reads = Array.isArray(resolved['reads'])
        ? (resolved['reads'] as Array<Record<string, unknown>>)
        : []
      const first = reads[0]
      if (first && typeof first['url'] === 'string' && first['url']) {
        targetUrl = first['url']
        hintedMime = typeof first['contentType'] === 'string' ? first['contentType'] : ''
      }
    }
  }

  if (!targetUrl) {
    throw new Error('Unable to resolve Grok attachment or document URL')
  }

  const res = await fetcher(targetUrl, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`Grok attachment download failed (${res.status})`)
  }
  const ab = await res.arrayBuffer()
  const buf = Buffer.from(ab)
  const mimeType = inferMediaMime({
    headerMime: res.headers.get('content-type') ?? hintedMime,
    nameOrPath: req.name || rawPath || targetUrl,
    bytes: buf
  })
  const isText =
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('markdown') ||
    mimeType.includes('xml')
  return {
    dataBase64: buf.toString('base64'),
    mimeType,
    ...(isText ? { text: buf.toString('utf8') } : {}),
    filename: req.name
  }
}

/** One attempt of a typed Grok RPC. */
async function runGrokRpcOnce(
  request: Exclude<GrokRequest, { op: 'cancelRequest' }>,
  context: { revision: number; accessToken?: string },
  signal?: AbortSignal
): Promise<GrokRpcResponse> {
  try {
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (context.revision !== grokCredentialRevision(request.accountId)) {
        throw new DOMException('Grok credentials changed', 'AbortError')
      }
    }
    assertCurrent()
    const defaultSession = ''

    if (request.op === 'stopWatch') {
      stopGrokAccountWatch(request.accountId)
      return { ok: true, data: { stopped: true } }
    }

    if (request.op === 'ensureWatch') {
      const handle = ensureGrokAccountWatch({
        accountId: request.accountId,
        agentIds: request.agentIds,
        conversationMap: request.conversationMap,
        targets: request.targets,
        createClient: () => clientForGrokAccount(request.accountId, request.timeZone),
        emit: broadcastGrokEvent
      })
      return {
        ok: true,
        data: { watching: true, approvals: handle.listApprovals() }
      }
    }

    if (request.op === 'listApprovals') {
      const handle = getGrokAccountWatch(request.accountId)
      return {
        ok: true,
        data: { pending: handle ? handle.listApprovals(request.agentId) : [] }
      }
    }

    const client = await clientForGrokAccount(request.accountId, request.timeZone)
    assertCurrent()
    context.accessToken = client.accessToken

    switch (request.op) {
      case 'listAgents': {
        const data = (await client.listAgents({
          role: request.role,
          includeTeamAgents: request.includeTeamAgents
        })) as Record<string, unknown> | null
        assertCurrent()
        const agents = Array.isArray(data?.['agents'])
          ? (data['agents'] as Array<Record<string, unknown>>)
          : []
        const ids = agents
          .map((a) => String(a['id'] ?? a['agent_id'] ?? a['agentId'] ?? ''))
          .filter(Boolean)
        if (ids.length > 0) {
          ensureGrokAccountWatch({
            accountId: request.accountId,
            agentIds: ids,
            createClient: () => clientForGrokAccount(request.accountId, request.timeZone),
            emit: broadcastGrokEvent
          })
        }
        return { ok: true, data }
      }
      case 'listAgentStatuses': {
        const data = await client.listAgentStatuses({ agentIds: request.agentIds })
        return { ok: true, data }
      }
      case 'uploadAttachment': {
        const bytes = Buffer.from(request.dataBase64, 'base64')
        const uploaded = await client.uploadAttachment({
          agentId: request.agentId,
          sessionId: request.sessionId,
          fileName: request.fileName,
          mimeType: request.mimeType,
          bytes
        })
        return { ok: true, data: uploaded }
      }
      case 'uploadAgentFile': {
        const bytes = Buffer.from(request.dataBase64, 'base64')
        const uploaded = await client.uploadAgentFile({
          agentId: request.agentId,
          fileName: request.fileName,
          contentType: request.contentType,
          bytes
        })
        return { ok: true, data: uploaded }
      }
      case 'resolveAttachmentReads': {
        const data = await client.resolveAttachmentReads({
          agentId: request.agentId,
          sessionId: request.sessionId,
          paths: request.paths
        })
        return { ok: true, data }
      }
      case 'downloadAttachment': {
        const data = await downloadGrokArtifact(request.accountId, client, request)
        return { ok: true, data }
      }
      case 'sendUserMessage': {
        const attachmentPaths = [...(request.attachmentPaths ?? [])]
        const attachmentNames = [...(request.attachmentNames ?? [])]
        if (request.attachments?.length) {
          for (const att of request.attachments) {
            if (!att.dataBase64) continue
            const uploaded = await client.uploadAttachment({
              agentId: request.agentId,
              sessionId: request.sessionId,
              fileName: att.name,
              mimeType: att.mimeType,
              bytes: Buffer.from(att.dataBase64, 'base64')
            }, signal)
            assertCurrent()
            attachmentPaths.push(uploaded.alias)
            attachmentNames.push(uploaded.fileName)
          }
        }
        assertCurrent()
        const data = await client.sendUserMessage({
          agentId: request.agentId,
          messageId: request.messageId,
          text: request.text,
          sessionId: request.sessionId ?? defaultSession,
          machineId: request.machineId ?? client.machineId,
          sentAtMs: request.sentAtMs,
          replyToId: request.replyToId,
          replyQuote: request.replyQuote,
          attachmentPaths,
          attachmentNames
        }, signal)
        assertCurrent()

        // Inspect 0.79.3 `SendGrokBotUserMessageResponse` refusal / delivery!
        const delivery = data['delivery']
        const refusal = data['refusal'] as
          | { failure_code?: string; failureCode?: string; message?: string }
          | undefined
        const isRefused =
          delivery === 3 ||
          delivery === 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED' ||
          Boolean(refusal?.message || refusal?.failure_code || refusal?.failureCode)
        if (isRefused) {
          const msg =
            refusal?.message ||
            refusal?.failure_code ||
            refusal?.failureCode ||
            'Message refused by Grok Bot server'
          return {
            ok: false,
            status: 422,
            code: refusal?.failure_code ?? refusal?.failureCode ?? 'message_refused',
            message: msg
          }
        }
        return { ok: true, data }
      }
      case 'getSendStatus': {
        const data = await client.getSendStatus({
          agentId: request.agentId,
          messageId: request.messageId,
          sessionId: request.sessionId ?? defaultSession
        })
        return { ok: true, data }
      }
      case 'listTranscriptEntries': {
        const sessionId = request.sessionId ?? defaultSession
        const rawPage = asObj(await client.listTranscriptEntries({
          agentId: request.agentId,
          sessionId,
          limit: request.limit,
          beforeSeq: request.beforeSeq
        }, signal)) ?? {}
        assertCurrent()
        if (request.watermarkOnly) return { ok: true, data: rawPage }

        const watchHandle = ensureGrokAccountWatch({
          accountId: request.accountId,
          targets: [{ agentId: request.agentId, sessionId }],
          createClient: () => clientForGrokAccount(request.accountId, request.timeZone),
          emit: broadcastGrokEvent
        })
        const parsedList = transcriptEntries(rawPage, request.agentId, sessionId).sort(compareGrokEntries)

        const hydrated: Array<Record<string, unknown>> = []
        let pendingTools: MuseToolCallView[] = []
        for (const rawItem of parsedList) {
          assertCurrent()
          const item = await hydrateGrokEntry(client, request.agentId, sessionId, rawItem, signal)
          if (item.role === 'tool' && item.toolCall) {
            pendingTools.push(item.toolCall)
            continue
          }
          if (item.role !== 'user' && item.role !== 'assistant') continue
          const media = await watchHandle.resolveMediaUrls(
            client,
            request.agentId,
            sessionId,
            item.media,
            signal
          )
          assertCurrent()
          hydrated.push({
            id: item.role === 'assistant' ? `grok_${item.entryId}` : item.entryId,
            clientNonce: item.clientNonce,
            requestId: item.requestId,
            seq: item.seq,
            isStreaming: item.isStreaming,
            role: item.role === 'user' ? 'user' : 'bot',
            text: item.text,
            createdAt: item.createdAtMs,
            widgets: item.widgets,
            richWidgets: item.richWidgets,
            media,
            tools: item.role === 'assistant' && pendingTools.length ? pendingTools : undefined
          })
          if (item.role === 'assistant') pendingTools = []
        }

        return { ok: true, data: { ...rawPage, hydrated } }
      }
      case 'respondWidget': {
        const data = await client.respondWidget({
          agentId: request.agentId,
          entryId: request.entryId,
          value: request.value,
          sessionId: request.sessionId ?? defaultSession
        })
        return { ok: true, data }
      }
      case 'dismissWidget': {
        const data = await client.dismissWidget({
          agentId: request.agentId,
          entryId: request.entryId,
          sessionId: request.sessionId ?? defaultSession
        })
        return { ok: true, data }
      }
      case 'answerMessagingCard': {
        const data = await client.answerMessagingCard({
          cardId: request.cardId,
          version: request.version,
          answer: request.answer,
          optionId: request.optionId,
          values: request.values
        })
        getGrokAccountWatch(request.accountId)?.removeApproval(`card:${request.cardId}`)
        return { ok: true, data }
      }
      case 'submitUserForm': {
        const data = await client.submitUserForm({
          agentId: request.agentId,
          entryId: request.entryId,
          values: request.values,
          sessionId: request.sessionId ?? defaultSession,
          saveToVault: request.saveToVault
        })
        return { ok: true, data }
      }
      case 'submitSecret': {
        const data = await client.submitSecret({
          agentId: request.agentId,
          entryId: request.entryId,
          value: request.value,
          sessionId: request.sessionId ?? defaultSession
        })
        return { ok: true, data }
      }
      case 'reactMessage': {
        const data = await client.reactToMessage({
          agentId: request.agentId,
          entryId: request.entryId,
          emoji: request.emoji,
          sessionId: request.sessionId ?? defaultSession
        })
        return { ok: true, data }
      }
      case 'searchTranscripts': {
        const data = await client.searchTranscripts({
          query: request.query,
          target: request.target,
          agentId: request.agentId,
          limit: request.limit,
          continuation: request.continuation
        })
        return { ok: true, data }
      }
      case 'exportRecipe': {
        const [agentsRes, skillsRes, autosRes, memRes] = await Promise.all([
          client.listAgents({ includeTeamAgents: true }).catch(() => ({})),
          client
            .unary<Record<string, unknown>, Record<string, unknown>>('ListGrokBotAgentSkills', {
              agent_id: request.agentId
            })
            .catch(() => ({})),
          client
            .unary<Record<string, unknown>, Record<string, unknown>>(
              'ListGrokBotAgentAutomations',
              { agent_id: request.agentId }
            )
            .catch(() => ({})),
          client
            .unary<Record<string, unknown>, Record<string, unknown>>(
              'ListGrokBotUserBotMemories',
              { agent_id: request.agentId }
            )
            .catch(() => ({}))
        ])
        const agents = Array.isArray((agentsRes as Record<string, unknown>)['agents'])
          ? ((agentsRes as Record<string, unknown>)['agents'] as Array<Record<string, unknown>>)
          : []
        const agent = agents.find((a) => String(a['id'] ?? a['agent_id']) === request.agentId) ?? {
          id: request.agentId
        }
        const recipe = {
          schemaVersion: 'grokbot-recipe-v1',
          exportedAt: new Date().toISOString(),
          agent: {
            name: agent['name'] ?? 'Grok Bot',
            description: agent['description'] ?? '',
            avatarShape: agent['avatarShape'] ?? agent['avatar_shape'] ?? 'sparkle',
            avatarColor: agent['avatarColor'] ?? agent['avatar_color'] ?? 'violet',
            harness: agent['harness'] ?? 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL'
          },
          skills: (skillsRes as Record<string, unknown>)['skills'] ?? [],
          automations: (autosRes as Record<string, unknown>)['automations'] ?? [],
          memories: (memRes as Record<string, unknown>)['memories'] ?? []
        }
        return { ok: true, data: recipe }
      }
      case 'importRecipe': {
        const parsed = JSON.parse(request.recipeJson) as Record<string, unknown>
        const agentMeta = (parsed['agent'] ?? parsed) as Record<string, unknown>
        const newAgentId = crypto.randomUUID()
        const name = (
          request.nameOverride?.trim() ||
          String(agentMeta['name'] ?? 'Imported Grok Bot')
        ).slice(0, 80)
        const created = await client.unary<Record<string, unknown>, Record<string, unknown>>(
          'CreateGrokBotAgent',
          {
            legacy_agent_id: newAgentId,
            agent_id: newAgentId,
            name,
            description: String(agentMeta['description'] ?? ''),
            title: name,
            avatar_shape: String(agentMeta['avatarShape'] ?? agentMeta['avatar_shape'] ?? 'sparkle'),
            avatar_color: String(agentMeta['avatarColor'] ?? agentMeta['avatar_color'] ?? 'violet'),
            harness: 2, // TEMPORAL
            create_intent: 1, // FRESH
            create_caller: 5 // PRODUCT_CREATE
          }
        )
        const skills = Array.isArray(parsed['skills'])
          ? (parsed['skills'] as Array<Record<string, unknown>>)
          : []
        for (const s of skills) {
          const sName = String(s['name'] ?? s['id'] ?? '').trim()
          const sContent = String(s['body'] ?? s['content'] ?? '').trim()
          if (!sName || !sContent) continue
          await client
            .unary('AddGrokBotAgentSkill', {
              agent_id: newAgentId,
              name: sName,
              content: sContent
            })
            .catch(() => undefined)
        }
        return { ok: true, data: { agentId: newAgentId, created } }
      }
      case 'resolveAutoReview': {
        const data = await client.resolveAutoReview({
          agentId: request.agentId,
          requestId: request.requestId,
          resolution: request.resolution,
          sessionId: request.sessionId ?? defaultSession,
          approvalPlatform: request.approvalPlatform,
          approvedCommand: request.approvedCommand
        })
        getGrokAccountWatch(request.accountId)?.removeApproval(
          `auto-review:${request.agentId}:${request.requestId}`
        )
        return { ok: true, data }
      }
      case 'resolveLocalTool': {
        const data = await client.resolveLocalTool({
          agentId: request.agentId,
          entryId: request.entryId,
          requestId: request.requestId,
          resolution: request.resolution,
          sessionId: request.sessionId ?? defaultSession
        })
        getGrokAccountWatch(request.accountId)?.removeApproval(
          `local-tool:${request.agentId}:${request.requestId}`
        )
        return { ok: true, data }
      }
      case 'resolveConnectorGrant': {
        const data = await client.resolveConnectorGrant({
          agentId: request.agentId,
          entryId: request.entryId,
          requestId: request.requestId,
          resolution: request.resolution,
          sessionId: request.sessionId ?? defaultSession
        })
        getGrokAccountWatch(request.accountId)?.removeApproval(
          `connector-grant:${request.agentId}:${request.requestId}`
        )
        return { ok: true, data }
      }
      case 'resolveVirtualCard': {
        const data = await client.resolveVirtualCard({
          agentId: request.agentId,
          entryId: request.entryId,
          requestId: request.requestId,
          resolution: request.resolution,
          paymentMethodId: request.paymentMethodId
        })
        getGrokAccountWatch(request.accountId)?.removeApproval(
          `virtual-card:${request.agentId}:${request.requestId}`
        )
        return { ok: true, data }
      }
      case 'watchUntilReply': {
        const data = await watchUntilReply(client, {
          accountId: request.accountId,
          conversationId: request.conversationId,
          agentId: request.agentId,
          sessionId: request.sessionId ?? defaultSession,
          afterUpdatedSeq: request.afterUpdatedSeq,
          afterMessageId: request.afterMessageId,
          timeoutMs: request.timeoutMs,
          signal
        })
        return { ok: true, data }
      }
      case 'call': {
        if (!request.method || !/^[A-Za-z0-9_]+$/.test(request.method)) {
          throw new Error('Invalid Grok ConnectRPC method name')
        }
        const data = await client.unary(request.method, request.params ?? {}, request.service)
        assertCurrent()
        return { ok: true, data }
      }
      default: {
        const _exhaustive: never = request
        return {
          ok: false,
          status: 0,
          message: `Unknown grok op: ${String((_exhaustive as { op?: string }).op)}`
        }
      }
    }
  } catch (error) {
    return fail(error)
  }
}

/** Dispatch a typed Grok RPC; on 401 refresh sand token once and retry. */
export async function runGrokRpc(request: Exclude<GrokRequest, { op: 'cancelRequest' }>, signal?: AbortSignal): Promise<GrokRpcResponse> {
  const context: { revision: number; accessToken?: string } = { revision: grokCredentialRevision(request.accountId) }
  const credentialSignal = activeGrokCredentialSignal(request.accountId)
  const scopedSignal = signal ? AbortSignal.any([signal, credentialSignal]) : credentialSignal
  const first = await runGrokRpcOnce(request, context, scopedSignal)
  if (first.ok || first.status !== 401 || scopedSignal.aborted || !context.accessToken) return first
  const refreshed = await forceRefreshSandAccessToken(request.accountId, undefined, context.accessToken, context.revision).catch(() => undefined)
  if (!refreshed || scopedSignal.aborted || context.revision !== grokCredentialRevision(request.accountId)) return first
  return runGrokRpcOnce(request, context, scopedSignal)
}
