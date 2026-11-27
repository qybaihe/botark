import { useState } from 'react'
import type { GeminiConfig } from '@shared/gemini'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { useT } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'
import type { BotAccount } from '@/types'
import { GeminiConnectForm } from './GeminiConnectForm'

function AccountSettings({ account }: { account: BotAccount }) {
  const t = useT()
  const [initial, setInitial] = useState<GeminiConfig | null>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const store = useBotStore.getState()
  return <section className="space-y-3 rounded-xl border border-line p-4">
    <div className="flex items-center gap-2"><strong>{account.displayName}</strong><StatusBadge status={account.status} /></div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy} onClick={() => void run(async () => {
        const api = getBridge()?.gemini
        if (!api) throw new Error(t('Gemini requires the desktop app'))
        setInitial(await api.config(account.id))
      })}>{t('Configure Gemini connection')}</Button>
      <Button size="sm" disabled={busy || account.pending} onClick={() => void run(() => store.connectAccount(account.id))}>
        {t('Test connection')}
      </Button>
      <Button size="sm" variant="danger" disabled={busy || account.pending} onClick={() => {
        if (window.confirm(t('Delete the saved Gemini credentials?'))) void run(async () => {
          setInitial(undefined)
          await store.signOutAccount(account.id)
        })
      }}>{t('Delete credentials')}</Button>
    </div>
    {initial !== undefined && <GeminiConnectForm accountId={account.id} initial={initial} onSaved={async () => {
      setInitial(undefined)
      await store.connectAccount(account.id)
    }} />}
    {(error || account.statusDetail) && <p role="status" className="text-xs text-ink-secondary">{error || account.statusDetail}</p>}
  </section>
}
export function GeminiAccountsSettingsPanel() {
  const t = useT()
  const accounts = useBotStore((s) => s.accounts)
  return <div className="space-y-3">
    <Button onClick={() => {
      useBotStore.getState().setSettingsOpen(false)
      useBotStore.getState().setAddBotOpen(true, 'gemini')
    }}>{t('Add Gemini account')}</Button>
    {Object.values(accounts).filter((a) => a.platformId === 'gemini').map((a) => <AccountSettings key={a.id} account={a} />)}
  </div>
}
