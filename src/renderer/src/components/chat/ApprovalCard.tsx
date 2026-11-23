import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { adapterRegistry } from '@adapters/registry'
import type { MuseApproval, MuseApprovalOption } from '@adapters/types'
import {
  extractApprovalMetadata,
  isUploadApproval,
  resolveApprovalOptions
} from '@shared/museApprovals'
import { ArkShieldVaultSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'

/** Registrable domain for the "always" note: agent.qq.com → qq.com. Heuristic, display only. */
function baseDomain(host: string): string {
  const parts = host.split('.').filter(Boolean)
  if (parts.length <= 2) return host
  const sld = parts[parts.length - 2]!
  const twoPart = ['com', 'net', 'org', 'gov', 'edu', 'co', 'ac'].includes(sld) && parts[parts.length - 1]!.length === 2
  return parts.slice(twoPart ? -3 : -2).join('.')
}

export function formatApprovalOptionLabel(
  approval: MuseApproval,
  option: MuseApprovalOption,
  serviceName?: string
): string {
  if (option.label) return option.label
  switch (option.kind) {
    case 'allow_once':
      return t('Allow once')
    case 'allow_session':
      return t('Allow for this task')
    case 'allow_always': {
      switch (option.scope) {
        case 'connector_all_actions':
          return serviceName
            ? t('Always allow all {service} actions', { service: serviceName })
            : t('Always allow all connector actions')
        case 'entity':
          return t('Always allow for this item')
        case 'recipient':
          return t('Always allow this recipient')
        case 'destination':
          return t('Always allow this destination')
        case 'destination_domain':
          return isUploadApproval(approval)
            ? t('Always allow uploads to this site')
            : t('Always allow this site')
        default:
          if (approval.host) {
            return isUploadApproval(approval)
              ? t('Always allow uploads to this site')
              : t('Always allow this site')
          }
          return t('Always allow')
      }
    }
    case 'deny_always':
      return t('Always deny')
    case 'deny':
      return t('Deny')
    default:
      return option.kind
  }
}

export function formatApprovalTitle(approval: MuseApproval): string {
  if (approval.hasExplicitTitle) return approval.title
  if (approval.host) return t('Allow Muse to share information with {host}?', { host: approval.host })
  return approval.title
}

/** One Sentinel card, in the conversation — mirrors the official Muse permission prompt. Never auto-decides. */
function Card({
  approval,
  busy,
  onDecide
}: {
  approval: MuseApproval
  busy: boolean
  onDecide: (option: MuseApprovalOption) => void
}) {
  const [open, setOpen] = useState(false)
  const host = approval.host
  const meta = extractApprovalMetadata(approval)
  const options = resolveApprovalOptions(approval)
  const description = approval.detail ?? approval.reason
  const title = formatApprovalTitle(approval)
  const facts: Array<[string, string]> = []
  if (meta.filename) facts.push([t('File'), meta.filename])
  if (host) facts.push([t('Destination'), `${meta.scheme ?? 'https'}://${host}${meta.path ?? ''}`])
  if (meta.method) facts.push([t('Method'), meta.method])
  if (meta.serviceName) facts.push([t('Service'), meta.serviceName])
  if (approval.reason && approval.reason !== description) facts.push([t('Reason'), approval.reason])
  const preview = meta.preview
  const showDomainScopeNote =
    Boolean(host) &&
    options.some((o) => o.kind === 'allow_always' && (!o.scope || o.scope === 'destination_domain'))

  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="mx-auto mb-2 w-full max-w-[720px] animate-step-in rounded-2xl border border-line-strong bg-surface p-3.5 shadow-card"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-status-attention/12 text-status-attention-ink">
          <ArkShieldVaultSvg className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] leading-5 font-medium text-ink">{title}</p>
          {description && <p className="mt-0.5 text-[13px] leading-[19px] text-ink-secondary">{description}</p>}
          {(facts.length > 0 || preview != null) && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mt-1 inline-flex items-center gap-0.5 text-[12px] text-ink-muted hover:text-ink"
            >
              {open ? t('Hide details') : t('Show details')}
              <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          )}
          {open && (
            <div className="mt-1.5 animate-veil-in rounded-lg bg-sunken px-3 py-2 text-[12px]">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {facts.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-muted">{k}</dt>
                    <dd className="min-w-0 break-all text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              {preview != null && (
                <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-ink-secondary">
                  {typeof preview === 'string' ? preview : JSON.stringify(preview, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
        {showDomainScopeNote && host && (
          <p className="mr-auto text-[11.5px] text-ink-muted">
            {t('“Always allow” covers {domain} and its subdomains', { domain: baseDomain(host) })}
          </p>
        )}
        {options.map((opt, idx) => (
          <Button
            key={`${opt.kind}:${opt.scope ?? idx}`}
            size="sm"
            variant={
              idx === 0 && (opt.kind === 'allow_once' || opt.kind === 'allow_session' || opt.kind === 'allow_always')
                ? 'primary'
                : 'secondary'
            }
            disabled={busy}
            onClick={() => onDecide(opt)}
          >
            {formatApprovalOptionLabel(approval, opt, meta.serviceName)}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Pending Muse or Grok Bot permission requests for the bot's active account, shown above the composer. */
export function ChatApprovals({
  accountId,
  platformId = 'meta-muse',
  agentId
}: {
  accountId: string
  platformId?: 'meta-muse' | 'grok'
  agentId?: string
}) {
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const [pending, setPending] = useState<MuseApproval[]>([])
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const adapter = adapterRegistry.get(platformId)
    if (!adapter) return
    const unsub = adapter.subscribe((event) => {
      if (event.type === 'approvals' && event.accountId === accountId) setPending(event.pending)
    })
    const active = Boolean(status && status !== 'offline')
    const pull = () => {
      if (!active) return
      void adapter.listApprovals?.(accountId).then(setPending).catch(() => {})
    }
    pull()

    // Official Muse client polls egress.approvals (5s staleTime) so background
    // browser/connector tasks that request approval after a turn ends still surface.
    let timer: ReturnType<typeof setInterval> | undefined
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) pull()
    }
    if (platformId === 'meta-muse' && active) {
      timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        pull()
      }, 5000)
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility)
      }
    }
    return () => {
      unsub()
      if (timer) clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [accountId, platformId, status])

  const visiblePending =
    platformId === 'grok' && agentId
      ? pending.filter((a) => {
          const rawAgent =
            a.raw && typeof a.raw === 'object'
              ? String((a.raw as Record<string, unknown>)['agentId'] ?? '')
              : ''
          return !rawAgent || rawAgent === agentId
        })
      : pending

  if (!visiblePending.length) return null
  const decide = async (id: string, option: MuseApprovalOption) => {
    const adapter = adapterRegistry.get(platformId)
    if (!adapter?.decideApproval) return
    setBusyId(id)
    setError(undefined)
    try {
      await adapter.decideApproval(accountId, id, option.kind, {
        scope: option.scope,
        opensUrl: option.opensUrl
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }
  return (
    <div className="px-4" data-chat-approvals>
      {visiblePending.map((a) => (
        <Card key={a.id} approval={a} busy={busyId === a.id} onDecide={(opt) => void decide(a.id, opt)} />
      ))}
      {error && <p className="mx-auto mb-2 max-w-[720px] text-[12px] text-status-error">{error}</p>}
    </div>
  )
}
