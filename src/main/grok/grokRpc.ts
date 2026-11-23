import { BrowserWindow } from 'electron'
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
import { getGrokMainAuth, setGrokMainAuth } from './grokAuthStore'
import { inferMediaMime } from '../mediaMime'
import { GrokConnectClient, GrokConnectError } from './connectClient'
import { getOrCreateGrokMachineId } from './grokMachineId'
import {
  forceRefreshSandAccessToken,
  getValidSandAccessToken,
  grokFetcherForAccount
} from './grokSandAuth'
import { parseGrokTranscriptEntry, type ParsedGrokTranscriptEntry } from './grokTranscriptDecoder'
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

/**
 * Resolve the write-capable sand accessToken for an account.
 * Writes (Send/Transcript/approvals) require the PKCE sand token or xAI token.
 * Falls back to the in-memory web token only when no sand token exists.
 */
async function resolveClientAuth(accountId: string): Promise<{
  accessToken: string
  teamId?: string
  machineId: string
  accountSlot?: string
}> {
  const stored = getGrokMainAuth(accountId)
  const machineId = stored?.machineId?.trim() || getOrCreateGrokMachineId(accountId)
  if (machineId !== stored?.machineId && stored) {
    setGrokMainAuth({ ...stored, machineId })
  }
  const sand = await getValidSandAccessToken(accountId)
  if (sand?.accessToken) {
    return {
      accessToken: sand.accessToken,
      teamId: sand.selectedTeamId ?? stored?.teamId,
      machineId,
      accountSlot: stored?.accountSlot
    }
  }
  if (stored?.accessToken) {
    return {
      accessToken: stored.accessToken,
      teamId: stored.teamId,
      machineId,
      accountSlot: stored.accountSlot
    }
  }
  throw new GrokConnectError(401, 'Not signed in (no sand or web token)', 'not-connected')
}

export async function clientForGrokAccount(
  accountId: string,
  timeZone?: string
): Promise<GrokConnectClient> {
  const auth = await resolveClientAuth(accountId)
  return new GrokConnectClient({
    auth,
    fetchImpl: grokFetcherForAccount(accountId),
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  })
}

function fail(error: unknown): GrokRpcResponse {
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

function parseBigIntSeq(val?: string): bigint {
  if (!val) return 0n
  try {
    return BigInt(val)
  } catch {
    return 0n
  }
}

async function hydrateOmittedEntry(
  client: GrokConnectClient,
  agentId: string,
  sessionId: string,
  stub: ParsedGrokTranscriptEntry
): Promise<ParsedGrokTranscriptEntry> {
  try {
    let beforeSeq: string | undefined
    try {
      const s = BigInt(stub.seq || '0')
      if (s > 0n) beforeSeq = (s + 1n).toString()
    } catch {
      beforeSeq = undefined
    }
    const page = (await client.listTranscriptEntries({
      agentId,
      sessionId: sessionId || undefined,
      beforeSeq,
      limit: 5
    })) as Record<string, unknown>
    const entries = Array.isArray(page['entries'])
      ? (page['entries'] as Array<Record<string, unknown>>)
      : []
    const match = entries.find((raw) => {
      const eid = String(raw['entry_id'] ?? raw['entryId'] ?? '')
      const seq = String(raw['seq'] ?? '')
      return (eid && eid === stub.entryId) || (seq && seq === stub.seq)
    })
    if (match && !(match['body_omitted'] ?? match['bodyOmitted'])) {
      const hydrated = parseGrokTranscriptEntry(match, agentId, sessionId)
      if (hydrated) return hydrated
    }
  } catch {
    /* fallback to stub if hydration RPC fails */
  }
  return stub
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
  }
): Promise<{
  text: string
  messageId?: string
  messages?: Array<{
    messageId: string
    text: string
    widgets?: MuseOptionWidgetView[]
    richWidgets?: MuseRichWidgetView[]
    tools?: MuseToolCallView[]
    media?: MuseMediaPartView[]
  }>
  widgets?: MuseOptionWidgetView[]
  richWidgets?: MuseRichWidgetView[]
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
  turnFailed?: { code: string; summary: string }
}> {
  const timeoutMs = args.timeoutMs ?? 90_000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const watchHandle = getGrokAccountWatch(args.accountId)

  const assistantBubbles = new Map<
    string,
    {
      messageId: string
      text: string
      widgets?: MuseOptionWidgetView[]
      richWidgets?: MuseRichWidgetView[]
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
    }
  >()
  const collectedTools = new Map<string, MuseToolCallView>()
  let turnFailed: { code: string; summary: string } | undefined
  let isAgentRunning = false
  let idleSettleTimer: ReturnType<typeof setTimeout> | undefined
  const afterSeq = parseBigIntSeq(args.afterUpdatedSeq)
  let seenUserAnchor = false

  const armSettle = (delayMs: number = GROK_REPLY_SETTLE_MS) => {
    if (idleSettleTimer) clearTimeout(idleSettleTimer)
    idleSettleTimer = setTimeout(() => ac.abort(), delayMs)
  }

  try {
    const cursors = [
      {
        agent_id: args.agentId,
        generation: 0,
        after_updated_seq: args.afterUpdatedSeq ?? '0',
        session_id: args.sessionId
      }
    ]
    for await (const frame of client.watchTranscripts({ cursors }, ac.signal)) {
      // Handle turn_failed immediately
      const tf = (frame['turn_failed'] ?? frame['turnFailed']) as
        | Record<string, unknown>
        | undefined
      if (tf) {
        const tfAgent = String(tf['agentId'] ?? tf['agent_id'] ?? '')
        if (!tfAgent || tfAgent === args.agentId) {
          turnFailed = {
            code: String(tf['code'] ?? 'TURN_FAILED'),
            summary: String(tf['summary'] ?? 'Grok Bot 执行该轮对话失败')
          }
          broadcastGrokEvent({
            type: 'turn_failed',
            accountId: args.accountId,
            agentId: args.agentId,
            sessionId: args.sessionId || undefined,
            code: turnFailed.code,
            summary: turnFailed.summary
          })
          break
        }
      }

      // Track live agent_state so we settle quickly once `is_running` becomes false!
      const st = (frame['agent_state'] ?? frame['agentState']) as
        | Record<string, unknown>
        | undefined
      if (st) {
        const stAgent = String(st['agentId'] ?? st['agent_id'] ?? '')
        if (!stAgent || stAgent === args.agentId) {
          const running = Boolean(st['isRunning'] ?? st['is_running'])
          const composing = Boolean(st['isComposingMessage'] ?? st['is_composing_message'])
          isAgentRunning = running || composing
          if (!isAgentRunning && assistantBubbles.size > 0) {
            armSettle(1_800)
          } else if (isAgentRunning && idleSettleTimer) {
            clearTimeout(idleSettleTimer)
          }
        }
      }

      const rows =
        (frame['rows'] as Record<string, unknown> | undefined) ??
        (frame['Rows'] as Record<string, unknown> | undefined) ??
        (Array.isArray(frame['entries']) ? frame : undefined)
      if (!rows) continue
      const isReplay = rows['replay'] === true
      const entries = (Array.isArray(rows['entries']) ? rows['entries'] : []) as Record<
        string,
        unknown
      >[]

      const parsedEntries = entries
        .map((raw) => parseGrokTranscriptEntry(raw, args.agentId, args.sessionId))
        .filter((x): x is ParsedGrokTranscriptEntry => Boolean(x))
      const anchorIdx =
        isReplay && args.afterMessageId
          ? parsedEntries.findIndex(
              (p) => p.entryId === args.afterMessageId || p.clientNonce === args.afterMessageId
            )
          : -1

      for (let idx = 0; idx < parsedEntries.length; idx++) {
        let parsed = parsedEntries[idx]!

        if (
          args.afterMessageId &&
          (parsed.entryId === args.afterMessageId || parsed.clientNonce === args.afterMessageId)
        ) {
          seenUserAnchor = true
          continue
        }
        if (isReplay && anchorIdx >= 0 && idx < anchorIdx) continue

        const entrySeq = parseBigIntSeq(parsed.updatedSeq || parsed.seq)
        if (afterSeq > 0n && entrySeq > 0n && entrySeq <= afterSeq) continue

        if (parsed.role === 'tool' && parsed.toolCall) {
          collectedTools.set(parsed.toolCall.id, parsed.toolCall)
          continue
        }

        if (parsed.role !== 'assistant') continue
        if (isReplay && !parsed.isStreaming) {
          if (afterSeq > 0n && entrySeq === 0n && !seenUserAnchor) continue
          if (afterSeq === 0n && args.afterMessageId && !seenUserAnchor) continue
        }

        if (parsed.bodyOmitted) {
          parsed = await hydrateOmittedEntry(client, args.agentId, args.sessionId, parsed)
        }

        const resolvedMedia = watchHandle
          ? await watchHandle.resolveMediaUrls(
              client,
              args.agentId,
              args.sessionId,
              parsed.media
            )
          : parsed.media

        const hasPayload =
          Boolean(parsed.text) ||
          Boolean(parsed.widgets?.length) ||
          Boolean(parsed.richWidgets?.length) ||
          Boolean(resolvedMedia?.length)
        if (!hasPayload) continue

        const msgId = `grok_${parsed.entryId}`
        const toolsArr = collectedTools.size > 0 ? [...collectedTools.values()] : undefined

        assistantBubbles.set(msgId, {
          messageId: msgId,
          text: parsed.text,
          widgets: parsed.widgets,
          richWidgets: parsed.richWidgets,
          tools: toolsArr,
          media: resolvedMedia
        })

        // Emit stream frame only when persistent AccountWatchController is not already
        // streaming this account, avoiding duplicate Watch IPC broadcasts per token.
        if (!watchHandle) {
          broadcastGrokEvent({
            type: 'stream',
            accountId: args.accountId,
            conversationId: args.conversationId,
            agentId: args.agentId,
            sessionId: args.sessionId || undefined,
            messageId: msgId,
            text: parsed.text,
            done: !parsed.isStreaming,
            ...(parsed.widgets?.length ? { widgets: parsed.widgets } : {}),
            ...(parsed.richWidgets?.length ? { richWidgets: parsed.richWidgets } : {}),
            ...(toolsArr ? { tools: toolsArr } : {}),
            ...(resolvedMedia?.length ? { media: resolvedMedia } : {})
          })
        }

        if (!parsed.isStreaming) {
          armSettle(isAgentRunning ? GROK_REPLY_SETTLE_MS : 2_200)
        } else if (idleSettleTimer) {
          clearTimeout(idleSettleTimer)
        }
      }
    }
  } catch (error) {
    if (!ac.signal.aborted && assistantBubbles.size === 0 && !turnFailed) {
      throw error
    }
  } finally {
    clearTimeout(timer)
    if (idleSettleTimer) clearTimeout(idleSettleTimer)
  }

  const all = [...assistantBubbles.values()]
  const last = all[all.length - 1]
  const toolsArr = collectedTools.size > 0 ? [...collectedTools.values()] : undefined
  return {
    text: last?.text ?? '',
    messageId: last?.messageId,
    messages: all,
    widgets: last?.widgets,
    richWidgets: last?.richWidgets,
    tools: last?.tools ?? toolsArr,
    media: last?.media,
    turnFailed
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
async function runGrokRpcOnce(request: GrokRpcRequest): Promise<GrokRpcResponse> {
  try {
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
    const auth = await resolveClientAuth(request.accountId)

    switch (request.op) {
      case 'listAgents': {
        const data = (await client.listAgents({
          role: request.role,
          includeTeamAgents: request.includeTeamAgents
        })) as Record<string, unknown> | null
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
            })
            attachmentPaths.push(uploaded.alias)
            attachmentNames.push(uploaded.fileName)
          }
        }
        const data = await client.sendUserMessage({
          agentId: request.agentId,
          messageId: request.messageId,
          text: request.text,
          sessionId: request.sessionId ?? defaultSession,
          machineId: request.machineId ?? auth.machineId,
          sentAtMs: request.sentAtMs,
          replyToId: request.replyToId,
          replyQuote: request.replyQuote,
          attachmentPaths,
          attachmentNames
        })

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
        const rawPage = (await client.listTranscriptEntries({
          agentId: request.agentId,
          sessionId: request.sessionId ?? defaultSession,
          limit: request.limit,
          beforeSeq: request.beforeSeq
        })) as Record<string, unknown>

        // Also return pre-decoded, chronological `hydrated` entries with resolved presigned media!
        const entries = Array.isArray(rawPage['entries'])
          ? (rawPage['entries'] as Array<Record<string, unknown>>)
          : []
        const watchHandle = ensureGrokAccountWatch({
          accountId: request.accountId,
          agentIds: [request.agentId],
          createClient: () => clientForGrokAccount(request.accountId, request.timeZone),
          emit: broadcastGrokEvent
        })
        const parsedList = entries
          .map((r) =>
            parseGrokTranscriptEntry(r, request.agentId, request.sessionId ?? defaultSession)
          )
          .filter((x): x is NonNullable<typeof x> => Boolean(x))
        parsedList.sort((a, b) => {
          try {
            const sa = BigInt(a.seq || '0')
            const sb = BigInt(b.seq || '0')
            if (sa !== sb) return sa < sb ? -1 : 1
          } catch {
            /* fallback */
          }
          return a.createdAtMs - b.createdAtMs
        })

        const hydrated: Array<Record<string, unknown>> = []
        let pendingTools: MuseToolCallView[] = []
        for (const rawItem of parsedList) {
          const item = rawItem.bodyOmitted
            ? await hydrateOmittedEntry(client, request.agentId, request.sessionId ?? defaultSession, rawItem)
            : rawItem
          if (item.role === 'tool' && item.toolCall) {
            pendingTools.push(item.toolCall)
            continue
          }
          const media = await watchHandle.resolveMediaUrls(
            client,
            request.agentId,
            request.sessionId ?? defaultSession,
            item.media
          )
          hydrated.push({
            id: item.role === 'assistant' ? `grok_${item.entryId}` : item.entryId,
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
          timeoutMs: request.timeoutMs
        })
        return { ok: true, data }
      }
      case 'call': {
        if (!request.method || !/^[A-Za-z0-9_]+$/.test(request.method)) {
          throw new Error('Invalid Grok ConnectRPC method name')
        }
        const data = await client.unary(request.method, request.params ?? {}, request.service)
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
export async function runGrokRpc(request: GrokRpcRequest): Promise<GrokRpcResponse> {
  const first = await runGrokRpcOnce(request)
  if (first.ok || first.status !== 401) return first
  const refreshed = await forceRefreshSandAccessToken(request.accountId).catch(() => null)
  if (!refreshed?.accessToken) return first
  const stored = getGrokMainAuth(request.accountId)
  setGrokMainAuth({
    accountId: request.accountId,
    accessToken: refreshed.accessToken,
    accountSlot: stored?.accountSlot,
    teamId: refreshed.selectedTeamId ?? stored?.teamId,
    machineId: stored?.machineId ?? getOrCreateGrokMachineId(request.accountId)
  })
  return runGrokRpcOnce(request)
}
