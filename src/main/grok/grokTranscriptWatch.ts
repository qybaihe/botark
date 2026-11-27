import type { GrokConnectClient } from './connectClient'
import { asObj, parseGrokTranscriptEntry, str, type ParsedGrokTranscriptEntry } from './grokTranscriptDecoder'

export function grokSessionKey(agentId: string, sessionId: string): string {
  return JSON.stringify([agentId, sessionId])
}

export function grokSeq(value: unknown): bigint {
  try { return BigInt(str(value) || '0') }
  catch { return 0n }
}

export function matchesGrokScope(row: Record<string, unknown>, agentId: string, sessionId: string, inherit = false): boolean {
  const agent = row['agentId']
  const wireAgent = row['agent_id']
  const session = row['sessionId']
  const wireSession = row['session_id']
  return (inherit || agent !== undefined || wireAgent !== undefined) &&
    (agent === undefined || agent === agentId) && (wireAgent === undefined || wireAgent === agentId) &&
    (inherit || sessionId === '' || session !== undefined || wireSession !== undefined) &&
    (session === undefined || session === sessionId) && (wireSession === undefined || wireSession === sessionId)
}

export function grokRows(frame: Record<string, unknown>): Record<string, unknown> | null {
  return asObj(frame['rows'] ?? frame['Rows']) ?? (Array.isArray(frame['entries']) ? frame : null)
}

export function transcriptEntries(value: unknown, agentId: string, sessionId: string): ParsedGrokTranscriptEntry[] {
  const entries = asObj(value)?.['entries']
  if (!Array.isArray(entries)) return []
  return entries.flatMap((value) => {
    const row = asObj(value)
    if (!row || !matchesGrokScope(row, agentId, sessionId, true)) return []
    const parsed = parseGrokTranscriptEntry(row, agentId, sessionId)
    return parsed ? [parsed] : []
  })
}

export function compareGrokEntries(a: ParsedGrokTranscriptEntry, b: ParsedGrokTranscriptEntry): number {
  const difference = grokSeq(a.seq) - grokSeq(b.seq)
  if (difference !== 0n) return difference < 0n ? -1 : 1
  return a.createdAtMs - b.createdAtMs
}

export function nextTranscriptPage(page: Record<string, unknown>, entries: ParsedGrokTranscriptEntry[], before?: string): string | undefined {
  if (page['hasMore'] === false || page['has_more'] === false) return undefined
  const explicit = grokSeq(page['nextBeforeSeq'] ?? page['next_before_seq'])
  let oldest = 0n
  for (const entry of entries) {
    const seq = grokSeq(entry.seq)
    if (seq > 0n && (oldest === 0n || seq < oldest)) oldest = seq
  }
  const next = explicit > 0n ? explicit : oldest
  return next > 1n && (!before || next < grokSeq(before)) ? next.toString() : undefined
}

export function isGrokSendAnchor(entry: ParsedGrokTranscriptEntry, messageId: string): boolean {
  return entry.role === 'user' && (entry.entryId === messageId || entry.clientNonce === messageId)
}

export async function readGrokTranscriptGap(
  client: GrokConnectClient,
  scope: { agentId: string; sessionId: string },
  opts: { floor: bigint; signal: AbortSignal; stopAt?: (entry: ParsedGrokTranscriptEntry) => boolean; maxPages?: number }
): Promise<{ entries: ParsedGrokTranscriptEntry[]; generation?: number; watermark: string }> {
  const entries: ParsedGrokTranscriptEntry[] = []
  let generation: number | undefined
  let watermark = '0'
  let beforeSeq: string | undefined
  let pagesLeft = opts.maxPages ?? Infinity
  do {
    opts.signal.throwIfAborted()
    const page = asObj(await client.listTranscriptEntries({ ...scope, beforeSeq, limit: 40 }, opts.signal)) ?? {}
    opts.signal.throwIfAborted()
    const gen = Number(page['generation'] ?? generation)
    if (Number.isSafeInteger(gen) && gen >= 0) {
      if (generation !== undefined && generation !== gen) throw new Error('Grok transcript generation changed during backfill')
      generation = gen
    }
    const pageWatermark = grokSeq(page['currentUpdatedSeq'] ?? page['current_updated_seq'] ?? page['updatedSeq'] ?? page['updated_seq'])
    if (pageWatermark > grokSeq(watermark)) watermark = pageWatermark.toString()
    const batch = transcriptEntries(page, scope.agentId, scope.sessionId)
    entries.push(...batch)
    if (batch.some((entry) => {
      const seq = grokSeq(entry.seq)
      return opts.stopAt?.(entry) || (seq > 0n && seq <= opts.floor)
    })) break
    beforeSeq = nextTranscriptPage(page, batch, beforeSeq)
  } while (beforeSeq && --pagesLeft > 0)
  return { entries: entries.sort(compareGrokEntries), generation, watermark }
}

function fingerprint(entry: ParsedGrokTranscriptEntry): string {
  return JSON.stringify([
    entry.role, entry.text, entry.widgets, entry.richWidgets, entry.media, entry.toolCall,
    entry.approval, entry.settledApprovalKey
  ])
}

interface EntryRevision {
  seq: bigint
  revision: bigint
  streaming: boolean
  fingerprint?: string
  bodyOmitted?: boolean
  deleted?: boolean
}

export class GrokEntryRevisions {
  private readonly seen = new Map<string, EntryRevision>()

  clear(): void { this.seen.clear() }

  check(entry: ParsedGrokTranscriptEntry): EntryRevision | undefined {
    const seq = grokSeq(entry.updatedSeq)
    const revision = grokSeq(entry.revision)
    const previous = this.seen.get(entry.entryId)
    if (previous && (seq < previous.seq || (seq === previous.seq && revision < previous.revision))) return undefined
    const content = fingerprint(entry)
    if (previous && seq === previous.seq && revision === previous.revision &&
      (previous.deleted || (!previous.streaming && entry.isStreaming) || (!previous.bodyOmitted && entry.bodyOmitted) ||
        (previous.streaming === entry.isStreaming &&
          (previous.fingerprint === content || ((seq > 0n || revision > 0n) && !entry.isStreaming && !previous.bodyOmitted))))) return undefined
    return { seq, revision, streaming: entry.isStreaming, fingerprint: content, bodyOmitted: entry.bodyOmitted }
  }

  accept(entry: ParsedGrokTranscriptEntry): boolean {
    const revision = this.check(entry)
    if (!revision) return false
    this.remember(entry.entryId, revision)
    return true
  }

  remove(id: string, updatedSeq: string): boolean {
    const seq = grokSeq(updatedSeq)
    const previous = this.seen.get(id)
    if (previous && (seq < previous.seq || (seq === previous.seq && previous.deleted))) return false
    this.remember(id, { seq, revision: 0n, streaming: false, deleted: true })
    return true
  }

  remember(id: string, value: EntryRevision): void {
    this.seen.delete(id)
    this.seen.set(id, value)
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!)
  }
}

export async function hydrateGrokEntry(
  client: GrokConnectClient, agentId: string, sessionId: string, stub: ParsedGrokTranscriptEntry, signal?: AbortSignal
): Promise<ParsedGrokTranscriptEntry> {
  if (!stub.bodyOmitted) return stub
  const seq = grokSeq(stub.seq)
  try {
    const page = await client.listTranscriptEntries({
      agentId, sessionId, beforeSeq: seq > 0n ? (seq + 1n).toString() : undefined, limit: 5
    }, signal)
    signal?.throwIfAborted()
    const match = transcriptEntries(page, agentId, sessionId).find((entry) => !entry.bodyOmitted && entry.entryId === stub.entryId)
    if (match && grokSeq(match.updatedSeq) >= grokSeq(stub.updatedSeq)) {
      return { ...match, clientNonce: match.clientNonce ?? stub.clientNonce }
    }
  } catch {
    signal?.throwIfAborted()
  }
  return stub
}
