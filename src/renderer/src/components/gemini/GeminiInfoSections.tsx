import { useEffect, useState } from 'react'
import type { GeminiConfig, GeminiDraft, GeminiSession } from '@shared/gemini'
import { Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { useT } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'
import { geminiField } from './GeminiConnectForm'

export function GeminiInfoSections({ bot }: { bot: Bot }) {
  const t = useT()
  const api = getBridge()?.gemini
  const accountId = bot.activeAccountId
  const status = useBotStore((s) => s.accounts[accountId]?.status)
  const typing = useBotStore((s) => s.typing[bot.id])
  const [config, setConfig] = useState<GeminiConfig | null>(null)
  const [sessions, setSessions] = useState<GeminiSession[]>([])
  const [instruction, setInstruction] = useState('')
  const [editingTitle, setEditingTitle] = useState<{ id: string; title: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    let active = true
    api?.config(accountId).then((value) => {
      if (active) { setConfig(value); setInstruction(value?.systemInstruction ?? '') }
    }).catch((e) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [api, accountId])
  useEffect(() => {
    let active = true
    api?.listSessions(accountId).then((items) => { if (active) setSessions(items) })
      .catch((e) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [api, accountId, bot.activeSessionId, typing, status, revision])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await action(); refresh((v) => v + 1) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const save = (patch: GeminiDraft) => void run(async () => { if (api) setConfig(await api.configure(accountId, patch)) })
  const usage = sessions.find((s) => s.id === bot.activeSessionId)?.usage
  return <>
    <Section title="Google Gemini">
      {config && <fieldset disabled={busy} className="space-y-2 text-xs">
        <Select aria-label={t('Model')} value={config.model} onValueChange={(model) => save({ model })}
          options={config.models.map((m) => ({ value: m.id, label: m.label, description: m.id }))} />
        <label className="flex items-center gap-2"><input type="checkbox" checked={config.enableSearchGrounding}
          onChange={(e) => save({ enableSearchGrounding: e.target.checked })} />{t('Ground answers with Google Search')}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={config.showThinking}
          onChange={(e) => save({ showThinking: e.target.checked })} />{t('Show thought summaries')}</label>
        <label className="block">{t('System instruction')}
          <textarea className={geminiField} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        </label>
        <Button size="sm" disabled={busy || instruction === config.systemInstruction}
          onClick={() => save({ systemInstruction: instruction })}>{t('Save')}</Button>
      </fieldset>}
      {usage && <p className="mt-2 text-xs text-ink-secondary">
        {t('Latest turn tokens')} · {t('Input')} {usage.promptTokenCount ?? '—'} · {t('Output')} {usage.candidatesTokenCount ?? '—'}
        {' · '}{t('Thinking')} {usage.thoughtsTokenCount ?? '—'} · {t('Total')} {usage.totalTokenCount ?? '—'}
      </p>}
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
    </Section>
    <Section title={t('Conversations')} count={sessions.length}>
      <ul className="space-y-1 text-xs">
        {sessions.map((session) => <li key={session.id} className="flex items-center gap-1">
          {editingTitle?.id === session.id ? <form className="flex min-w-0 flex-1 gap-1" onSubmit={(event) => {
            event.preventDefault()
            if (!api) return
            void run(async () => {
              await api.renameSession(accountId, session.id, editingTitle.title)
              setEditingTitle(null)
            })
          }}>
            <input autoFocus aria-label={t('Conversation title')} className={geminiField} value={editingTitle.title}
              onChange={(e) => setEditingTitle({ id: session.id, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') setEditingTitle(null) }} />
            <Button size="sm" type="submit" disabled={busy || !editingTitle.title.trim()}>{t('Save')}</Button>
          </form> : <>
          <button className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left hover:bg-hover aria-current:font-semibold"
            aria-current={session.id === bot.activeSessionId} disabled={busy || typing} title={session.title}
            onClick={() => void run(() => useBotStore.getState().switchGeminiSession(bot.id, session.id))}>{session.title}</button>
          <Button size="sm" disabled={busy} onClick={() => setEditingTitle({ id: session.id, title: session.title })}>
            {t('Rename')}
          </Button>
          </>}
          <Button size="sm" variant="danger" disabled={busy || typing} onClick={() => {
            if (!api || !window.confirm(t('Delete this conversation?'))) return
            void run(() => useBotStore.getState().deleteGeminiSession(bot.id, session.id))
          }}>{t('Delete')}</Button>
        </li>)}
      </ul>
    </Section>
  </>
}
