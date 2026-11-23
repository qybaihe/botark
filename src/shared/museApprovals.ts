/**
 * Shared Meta Muse / Sentinel approval parsing, normalization, and RPC payload
 * builders. Pure TypeScript (no Electron/DOM/Node deps) so main, adapters, and
 * renderer all use the exact same source of truth.
 */

export type ApprovalDecision =
  | 'allow_once'
  | 'allow_session'
  | 'allow_always'
  | 'deny'
  | 'deny_always'

export interface MuseApprovalOption {
  kind: ApprovalDecision | string
  /** Server-provided localized button label (`label_text`), if non-empty. */
  label?: string
  /** Structured label kind from `decision_options[].label.kind` (e.g. `allow_always_scoped`). */
  labelKind?: string
  /** Scope to echo in `always_scope` / `allow_always_scope` (e.g. `destination_domain`, `entity`, `connector_all_actions`, `destination`, `recipient`). */
  scope?: string
  /** Optional external URL opened by this option (`decision_options[].opens_url`). */
  opensUrl?: string
}

export interface MuseApproval {
  id: string
  status: 'pending' | 'approved' | 'denied' | 'timed_out' | string
  title: string
  /** True when `title` came from an explicit server question (e.g. `display.permission_question.text` or `display.title`). */
  hasExplicitTitle?: boolean
  detail?: string
  approvalType?: string
  /** Destination host for network/connector/upload cards, e.g. github.com. */
  host?: string
  /** Server-offered buttons (decision_options). Empty = allow_once/allow_always/deny. */
  decisionOptions?: ApprovalDecision[]
  /** Full parsed decision options (preserves per-button `label_text`, `scope`, and `opens_url`). */
  decisionOptionDetails?: MuseApprovalOption[]
  /** Server reason / explanation text for the expandable detail. */
  reason?: string
  /** Raw payload for debugging / richer UI. */
  raw?: unknown
}

const TERMINAL_STATUSES = new Set(['approved', 'denied', 'timed_out', 'expired', 'cancelled', 'canceled'])

export const KNOWN_APPROVAL_DECISIONS = new Set<ApprovalDecision>([
  'allow_once',
  'allow_session',
  'allow_always',
  'deny',
  'deny_always'
])

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = nonEmptyStr(v)
    if (s) return s
  }
  return undefined
}

function extractPayloadVariants(raw: Record<string, unknown>): Record<string, unknown>[] {
  const payload = asObj(raw['payload'])
  if (!payload) return []
  const variants: Record<string, unknown>[] = []
  for (const key of [
    'outgoing_media_payload',
    'connector_payload',
    'network_payload',
    'browser_checkout_payload',
    'shopify_checkout_payload',
    'stripe_link_checkout_payload',
    'device_payload'
  ]) {
    const sub = asObj(payload[key])
    if (sub) variants.push(sub)
  }
  for (const [key, val] of Object.entries(payload)) {
    if (!key.endsWith('_payload')) continue
    const sub = asObj(val)
    if (sub && !variants.includes(sub)) variants.push(sub)
  }
  return variants
}

function isSpaceReaderEligible(raw: Record<string, unknown> | undefined): boolean {
  if (!raw) return false
  if (raw['space_reader_grant_eligible'] === true) return true
  for (const sub of extractPayloadVariants(raw)) {
    if (sub['space_reader_grant_eligible'] === true) return true
  }
  return false
}

/**
 * Extract all pending Sentinel approval records from legacy (`pending`),
 * snapshot (`pending_approvals`), combined (`{ pending: [], pending_approvals: [...] }`),
 * wrapped (`{ result / data }`), or raw array responses without letting an empty
 * `pending: []` shadow `pending_approvals`.
 */
export function extractRawApprovalItems(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return []
  if (Array.isArray(raw)) {
    const out: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      const rec = asObj(item)
      if (!rec) continue
      const status = nonEmptyStr(rec['status'])?.toLowerCase()
      if (status && TERMINAL_STATUSES.has(status)) continue
      const id = firstStr(rec['approval_id'], rec['id']) ?? ''
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      out.push(rec)
    }
    return out
  }
  const root = raw as Record<string, unknown>
  const containers: Record<string, unknown>[] = [root]
  for (const wrapperKey of ['result', 'data']) {
    const inner = asObj(root[wrapperKey])
    if (inner) containers.push(inner)
  }

  const combined: Record<string, unknown>[] = []
  const seenIds = new Set<string>()

  const pushArray = (candidate: unknown) => {
    if (!Array.isArray(candidate) || candidate.length === 0) return
    for (const item of candidate) {
      const rec = asObj(item)
      if (!rec) continue
      const status = nonEmptyStr(rec['status'])?.toLowerCase()
      if (status && TERMINAL_STATUSES.has(status)) continue
      const id = firstStr(rec['approval_id'], rec['id']) ?? ''
      if (id) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      combined.push(rec)
    }
  }

  for (const container of containers) {
    // Prefer snapshot shape (`pending_approvals`) first so rich `display` / `decision_options` win on dedup.
    pushArray(container['pending_approvals'])
    pushArray(container['pending'])
    pushArray(container['approvals'])
    pushArray(container['items'])
  }

  return combined
}

/**
 * Parse `decision_options` from both legacy string arrays (`["allow_once", "allow_always", "deny"]`)
 * and snapshot object arrays (`[{ kind, label: { kind, scope }, label_text, opens_url }]`).
 */
export function parseDecisionOptionDetails(raw: Record<string, unknown>): MuseApprovalOption[] {
  const list = raw['decision_options']
  if (!Array.isArray(list) || list.length === 0) return []
  const out: MuseApprovalOption[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry === 'string') {
      const kind = entry.trim()
      if (!kind) continue
      const dedup = `${kind}:`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      out.push({ kind })
      continue
    }
    const obj = asObj(entry)
    if (!obj) continue
    const labelObj = asObj(obj['label'])
    const kind = firstStr(obj['kind'], obj['decision'], obj['value'], obj['id'])
    if (!kind) continue
    const scope = firstStr(
      obj['scope'],
      obj['always_scope'],
      obj['allow_always_scope'],
      labelObj?.['scope'],
      labelObj?.['always_scope']
    )
    const labelKind = firstStr(labelObj?.['kind'], typeof obj['label'] === 'string' ? obj['label'] : undefined)
    const label = firstStr(obj['label_text'], obj['text'], obj['title'], labelObj?.['text'])
    const opensUrl = firstStr(obj['opens_url'], obj['opensUrl'], obj['url'])
    const safeUrl = opensUrl && /^https?:\/\//i.test(opensUrl) ? opensUrl : undefined
    const dedup = `${kind}:${scope ?? ''}`
    if (seen.has(dedup)) continue
    seen.add(dedup)
    out.push({
      kind,
      ...(label ? { label } : {}),
      ...(labelKind ? { labelKind } : {}),
      ...(scope ? { scope } : {}),
      ...(safeUrl ? { opensUrl: safeUrl } : {})
    })
  }
  return out
}

function extractHost(raw: Record<string, unknown>, variants: Record<string, unknown>[]): string | undefined {
  const direct = firstStr(raw['host'], raw['destination_domain'], raw['domain'])
  if (direct) return direct
  for (const sub of variants) {
    const h = firstStr(sub['host'], sub['destination_domain'], sub['domain'], sub['site'], sub['origin'])
    if (h) {
      if (/^https?:\/\//i.test(h)) {
        try {
          return new URL(h).hostname || h
        } catch {
          return h
        }
      }
      return h
    }
    const urlStr = firstStr(sub['url'], sub['destination_url'], sub['target_url'])
    if (urlStr && /^https?:\/\//i.test(urlStr)) {
      try {
        const parsed = new URL(urlStr)
        if (parsed.hostname) return parsed.hostname
      } catch {
        /* ignore */
      }
    }
    const declared = sub['declared_hosts']
    if (Array.isArray(declared) && typeof declared[0] === 'string' && declared[0].trim()) {
      return declared[0].trim()
    }
  }
  const topDeclared = raw['declared_hosts']
  if (Array.isArray(topDeclared) && typeof topDeclared[0] === 'string' && topDeclared[0].trim()) {
    return topDeclared[0].trim()
  }
  return undefined
}

export function mapMuseApproval(raw: Record<string, unknown>): MuseApproval {
  const display = asObj(raw['display']) ?? {}
  const permissionQuestion = asObj(display['permission_question']) ?? asObj(raw['permission_question'])
  const payload = asObj(raw['payload'])
  const variants = extractPayloadVariants(raw)

  const id = firstStr(raw['approval_id'], raw['id']) ?? ''
  const host = extractHost(raw, variants)
  const approvalType = firstStr(raw['approval_type'], payload?.['type']) ?? (host ? 'network' : undefined)

  const explicitTitle = firstStr(
    permissionQuestion?.['text'],
    permissionQuestion?.['title'],
    display['title']
  )
  const actionDescription = firstStr(display['action_description'], raw['action_description'])
  const title =
    explicitTitle ??
    firstStr(
      raw['title'],
      actionDescription,
      display['action_label'],
      raw['action_label'],
      display['display_name'],
      raw['display_name'],
      approvalType
    ) ??
    'Pending approval'

  const candidateDetail = firstStr(
    actionDescription,
    display['subtitle'],
    display['purpose_summary'],
    raw['purpose_summary'],
    raw['approval_phrase']
  )
  const detail = candidateDetail && candidateDetail !== title ? candidateDetail : undefined

  const reason = firstStr(
    display['rich_explanation'],
    raw['rich_explanation'],
    display['short_explanation'],
    raw['short_explanation'],
    display['reason'],
    raw['reason']
  )

  const optionDetails = parseDecisionOptionDetails(raw)
  const decisionOptions = optionDetails
    .map((o) => o.kind)
    .filter((k): k is ApprovalDecision => KNOWN_APPROVAL_DECISIONS.has(k as ApprovalDecision))

  return {
    id,
    status: firstStr(raw['status']) ?? 'pending',
    title,
    hasExplicitTitle: Boolean(explicitTitle),
    detail,
    approvalType,
    host,
    decisionOptions: decisionOptions.length ? decisionOptions : undefined,
    decisionOptionDetails: optionDetails.length ? optionDetails : undefined,
    reason,
    raw
  }
}

/**
 * Resolve the ordered list of clickable options for an approval card, preserving
 * per-option scopes/labels and matching Muse's space-reader fallback when
 * `decision_options` is omitted.
 */
export function resolveApprovalOptions(approval: MuseApproval): MuseApprovalOption[] {
  if (approval.decisionOptionDetails?.length) return approval.decisionOptionDetails
  if (approval.decisionOptions?.length) return approval.decisionOptions.map((kind) => ({ kind }))
  const raw = asObj(approval.raw)
  if (isSpaceReaderEligible(raw)) {
    return [
      { kind: 'allow_always', scope: 'entity' },
      { kind: 'deny_always', scope: 'entity' }
    ]
  }
  return [{ kind: 'allow_once' }, { kind: 'allow_always' }, { kind: 'deny' }]
}

export function isUploadApproval(approval: MuseApproval): boolean {
  if (approval.approvalType && /outgoing_media|upload/i.test(approval.approvalType)) return true
  const raw = asObj(approval.raw)
  const payload = asObj(raw?.['payload'])
  if (payload?.['outgoing_media_payload']) return true
  const display = asObj(raw?.['display'])
  const pq = asObj(display?.['permission_question'])
  const pqKind = firstStr(pq?.['kind'])
  return Boolean(pqKind && /outgoing_media|upload/i.test(pqKind))
}

export function resolveAlwaysScope(
  approval: MuseApproval | undefined,
  decision: ApprovalDecision | string,
  explicitScope?: string
): string {
  if (explicitScope?.trim()) return explicitScope.trim()
  const matched = approval?.decisionOptionDetails?.find((o) => o.kind === decision && o.scope)
  if (matched?.scope) return matched.scope
  const raw = asObj(approval?.raw)
  const rawScope = firstStr(raw?.['always_scope'], raw?.['allow_always_scope'])
  if (rawScope) return rawScope
  if (isSpaceReaderEligible(raw)) return 'entity'
  if (approval?.approvalType === 'connector' && !approval.host) return 'connector_all_actions'
  return 'destination_domain'
}

export function buildMuseApprovalDecideParams(
  approval: MuseApproval | undefined,
  approvalId: string,
  decision: ApprovalDecision | string,
  explicitScope?: string
): Record<string, unknown> {
  const raw = asObj(approval?.raw)
  const isAllowAlways = decision === 'allow_always'
  const isDenyAlways = decision === 'deny_always'
  const scope = isAllowAlways || isDenyAlways ? resolveAlwaysScope(approval, decision, explicitScope) : undefined
  const rev = raw?.['message_revision']
  const expectedRevision = typeof rev === 'number' || typeof rev === 'string' ? rev : null

  return {
    approval_id: approvalId,
    decision,
    ...(isAllowAlways && scope ? { always_scope: scope, allow_always_scope: scope } : {}),
    ...(isDenyAlways && scope ? { always_scope: scope } : {}),
    reason: null,
    expires_at_ms: null,
    notification_channel: 'ui',
    expected_message_revision: expectedRevision
  }
}

export interface ApprovalDisplayMetadata {
  method?: string
  path?: string
  scheme?: string
  serviceName?: string
  filename?: string
  preview?: unknown
  editableMessage: boolean
}

export function extractApprovalMetadata(approval: MuseApproval): ApprovalDisplayMetadata {
  const raw = asObj(approval.raw) ?? {}
  const display = asObj(raw['display']) ?? {}
  const variants = extractPayloadVariants(raw)

  let method = firstStr(raw['method'])
  let path = firstStr(raw['path'])
  let scheme = firstStr(raw['scheme'])
  let filename = firstStr(raw['filename'], raw['file_name'], raw['file_path'], raw['media_path'])
  let preview: unknown = raw['payload_preview'] ?? display['request_preview_document']

  for (const sub of variants) {
    if (!method) method = firstStr(sub['method'])
    if (!path) path = firstStr(sub['path'], sub['file_path'], sub['media_path'])
    if (!scheme) scheme = firstStr(sub['scheme'])
    if (!filename) {
      filename = firstStr(
        sub['filename'],
        sub['file_name'],
        sub['attachment_name'],
        sub['name'],
        sub['file_path'],
        sub['media_path']
      )
    }
    if (!filename && Array.isArray(sub['files']) && sub['files'].length > 0) {
      const firstFile = asObj(sub['files'][0])
      filename = firstStr(firstFile?.['filename'], firstFile?.['name'], firstFile?.['path'])
    }
    if (preview == null && sub['payload_preview'] != null) preview = sub['payload_preview']
  }

  const serviceName = firstStr(display['display_name'], raw['display_name'])
  const editableMessage = Boolean(
    raw['editable_message_available'] || raw['editable_message'] || raw['is_editable']
  )

  return { method, path, scheme, serviceName, filename, preview, editableMessage }
}
