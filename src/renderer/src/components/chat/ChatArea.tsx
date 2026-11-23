import { HarkBrowserCard } from '../hark/HarkBrowserCard'
import { useCallback, useMemo } from 'react'
import type { AttachmentMeta, PlatformId } from '@adapters/types'
import { ArkDrawerToggleSvg } from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { getPlatformInspector } from '@/components/info/platformInspector'
import { OnboardingStage } from '@/components/onboarding/OnboardingGuide'
import { getBotAccounts } from '@/lib/selectors'
import { useBotStore } from '@/store/botStore'
import type { Bot, ChatMessage } from '@/types'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { WebSessionPane } from './WebSessionPane'
import { DocumentCanvasPane } from './NativeDocumentDialog'
import { ShareConversationDialog } from './ShareConversationDialog'
import { t } from '@/lib/i18n'
import { ChatApprovals } from './ApprovalCard'

const NO_MESSAGES: ChatMessage[] = []

const STARTERS = [
  t('What can you help me with?'),
  t('Draft a short status update for the team'),
  t('Brainstorm five names for a side project')
]

const PLATFORM_LOGIN_LABELS: Record<PlatformId, string> = {
  'meta-muse': '使用 Muse 登录',
  grok: '使用 Grok Bot 登录',
  hark: '使用 Hark 登录',
  dot: '使用 ChatGPT Dot 登录',
  hermes: '配置 Hermes 连接',
  antigravity: '使用 Antigravity 登录',
  cue: '使用 Cue 登录'
}

function ConversationIntro({
  bot,
  canSend,
  needsPlatformLogin,
  onPick,
  onPlatformLogin,
  onOpenInspector
}: {
  bot: Bot
  canSend: boolean
  needsPlatformLogin: boolean
  onPick: (text: string) => void
  onPlatformLogin?: () => void
  onOpenInspector?: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 animate-veil-in flex-col items-center justify-center gap-5 px-8 pb-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <BotAvatar
          emoji={bot.emoji}
          seed={bot.id}
          avatar={bot.avatar}
          avatarShape={bot.avatarShape}
          avatarColor={bot.avatarColor}
          platformId={bot.platformId}
          followPointer
          size="lg"
        />
        <h2 className="text-[17px] leading-6 font-medium tracking-tight text-ink">{bot.name}</h2>
      </div>
      {needsPlatformLogin && onPlatformLogin ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" size="lg" onClick={onPlatformLogin}>
            {t(PLATFORM_LOGIN_LABELS[bot.platformId])}
          </Button>
          {bot.platformId !== 'meta-muse' && onOpenInspector && (
            <Button variant="secondary" size="lg" onClick={onOpenInspector}>
              <ArkDrawerToggleSvg side="right" className="size-4" />
              {t('Import token in right panel')}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex max-w-xl flex-wrap justify-center gap-2">
          {STARTERS.map((starter) => (
            <Button key={starter} size="sm" disabled={!canSend} onClick={() => onPick(starter)} className="h-8 text-[13px] font-normal">
              {starter}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ChatArea() {
  const bot = useBotStore((s) => s.bots.find((b) => b.id === s.selectedBotId))
  const sessionError = useBotStore((s) => s.selectedBotId ? s.hermesSessionErrors[s.selectedBotId] : undefined)
  const accountMap = useBotStore((s) => s.accounts)
  const messages = useBotStore((s) => (s.selectedBotId ? s.messages[s.selectedBotId] : undefined) ?? NO_MESSAGES)
  const typing = useBotStore((s) => (s.selectedBotId ? s.typing[s.selectedBotId] === true : false))
  const sendMessage = useBotStore((s) => s.sendMessage)
  const retryMessage = useBotStore((s) => s.retryMessage)
  const cancelGeneration = useBotStore((s) => s.cancelGeneration)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const openMuseLogin = useBotStore((s) => s.openMuseLogin)
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const openHarkLogin = useBotStore((s) => s.openHarkLogin)
  const openDotLogin = useBotStore((s) => s.openDotLogin)
  const openAntigravityLogin = useBotStore((s) => s.openAntigravityLogin)
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const webSessionOpen = useBotStore((s) => s.webSessionOpen)
  const hasBots = useBotStore((s) => s.bots.length > 0)
  const infoPanelOpen = useBotStore((s) => s.infoPanelOpen)
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const activeDocument = useBotStore((s) => s.activeDocument)
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)

  const accounts = useMemo(() => (bot ? getBotAccounts(bot, accountMap) : []), [bot, accountMap])
  const activeAccount = bot ? accountMap[bot.activeAccountId] : undefined
  const botId = bot?.id

  const onSend = useCallback(
    (text: string, attachments: AttachmentMeta[] = []) => {
      if (botId) void sendMessage(botId, text, attachments)
    },
    [botId, sendMessage]
  )
  const onRetry = useCallback(
    (messageId: string) => {
      if (botId) void retryMessage(botId, messageId)
    },
    [botId, retryMessage]
  )
  const onCancel = useCallback(() => {
    if (botId) void cancelGeneration(botId)
  }, [botId, cancelGeneration])
  const onConnect = useCallback((accountId: string) => void connectAccount(accountId), [connectAccount])
  const onMuseLogin = useCallback((accountId: string) => void openMuseLogin(accountId), [openMuseLogin])
  const onGrokLogin = useCallback((accountId: string) => void openGrokLogin(accountId), [openGrokLogin])
  const onHarkLogin = useCallback((accountId: string) => void openHarkLogin(accountId), [openHarkLogin])
  const onDotLogin = useCallback((accountId: string) => void openDotLogin(accountId), [openDotLogin])
  const onAntigravityLogin = useCallback(
    (accountId: string) => void openAntigravityLogin(accountId),
    [openAntigravityLogin]
  )
  const onCueLogin = useCallback(
    (accountId: string) => void openCueLogin(accountId, false),
    [openCueLogin]
  )

  if (!bot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="drag-region h-[52px] shrink-0" />
        {hasBots ? (
          <div className="flex flex-1 animate-veil-in flex-col items-center justify-center gap-4 pb-[52px]">
            <p className="text-[13px] text-ink-muted">{t('Select a bot')}</p>
          </div>
        ) : (
          <OnboardingStage />
        )}
      </div>
    )
  }

  // Signed-out accounts on all 4 platforms offer direct partition login; errors and approvals surface as themselves.
  const needsPlatformLogin = !!activeAccount && activeAccount.status === 'offline'

  const triggerActiveAccountLogin = () => {
    if (!activeAccount) return
    switch (bot.platformId) {
      case 'meta-muse':
        return onMuseLogin(activeAccount.id)
      case 'grok':
        return onGrokLogin(activeAccount.id)
      case 'hark':
        return onHarkLogin(activeAccount.id)
      case 'dot':
        return onDotLogin(activeAccount.id)
      case 'hermes':
        useBotStore.getState().setSettingsOpen(true, 'hermes-accounts')
        return
      case 'antigravity':
        return onAntigravityLogin(activeAccount.id)
      case 'cue':
        return onCueLogin(activeAccount.id)
    }
  }

  const canSend =
    activeAccount?.status === 'online' ||
    activeAccount?.status === 'busy' ||
    activeAccount?.status === 'attention'
  const showWebSession =
    webSessionOpen && !!activeAccount && getPlatformInspector(bot.platformId).supportsWebSession

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader bot={bot} accounts={accounts} />
        {sessionError && (
          <p role="alert" className="mx-6 my-2 text-[13px] text-status-error">
            {t('Could not start a new conversation. {reason}', { reason: sessionError })}
          </p>
        )}
        {showWebSession && activeAccount ? (
          <WebSessionPane key={`${bot.id}:${activeAccount.id}`} bot={bot} account={activeAccount} />
        ) : (
          <>
            {bot.platformId === 'hark' && activeAccount && canSend && (
              <HarkBrowserCard key={JSON.stringify([activeAccount.id, bot.activeSessionId])}
                accountId={activeAccount.id} sessionId={bot.activeSessionId} />
            )}
            {messages.length === 0 && !typing ? (
              <ConversationIntro
                bot={bot}
                canSend={canSend}
                needsPlatformLogin={needsPlatformLogin}
                onPick={(text) => onSend(text)}
                onPlatformLogin={activeAccount ? triggerActiveAccountLogin : undefined}
                onOpenInspector={() => {
                  if (!infoPanelOpen) toggleInfoPanel()
                }}
              />
            ) : (
              <MessageList bot={bot} messages={messages} accounts={accounts} typing={typing} onRetry={onRetry} />
            )}
            {(bot.platformId === 'meta-muse' || bot.platformId === 'grok') && activeAccount && (
              <ChatApprovals
                accountId={activeAccount.id}
                platformId={bot.platformId}
                agentId={bot.selectedAgentId}
              />
            )}
            <Composer
              key={bot.id}
              bot={bot}
              account={activeAccount}
              typing={typing}
              onSend={onSend}
              onCancel={onCancel}
              onConnect={onConnect}
              onMuseLogin={onMuseLogin}
              onGrokLogin={onGrokLogin}
              onHarkLogin={onHarkLogin}
              onDotLogin={onDotLogin}
              onAntigravityLogin={onAntigravityLogin}
              onCueLogin={onCueLogin}
              hideNotice={needsPlatformLogin && messages.length === 0 && !typing}
            />
          </>
        )}
      </div>
      {activeDocument && !showWebSession && (
        <DocumentCanvasPane
          target={activeDocument}
          onClose={() => setActiveDocument(null)}
          onOpenNestedDoc={(next) => setActiveDocument(next)}
        />
      )}
      <ShareConversationDialog bot={bot} messages={messages} />
    </div>
  )
}
