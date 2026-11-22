import { useEffect, useState } from 'react'
import { getPlatform } from '@adapters/platforms'
import { adapterRegistry } from '@adapters/registry'
import { ArrowRightLeft, ArrowUpRight, Pencil, RotateCcw, Trash2, UserMinus, X } from 'lucide-react'
import { Section } from '@/components/info/Section'
import { PaneHeader } from '@/components/layout/PaneHeader'
import {
  ArkExportDocSvg,
  ArkPromptSparkSvg,
  ArkRelayOrbSvg,
  ArkSlackWeaveSvg,
  ArkWorkspaceVaultSvg
} from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { NumberStepper } from '@/components/ui/Controls'
import { IconButton } from '@/components/ui/IconButton'
import { InlineEdit } from '@/components/ui/InlineEdit'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { cn } from '@/lib/cn'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import { roomMarkdown, type CollabRoom } from './model'
import { RoomAvatarCluster } from './RoomAvatarCluster'
import {
  clearRoomTranscript,
  deleteRoom,
  moveMemberToRoom,
  removeMember,
  renameRoom,
  updateRoomConfig,
  useRooms
} from './roomStore'
import { SlackPanel } from './SlackPanel'
import { WorkspaceTools } from './WorkspaceTools'

type RoomTab = 'overview' | 'workspace' | 'slack'

export function exportRoomMarkdownFile(room: CollabRoom) {
  const url = URL.createObjectURL(new Blob([roomMarkdown(room)], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${room.title}.md`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function RoomInspectorPanel({ room }: { room: CollabRoom }) {
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const selectBot = useBotStore((s) => s.selectBot)
  const speaker = useRooms((s) => s.speakers[room.id])
  const allRooms = useRooms((s) => s.rooms)
  const [tab, setTab] = useState<RoomTab>('overview')
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [movingBotId, setMovingBotId] = useState<string | null>(null)
  const [targetRoomId, setTargetRoomId] = useState('')
  const [memberFeedback, setMemberFeedback] = useState<{
    kind: 'error' | 'success'
    text: string
  } | null>(null)

  useEffect(() => {
    setEditing(false)
    setConfirmDelete(false)
    setMovingBotId(null)
    setTargetRoomId('')
    setMemberFeedback(null)
  }, [room.id])

  const otherRooms = allRooms.filter((r) => r.id !== room.id)
  const hermesAccount = room.members.find((m) => m.platform === 'hermes')?.accountId

  return (
    <>
      <PaneHeader className="pr-3">
        <IconButton
          label="关闭"
          shortcut={shortcutLabel('I')}
          className="no-drag ml-auto"
          onClick={toggleInfoPanel}
        >
          <X />
        </IconButton>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto pb-5">
        {/* Quiet Room Hero */}
        <div className="flex items-center gap-3 px-4 pb-3">
          <RoomAvatarCluster
            members={room.members}
            speakingName={speaker}
            size="md"
            ringClassName="ring-main"
          />
          <div className="min-w-0 flex-1">
            {editing ? (
              <InlineEdit
                value={room.title}
                label="群聊名称"
                className="h-7 text-[15px] font-semibold"
                onCommit={(next) => renameRoom(room.id, next)}
                onDone={() => setEditing(false)}
              />
            ) : (
              <p className="truncate text-[15px] leading-5 font-semibold tracking-tight text-ink">
                {room.title}
              </p>
            )}
            <p className="mt-0.5 text-[12px] text-ink-muted">{room.members.length} 位成员</p>
          </div>
          <IconButton label="重命名" className="shrink-0" onClick={() => setEditing(true)}>
            <Pencil />
          </IconButton>
        </div>

        {/* Gliding Tabs */}
        <div className="px-4 pb-1">
          <SegmentedControl<RoomTab>
            value={tab}
            onValueChange={setTab}
            fullWidth
            size="xs"
            aria-label="协作设置"
            options={[
              { value: 'overview', label: '编排', icon: <ArkRelayOrbSvg /> },
              { value: 'workspace', label: '工作区', icon: <ArkWorkspaceVaultSvg /> },
              { value: 'slack', label: 'Slack', icon: <ArkSlackWeaveSvg /> }
            ]}
          />
        </div>

        <div key={`${room.id}:${tab}`} className="animate-veil-in">
          {tab === 'overview' && (
            <>
              <Section title="调度">
                <div className="flex flex-col gap-2.5 text-[12px]">
                  <SegmentedControl<CollabRoom['mode']>
                    value={room.mode}
                    onValueChange={(mode) => updateRoomConfig(room.id, { mode })}
                    fullWidth
                    size="xs"
                    options={[
                      { value: 'auto', label: '自主接力', icon: <ArkPromptSparkSvg /> },
                      { value: 'manual', label: '手动 @' }
                    ]}
                  />

                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-ink-secondary">单轮上限</span>
                    <NumberStepper
                      value={room.limit}
                      onChange={(limit) => updateRoomConfig(room.id, { limit })}
                      min={1}
                      max={24}
                      suffix="轮"
                      aria-label="单轮上限"
                    />
                  </div>
                </div>
              </Section>

              <Section title="成员" count={room.members.length} flush>
                {memberFeedback && (
                  <p
                    role={memberFeedback.kind === 'error' ? 'alert' : 'status'}
                    className={cn(
                      'mx-4 mb-2 rounded-lg px-2.5 py-1.5 text-[11.5px]',
                      memberFeedback.kind === 'error'
                        ? 'bg-status-error/10 text-status-error'
                        : 'bg-status-online/10 text-status-online-ink'
                    )}
                  >
                    {memberFeedback.text}
                  </p>
                )}
                <ul className="flex flex-col gap-0.5 px-2">
                  {room.members.map((m) => {
                    const bot = bots.find((b) => b.id === m.botId)
                    const acc = accounts[m.accountId]
                    const adapterStatus = adapterRegistry.get(m.platform)?.getStatus(m.accountId)
                    const status =
                      acc?.status && acc.status !== 'offline'
                        ? acc.status
                        : adapterStatus && adapterStatus !== 'offline'
                          ? adapterStatus
                          : (acc?.status ?? 'offline')
                    const isSpeaking = speaker === m.name
                    const platform = getPlatform(m.platform)
                    const isMoving = movingBotId === m.botId
                    const cannotRemove = room.members.length <= 1
                    const eligibleTargets = otherRooms.filter(
                      (r) =>
                        r.members.length < 6 &&
                        !r.members.some(
                          (tm) =>
                            tm.botId === m.botId ||
                            tm.name.toLowerCase() === m.name.toLowerCase()
                        )
                    )
                    return (
                      <li
                        key={m.botId}
                        className={cn(
                          'group flex flex-col gap-2 rounded-xl px-2 py-1.5 transition-colors',
                          isSpeaking ? 'bg-accent-50/70' : 'hover:bg-hover'
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <BotAvatar
                            emoji={bot?.emoji ?? '🤖'}
                            seed={bot?.id ?? m.botId}
                            avatar={bot?.avatar}
                            avatarShape={bot?.avatarShape}
                            avatarColor={bot?.avatarColor}
                            platformId={m.platform}
                            status={status}
                            isWorking={isSpeaking}
                            size="xs"
                            ringClassName="ring-main"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-ink">{m.name}</p>
                            <p className="truncate text-[11px] text-ink-muted">
                              {platform.name}
                              {acc?.handle && acc.handle !== m.name ? ` · ${acc.handle}` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            {bot && (
                              <button
                                type="button"
                                title={`打开 ${m.name}`}
                                aria-label={`打开 ${m.name}`}
                                onClick={() => selectBot(bot.id)}
                                className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-active hover:text-ink"
                              >
                                <ArrowUpRight className="size-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              title={
                                cannotRemove
                                  ? '群聊至少保留一位成员'
                                  : `将 ${m.name} 移动到其他群组`
                              }
                              aria-label={`移动 ${m.name}`}
                              disabled={cannotRemove}
                              onClick={() => {
                                setMemberFeedback(null)
                                if (isMoving) {
                                  setMovingBotId(null)
                                  setTargetRoomId('')
                                  return
                                }
                                setMovingBotId(m.botId)
                                setTargetRoomId(eligibleTargets[0]?.id ?? '')
                              }}
                              className={cn(
                                'press-icon grid size-6 place-items-center rounded-full hover:bg-active hover:text-ink',
                                isMoving ? 'bg-active text-ink' : 'text-ink-muted',
                                cannotRemove && 'opacity-50'
                              )}
                            >
                              <ArrowRightLeft className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              title={cannotRemove ? '群聊至少保留一位成员' : `移出 ${m.name}`}
                              aria-label={`移出 ${m.name}`}
                              disabled={cannotRemove}
                              onClick={() => {
                                const res = removeMember(room.id, m.botId)
                                if (!res.ok) {
                                  setMemberFeedback({
                                    kind: 'error',
                                    text: res.error ?? '无法移出成员'
                                  })
                                } else {
                                  if (isMoving) {
                                    setMovingBotId(null)
                                    setTargetRoomId('')
                                  }
                                  setMemberFeedback({
                                    kind: 'success',
                                    text: `已将 ${m.name} 移出当前群聊`
                                  })
                                }
                              }}
                              className={cn(
                                'press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-status-error/15 hover:text-status-error',
                                cannotRemove && 'opacity-50'
                              )}
                            >
                              <UserMinus className="size-3.5" />
                            </button>
                          </div>
                        </div>

                        {isMoving && (
                          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2 text-[11.5px]">
                            {otherRooms.length === 0 ? (
                              <span className="text-ink-muted">暂无其他群聊可转移</span>
                            ) : (
                              <>
                                <select
                                  aria-label={`选择 ${m.name} 的目标群聊`}
                                  value={targetRoomId}
                                  onChange={(e) => setTargetRoomId(e.target.value)}
                                  className="h-7 w-full rounded-md border border-line bg-main px-2 text-[11.5px] text-ink outline-none focus:border-ink/30"
                                >
                                  {otherRooms.map((r) => {
                                    const full = r.members.length >= 6
                                    const dup = r.members.some(
                                      (tm) =>
                                        tm.botId === m.botId ||
                                        tm.name.toLowerCase() === m.name.toLowerCase()
                                    )
                                    const reason = full ? '已满 6 人' : dup ? '已存在' : ''
                                    return (
                                      <option key={r.id} value={r.id} disabled={Boolean(reason)}>
                                        {r.title}
                                        {reason ? `（${reason}）` : ''}
                                      </option>
                                    )
                                  })}
                                </select>
                                <div className="flex items-center justify-end gap-1.5">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setMovingBotId(null)
                                      setTargetRoomId('')
                                    }}
                                    className="h-6 px-2 text-[11px]"
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={!targetRoomId}
                                    onClick={() => {
                                      const target = otherRooms.find((r) => r.id === targetRoomId)
                                      const res = moveMemberToRoom(room.id, m.botId, targetRoomId)
                                      if (!res.ok) {
                                        setMemberFeedback({
                                          kind: 'error',
                                          text: res.error ?? '转移成员失败'
                                        })
                                      } else {
                                        setMovingBotId(null)
                                        setTargetRoomId('')
                                        setMemberFeedback({
                                          kind: 'success',
                                          text: `已将 ${m.name} 转移到「${target?.title ?? '目标群聊'}」`
                                        })
                                      }
                                    }}
                                    className="h-6 px-2.5 text-[11px]"
                                  >
                                    确认转移
                                  </Button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Section>

              <Section title="操作">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={room.messages.length === 0}
                    onClick={() => exportRoomMarkdownFile(room)}
                    className="flex-1"
                  >
                    <ArkExportDocSvg className="size-3.5" />
                    导出
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={room.messages.length === 0}
                    onClick={() => clearRoomTranscript(room.id)}
                    title="清空对话"
                  >
                    <RotateCcw className="size-3.5" />
                    清空
                  </Button>
                  <Button
                    size="sm"
                    variant={confirmDelete ? 'danger-confirm' : 'danger'}
                    onClick={() => {
                      if (!confirmDelete) {
                        setConfirmDelete(true)
                        return
                      }
                      deleteRoom(room.id)
                    }}
                    onBlur={() => setConfirmDelete(false)}
                  >
                    <Trash2 className="size-3.5" />
                    {confirmDelete ? '确认' : '删除'}
                  </Button>
                </div>
              </Section>
            </>
          )}

          {tab === 'workspace' && (
            <WorkspaceTools
              scope={room.id}
              recipient={room.title}
              hermesAccount={hermesAccount}
              variant="inspector"
              append={(value) =>
                window.dispatchEvent(
                  new CustomEvent('botark:room-append-draft', {
                    detail: { roomId: room.id, text: value }
                  })
                )
              }
            />
          )}

          {tab === 'slack' &&
            (room.slackParent ? (
              <Section title="Slack 线程">
                <p className="font-mono text-[11.5px] text-ink-secondary">
                  {room.slackChannel} · {room.slackThread}
                </p>
              </Section>
            ) : (
              <SlackPanel id={room.id} variant="inspector" />
            ))}
        </div>
      </div>
    </>
  )
}
