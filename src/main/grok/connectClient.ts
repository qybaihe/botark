/**
 * Main-process ConnectRPC client for Grok Bot 0.79.3 (`aiserver.v1.*`).
 * Runs in Electron main (Node fetch via per-account `proxyFetch`) so the
 * renderer never hits api2 CORS and never leaks the host's real IP.
 *
 * Matches Grok Bot.app 0.79.3 (`main-core.cjs` `X3` / `cwe` / `T_`):
 * - UA: `Mozilla/5.0 (...) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.79.3 Safari/537.36`
 * - `x-sand-box-namespace: prod` (always present unless overridden)
 * - `x-cursor-checksum`: 6-byte timestamp XOR obfuscation + `machineId`
 * - Supports `GrokBotService` (464 RPCs), `SandBoxService` (55), `AgentStoreService` (25),
 *   `DashboardService` (92), and `AiService` (8).
 */

import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { GrokServiceId } from '@shared/ipc'

export const GROK_API_BASE = 'https://api2.cursor.sh'
export const GROK_SERVICE = 'aiserver.v1.GrokBotService'

export const GROK_SERVICES: Record<GrokServiceId, string> = {
  grokbot: 'aiserver.v1.GrokBotService',
  sandbox: 'aiserver.v1.SandBoxService',
  agentstore: 'aiserver.v1.AgentStoreService',
  dashboard: 'aiserver.v1.DashboardService',
  ai: 'aiserver.v1.AiService'
}

/** Match Grok Bot.app 1.1.0 sand client identity (`main-core.cjs`). */
export const GROK_SAND_CLIENT_VERSION = '1.1.0'

/** Protobuf enum values from `0.79.3` `proto.cjs`. */
export const GROK_USER_MESSAGE_INITIATOR = {
  UNSPECIFIED: 0,
  USER: 1,
  CARD_ACTION: 4
} as const

export const GROK_MESSAGE_SOURCE = {
  UNSPECIFIED: 0,
  DESKTOP: 1,
  IOS: 2,
  ANDROID: 3,
  WEB: 4
} as const

export const GROK_SEND_SOURCE = {
  UNSPECIFIED: 0,
  CHAT: 1,
  QUICK_BAR: 2
} as const

export const GROK_CARD_ANSWER_KIND: Record<string, number> = {
  UNSPECIFIED: 0,
  APPROVE: 1,
  DENY: 2,
  CHOOSE: 3,
  SUBMIT: 4,
  ALWAYS: 5,
  ESCALATE: 8
}

export interface GrokMainAuthLike {
  accessToken: string
  teamId?: string
  machineId?: string
  accountSlot?: string
}

export interface GrokConnectClientOptions {
  baseUrl?: string
  auth: GrokMainAuthLike
  fetchImpl?: typeof fetch
  clientVersion?: string
  clientOs?: string
  ghostMode?: boolean
  timeZone?: string
  /** Sand box namespace header (`main-core.cjs` defaults to `"prod"`). */
  boxNamespace?: string
  /** Override checksum for this client instance. */
  checksumFn?: (machineId: string) => string
}

export class GrokConnectError extends Error {
  readonly status: number
  readonly code?: string
  readonly body: string

  constructor(status: number, body: string, code?: string) {
    super(`Grok ConnectRPC ${status}${code ? ` (${code})` : ''}: ${body.slice(0, 240)}`)
    this.name = 'GrokConnectError'
    this.status = status
    this.body = body
    this.code = code
  }
}

type ChecksumFn = (machineId: string) => string

/** asar F9t — mutates the 6-byte timestamp buffer in place. */
export function obfuscateTimestampBytes(bytes: Uint8Array): Uint8Array {
  let t = 165
  for (let n = 0; n < bytes.length; n++) {
    bytes[n] = (((bytes[n]! ^ t) + (n % 256)) & 255) as number
    t = bytes[n]!
  }
  return bytes
}

/**
 * asar createCursorChecksum / T_.
 * Only call when machineId is non-empty — otherwise omit the header.
 */
export function createCursorChecksum(machineId: string, nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs / 1e6)
  const n = new Uint8Array([
    (ts >> 40) & 255,
    (ts >> 32) & 255,
    (ts >> 24) & 255,
    (ts >> 16) & 255,
    (ts >> 8) & 255,
    ts & 255
  ])
  obfuscateTimestampBytes(n)
  return Buffer.from(n).toString('base64url') + machineId
}

let globalChecksumFn: ChecksumFn = createCursorChecksum

/** Plug in an alternate checksum without rewriting callers. */
export function setGrokChecksumCalculator(fn: ChecksumFn): void {
  globalChecksumFn = fn
}

export function getGrokChecksumCalculator(): ChecksumFn {
  return globalChecksumFn
}

/** @deprecated use createCursorChecksum — kept as alias for older imports. */
export function approximateCursorChecksum(machineId: string): string {
  return globalChecksumFn(machineId)
}

/** Exact UA from Grok Bot.app 0.79.3 `main-core.cjs` `cwe(e)` (no Chrome/Electron tokens). */
export function sandUserAgent(
  clientOs: string,
  clientVersion: string = GROK_SAND_CLIENT_VERSION
): string {
  const osUa =
    clientOs === 'darwin'
      ? '(Macintosh; Intel Mac OS X 10_15_7)'
      : clientOs === 'win32'
        ? '(Windows NT 10.0; Win64; x64)'
        : clientOs === 'linux'
          ? '(X11; Linux x86_64)'
          : `(compatible; ${clientOs})`
  return `Mozilla/5.0 ${osUa} AppleWebKit/537.36 (KHTML, like Gecko) Sand/${clientVersion} Safari/537.36`
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function buildGrokConnectHeaders(opts: GrokConnectClientOptions): Record<string, string> {
  const checksum = opts.checksumFn ?? globalChecksumFn
  const clientOs = opts.clientOs ?? processPlatform()
  const clientVersion = opts.clientVersion ?? GROK_SAND_CLIENT_VERSION
  const reqId = randomUUID()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    authorization: `Bearer ${opts.auth.accessToken}`,
    'user-agent': sandUserAgent(clientOs, clientVersion),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': clientVersion,
    'x-cursor-client-os': clientOs,
    'x-cursor-client-arch': process.arch === 'x64' ? 'x64' : 'arm64',
    'x-cursor-client-device-type': 'desktop',
    'x-ghost-mode': opts.ghostMode === true ? 'true' : 'false',
    'x-request-id': reqId,
    'x-amzn-trace-id': `Root=${reqId}`,
    'x-cursor-timezone': opts.timeZone || defaultTimeZone(),
    'x-sand-box-namespace': opts.boxNamespace || 'prod'
  }
  if (opts.auth.teamId) headers['x-cursor-team-id'] = String(opts.auth.teamId)
  const machineId = opts.auth.machineId?.trim()
  if (machineId) headers['x-cursor-checksum'] = checksum(machineId)
  return headers
}

function processPlatform(): string {
  const p = process.platform
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p
  return 'darwin'
}

export interface UploadedAttachmentRef {
  alias: string
  fileName: string
  sizeBytes: number
  contentType: string
}

export class GrokConnectClient {
  private readonly baseUrl: string
  private readonly opts: GrokConnectClientOptions
  private readonly fetchImpl: typeof fetch

  get accessToken(): string { return this.opts.auth.accessToken }
  get machineId(): string | undefined { return this.opts.auth.machineId }

  constructor(opts: GrokConnectClientOptions) {
    this.opts = opts
    this.baseUrl = (opts.baseUrl ?? GROK_API_BASE).replace(/\/$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async unary<TReq extends object, TRes = unknown>(
    method: string,
    body: TReq,
    service: GrokServiceId = 'grokbot',
    signal?: AbortSignal
  ): Promise<TRes> {
    const svcName = GROK_SERVICES[service] ?? GROK_SERVICE
    const url = `${this.baseUrl}/${svcName}/${method}`
    const maxAttempts = 3
    let lastErr: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.round(
          350 * Math.pow(1.8, attempt - 1) * (0.85 + Math.random() * 0.3)
        )
        await delay(delayMs, undefined, { signal })
      }
      signal?.throwIfAborted()
      try {
        const deadline = AbortSignal.timeout(25_000)
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: buildGrokConnectHeaders(this.opts),
          body: JSON.stringify(body ?? {}),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline
        })
        const text = await res.text()
        if (!res.ok) {
          let code: string | undefined
          try {
            const parsed = JSON.parse(text) as { code?: string; error?: { code?: string } }
            code = parsed.code ?? parsed.error?.code
          } catch {
            /* plain body */
          }
          const err = new GrokConnectError(res.status, text, code)
          if (
            (res.status === 429 ||
              res.status === 502 ||
              res.status === 503 ||
              res.status === 504) &&
            attempt + 1 < maxAttempts
          ) {
            lastErr = err
            continue
          }
          throw err
        }
        if (!text) return {} as TRes
        try {
          return JSON.parse(text) as TRes
        } catch {
          throw new GrokConnectError(res.status, `non-JSON response: ${text.slice(0, 200)}`)
        }
      } catch (err) {
        lastErr = err
        if (signal?.aborted || err instanceof GrokConnectError) throw err
        if (attempt + 1 >= maxAttempts) throw err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Grok ConnectRPC request failed')
  }

  listAgents(req: { role?: string; includeTeamAgents?: boolean } = {}) {
    return this.unary<Record<string, unknown>>('ListGrokBotAgents', {
      ...(req.role ? { role: req.role } : {}),
      include_team_agents: req.includeTeamAgents ?? true,
      added_team_agents_only: false
    })
  }

  listAgentStatuses(req: { agentIds?: string[] } = {}) {
    return this.unary('ListGrokBotAgentStatuses', {
      agent_ids: req.agentIds ?? []
    })
  }

  /**
   * Proto-accurate `SendGrokBotUserMessage` (0.79.3):
   * - `initiator`: 1 (`GROK_BOT_USER_MESSAGE_INITIATOR_USER`)
   * - `source`: 1 (`GROK_BOT_MESSAGE_SOURCE_DESKTOP`)
   * - `send_source`: 1 (`GROK_BOT_SEND_SOURCE_CHAT`)
   * - `renders_mcp_elicitation_forms`: true
   * BotArk does not render the shopping/travel cards advertised by Sand.
   */
  sendUserMessage(req: {
    agentId: string
    messageId: string
    text: string
    sessionId?: string
    machineId?: string
    sentAtMs?: number
    replyToId?: string
    replyQuote?: string
    attachmentPaths?: string[]
    attachmentNames?: string[]
  }, signal?: AbortSignal) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>('SendGrokBotUserMessage', {
      agent_id: req.agentId,
      message_id: req.messageId,
      text: req.text,
      sent_at_ms: req.sentAtMs ?? Date.now(),
      is_fork: false,
      ...(req.replyToId ? { reply_to_id: req.replyToId } : {}),
      ...(req.replyQuote ? { reply_quote: req.replyQuote } : {}),
      attachment_paths: req.attachmentPaths ?? [],
      attachment_names: req.attachmentNames ?? [],
      session_id: req.sessionId ?? '',
      machine_id: req.machineId ?? this.opts.auth.machineId ?? '',
      initiator: GROK_USER_MESSAGE_INITIATOR.USER,
      source: GROK_MESSAGE_SOURCE.DESKTOP,
      send_source: GROK_SEND_SOURCE.CHAT,
      renders_mcp_elicitation_forms: true
    }, 'grokbot', signal)
  }

  getSendStatus(req: { agentId: string; messageId: string; sessionId?: string }, signal?: AbortSignal) {
    return this.unary('GetGrokBotSendStatus', {
      agent_id: req.agentId,
      message_id: req.messageId,
      session_id: req.sessionId ?? ''
    }, 'grokbot', signal)
  }

  listTranscriptEntries(req: {
    agentId: string
    sessionId?: string
    limit?: number
    beforeSeq?: string
  }, signal?: AbortSignal) {
    return this.unary('ListGrokBotTranscriptEntries', {
      agent_id: req.agentId,
      session_id: req.sessionId ?? '',
      limit: req.limit ?? 50,
      ...(req.beforeSeq ? { before_seq: req.beforeSeq } : {})
    }, 'grokbot', signal)
  }

  // ---------------- Attachments & Store Files ----------------

  async uploadAttachment(req: {
    agentId: string
    sessionId?: string
    fileName: string
    mimeType?: string
    bytes: Buffer
  }, signal?: AbortSignal): Promise<UploadedAttachmentRef> {
    const sha256Hex = createHash('sha256').update(req.bytes).digest('hex')
    const begin = await this.unary<Record<string, unknown>, Record<string, unknown>>(
      'BeginGrokBotAttachmentUpload',
      {
        agent_id: req.agentId,
        ...(req.sessionId ? { session_id: req.sessionId } : {}),
        file_name: req.fileName,
        size_bytes: String(req.bytes.byteLength),
        supports_store_attachment_refs: true,
        supports_multipart: true,
        sha256_hex: sha256Hex
      }, 'grokbot', signal
    )

    const modeRaw = begin['mode']
    const refusalRaw = begin['refusal']
    const isRefused =
      modeRaw === 4 ||
      modeRaw === 'GROK_BOT_ATTACHMENT_UPLOAD_MODE_REFUSED' ||
      (refusalRaw != null &&
        refusalRaw !== 0 &&
        refusalRaw !== 'GROK_BOT_ATTACHMENT_UPLOAD_REFUSAL_UNSPECIFIED')
    if (isRefused) {
      throw new Error(`Grok attachment upload refused: ${String(refusalRaw || modeRaw)}`)
    }

    // Fallback when server directs upload to agent file store (`USE_BOX` = 1)
    if (modeRaw === 1 || modeRaw === 'GROK_BOT_ATTACHMENT_UPLOAD_MODE_USE_BOX') {
      const boxFile = await this.uploadAgentFile({
        agentId: req.agentId,
        fileName: req.fileName,
        contentType: req.mimeType || 'application/octet-stream',
        bytes: req.bytes
      }, signal)
      return {
        alias: boxFile.path || boxFile.name,
        fileName: req.fileName,
        sizeBytes: req.bytes.byteLength,
        contentType: req.mimeType || 'application/octet-stream'
      }
    }

    const uploadToken = String(begin['uploadToken'] ?? begin['upload_token'] ?? '')
    if (!uploadToken) {
      throw new Error('BeginGrokBotAttachmentUpload returned no upload_token')
    }

    const putTarget = (begin['put'] ?? null) as
      | { url?: string; headers?: Record<string, string> }
      | null
    const isMultipart =
      modeRaw === 3 || modeRaw === 'GROK_BOT_ATTACHMENT_UPLOAD_MODE_MULTIPART'

    if (isMultipart) {
      const partSize = Math.max(
        1024 * 1024,
        Number(begin['partSizeBytes'] ?? begin['part_size_bytes'] ?? 5 * 1024 * 1024)
      )
      const partChecksums: Array<{ part_number: number; checksum_sha256: string }> = []
      for (let offset = 0, partNum = 1; offset < req.bytes.byteLength; offset += partSize, partNum++) {
        const slice = req.bytes.subarray(offset, Math.min(offset + partSize, req.bytes.byteLength))
        const sumB64 = createHash('sha256').update(slice).digest('base64')
        partChecksums.push({ part_number: partNum, checksum_sha256: sumB64 })
      }
      const presigned = await this.unary<Record<string, unknown>, Record<string, unknown>>(
        'PresignGrokBotAttachmentUploadParts',
        {
          upload_token: uploadToken,
          parts: partChecksums
        }, 'grokbot', signal
      )
      const parts = Array.isArray(presigned['parts'])
        ? (presigned['parts'] as Array<Record<string, unknown>>)
        : []
      for (const p of parts) {
        const partNumber = Number(p['partNumber'] ?? p['part_number'] ?? 1)
        const offset = Number(
          p['offsetBytes'] ?? p['offset_bytes'] ?? (partNumber - 1) * partSize
        )
        const size = Number(
          p['sizeBytes'] ??
            p['size_bytes'] ??
            Math.min(partSize, req.bytes.byteLength - offset)
        )
        const target = (p['target'] ?? {}) as { url?: string; headers?: Record<string, string> }
        if (!target.url) throw new Error(`Missing presigned URL for part ${partNumber}`)
        const putRes = await this.fetchImpl(target.url, {
          method: 'PUT',
          headers: { ...(target.headers ?? {}) },
          body: req.bytes.subarray(offset, offset + size),
          signal
        })
        if (!putRes.ok) {
          throw new Error(`Attachment multipart PUT failed (${putRes.status})`)
        }
      }
    } else {
      let target = putTarget
      if (!target?.url) {
        const sumB64 = createHash('sha256').update(req.bytes).digest('base64')
        const presigned = await this.unary<Record<string, unknown>, Record<string, unknown>>(
          'PresignGrokBotAttachmentUploadParts',
          {
            upload_token: uploadToken,
            parts: [{ part_number: 1, checksum_sha256: sumB64 }]
          }, 'grokbot', signal
        )
        target = (presigned['put'] ??
          (Array.isArray(presigned['parts'])
            ? (presigned['parts'][0] as Record<string, unknown> | undefined)?.['target']
            : undefined)) as { url?: string; headers?: Record<string, string> } | null
      }
      if (!target?.url) throw new Error('Missing presigned PUT URL for attachment upload')
      const headers: Record<string, string> = { ...(target.headers ?? {}) }
      if (
        req.mimeType &&
        !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
      ) {
        headers['content-type'] = req.mimeType
      }
      const putRes = await this.fetchImpl(target.url, {
        method: 'PUT',
        headers,
        body: req.bytes,
        signal
      })
      if (!putRes.ok) {
        throw new Error(`Attachment PUT failed (${putRes.status})`)
      }
    }

    const done = await this.unary<Record<string, unknown>, Record<string, unknown>>(
      'CompleteGrokBotAttachmentUpload',
      { upload_token: uploadToken }, 'grokbot', signal
    )
    const doneRefusal = done['refusal']
    if (
      doneRefusal != null &&
      doneRefusal !== 0 &&
      doneRefusal !== 'GROK_BOT_ATTACHMENT_UPLOAD_REFUSAL_UNSPECIFIED'
    ) {
      throw new Error(`CompleteGrokBotAttachmentUpload refused: ${String(doneRefusal)}`)
    }
    const alias = String(done['alias'] ?? '')
    if (!alias) throw new Error('CompleteGrokBotAttachmentUpload returned empty alias')
    return {
      alias,
      fileName: String(done['fileName'] ?? done['file_name'] ?? req.fileName),
      sizeBytes: Number(done['sizeBytes'] ?? done['size_bytes'] ?? req.bytes.byteLength),
      contentType: String(
        done['contentType'] ?? done['content_type'] ?? req.mimeType ?? 'application/octet-stream'
      )
    }
  }

  async uploadAgentFile(req: {
    agentId: string
    fileName: string
    contentType?: string
    bytes: Buffer
  }, signal?: AbortSignal): Promise<{ name: string; path: string }> {
    const sha256Hex = createHash('sha256').update(req.bytes).digest('hex')
    const contentType = req.contentType || 'application/octet-stream'
    const begin = await this.unary<Record<string, unknown>, Record<string, unknown>>(
      'BeginGrokBotAgentFileUpload',
      {
        agent_id: req.agentId,
        file_name: req.fileName,
        size_bytes: String(req.bytes.byteLength),
        sha256_hex: sha256Hex,
        content_type: contentType
      }, 'grokbot', signal
    )
    const uploadToken = String(begin['uploadToken'] ?? begin['upload_token'] ?? '')
    const putUrl = String(begin['url'] ?? '')
    if (!uploadToken || !putUrl) {
      throw new Error('BeginGrokBotAgentFileUpload missing uploadToken or url')
    }
    const headers: Record<string, string> = {
      ...((begin['headers'] as Record<string, string> | undefined) ?? {})
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = contentType
    }
    const putRes = await this.fetchImpl(putUrl, {
      method: 'PUT',
      headers,
      body: req.bytes,
      signal
    })
    if (!putRes.ok) {
      throw new Error(`Agent file PUT failed (${putRes.status})`)
    }
    const finished = await this.unary<Record<string, unknown>, Record<string, unknown>>(
      'FinishGrokBotAgentFileUpload',
      {
        agent_id: req.agentId,
        upload_token: uploadToken
      }, 'grokbot', signal
    )
    const fileObj = (finished['file'] ?? {}) as Record<string, unknown>
    const finalName = String(
      fileObj['name'] ?? begin['finalName'] ?? begin['final_name'] ?? req.fileName
    )
    return {
      name: finalName,
      path: String(fileObj['path'] ?? finalName)
    }
  }

  resolveAttachmentReads(req: { agentId: string; sessionId?: string; paths: string[] }, signal?: AbortSignal) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>(
      'ResolveGrokBotAttachmentReads',
      {
        agent_id: req.agentId,
        ...(req.sessionId ? { session_id: req.sessionId } : {}),
        paths: req.paths
      }, 'grokbot', signal
    )
  }

  // ---------------- Interactive Widgets, Cards, Approvals & Forms ----------------

  respondWidget(req: { agentId: string; entryId: string; value: string; sessionId?: string }) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>('RespondGrokBotWidget', {
      agent_id: req.agentId,
      entry_id: req.entryId,
      value: req.value,
      session_id: req.sessionId ?? ''
    })
  }

  dismissWidget(req: { agentId: string; entryId: string; sessionId?: string }) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>('DismissGrokBotWidget', {
      agent_id: req.agentId,
      entry_id: req.entryId,
      session_id: req.sessionId ?? ''
    })
  }

  getMessagingCard(cardId: string) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>(
      'GetGrokBotMessagingCard',
      { card_id: cardId }
    )
  }

  answerMessagingCard(req: {
    cardId: string
    version: number
    answer: string | number
    optionId?: string
    values?: Record<string, string>
  }) {
    const answerNum =
      typeof req.answer === 'number'
        ? req.answer
        : (GROK_CARD_ANSWER_KIND[req.answer] ?? GROK_CARD_ANSWER_KIND.APPROVE)
    return this.unary<Record<string, unknown>, Record<string, unknown>>(
      'AnswerGrokBotMessagingCard',
      {
        card_id: req.cardId,
        version: req.version,
        answer: answerNum,
        option_id: req.optionId ?? '',
        values: req.values ?? {}
      }
    )
  }

  submitUserForm(req: {
    agentId: string
    entryId: string
    values: Record<string, string>
    sessionId?: string
    saveToVault?: boolean
  }) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>('SubmitGrokBotUserForm', {
      agent_id: req.agentId,
      entry_id: req.entryId,
      values: req.values,
      session_id: req.sessionId ?? '',
      platform: 1, // DESKTOP
      save_to_vault: req.saveToVault === true,
      vault_target: req.saveToVault ? 1 : 0
    })
  }

  submitSecret(req: { agentId: string; entryId: string; value: string; sessionId?: string }) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>('SubmitGrokBotSecret', {
      agent_id: req.agentId,
      entry_id: req.entryId,
      value: req.value,
      session_id: req.sessionId ?? ''
    })
  }

  reactToMessage(req: { agentId: string; entryId: string; emoji: string; sessionId?: string }) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>('ReactToGrokBotMessage', {
      agent_id: req.agentId,
      entry_id: req.entryId,
      emoji: req.emoji,
      session_id: req.sessionId ?? ''
    })
  }

  searchTranscripts(req: {
    query: string
    target?: 'MESSAGES' | 'FILES'
    agentId?: string
    limit?: number
    continuation?: string
  }) {
    return this.unary<Record<string, unknown>, Record<string, unknown>>(
      'SearchGrokBotTranscripts',
      {
        target: req.target === 'FILES' ? 2 : 1,
        query: req.query,
        limit: req.limit ?? 25,
        ...(req.agentId ? { agent_id: req.agentId } : {}),
        ...(req.continuation ? { continuation: req.continuation } : {})
      }
    )
  }

  resolveAutoReview(req: {
    agentId: string
    requestId: string
    resolution: number
    sessionId?: string
    approvalPlatform?: string
    approvedCommand?: string
  }) {
    return this.unary('ResolveGrokBotAutoReviewApproval', {
      agent_id: req.agentId,
      request_id: req.requestId,
      resolution: req.resolution,
      approval_platform: req.approvalPlatform || 'desktop',
      ...(req.approvedCommand ? { approved_command: req.approvedCommand } : {}),
      ...(req.sessionId ? { session_id: req.sessionId } : {})
    })
  }

  resolveLocalTool(req: {
    agentId: string
    entryId?: string
    requestId: string
    resolution: number
    sessionId?: string
  }) {
    return this.unary('ResolveGrokBotLocalToolPermission', {
      agent_id: req.agentId,
      entry_id: req.entryId ?? req.requestId,
      request_id: req.requestId,
      resolution: req.resolution,
      ...(req.sessionId ? { session_id: req.sessionId } : {})
    })
  }

  resolveConnectorGrant(req: {
    agentId: string
    entryId?: string
    requestId: string
    resolution: number
    sessionId?: string
  }) {
    return this.unary('ResolveGrokBotConnectorGrant', {
      agent_id: req.agentId,
      request_id: req.requestId,
      resolution: req.resolution,
      ...(req.sessionId ? { session_id: req.sessionId } : {}),
      ...(req.entryId ? { entry_id: req.entryId } : {})
    })
  }

  resolveVirtualCard(req: {
    agentId: string
    entryId?: string
    requestId: string
    resolution: number
    paymentMethodId?: string
  }) {
    return this.unary('ResolveGrokBotVirtualCardApproval', {
      agent_id: req.agentId,
      entry_id: req.entryId ?? req.requestId,
      request_id: req.requestId,
      resolution: req.resolution,
      ...(req.paymentMethodId ? { payment_method_id: req.paymentMethodId } : {}),
      pay_another_way: false
    })
  }

  // ---------------- Server-Streaming Watch ----------------

  /**
   * Server-streaming `WatchGrokBotTranscripts` (Connect JSON envelopes).
   * Yields decoded JSON objects from the stream until aborted or ended.
   */
  async *watchTranscripts(
    req: {
      cursors: Array<{
        agent_id: string
        generation?: number
        after_updated_seq?: string | number
        session_id?: string
      }>
      includeUnlistedAgents?: boolean
      inlineBodyMaxBytes?: number
    },
    signal?: AbortSignal
  ): AsyncGenerator<Record<string, unknown>, void, void> {
    signal?.throwIfAborted()
    const url = `${this.baseUrl}/${GROK_SERVICE}/WatchGrokBotTranscripts`
    const headers = {
      ...buildGrokConnectHeaders(this.opts),
      'content-type': 'application/connect+json',
      accept: 'application/connect+json'
    }
    const body = {
      cursors: req.cursors,
      include_unlisted_agents: req.includeUnlistedAgents ?? true,
      inline_body_max_bytes: req.inlineBodyMaxBytes ?? 262_144
    }
    const payload = new TextEncoder().encode(JSON.stringify(body))
    const envelope = new Uint8Array(5 + payload.length)
    new DataView(envelope.buffer).setUint32(1, payload.length)
    envelope.set(payload, 5)
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: envelope,
      signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let code: string | undefined
      try {
        const parsed = JSON.parse(text) as { code?: string }
        code = parsed.code
      } catch {
        /* ignore */
      }
      throw new GrokConnectError(res.status, text, code)
    }
    if (!res.body) return
    const reader = res.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => undefined) }
    signal?.addEventListener('abort', cancel, { once: true })
    const decoder = new TextDecoder()
    let buffer = Buffer.alloc(0)
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        signal?.throwIfAborted()
        if (done) break
        buffer = Buffer.concat([buffer, Buffer.from(value)])
        while (buffer.length >= 5) {
          signal?.throwIfAborted()
          const flags = buffer[0]!
          const len = buffer.readUInt32BE(1)
          if (buffer.length < 5 + len) break
          const payload = buffer.subarray(5, 5 + len)
          buffer = buffer.subarray(5 + len)
          if (flags & 0x02) {
            if (payload.length) {
              try {
                const trailer = JSON.parse(payload.toString('utf8')) as {
                  error?: { code?: string; message?: string }
                }
                if (trailer.error) {
                  throw new GrokConnectError(
                    0,
                    trailer.error.message ?? 'watch ended with error',
                    trailer.error.code
                  )
                }
              } catch (error) {
                if (error instanceof GrokConnectError) throw error
              }
            }
            return
          }
          if (!payload.length) continue
          try {
            yield JSON.parse(decoder.decode(payload)) as Record<string, unknown>
          } catch {
            /* skip malformed frame */
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancel)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
