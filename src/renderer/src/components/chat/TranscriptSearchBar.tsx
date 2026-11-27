import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { findMessageMatchIds, type SearchableMessage } from '@/lib/conversationSearch'
import { useT } from '@/lib/i18n'
import { hasOpenOverlay } from '@/lib/overlay'
import { FIND_TRANSCRIPT_EVENT, openTranscriptSearch, shortcutLabel } from '@/lib/shortcuts'

export function TranscriptSearchButton() {
  const t = useT()
  return <IconButton label={t('Find in conversation')} shortcut={shortcutLabel('F')} onClick={openTranscriptSearch}><Search /></IconButton>
}

export function TranscriptSearchBar({ conversationId, messages, focusMessage }: {
  conversationId: string
  messages: readonly SearchableMessage[]
  focusMessage: (conversationId: string, messageId: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const ids = useMemo(() => findMessageMatchIds(messages, query), [messages, query])
  const index = selected ? Math.max(0, ids.indexOf(selected)) : 0
  const current = ids[index]

  function close() {
    setOpen(false)
    setQuery('')
    setSelected(undefined)
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
  }

  useEffect(() => {
    const show = (event: Event) => {
      event.preventDefault()
      if (!open) returnFocus.current = document.activeElement as HTMLElement | null
      setOpen(true)
      input.current?.select()
      input.current?.focus()
    }
    const escape = (event: KeyboardEvent) => {
      if (open && event.key === 'Escape' && !event.defaultPrevented && !event.isComposing &&
        !hasOpenOverlay()) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener(FIND_TRANSCRIPT_EVENT, show)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener(FIND_TRANSCRIPT_EVENT, show)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (open && current) focusMessage(conversationId, current)
  }, [open, current, conversationId, focusMessage])

  const step = (direction: number) => {
    input.current?.focus()
    if (!ids.length) return
    const next = ids[(index + direction + ids.length) % ids.length]!
    if (next === current) focusMessage(conversationId, next)
    setSelected(next)
  }

  if (!open) return null
  return (
    <div role="search" className="no-drag flex shrink-0 items-center justify-end gap-1 border-b border-line bg-main px-3 py-1">
      <Search aria-hidden className="size-3.5 text-ink-muted" />
      <input ref={input} autoFocus data-transcript-search-input value={query} aria-label={t('Find in conversation')}
        placeholder={t('Find in conversation')} className="w-48 min-w-0 bg-transparent px-1 text-[13px] text-ink outline-none"
        onChange={(event) => {
          setQuery(event.target.value)
          setSelected(undefined)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <span role="status" className="px-1 text-[12px] text-ink-muted tabular-nums">{current ? index + 1 : 0} / {ids.length}</span>
      <IconButton size="sm" label={t('Previous match')} shortcut="Shift+Enter" disabled={!current} onClick={() => step(-1)}><ChevronUp /></IconButton>
      <IconButton size="sm" label={t('Next match')} shortcut="Enter" disabled={!current} onClick={() => step(1)}><ChevronDown /></IconButton>
      <IconButton size="sm" label={t('Close search')} shortcut="Esc" onClick={close}><X /></IconButton>
    </div>
  )
}
