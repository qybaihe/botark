/**
 * Electron main-process client for Google Antigravity Cloud Agents (`antigravity.google.com`).
 *
 * Calls `https://aicode.clients6.google.com/$rpc/google.gca.aicode.v1alpha.JetskiRemoteAgentProxyService/*`
 * through the account's isolated Electron session partition (`ses.fetch`), so per-account
 * proxies and Google session cookies are always honored automatically.
 *
 * Never logs cookie or auth-header values.
 */

import { session as electronSession } from 'electron'
import type { AntigravityMainEvent } from '@shared/ipc'
import { applyProxyToPartition } from '../muse/accountProxy'
import { partitionForAccount } from '../webContentsViewManager'
import {
  ANTIGRAVITY_API_KEY,
  ANTIGRAVITY_API_ORIGIN,
  ANTIGRAVITY_ORIGIN,
  ANTIGRAVITY_RPC_PREFIX,
  buildCancelCascadeReq,
  buildDeleteConversationReq,
  buildGetConversationReq,
  buildListConversationsReq,
  buildSapisidAuthHeader,
  buildSendUserCascadeMessageReq,
  buildStartCascadeReq,
  buildStreamAgentStateUpdatesReq,
  CASCADE_RUN_STATUS,
  cleanAntigravityChromeUserAgent,
  extractTranscriptFromSteps,
  extractTurnProgress,
  JspbStreamBodyParser,
  mergeTrajectorySteps,
  parseAgents,
  parseAvailableModels,
  parseConversationsList,
  parseEnvironments,
  parseGetConversationResponse,
  parseStartCascadeResponse,
  parseStreamUpdateResponse,
  parseUserProfile,
  parseWorkspaces,
  type AntigravityAgentInfo,
  type AntigravityConversationSummary,
  type AntigravityEnvironmentInfo,
  type AntigravityModelInfo,
  type AntigravityParsedStep,
  type AntigravityTranscriptMessage,
  type AntigravityUserProfile,
  type AntigravityWorkspaceInfo
} from './antigravityProtocol'

export interface AntigravityAccountPrefs {
  modelEnum?: number
  modelDisplayName?: string
  capsuleId?: string
  agentPath?: string
}

interface ActiveRun {
  controller: AbortController
  cascadeId?: string
}

const accountPrefs = new Map<string, AntigravityAccountPrefs>()
const activeRuns = new Map<string, ActiveRun>()

export function getAntigravityAccountPrefs(accountId: string): AntigravityAccountPrefs {
  return accountPrefs.get(accountId) ?? {}
}

export function setAntigravityAccountPrefs(
  accountId: string,
  patch: Partial<AntigravityAccountPrefs>
): AntigravityAccountPrefs {
  const next: AntigravityAccountPrefs = { ...getAntigravityAccountPrefs(accountId), ...patch }
  accountPrefs.set(accountId, next)
  return next
}

export function clearAntigravityAccountState(accountId: string): void {
  cancelAntigravityRun(accountId)
  accountPrefs.delete(accountId)
}

export function cancelAntigravityRun(accountId: string): void {
  const run = activeRuns.get(accountId)
  if (!run) return
  activeRuns.delete(accountId)
  run.controller.abort()
  if (run.cascadeId) {
    void callAntigravityRpc(accountId, 'CancelCascade', buildCancelCascadeReq(run.cascadeId)).catch(
      () => undefined
    )
  }
}

export function cancelAllAntigravityRuns(target: string): void {
  if (target === '*') {
    for (const id of [...activeRuns.keys()]) cancelAntigravityRun(id)
  } else {
    cancelAntigravityRun(target)
  }
}

async function getPartitionCookies(accountId: string): Promise<Array<{ name: string; value: string }>> {
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  const [agyCookies, googleCookies] = await Promise.all([
    ses.cookies.get({ url: ANTIGRAVITY_ORIGIN }).catch(() => []),
    ses.cookies.get({ url: 'https://www.google.com' }).catch(() => [])
  ])
  const merged = new Map<string, string>()
  for (const c of googleCookies) merged.set(c.name, c.value)
  for (const c of agyCookies) merged.set(c.name, c.value)
  return [...merged.entries()].map(([name, value]) => ({ name, value }))
}

export async function listAntigravityCookieNames(accountId: string): Promise<string[]> {
  const cookies = await getPartitionCookies(accountId)
  return cookies.map((c) => c.name)
}

async function buildRequestHeaders(accountId: string): Promise<{
  ses: Electron.Session
  headers: Record<string, string>
} | null> {
  await applyProxyToPartition(accountId)
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  const cleanUa = cleanAntigravityChromeUserAgent(ses.getUserAgent())
  ses.setUserAgent(cleanUa)

  const cookies = await getPartitionCookies(accountId)
  const authHeader = buildSapisidAuthHeader(cookies, ANTIGRAVITY_ORIGIN)
  if (!authHeader) return null

  return {
    ses,
    headers: {
      'Content-Type': 'application/json+protobuf',
      Accept: '*/*',
      'X-User-Agent': 'grpc-web-javascript/0.1',
      'X-Goog-Api-Key': ANTIGRAVITY_API_KEY,
      'X-Goog-AuthUser': '0',
      Authorization: authHeader,
      Origin: ANTIGRAVITY_ORIGIN,
      Referer: `${ANTIGRAVITY_ORIGIN}/`,
      'User-Agent': cleanUa
    }
  }
}

export class AntigravityRpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly grpcCode?: number
  ) {
    super(message)
    this.name = 'AntigravityRpcError'
  }
}

function parseRpcErrorPayload(status: number, bodyText: string): AntigravityRpcError {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'number') {
      const code = parsed[0]
      const msg = typeof parsed[1] === 'string' && parsed[1] ? parsed[1] : `gRPC error ${code}`
      const effectiveStatus = code === 16 ? 401 : code === 7 ? 403 : status
      return new AntigravityRpcError(effectiveStatus, msg.slice(0, 260), code)
    }
  } catch {
    /* fall through */
  }
  return new AntigravityRpcError(status, `Antigravity RPC HTTP ${status}`)
}

const ANTIGRAVITY_RPC_TIMEOUT_MS = 25_000

export async function callAntigravityRpc(
  accountId: string,
  method: string,
  bodyArray: unknown[] = [],
  signal?: AbortSignal
): Promise<unknown> {
  const prepared = await buildRequestHeaders(accountId)
  if (!prepared) {
    throw new AntigravityRpcError(401, 'Not signed in to Google Antigravity (missing SAPISID cookies)', 16)
  }
  const url = `${ANTIGRAVITY_API_ORIGIN}${ANTIGRAVITY_RPC_PREFIX}/${method}`
  const maxAttempts = method === 'StartCascade' || method === 'SendUserCascadeMessage' ? 1 : 2
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(400 * attempt, signal)
    }
    const deadline = AbortSignal.timeout(ANTIGRAVITY_RPC_TIMEOUT_MS)
    const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    try {
      const res = await prepared.ses.fetch(url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(bodyArray),
        signal: effectiveSignal
      })
      const text = await res.text()
      if (!res.ok) {
        const err = parseRpcErrorPayload(res.status, text)
        if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt + 1 < maxAttempts) {
          lastError = err
          continue
        }
        throw err
      }
      if (!text.trim()) return []
      try {
        return JSON.parse(text)
      } catch {
        throw new AntigravityRpcError(502, `Invalid JSON response from Antigravity ${method}`)
      }
    } catch (error) {
      if (error instanceof AntigravityRpcError) throw error
      lastError = error
      if (signal?.aborted || attempt + 1 >= maxAttempts) {
        const msg =
          error instanceof Error && error.name === 'TimeoutError'
            ? `Antigravity ${method} timed out`
            : error instanceof Error
              ? error.message
              : String(error)
        throw new AntigravityRpcError(504, msg)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new AntigravityRpcError(502, `Antigravity ${method} failed`)
}

export type AntigravitySessionProbe =
  | { signedIn: true; profile: AntigravityUserProfile }
  | { signedIn: false; reason: 'no-cookies' | 'unauthorized' | 'network'; message?: string }

export async function probeAntigravitySession(accountId: string): Promise<AntigravitySessionProbe> {
  try {
    const prepared = await buildRequestHeaders(accountId)
    if (!prepared) return { signedIn: false, reason: 'no-cookies' }
    const raw = await callAntigravityRpc(accountId, 'GetUserProfile', [])
    const profile = parseUserProfile(raw)
    if (!profile) {
      return { signedIn: false, reason: 'unauthorized', message: 'Empty Antigravity user profile' }
    }
    return { signedIn: true, profile }
  } catch (error) {
    if (error instanceof AntigravityRpcError && (error.status === 401 || error.status === 403 || error.grpcCode === 16)) {
      return { signedIn: false, reason: 'unauthorized', message: error.message }
    }
    return {
      signedIn: false,
      reason: 'network',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function fetchAntigravityProfile(accountId: string): Promise<AntigravityUserProfile | null> {
  const raw = await callAntigravityRpc(accountId, 'GetUserProfile', [])
  return parseUserProfile(raw)
}

export async function fetchAntigravityModels(accountId: string): Promise<AntigravityModelInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListAvailableModels', [])
  return parseAvailableModels(raw)
}

export async function fetchAntigravityAgents(accountId: string): Promise<AntigravityAgentInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListAgents', [])
  return parseAgents(raw)
}

export async function fetchAntigravityEnvironments(accountId: string): Promise<AntigravityEnvironmentInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListEnvironments', [])
  return parseEnvironments(raw)
}

export async function fetchAntigravityWorkspaces(accountId: string): Promise<AntigravityWorkspaceInfo[]> {
  const raw = await callAntigravityRpc(accountId, 'ListWorkspaces', [])
  return parseWorkspaces(raw)
}

export async function fetchAntigravityConversations(
  accountId: string,
  pageSize = 30
): Promise<AntigravityConversationSummary[]> {
  const raw = await callAntigravityRpc(accountId, 'ListConversations', buildListConversationsReq(pageSize))
  return parseConversationsList(raw).conversations
}

export async function fetchAntigravityTranscript(
  accountId: string,
  conversationId: string
): Promise<{
  messages: AntigravityTranscriptMessage[]
  runStatus: number
  fullyIdle: boolean
}> {
  const raw = await callAntigravityRpc(
    accountId,
    'GetConversation',
    buildGetConversationReq(conversationId, 2)
  )
  const update = parseGetConversationResponse(raw)
  if (!update) return { messages: [], runStatus: CASCADE_RUN_STATUS.IDLE, fullyIdle: true }
  const map = new Map<number, AntigravityParsedStep>()
  mergeTrajectorySteps(map, update)
  return {
    messages: extractTranscriptFromSteps(map, conversationId),
    runStatus: update.runStatus,
    fullyIdle: update.fullyIdle
  }
}

export async function deleteAntigravityConversation(
  accountId: string,
  conversationId: string
): Promise<void> {
  await callAntigravityRpc(accountId, 'DeleteConversation', buildDeleteConversationReq(conversationId))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface SendAntigravityMessageParams {
  accountId: string
  conversationId: string
  sessionId?: string
  text: string
  clientMessageId?: string
  onEvent: (event: AntigravityMainEvent) => void
}

export async function sendAndStreamAntigravityMessage(
  params: SendAntigravityMessageParams
): Promise<{ cascadeId: string; messageId: string }> {
  const { accountId, conversationId, text, clientMessageId, onEvent } = params
  cancelAntigravityRun(accountId)

  const controller = new AbortController()
  const run: ActiveRun = { controller }
  activeRuns.set(accountId, run)

  const prefs = getAntigravityAccountPrefs(accountId)
  const stepsMap = new Map<number, AntigravityParsedStep>()
  let afterStepIndex = -1
  let cascadeId = params.sessionId?.trim() || ''

  try {
    onEvent({
      type: 'activity',
      accountId,
      activityCode: 'thinking',
      activityText: cascadeId ? 'Sending to Antigravity…' : 'Starting Antigravity cloud agent…',
      busy: true
    })

    if (cascadeId) {
      // Snapshot current steps so we only stream steps produced by THIS new turn.
      try {
        const pre = parseGetConversationResponse(
          await callAntigravityRpc(accountId, 'GetConversation', buildGetConversationReq(cascadeId, 2), controller.signal)
        )
        if (pre) {
          mergeTrajectorySteps(stepsMap, pre)
          for (const idx of stepsMap.keys()) {
            if (idx > afterStepIndex) afterStepIndex = idx
          }
        }
      } catch {
        /* proceed even if pre-snapshot fails */
      }

      const sendRaw = await callAntigravityRpc(
        accountId,
        'SendUserCascadeMessage',
        buildSendUserCascadeMessageReq({
          cascadeId,
          text,
          modelEnum: prefs.modelEnum,
          continueExecution: true,
          clientMessageId
        }),
        controller.signal
      )
      const returnedId = parseStartCascadeResponse(sendRaw).cascadeId
      if (returnedId) cascadeId = returnedId
    } else {
      const startRaw = await callAntigravityRpc(
        accountId,
        'StartCascade',
        buildStartCascadeReq({
          text,
          modelEnum: prefs.modelEnum,
          capsuleId: prefs.capsuleId,
          agentPath: prefs.agentPath,
          clientMessageId
        }),
        controller.signal
      )
      cascadeId = parseStartCascadeResponse(startRaw).cascadeId
      if (!cascadeId) {
        throw new AntigravityRpcError(502, 'Antigravity StartCascade returned an empty cascadeId')
      }
      // The initial user prompt is step 0.
      afterStepIndex = 0
    }

    run.cascadeId = cascadeId
    const replyMessageId = `agy_${cascadeId}_${Date.now()}`

    // Launch background live stream + fallback poller so the RPC caller gets immediate ack.
    void streamCascadeUntilDone({
      accountId,
      conversationId,
      cascadeId,
      replyMessageId,
      afterStepIndex,
      stepsMap,
      signal: controller.signal,
      onEvent
    }).finally(() => {
      if (activeRuns.get(accountId) === run) activeRuns.delete(accountId)
    })

    return { cascadeId, messageId: replyMessageId }
  } catch (error) {
    if (activeRuns.get(accountId) === run) activeRuns.delete(accountId)
    onEvent({
      type: 'activity',
      accountId,
      activityCode: 'idle',
      activityText: null,
      busy: false
    })
    throw error
  }
}

async function streamCascadeUntilDone(opts: {
  accountId: string
  conversationId: string
  cascadeId: string
  replyMessageId: string
  afterStepIndex: number
  stepsMap: Map<number, AntigravityParsedStep>
  signal: AbortSignal
  onEvent: (event: AntigravityMainEvent) => void
}): Promise<void> {
  const { accountId, conversationId, cascadeId, replyMessageId, stepsMap, signal, onEvent } = opts
  let afterStepIndex = opts.afterStepIndex
  let resumeToken: string | undefined
  let lastSentText = ''
  let lastToolSig = ''
  let lastActivity = ''
  let sawRunning = false
  let finished = false
  let needsApproval = false

  const emitProgress = (done: boolean) => {
    // Advance afterStepIndex if the new user input step appeared at index > initial afterStepIndex
    for (const s of stepsMap.values()) {
      if (s.userText && s.index > afterStepIndex && !sawRunning && s.index <= afterStepIndex + 2) {
        afterStepIndex = s.index
      }
    }
    const progress = extractTurnProgress(stepsMap, afterStepIndex)
    const toolSig = JSON.stringify(progress.tools)

    if (!done) {
      const nextActivity = progress.activityText || (progress.text ? 'Responding…' : 'Thinking…')
      if (nextActivity !== lastActivity) {
        lastActivity = nextActivity
        onEvent({
          type: 'activity',
          accountId,
          activityCode: progress.tools.some((t) => t.status === 'running') ? 'tool' : 'thinking',
          activityText: nextActivity,
          busy: true
        })
      }
      if (progress.text !== lastSentText || toolSig !== lastToolSig) {
        lastSentText = progress.text
        lastToolSig = toolSig
        onEvent({
          type: 'stream',
          accountId,
          conversationId,
          sessionId: cascadeId,
          messageId: replyMessageId,
          text: progress.text,
          tools: progress.tools.length > 0 ? progress.tools : undefined,
          done: false
        })
      }
      return
    }

    if (!needsApproval) {
      onEvent({
        type: 'activity',
        accountId,
        activityCode: 'idle',
        activityText: null,
        busy: false
      })
    }
    onEvent({
      type: 'stream',
      accountId,
      conversationId,
      sessionId: cascadeId,
      messageId: replyMessageId,
      text: progress.text || lastSentText,
      tools: progress.tools.length > 0 ? progress.tools : undefined,
      done: true
    })
  }

  const applyUpdate = (update: ReturnType<typeof parseStreamUpdateResponse>): boolean => {
    if (!update) return false
    if (update.resumeToken) resumeToken = update.resumeToken
    mergeTrajectorySteps(stepsMap, update)

    const isActive =
      update.runStatus === CASCADE_RUN_STATUS.RUNNING ||
      update.runStatus === CASCADE_RUN_STATUS.BUSY ||
      update.runStatus === CASCADE_RUN_STATUS.CANCELING
    if (isActive) sawRunning = true

    emitProgress(false)

    const progress = extractTurnProgress(stepsMap, afterStepIndex)
    const isIdle = update.fullyIdle || update.runStatus === CASCADE_RUN_STATUS.IDLE
    const hasWaiting = update.waitingStepIndices.length > 0
    if (hasWaiting) {
      needsApproval = true
      onEvent({
        type: 'activity',
        accountId,
        activityCode: 'needs_approval',
        activityText: 'Waiting for confirmation in Antigravity Web',
        busy: false
      })
      return true
    }
    if (isIdle && (sawRunning || progress.text.length > 0 || progress.hasError)) {
      return true
    }
    return false
  }

  // Phase 1: Real-time server-streaming via StreamAgentStateUpdates
  try {
    const prepared = await buildRequestHeaders(accountId)
    if (prepared && !signal.aborted) {
      const url = `${ANTIGRAVITY_API_ORIGIN}${ANTIGRAVITY_RPC_PREFIX}/StreamAgentStateUpdates`
      const res = await prepared.ses.fetch(url, {
        method: 'POST',
        headers: prepared.headers,
        body: JSON.stringify(buildStreamAgentStateUpdatesReq(cascadeId, resumeToken, 2)),
        signal
      })
      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        const parser = new JspbStreamBodyParser()
        while (!signal.aborted && !finished) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value) continue
          const textChunk = decoder.decode(value, { stream: true })
          for (const ev of parser.push(textChunk)) {
            if (ev.kind === 'message') {
              const parsed = parseStreamUpdateResponse(ev.payload)
              if (applyUpdate(parsed)) {
                finished = true
                void reader.cancel().catch(() => undefined)
                break
              }
            } else if (ev.kind === 'status' && ev.code !== 0) {
              break
            }
          }
        }
      }
    }
  } catch {
    /* fall back cleanly to GetConversation polling */
  }

  // Phase 2: Fallback poll via GetConversation if stream ended before IDLE
  const deadline = Date.now() + 180_000
  let idlePollsWithoutContent = 0
  while (!signal.aborted && !finished && Date.now() < deadline) {
    await sleep(1_200, signal)
    if (signal.aborted) break
    try {
      const raw = await callAntigravityRpc(
        accountId,
        'GetConversation',
        buildGetConversationReq(cascadeId, 2),
        signal
      )
      const update = parseGetConversationResponse(raw)
      if (applyUpdate(update)) {
        finished = true
        break
      }
      if (update && (update.fullyIdle || update.runStatus === CASCADE_RUN_STATUS.IDLE)) {
        idlePollsWithoutContent++
        if (idlePollsWithoutContent >= 4) {
          finished = true
          break
        }
      } else {
        idlePollsWithoutContent = 0
      }
    } catch {
      idlePollsWithoutContent++
      if (idlePollsWithoutContent >= 5) break
    }
  }

  if (!signal.aborted) {
    emitProgress(true)
  } else {
    onEvent({
      type: 'activity',
      accountId,
      activityCode: 'idle',
      activityText: null,
      busy: false
    })
    onEvent({
      type: 'stream',
      accountId,
      conversationId,
      sessionId: cascadeId,
      messageId: replyMessageId,
      text: '',
      done: true
    })
  }
}
