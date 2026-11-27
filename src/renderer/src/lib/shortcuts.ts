import { useEffect } from 'react'
import { useBotStore } from '@/store/botStore'
import { hasOpenOverlay } from './overlay'
import { runtimePlatform } from './bridge'

const isMac = runtimePlatform === 'darwin' || (runtimePlatform === 'web' && /Mac/.test(globalThis.navigator?.platform ?? ''))

export const FIND_TRANSCRIPT_EVENT = 'botark:find-transcript'

export function openTranscriptSearch(): boolean {
  if (hasOpenOverlay()) return false
  return !window.dispatchEvent(new Event(FIND_TRANSCRIPT_EVENT, { cancelable: true }))
}

/** "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcutLabel(key: string, { alt = false }: { alt?: boolean } = {}): string {
  if (isMac) return `${alt ? '⌥' : '⌘'}${key}`
  return `${alt ? 'Alt' : 'Ctrl'}+${key}`
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]')
}

/**
 * App-wide keys:
 * ⌘F find in conversation · ⌘K search · ⌘N new bot · ⌘I details · ⌘1–9 jump to a bot · ⌥↑/⌥↓ previous/next bot.
 * Dialogs own the keyboard while open. The palette can also close with ⌘K.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[data-onboarding-dialog]')) return
      const store = useBotStore.getState()
      if (store.onboardingOpen) return
      const mod = isMac ? event.metaKey : event.ctrlKey
      const plainMod = mod && !event.shiftKey && !event.altKey
      const key = event.key.toLowerCase()

      if (plainMod && key === 'k') {
        event.preventDefault()
        if (store.paletteOpen) store.closePalette()
        else if (!document.querySelector('[role="dialog"][data-state="open"]')) store.openPalette()
        return
      }
      if (document.querySelector('[role="dialog"][data-state="open"]')) return

      if (plainMod && key === 'f') {
        if (openTranscriptSearch()) event.preventDefault()
      } else if (plainMod && key === 'n') {
        event.preventDefault()
        store.setAddBotOpen(true)
      } else if (plainMod && key === 'i') {
        event.preventDefault()
        store.toggleInfoPanel()
      } else if (plainMod && /^[1-9]$/.test(event.key)) {
        const ordered = store.groups.flatMap((g) => store.bots.filter((b) => b.groupId === g.id))
        const bot = ordered[Number(event.key) - 1]
        if (bot) {
          event.preventDefault()
          store.selectBot(bot.id)
        }
      } else if (
        event.altKey &&
        !mod &&
        !event.shiftKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !isEditable(event.target)
      ) {
        event.preventDefault()
        store.selectAdjacentBot(event.key === 'ArrowUp' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
