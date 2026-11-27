import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Pin, Slash } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { MENU_SURFACE } from '@/components/ui/Menu'
import { cn } from '@/lib/cn'
import { useOverlayLock } from '@/lib/overlay'
import { useT } from '@/lib/i18n'
import { expandPromptTemplate, filterPromptTemplates, parseSlashQuery, usePromptStore, type PromptTemplate, type SlashQuery } from '@/store/promptStore'

export function usePromptSlashMenu(ref: RefObject<HTMLTextAreaElement | null>, text: string,
  setText: (text: string) => void, resize: () => void, botName: string, blocked = false) {
  const t = useT()
  const id = useId()
  const templates = usePromptStore((s) => s.templates)
  const [session, setSession] = useState<{ text: string; range: SlashQuery } | null>(null)
  const [index, setIndex] = useState(0)
  const lastSelection = useRef('')
  const composing = useRef(false)
  const revision = useRef(0)
  const range = !blocked && session?.text === text ? session.range : null
  useOverlayLock(Boolean(range))
  const items = range ? filterPromptTemplates(templates, range.query) : []
  const active = Math.min(index, items.length) // The final row opens the library.
  const close = () => {
    revision.current++
    setSession(null)
  }
  const sync = (el: HTMLTextAreaElement) => {
    const selection = JSON.stringify([el.value, el.selectionStart, el.selectionEnd])
    if (selection === lastSelection.current || composing.current) return
    lastSelection.current = selection
    revision.current++
    const match = el.selectionStart === el.selectionEnd && parseSlashQuery(el.value, el.selectionStart)
    setSession(match ? { text: el.value, range: match } : null)
    setIndex(0)
  }

  const pick = async (template: PromptTemplate) => {
    const el = ref.current
    if (!el || !range) return
    const request = ++revision.current
    let clipboard = ''
    if (template.content.includes('{{clipboard}}')) {
      try { clipboard = await navigator.clipboard.readText() } catch { /* Leave the unavailable value empty. */ }
    }
    if (revision.current !== request || el !== ref.current || el.value !== text) return
    const date = new Date().toLocaleDateString('sv-SE')
    const expanded = expandPromptTemplate(template.content, { botName, clipboard, date })
    const value = text.slice(0, range.replaceStart) + expanded.text + text.slice(range.replaceEnd)
    const caret = range.replaceStart + expanded.cursorOffset
    flushSync(() => {
      close()
      setText(value)
    })
    lastSelection.current = JSON.stringify([value, caret, caret])
    el.focus()
    el.setSelectionRange(caret, caret)
    resize()
    usePromptStore.getState().recordUse(template.id)
  }

  const manage = () => {
    close()
    usePromptStore.getState().setLibraryOpen(true)
  }
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return true
    if (!range) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      if (items[active]) void pick(items[active])
      else manage()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else return false
    return true
  }

  return {
    textareaProps: {
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => sync(e.currentTarget),
      onBlur: close,
      onCompositionStart: () => { composing.current = true; close() },
      onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        composing.current = false
        lastSelection.current = ''
        sync(e.currentTarget)
      },
      'aria-autocomplete': 'list' as const,
      'aria-controls': range ? id : undefined,
      'aria-activedescendant': range ? id + '-' + active : undefined
    },
    sync, handleKey,
    menu: range && <PromptSlashMenu id={id} items={items} active={active} select={setIndex} pick={pick} manage={manage} />,
    button: <IconButton label={t('Prompt templates (/)')} disabled={blocked} aria-expanded={Boolean(range)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const el = ref.current
        if (!el) return
        if (range) { close(); return }
        el.focus()
        const match = el.selectionStart === el.selectionEnd && parseSlashQuery(text, el.selectionStart)
        setSession({ text, range: match || { query: '', replaceStart: el.selectionStart, replaceEnd: el.selectionEnd } })
        setIndex(0)
      }}><Slash /></IconButton>
  }
}

function PromptSlashMenu({ id, items, active, select, pick, manage }: {
  id: string; items: PromptTemplate[]; active: number; select: (index: number) => void
  pick: (template: PromptTemplate) => void; manage: () => void
}) {
  const t = useT()
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div ref={list} id={id} role="listbox" aria-label={t('Prompt templates')}
      onMouseDown={(e) => e.preventDefault()}
      className={cn('absolute bottom-full left-2 z-30 mb-2 w-[min(22rem,95%)] p-1.5', MENU_SURFACE)}>
      <div className="max-h-[min(36vh,16rem)] overflow-y-auto">
        {items.map((item, i) => (
          <button key={item.id} id={id + '-' + i} type="button" tabIndex={-1} role="option" aria-selected={i === active}
            onMouseEnter={() => select(i)} onClick={() => pick(item)}
            className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink', i === active && 'bg-hover')}>
            <span className="max-w-[44%] truncate font-mono text-accent-600">/{item.trigger}</span>
            <span className="flex-1 truncate">{item.title}</span>
            {item.pinned && <Pin className="size-3 text-ink-muted" aria-label={t('Pinned')} />}
          </button>
        ))}
        {!items.length && <p className="p-2 text-xs text-ink-muted">{t('No matching templates')}</p>}
      </div>
      <button id={id + '-' + items.length} type="button" role="option" tabIndex={-1} aria-selected={active === items.length}
        onMouseEnter={() => select(items.length)} onClick={manage}
        className={cn('mt-1 w-full border-t border-line px-2.5 py-2 text-left text-xs text-ink-secondary', active === items.length && 'bg-hover')}>
        {t('Manage prompt templates…')}
      </button>
    </div>
  )
}
