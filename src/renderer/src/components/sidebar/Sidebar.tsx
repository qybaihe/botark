import { PinnedRoomsList, RoomList } from '@/rooms/RoomSidebarList'
import { type KeyboardEvent } from 'react'
import { Plus, Search, Settings } from 'lucide-react'
import { hasSeenOnboarding } from '@/components/onboarding/onboardingState'
import {
  ArkDrawerToggleSvg,
  ArkMobileLinkSvg,
  ArkPromptSparkSvg
} from '@/components/ui/ArkGlyphs'
import { GrokBotMark } from '@/components/ui/GrokBotMark'
import { IconButton } from '@/components/ui/IconButton'
import { t } from '@/lib/i18n'
import { runtimePlatform } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import { BotList } from './BotList'

interface SidebarProps {
  onAddBot: () => void
}

function BrandMark() {
  return (
    <span className="grid size-6 place-items-center" aria-hidden>
      <GrokBotMark seed="bothub-brand" shape="blob" color="black" sizePx={22} followPointer />
    </span>
  )
}

export function Sidebar({ onAddBot }: SidebarProps) {
  const openPalette = useBotStore((s) => s.openPalette)
  const sidebarCollapsed = useBotStore((s) => s.sidebarCollapsed)
  const toggleSidebarCollapsed = useBotStore((s) => s.toggleSidebarCollapsed)
  const settingsOpen = useBotStore((s) => s.settingsOpen)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const onboardingOpen = useBotStore((s) => s.onboardingOpen)
  const setOnboardingOpen = useBotStore((s) => s.setOnboardingOpen)
  const selectedPlatformId = useBotStore(
    (s) => s.bots.find((b) => b.id === s.selectedBotId)?.platformId
  )
  const unseenGuide = !onboardingOpen && !hasSeenOnboarding()

  const defaultSettingsTab =
    selectedPlatformId === 'dot'
      ? 'dot-accounts'
      : selectedPlatformId === 'grok'
        ? 'grok-accounts'
        : selectedPlatformId === 'hark'
          ? 'hark-accounts'
          : selectedPlatformId === 'hermes'
            ? 'hermes-accounts'
            : selectedPlatformId === 'antigravity'
              ? 'antigravity-accounts'
              : selectedPlatformId === 'cue'
                ? 'cue-accounts'
                : selectedPlatformId === 'ds-bot'
                  ? 'ds-bot-accounts'
                  : 'muse-accounts'

  // Typing while the sidebar has focus starts a search.
  const typeToSearch = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return
    event.preventDefault()
    openPalette(event.key)
  }

  if (sidebarCollapsed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center" onKeyDown={typeToSearch}>
        <div className="drag-region h-[42px] w-full shrink-0" />
        <div className="flex min-h-0 w-full flex-1 flex-col items-center px-1.5 pt-1 pb-2">
          <PinnedRoomsList compact />
          <BotList />
          <RoomList compact />
        </div>
        <div className="no-drag flex shrink-0 flex-col items-center gap-1.5 pb-3 pt-1">
          <IconButton
            round
            label={t('Expand sidebar')}
            onClick={toggleSidebarCollapsed}
          >
            <ArkDrawerToggleSvg side="left" />
          </IconButton>
          <IconButton round label={t('New bot')} shortcut={shortcutLabel('N')} onClick={onAddBot}>
            <Plus />
          </IconButton>
          <span className="relative">
            <IconButton
              round
              active={onboardingOpen}
              label="打开操作指南"
              onClick={() => setOnboardingOpen(true)}
            >
              <ArkPromptSparkSvg />
            </IconButton>
            {unseenGuide && (
              <span
                aria-hidden
                className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-accent-600 ring-2 ring-surface"
              />
            )}
          </span>
          <IconButton
            round
            active={settingsOpen}
            label="设置与账号"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings />
          </IconButton>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={typeToSearch}>
      <header
        className={cn(
          'drag-region flex h-[54px] shrink-0 items-center gap-1.5 px-3 pt-1.5',
          runtimePlatform === 'darwin' && 'pl-[78px]'
        )}
      >
        <div className="no-drag ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            round
            label={t('Collapse sidebar')}
            onClick={toggleSidebarCollapsed}
          >
            <ArkDrawerToggleSvg side="left" active />
          </IconButton>
          <IconButton round label={t('Search')} shortcut={shortcutLabel('K')} onClick={() => openPalette()}>
            <Search />
          </IconButton>
          <IconButton round label={t('New bot')} shortcut={shortcutLabel('N')} onClick={onAddBot}>
            <Plus />
          </IconButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-2 pt-0.5 pb-2">
        <PinnedRoomsList />
        <BotList />
        <RoomList />
      </div>

      <footer className="no-drag flex shrink-0 items-center justify-between gap-1.5 border-t border-ink/[0.06] px-2.5 py-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(!settingsOpen, settingsOpen ? undefined : defaultSettingsTab)}
          className={cn(
            'press flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full px-2 text-left transition-colors',
            settingsOpen ? 'bg-active text-ink' : 'hover:bg-hover text-ink'
          )}
        >
          <BrandMark />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-ink">
            设置与账号
          </span>
          <Settings className="size-4 shrink-0 text-ink-secondary" aria-hidden />
        </button>
        <IconButton
          round
          label="手机无线同步"
          onClick={() => setSettingsOpen(true, 'mobile-sync')}
        >
          <ArkMobileLinkSvg />
        </IconButton>
        <span className="relative shrink-0">
          <IconButton
            round
            active={onboardingOpen}
            label="打开操作指南"
            onClick={() => setOnboardingOpen(true)}
          >
            <ArkPromptSparkSvg />
          </IconButton>
          {unseenGuide && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-accent-600 ring-2 ring-surface"
            />
          )}
        </span>
      </footer>
    </div>
  )
}
