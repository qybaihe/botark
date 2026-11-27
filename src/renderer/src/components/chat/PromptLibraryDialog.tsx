import { useRef, useState } from 'react'
import { Copy, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/IconButton'
import { useT } from '@/lib/i18n'
import { expandPromptTemplate, exportPromptTemplatesJson, filterPromptTemplates, usePromptStore, type PromptTemplate } from '@/store/promptStore'

type Form = Pick<PromptTemplate, 'title' | 'category' | 'trigger' | 'content'> & { id?: string }
const blank: Form = { title: '', trigger: '', category: '', content: '' }
const field = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600'
const variables = ['date', 'bot', 'clipboard', 'cursor']

function TemplateEditor({ initial, onDone }: { initial: Form; onDone: () => void }) {
  const t = useT()
  const [form, setForm] = useState(initial)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const preview = expandPromptTemplate(form.content, {
    date: new Date().toLocaleDateString('sv-SE'), botName: t('Example bot'), clipboard: t('Example clipboard text')
  })
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault()
      try { usePromptStore.getState().save(form, form.id); onDone() }
      catch (err) { setError(t(err instanceof Error ? err.message : 'Could not save template.')) }
    }}>
      {(['title', 'trigger', 'category'] as const).map((key) => (
        <label key={key} className="block text-xs text-ink-secondary">
          {t({ title: 'Template title', trigger: 'Slash trigger', category: 'Category' }[key])}
          <input className={field + ' mt-1'} autoFocus={key === 'title'} required={key !== 'category'}
            placeholder={key === 'trigger' ? '/review' : undefined}
            value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        </label>
      ))}
      <label className="block text-xs text-ink-secondary">
        {t('Prompt text')}
        <textarea ref={input} className={field + ' mt-1 min-h-24 resize-y'} required
          value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
      </label>
      <div className="flex flex-wrap gap-1">
        {variables.map((v) => (
          <Button key={v} size="sm" variant="ghost" className="font-mono"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const el = input.current
              if (!el) return
              const token = '{{' + v + '}}'
              const caret = el.selectionStart + token.length
              setForm({ ...form, content: form.content.slice(0, el.selectionStart) + token + form.content.slice(el.selectionEnd) })
              requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret) })
            }}>{'{{' + v + '}}'}</Button>
        ))}
      </div>
      <div className="rounded-xl bg-sunken p-3">
        <h3 className="mb-1 text-xs font-medium text-ink-muted">{t('Template preview')}</h3>
        <p className="max-h-36 overflow-auto text-[13px] whitespace-pre-wrap break-words text-ink">
          {preview.text.slice(0, preview.cursorOffset)}
          {form.content.includes('{{cursor}}') && <span className="border-l-2 border-accent-600" aria-label={t('Cursor position')}>{'\u200b'}</span>}
          {preview.text.slice(preview.cursorOffset)}
        </p>
      </div>
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{t('Cancel')}</Button>
        <Button type="submit" variant="primary">{t('Save template')}</Button>
      </div>
    </form>
  )
}

function LibraryBody() {
  const t = useT()
  const templates = usePromptStore((s) => s.templates)
  const [form, setForm] = useState<Form | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [feedback, setFeedback] = useState('')
  const [confirm, setConfirm] = useState<{ action: 'delete'; id: string } | { action: 'restore' } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const categories = [...new Set(templates.map((item) => item.category).filter(Boolean))].sort()
  const selectedCategory = categories.includes(category) ? category : ''
  const filtered = filterPromptTemplates(templates, query).filter((item) => !selectedCategory || item.category === selectedCategory)
  const edit = (draft: Form) => { setConfirm(null); setFeedback(''); setForm(draft) }

  const exportJson = () => {
    const blob = new Blob([exportPromptTemplatesJson(templates)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'botark-prompts.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  if (form) return <TemplateEditor initial={form} onDone={() => setForm(null)} />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={field + ' min-w-32 flex-1'} aria-label={t('Search templates')} placeholder={t('Search templates')}
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label={t('Category')} className={field + ' max-w-36'} value={selectedCategory} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('All categories')}</option>
          {categories.map((name) => <option key={name}>{name}</option>)}
        </select>
        <Button variant="primary" onClick={() => edit(blank)}>{t('New template')}</Button>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {filtered.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-1 p-2">
            <button className="min-w-28 flex-1 rounded-lg px-2 py-1 text-left hover:bg-hover" onClick={() => edit(item)}>
              <span className="block truncate text-[13px] font-medium text-ink">{item.title}</span>
              <span className="block truncate text-xs text-ink-muted">/{item.trigger} {item.category && ' · ' + item.category}</span>
            </button>
            <IconButton size="sm" label={t(item.pinned ? 'Unpin template' : 'Pin template')} active={item.pinned}
              onClick={() => usePromptStore.getState().togglePin(item.id)}>{item.pinned ? <PinOff /> : <Pin />}</IconButton>
            <IconButton size="sm" label={t('Edit template')} onClick={() => edit(item)}><Pencil /></IconButton>
            <IconButton size="sm" label={t('Duplicate template')} onClick={() => {
              const base = item.trigger + '-copy'
              let trigger = base
              for (let n = 2; templates.some((other) => other.trigger === trigger); n++) trigger = base + '-' + n
              edit({ ...item, id: undefined, trigger, title: t('{title} (copy)', { title: item.title }) })
            }}><Copy /></IconButton>
            {confirm?.action === 'delete' && confirm.id === item.id
              ? <Button size="sm" variant="danger-confirm" onClick={() => {
                usePromptStore.getState().remove(item.id)
                setConfirm(null)
              }}>{t('Confirm deletion')}</Button>
              : <IconButton size="sm" label={t('Delete template')} onClick={() => setConfirm({ action: 'delete', id: item.id })}><Trash2 /></IconButton>}
          </li>
        ))}
        {!filtered.length && <li className="p-4 text-sm text-ink-muted">{t('No matching templates')}</li>}
      </ul>
      <div className="flex flex-wrap gap-1">
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          try {
            const count = usePromptStore.getState().importJson(await file.text())
            setFeedback(t('Imported {count} templates. Existing triggers were skipped.', { count }))
          } catch { setFeedback(t('Invalid prompt library file.')) }
        }} />
        <Button size="sm" onClick={() => fileInput.current?.click()}>{t('Import JSON')}</Button>
        <Button size="sm" onClick={exportJson}>{t('Export JSON')}</Button>
        <Button size="sm" variant="ghost" onClick={() => {
          if (confirm?.action !== 'restore') { setConfirm({ action: 'restore' }); return }
          usePromptStore.getState().restoreDefaults()
          setConfirm(null)
          setFeedback(t('Starter templates restored.'))
        }}>{t(confirm?.action === 'restore' ? 'Confirm restore' : 'Restore default templates')}</Button>
      </div>
      {feedback && <p role="status" className="text-xs text-ink-secondary">{feedback}</p>}
    </div>
  )
}

export function PromptLibraryDialog() {
  const t = useT()
  const open = usePromptStore((s) => s.libraryOpen)
  const setOpen = usePromptStore((s) => s.setLibraryOpen)
  return <Dialog open={open} onOpenChange={setOpen} title={t('Prompt library')}><LibraryBody /></Dialog>
}
