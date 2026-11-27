import { useState } from 'react'
import { GEMINI_BASE_URL, GEMINI_MODEL, type GeminiConfig, type GeminiModel } from '@shared/gemini'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { useT } from '@/lib/i18n'

export const geminiField = 'mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink'
export function GeminiConnectForm({ accountId, initial, onSaved }: {
  accountId: string
  initial?: GeminiConfig | null
  onSaved: () => void | Promise<void>
}) {
  const t = useT()
  const [apiKey, setKey] = useState('')
  const [baseUrl, setUrl] = useState(initial?.baseUrl ?? '')
  const [model, setModel] = useState(initial?.model ?? GEMINI_MODEL)
  const [instruction, setInstruction] = useState(initial?.systemInstruction ?? '')
  const [models, setModels] = useState<GeminiModel[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (save: boolean) => {
    setBusy(true)
    setError('')
    try {
      const api = getBridge()?.gemini
      if (!api) throw new Error(t('Gemini requires the desktop app'))
      const draft = { apiKey: apiKey || undefined, baseUrl, model, systemInstruction: instruction }
      if (save) {
        await api.configure(accountId, draft)
        setKey('')
        await onSaved()
      } else {
        const items = await api.verifyAndListModels(accountId, draft)
        setModels(items)
        if (!items.some((m) => m.id === model)) setModel(items[0].id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return <fieldset disabled={busy} className="space-y-3 py-2 text-sm text-ink-secondary">
    <label className="block">API Key
      <input className={geminiField} type="password" autoComplete="off" spellCheck={false}
        value={apiKey} placeholder={initial ? t('Keep saved API key') : 'API Key'}
        onChange={(e) => { setKey(e.target.value); setModels([]) }} />
    </label>
    <a className="text-accent-600 hover:underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
      {t('Get a key from Google AI Studio')}
    </a>
    <label className="block">Base URL
      <input className={geminiField} type="url" value={baseUrl} placeholder={GEMINI_BASE_URL}
        onChange={(e) => { setUrl(e.target.value); setModels([]) }} />
    </label>
    <Button size="sm" disabled={busy || (!apiKey.trim() && !initial)} onClick={() => void run(false)}>
      {t('Test and load models')}
    </Button>
    {models.length > 0 && <>
      <Select aria-label={t('Model')} value={model} onValueChange={setModel}
        options={models.map((m) => ({ value: m.id, label: m.label, description: m.id }))} />
      <label className="block">{t('System instruction')}
        <textarea className={geminiField} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <Button variant="primary" disabled={busy} onClick={() => void run(true)}>{t('Save')}</Button>
    </>}
    {error && <p role="alert" className="text-status-error">{error}</p>}
  </fieldset>
}
