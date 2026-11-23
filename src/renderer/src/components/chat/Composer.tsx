import { WorkspaceTools } from '@/rooms/WorkspaceTools'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { AttachmentMeta } from '@adapters/types'
import { ArrowUp, CornerDownRight, FileText, Film, Loader2, LogIn, Music, Plus, PlugZap, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'
import { t } from '@/lib/i18n'
import { createAttachmentDraft, type DraftAttachment } from './attachmentDraft'

interface ComposerProps {
  bot: Bot
  account: BotAccount | undefined
  typing?: boolean
  onSend: (text: string, attachments: AttachmentMeta[]) => void
  onCancel?: () => void
  onConnect: (accountId: string) => void
  onMuseLogin?: (accountId: string) => void
  onGrokLogin?: (accountId: string) => void
  onHarkLogin?: (accountId: string) => void
  onDotLogin?: (accountId: string) => void
  onAntigravityLogin?: (accountId: string) => void
  onCueLogin?: (accountId: string) => void
  /** The empty conversation already shows its own sign-in action. */
  hideNotice?: boolean
}

const MAX_HEIGHT_PX = 200

function ConnectionNotice({
  account,
  onConnect,
  onMuseLogin,
  onGrokLogin,
  onHarkLogin,
  onDotLogin,
  onAntigravityLogin,
  onCueLogin
}: {
  account: BotAccount
  onConnect: () => void
  onMuseLogin?: () => void
  onGrokLogin?: () => void
  onHarkLogin?: () => void
  onDotLogin?: () => void
  onAntigravityLogin?: () => void
  onCueLogin?: () => void
}) {
  const isError = account.status === 'error'
  const isMuse = account.platformId === 'meta-muse'
  const isGrok = account.platformId === 'grok'
  const isHark = account.platformId === 'hark'
  const isDot = account.platformId === 'dot'
  const isHermes = account.platformId === 'hermes'
  const isAntigravity = account.platformId === 'antigravity'
  const isCue = account.platformId === 'cue'
  return (
    <div
      className={cn(
        'mb-2 flex animate-step-in flex-wrap items-center gap-2 rounded-xl border py-1.5 pr-1.5 pl-3',
        isError ? 'border-status-error/20 bg-status-error/5 text-status-error' : 'border-line bg-surface text-ink'
      )}
      role="status"
    >
      {isMuse || isHark || isDot || isAntigravity || isCue ? (
        <LogIn className="size-4 shrink-0 text-accent-600" aria-hidden />
      ) : (
        <PlugZap className="size-4 shrink-0 text-ink-muted" aria-hidden />
      )}
      <span className="min-w-0 flex-1 text-[13px]">
        {isError
          ? (account.statusDetail ?? '连接出错')
          : isMuse
            ? '登录 Muse 后即可发消息'
            : isGrok
              ? '登录 Grok Bot 后即可发消息'
              : isHark
                ? '登录 Hark 后即可发消息'
                : isDot
                  ? '登录 ChatGPT Dot 或在右侧导入 AT / RT 后即可发消息'
                  : isHermes
                    ? '连接 Hermes API Server（hermes gateway）后即可发消息'
                    : isAntigravity
                      ? '登录 Google Antigravity（antigravity.google.com）后即可发消息'
                      : isCue
                        ? '登录 Cue（cue.im）后即可发消息'
                        : '账号未连接'}
      </span>
      {isMuse && onMuseLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onMuseLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Muse 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            已完成登录
          </Button>
        </>
      ) : isHark && onHarkLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onHarkLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? (account.statusDetail ?? '处理中…') : '使用 Hark 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新会话
          </Button>
        </>
      ) : isDot && onDotLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onDotLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Dot 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新连接
          </Button>
        </>
      ) : isAntigravity && onAntigravityLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onAntigravityLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Antigravity 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新会话
          </Button>
        </>
      ) : isCue && onCueLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onCueLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? (account.statusDetail ?? '登录中…') : '使用 Cue 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新会话
          </Button>
        </>
      ) : isGrok && onGrokLogin ? (
        <>
          <Button size="sm" variant="primary" onClick={onGrokLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Grok Bot 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新连接
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" onClick={onConnect} disabled={account.pending}>
          {account.pending && <Loader2 className="animate-spin" aria-hidden />}
          {account.pending ? '连接中' : isError ? '重试' : '连接'}
        </Button>
      )}
    </div>
  )
}

export function Composer({ bot, account, typing = false, onSend, onCancel, onConnect, onMuseLogin, onGrokLogin, onHarkLogin, onDotLogin, onAntigravityLogin, onCueLogin, hideNotice = false }: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [draft] = useState(() => createAttachmentDraft(setAttachments))
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replyTarget = useBotStore((s) => s.replyingTo[bot.id])
  const setReplyTarget = useBotStore((s) => s.setReplyTarget)

  const connected = account?.status === 'online' || account?.status === 'busy' || account?.status === 'attention'
  const [multiline, setMultiline] = useState(false)
  const expanded = multiline || attachments.length > 0 || Boolean(replyTarget)
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const canSend = connected && hasContent && attachments.every((entry) => entry.status === 'ready')

  // The palette asks for focus after jumping to a bot.
  useEffect(() => {
    const focus = () => textareaRef.current?.focus()
    window.addEventListener('bothub:focus-composer', focus)
    return () => window.removeEventListener('bothub:focus-composer', focus)
  }, [])

  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    setMultiline(el.scrollHeight > 40)
  }

  const submit = () => {
    const sendable = draft.forSend()
    if (!connected || !sendable || (!text.trim() && sendable.length === 0)) return
    onSend(text, sendable)
    setText('')
    draft.clear()
    requestAnimationFrame(resize)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && replyTarget) {
      event.preventDefault()
      setReplyTarget(bot.id, null)
      return
    }
    // Respect IME composition (e.g. Chinese/Japanese input) before sending.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const addFiles = (files: FileList | File[] | null) => {
    if (files) void draft.add(files)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  return (
    <div className="shrink-0 px-6 pt-2 pb-5">
      <div className="mx-auto max-w-[860px] px-2">
        {account && !connected && !hideNotice && (
          <ConnectionNotice
            account={account}
            onConnect={() => onConnect(account.id)}
            onMuseLogin={onMuseLogin ? () => onMuseLogin(account.id) : undefined}
            onGrokLogin={onGrokLogin ? () => onGrokLogin(account.id) : undefined}
            onHarkLogin={onHarkLogin ? () => onHarkLogin(account.id) : undefined}
            onDotLogin={onDotLogin ? () => onDotLogin(account.id) : undefined}
            onAntigravityLogin={onAntigravityLogin ? () => onAntigravityLogin(account.id) : undefined}
            onCueLogin={onCueLogin ? () => onCueLogin(account.id) : undefined}
          />
        )}

        <div
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'border border-line-strong bg-surface p-[7px] shadow-card transition-[border-color,box-shadow,border-radius] duration-200',
            expanded ? 'rounded-[18px]' : 'rounded-[22px]',
            'focus-within:border-ink/20',
            dragging && 'border-accent-600 ring-4 ring-accent-100'
          )}
        >
          {replyTarget && (
            <div className="mb-1.5 flex items-center justify-between gap-2 rounded-xl border border-line bg-sunken/50 px-2.5 py-1.5 text-[12px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <CornerDownRight className="size-3.5 shrink-0 text-accent-600" aria-hidden />
                <span className="shrink-0 font-medium text-ink-secondary">
                  {replyTarget.role === 'user' ? '引用自己' : `引用 ${bot.name}`}：
                </span>
                <span className="truncate text-ink">{replyTarget.quote}</span>
              </div>
              <button
                type="button"
                aria-label="取消引用"
                onClick={() => setReplyTarget(bot.id, null)}
                className="press-icon grid size-5 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-active hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 px-1 pt-0.5 pb-1.5" aria-label={t('Attachments')}>
              {attachments.map(({ file, status }) => {
                const image = file.mimeType.startsWith('image/')
                const isImg = image && status === 'ready'
                const isVideo = file.mimeType.startsWith('video/')
                const isAudio = file.mimeType.startsWith('audio/')
                const invalid = status !== 'ready' && status !== 'reading'
                const detail = {
                  reading: t('Reading attachment…'),
                  ready: formatBytes(file.size),
                  'too-large': t('File exceeds {limit} MB', { limit: image ? 20 : 50 }),
                  empty: t('Empty file'),
                  'read-failed': t('Could not read file')
                }[status]
                return (
                  <li
                    key={file.id}
                    className={cn(
                      'flex animate-mark-pop items-center gap-2 rounded-xl border border-line/70 bg-hover/80 py-1 pr-1.5 pl-1.5 text-[12px]',
                      invalid && 'border-status-error/40 bg-status-error/5'
                    )}
                  >
                    {isImg ? (
                      <img
                        src={`data:${file.mimeType};base64,${file.dataBase64}`}
                        alt={file.name}
                        className="size-8 shrink-0 rounded-lg object-cover ring-1 ring-line/60"
                      />
                    ) : (
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface text-accent-600">
                        {status === 'reading' ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : isVideo ? (
                          <Film className="size-3.5" aria-hidden />
                        ) : isAudio ? (
                          <Music className="size-3.5" aria-hidden />
                        ) : (
                          <FileText className="size-3.5 text-ink-secondary" aria-hidden />
                        )}
                      </span>
                    )}
                    <div className="min-w-0">
                      <span className="block max-w-40 truncate font-medium text-ink">{file.name}</span>
                      <span
                        className={cn('block text-[11px] tabular-nums', invalid ? 'text-status-error' : 'text-ink-muted')}
                        aria-live="polite"
                      >
                        {detail}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={t('Remove {name}', { name: file.name })}
                      onClick={() => draft.remove(file.id)}
                      className="press-icon grid size-5 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-active hover:text-ink"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="flex items-end gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <IconButton label={t('Attach files')} onClick={() => fileInputRef.current?.click()}>
              <Plus />
            </IconButton>
            <WorkspaceTools
              key={bot.id + ':' + bot.activeAccountId}
              scope={bot.id + ':' + bot.activeAccountId}
              recipient={bot.name}
              variant="popover"
              hermesAccount={bot.platformId === 'hermes' ? bot.activeAccountId : undefined}
              append={({ label, text: result }) => {
                setText((prev) => [prev, `[${label}]\n${result}`].filter(Boolean).join('\n\n'))
                requestAnimationFrame(() => {
                  resize()
                  textareaRef.current?.focus()
                })
              }}
            />
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(event) => {
                setText(event.target.value)
                resize()
              }}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                if (event.clipboardData.files.length > 0) {
                  event.preventDefault()
                  addFiles(event.clipboardData.files)
                }
              }}
              placeholder={t('Message {name}', { name: bot.name })}
              aria-label={`Message ${bot.name}`}
              className="block max-h-[200px] min-h-8 flex-1 resize-none bg-transparent px-1 py-[5px] text-[14px] leading-[22px] text-ink outline-none placeholder:text-ink-muted"
            />
            {typing && onCancel && !hasContent ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label={t('Stop generating')}
                title={t('Stop generating')}
                className="press-icon grid size-8 shrink-0 place-items-center rounded-full bg-ink text-canvas hover:bg-ink/85"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label={t('Send message')}
                title={t('Send (Enter)')}
                className={cn(
                  'press-icon grid size-8 shrink-0 place-items-center rounded-full',
                  canSend ? 'bg-accent-600 text-white hover:bg-accent-700' : 'bg-hover text-ink-faint'
                )}
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
