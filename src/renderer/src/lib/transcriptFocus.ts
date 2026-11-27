// The find input keeps keyboard focus while typing or stepping. Palette jumps focus the row.
export function revealTranscriptRow(row: HTMLElement): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  row.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'instant' : 'smooth' })
  if (!document.activeElement?.hasAttribute('data-transcript-search-input')) row.focus({ preventScroll: true })
  row.animate([
    { backgroundColor: 'var(--color-accent-50)', outline: '2px solid var(--color-accent-600)', offset: 0 },
    { backgroundColor: 'var(--color-accent-50)', outline: '2px solid var(--color-accent-600)', offset: reducedMotion ? 1 : 0.55 },
    { backgroundColor: 'transparent', outline: '2px solid transparent' }
  ], 1100)
}
