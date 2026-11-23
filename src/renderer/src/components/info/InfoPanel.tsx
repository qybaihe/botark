import { setRoomAdministrator, useRooms } from '@/rooms/roomStore'
import { useMemo, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { PaneHeader } from '@/components/layout/PaneHeader'
import { ApprovalsSection } from '@/components/muse/ApprovalsSection'
import { AgentDiagnosticSection } from '@/components/muse/AgentDiagnosticSection'
import { ComputerSection } from '@/components/muse/ComputerSection'
import { GoalsSection } from '@/components/muse/GoalsSection'
import {
  GrokAccountAuthSection,
  GrokAgentsAndRoomsSection,
  GrokAutomationsSection,
  GrokComputerSection,
  GrokConnectorsAndMcpSection,
  GrokFilesSection,
  GrokMemoriesAndSkillsSection,
  GrokMembersSection,
  GrokSessionsSection,
  GrokTasksAndSubagentsSection
} from '@/components/grok/GrokInfoSections'
import {
  HarkBillingSection,
  HarkComputerSection,
  HarkConnectorsSection,
  HarkConversationsSection,
  HarkHomeCardsSection,
  HarkInviteAndSessionsSection,
  HarkLibrarySection,
  HarkScheduledTasksSection
} from '@/components/hark/HarkInfoSections'
import {
  DotCredentialsAndQuotaSection,
  DotGoalAndThreadsSection,
  DotLibrarySection,
  DotOrbitProfilesSection
} from '@/components/dot/DotInfoSections'
import {
  HermesJobsSection,
  HermesServerSection,
  HermesSessionsSection,
  HermesSkillsSection,
  HermesToolsetsSection
} from '@/components/hermes/HermesInfoSections'
import {
  AntigravityAccountAndModelSection,
  AntigravityAgentsSection,
  AntigravityConversationsSection,
  AntigravityEnvironmentsSection
} from '@/components/antigravity/AntigravityInfoSections'
import {
  CueAccountAuthSection,
  CueAgentContactsSection,
  CueAgentsSection,
  CueAutomationsSection,
  CueComputerSection,
  CueConnectorsSection,
  CueFilesSection,
  CueOverviewSection,
  CueSessionsSection,
  CueSkillsSection
} from '@/components/cue/CueInfoSections'
import { MemorySection } from '@/components/muse/MemorySection'
import { PermissionsSection } from '@/components/muse/PermissionsSection'
import { SkillsSection } from '@/components/muse/SkillsSection'
import { ConnectorsSection } from '@/components/muse/ConnectorsSection'
import { FilesSection } from '@/components/muse/FilesSection'
import { InviteSection } from '@/components/muse/InviteSection'
import { PeersSection } from '@/components/muse/PeersSection'
import { SharedAgentsSection } from '@/components/muse/SharedAgentsSection'
import { ProxySection } from '@/components/muse/ProxySection'
import { QuotaSection } from '@/components/muse/QuotaSection'
import { SchedulesSection } from '@/components/muse/SchedulesSection'
import { SessionsSection } from '@/components/muse/SessionsSection'
import { BotAvatar } from '@/components/ui/Avatar'
import { BotAvatarEditorDialog } from '@/components/ui/BotAvatarEditorDialog'
import { IconButton } from '@/components/ui/IconButton'
import { InlineEdit } from '@/components/ui/InlineEdit'
import { useGlide } from '@/hooks/useGlide'
import { cn } from '@/lib/cn'
import { getBotAccounts, getBotStatus } from '@/lib/selectors'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'
import { AccountList } from './AccountList'
import { MemoryEditor } from './MemoryEditor'
import { EmptyLine, Section, SectionsCollapsed } from './Section'
import {
  getPlatformInspector,
  resolveInspectorTab,
  type InspectorTabId,
  type InspectorTabSpec
} from './platformInspector'
import { t } from '@/lib/i18n'

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  busy: 'Busy',
  attention: 'Needs attention',
  offline: 'Offline',
  error: 'Error'
}
const STATUS_DOT: Record<string, string> = {
  online: 'bg-status-online',
  busy: 'bg-status-attention',
  attention: 'bg-status-attention',
  offline: 'bg-ink-muted',
  error: 'bg-status-error'
}

/** Compact header row: avatar (click: appearance editor), name (click: rename), status, platform & protocol badge. */
function BotHero({ bot }: { bot: Bot }) {
  const accounts = useBotStore((s) => s.accounts)
  const renameBot = useBotStore((s) => s.renameBot)
  const typing = useBotStore((s) => s.typing[bot.id] === true)
  const [editing, setEditing] = useState(false)
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false)
  const inspector = getPlatformInspector(bot.platformId)
  const status = getBotStatus(bot, accounts)

  return (
    <div className="flex items-center gap-3 px-4 pb-3">
      <button
        type="button"
        onClick={() => setAvatarEditorOpen(true)}
        aria-label={t('Bot appearance')}
        title={t('Bot appearance')}
        className="press-icon shrink-0 rounded-full"
      >
        <span key={`${bot.avatar ?? 'mark'}:${bot.avatarShape ?? ''}:${bot.avatarColor ?? ''}`} className="inline-flex animate-mark-pop">
          <BotAvatar
            emoji={bot.emoji}
            seed={bot.id}
            avatar={bot.avatar}
            avatarShape={bot.avatarShape}
            avatarColor={bot.avatarColor}
            platformId={bot.platformId}
            status={status}
            isWorking={typing}
            followPointer
            size="md"
            ringClassName="ring-main"
          />
        </span>
      </button>
      <BotAvatarEditorDialog bot={bot} open={avatarEditorOpen} onOpenChange={setAvatarEditorOpen} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <InlineEdit
            value={bot.name}
            label={t('Bot name')}
            className="h-7 text-[15px] font-semibold"
            onCommit={(name) => renameBot(bot.id, name)}
            onDone={() => setEditing(false)}
          />
        ) : (
          <p className="truncate text-[15px] leading-5 font-semibold tracking-tight text-ink">{bot.name}</p>
        )}
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-ink-secondary">
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status] ?? 'bg-ink-muted')} />
          <span className="shrink-0">{t(STATUS_LABEL[status] ?? status)}</span>
          <span className="truncate text-ink-muted">· {inspector.displayName}</span>
        </p>
      </div>
      <IconButton label={t('Rename')} className="shrink-0" onClick={() => setEditing(true)}>
        <Pencil />
      </IconButton>
    </div>
  )
}

function Tabs({
  tabs,
  platformKey,
  tab,
  onChange
}: {
  tabs: ReadonlyArray<InspectorTabSpec>
  platformKey: string
  tab: InspectorTabId
  onChange: (tab: InspectorTabId) => void
}) {
  const glide = useGlide<HTMLDivElement>(`${platformKey}:${tab}:${tabs.length}`, { axis: 'x' })
  return (
    <div
      ref={glide.ref}
      role="tablist"
      aria-label={t('Details panels')}
      className="relative mx-4 flex rounded-[10px] bg-hover p-0.5"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowRight' ? 1 : -1
        const idx = Math.max(0, tabs.findIndex((item) => item.id === tab))
        const next = tabs[(idx + delta + tabs.length) % tabs.length]!.id
        onChange(next)
        glide.ref.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
      }}
    >
      {glide.thumb && (
        <span aria-hidden className="absolute top-0.5 bottom-0.5 rounded-lg bg-surface shadow-float" style={glide.thumb} />
      )}
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-tab={id}
          aria-selected={tab === id}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => onChange(id)}
          className={cn(
            'press relative h-[30px] min-w-0 flex-1 rounded-lg px-1 text-[12px] tracking-tight whitespace-nowrap transition-colors',
            tab === id ? 'text-ink' : 'text-ink-secondary hover:text-ink'
          )}
        >
          {t(label)}
        </button>
      ))}
    </div>
  )
}

function NotesAndProxyCollapsed({
  bot,
  onUpdateNotes,
  extraBeforeProxy
}: {
  bot: Bot
  onUpdateNotes: (botId: string, notes: string) => void
  extraBeforeProxy?: React.ReactNode
}) {
  return (
    <SectionsCollapsed>
      {extraBeforeProxy}
      {bot.activeAccountId && <ProxySection accountId={bot.activeAccountId} />}
      <Section title={t('Notes')} count={(bot.memory ?? []).length || undefined}>
        <div className="flex flex-col gap-2">
          <MemoryEditor bot={bot} />
          <textarea
            value={bot.notes}
            onChange={(event) => onUpdateNotes(bot.id, event.target.value)}
            placeholder={t('Private notes')}
            aria-label={t('Notes')}
            rows={2}
            className="block w-full resize-none border-t border-line pt-2 bg-transparent text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-muted"
          />
        </div>
      </Section>
    </SectionsCollapsed>
  )
}

function SignInRequiredSection({
  title,
  platformName,
  bot,
  accounts
}: {
  title: string
  platformName: string
  bot: Bot
  accounts: BotAccount[]
}) {
  return (
    <>
      <Section title={title}>
        <EmptyLine>{t('Sign in to {name} to use this panel', { name: platformName })}</EmptyLine>
      </Section>
      <Section title={t('Accounts')} flush>
        <AccountList bot={bot} accounts={accounts} />
      </Section>
    </>
  )
}

export function InfoPanel() {
  const bot = useBotStore((s) => s.bots.find((b) => b.id === s.selectedBotId))
  const accountMap = useBotStore((s) => s.accounts)
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const updateNotes = useBotStore((s) => s.updateNotes)
  const [requestedTab, setTab] = useState<InspectorTabId>('overview')

  const coordinationRoom = useRooms((s) => s.rooms.find((r) => r.coordinatorId === bot?.id && r.coordinatorId))

  const accounts = useMemo(() => (bot ? getBotAccounts(bot, accountMap) : []), [bot, accountMap])
  const inspector = bot ? getPlatformInspector(bot.platformId) : null
  const activeTab = bot ? resolveInspectorTab(bot.platformId, requestedTab) : 'overview'
  const activeTabLabel =
    inspector?.tabs.find((item) => item.id === activeTab)?.label ?? 'Overview'

  return (
    <>
      <PaneHeader className="pr-3">
        <IconButton
          label={t('Close details')}
          shortcut={shortcutLabel('I')}
          className="no-drag ml-auto"
          onClick={toggleInfoPanel}
        >
          <X />
        </IconButton>
      </PaneHeader>

      {bot && inspector && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <BotHero key={bot.id} bot={bot} />
          <Tabs
            tabs={inspector.tabs}
            platformKey={bot.platformId}
            tab={activeTab}
            onChange={setTab}
          />

          <div key={`${bot.id}:${activeTab}`} className="animate-veil-in">
            {activeTab === 'overview' ? (
              <>
                <Section title="协作调度">
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" checked={Boolean(coordinationRoom)}
                      onChange={(e) => setRoomAdministrator(bot.id, e.target.checked)} />
                    设为管理员
                  </label>
                  {coordinationRoom && (
                    <button type="button" className="mt-2 text-[12px] text-accent-600"
                      onClick={() => useBotStore.getState().selectBot(coordinationRoom.id)}>
                      打开调度对话
                    </button>
                  )}
                </Section>
                {bot.platformId === 'meta-muse' && bot.activeAccountId && (
                  <>
                    <QuotaSection accountId={bot.activeAccountId} />
                    <ApprovalsSection accountId={bot.activeAccountId} />
                    <SessionsSection accountId={bot.activeAccountId} />
                    <SchedulesSection accountId={bot.activeAccountId} />
                  </>
                )}
                {bot.platformId === 'grok' && bot.activeAccountId && (
                  <>
                    <GrokAccountAuthSection accountId={bot.activeAccountId} />
                    <ApprovalsSection accountId={bot.activeAccountId} platformId="grok" />
                    <GrokSessionsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                      botId={bot.id}
                    />
                    <GrokTasksAndSubagentsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                    />
                    <GrokAutomationsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                    />
                    <GrokMemoriesAndSkillsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                    />
                  </>
                )}
                {bot.platformId === 'hark' && bot.activeAccountId && (
                  <>
                    <HarkBillingSection accountId={bot.activeAccountId} />
                    <HarkHomeCardsSection accountId={bot.activeAccountId} botId={bot.id} />
                    <HarkConversationsSection accountId={bot.activeAccountId} botId={bot.id} />
                    <HarkScheduledTasksSection accountId={bot.activeAccountId} />
                  </>
                )}
                {bot.platformId === 'dot' && bot.activeAccountId && (
                  <>
                    <DotCredentialsAndQuotaSection accountId={bot.activeAccountId} botId={bot.id} />
                    <DotOrbitProfilesSection accountId={bot.activeAccountId} botId={bot.id} />
                  </>
                )}
                {bot.platformId === 'hermes' && bot.activeAccountId && (
                  <>
                    <HermesServerSection accountId={bot.activeAccountId} />
                    <ApprovalsSection accountId={bot.activeAccountId} platformId="hermes" />
                    <HermesSessionsSection accountId={bot.activeAccountId} botId={bot.id} />
                    <HermesJobsSection accountId={bot.activeAccountId} />
                  </>
                )}
                {bot.platformId === 'antigravity' && bot.activeAccountId && (
                  <>
                    <AntigravityAccountAndModelSection accountId={bot.activeAccountId} />
                    <AntigravityConversationsSection
                      botId={bot.id}
                      accountId={bot.activeAccountId}
                      activeSessionId={bot.activeSessionId}
                    />
                  </>
                )}
                {bot.platformId === 'cue' && bot.activeAccountId && (
                  <>
                    <CueAccountAuthSection accountId={bot.activeAccountId} />
                    <CueOverviewSection bot={bot} account={accountMap[bot.activeAccountId]} />
                    <CueSessionsSection accountId={bot.activeAccountId} bot={bot} />
                    <CueAutomationsSection accountId={bot.activeAccountId} />
                    <CueSkillsSection accountId={bot.activeAccountId} />
                  </>
                )}

                <Section title={t('Accounts')} flush>
                  <AccountList bot={bot} accounts={accounts} />
                </Section>

                {bot.platformId === 'meta-muse' && bot.activeAccountId && (
                  <ConnectorsSection accountId={bot.activeAccountId} />
                )}
                {bot.platformId === 'hark' && bot.activeAccountId && (
                  <HarkConnectorsSection accountId={bot.activeAccountId} />
                )}

                <NotesAndProxyCollapsed
                  bot={bot}
                  onUpdateNotes={updateNotes}
                  extraBeforeProxy={
                    bot.platformId === 'meta-muse' && bot.activeAccountId ? (
                      <>
                        <GoalsSection accountId={bot.activeAccountId} />
                        <MemorySection accountId={bot.activeAccountId} />
                        <SkillsSection accountId={bot.activeAccountId} />
                      </>
                    ) : undefined
                  }
                />
              </>
            ) : !bot.activeAccountId ? (
              <SignInRequiredSection
                title={t(activeTabLabel)}
                platformName={inspector.displayName}
                bot={bot}
                accounts={accounts}
              />
            ) : activeTab === 'memory' ? (
              <DotGoalAndThreadsSection accountId={bot.activeAccountId} />
            ) : activeTab === 'library' ? (
              bot.platformId === 'meta-muse' ? (
                <FilesSection accountId={bot.activeAccountId} />
              ) : bot.platformId === 'grok' ? (
                <GrokFilesSection
                  accountId={bot.activeAccountId}
                  agentId={bot.selectedAgentId}
                />
              ) : bot.platformId === 'cue' ? (
                <CueFilesSection
                  accountId={bot.activeAccountId}
                  sessionId={bot.activeSessionId}
                />
              ) : bot.platformId === 'hark' ? (
                <HarkLibrarySection botId={bot.id} key={bot.activeAccountId + (bot.activeSessionId ?? '')} accountId={bot.activeAccountId} />
              ) : (
                <DotLibrarySection accountId={bot.activeAccountId} />
              )
            ) : activeTab === 'computer' ? (
              bot.platformId === 'meta-muse' ? (
                <>
                  <ComputerSection accountId={bot.activeAccountId} />
                  <PermissionsSection accountId={bot.activeAccountId} />
                  <SectionsCollapsed>
                    <AgentDiagnosticSection accountId={bot.activeAccountId} />
                  </SectionsCollapsed>
                </>
              ) : bot.platformId === 'grok' ? (
                <>
                  <GrokComputerSection
                    accountId={bot.activeAccountId}
                    agentId={bot.selectedAgentId}
                  />
                  <GrokConnectorsAndMcpSection
                    accountId={bot.activeAccountId}
                    agentId={bot.selectedAgentId}
                  />
                </>
              ) : bot.platformId === 'cue' ? (
                <>
                  <CueComputerSection
                    accountId={bot.activeAccountId}
                    agentId={bot.selectedAgentId}
                    sessionId={bot.activeSessionId}
                  />
                  <CueConnectorsSection accountId={bot.activeAccountId} />
                </>
              ) : bot.platformId === 'hermes' ? (
                <>
                  <HermesSkillsSection accountId={bot.activeAccountId} />
                  <HermesToolsetsSection accountId={bot.activeAccountId} />
                </>
              ) : bot.platformId === 'antigravity' ? (
                <AntigravityEnvironmentsSection accountId={bot.activeAccountId} />
              ) : (
                <HarkComputerSection key={bot.activeAccountId + (bot.activeSessionId ?? '')} accountId={bot.activeAccountId} botId={bot.id} />
              )
            ) : (
              /* activeTab === 'members' — Muse Sharing / Grok & Cue Agents / Hark Devices / Antigravity Agents */
              <>
                {bot.platformId === 'meta-muse' ? (
                  <>
                    <SharedAgentsSection accountId={bot.activeAccountId} />
                    <InviteSection accountId={bot.activeAccountId} />
                    <SectionsCollapsed>
                      <PeersSection accountId={bot.activeAccountId} />
                    </SectionsCollapsed>
                  </>
                ) : bot.platformId === 'grok' ? (
                  <>
                    <GrokAgentsAndRoomsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                      botId={bot.id}
                    />
                    <GrokMembersSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                    />
                  </>
                ) : bot.platformId === 'cue' ? (
                  <>
                    <CueAgentsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                      botId={bot.id}
                    />
                    <CueAgentContactsSection
                      accountId={bot.activeAccountId}
                      agentId={bot.selectedAgentId}
                      sessionId={bot.activeSessionId}
                    />
                  </>
                ) : bot.platformId === 'antigravity' ? (
                  <AntigravityAgentsSection accountId={bot.activeAccountId} />
                ) : (
                  <HarkInviteAndSessionsSection accountId={bot.activeAccountId} />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
