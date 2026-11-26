import { useEffect, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { getPlatform } from '@adapters/platforms'
import type { PlatformId } from '@adapters/types'
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  FolderOpen,
  Layers,
  MessageSquare,
  Plus,
  Settings,
  X
} from 'lucide-react'
import { getPlatformInspector } from '@/components/info/platformInspector'
import { ArkDrawerToggleSvg, ArkPromptSparkSvg, ArkRelayOrbSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { GrokBotMark, type BotColorId, type BotShape } from '@/components/ui/GrokBotMark'
import { IconButton } from '@/components/ui/IconButton'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { runtimePlatform } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { t, useT } from '@/lib/i18n'
import { useOverlayLock } from '@/lib/overlay'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'

import { hasSeenOnboarding, markOnboardingSeen } from './onboardingState'
export { hasSeenOnboarding, markOnboardingSeen }

type StepId = 'workspace' | 'accounts' | 'workbench'

const STEPS: Array<{ id: StepId; indexLabel: string; title: string }> = [
  { id: 'workspace', indexLabel: '01', title: '工作台布局' },
  { id: 'accounts', indexLabel: '02', title: '导入与管理账号' },
  { id: 'workbench', indexLabel: '03', title: '右侧操作台' }
]

interface PlatformGuideItem {
  id: PlatformId
  title: string
  settingsTab:
    | 'grok-accounts'
    | 'muse-accounts'
    | 'hark-accounts'
    | 'dot-accounts'
    | 'hermes-accounts'
    | 'antigravity-accounts'
    | 'ds-bot-accounts'
  accountRule: string
  importMethods: string
  workbenchCards: Array<{ title: string; summary: string }>
  shape: BotShape
  color: BotColorId
  grokState: string
}

const PLATFORM_GUIDE_ITEMS: PlatformGuideItem[] = [
  {
    id: 'grok',
    title: 'Grok Bot',
    settingsTab: 'grok-accounts',
    accountRule: '1 个账号对应多个 Bot —— 登录一次，账号下的全部 Bot 自动展开在左侧列表',
    importMethods: '支持弹窗登录、默认浏览器一键授权、粘贴 Token / Cookie 导入',
    workbenchCards: [
      { title: '会话与子代理任务', summary: '查看历史对话、后台运行的子任务与自动触发器' },
      { title: '记忆与技能库', summary: '直接编辑当前 Bot 的长期记忆与专属技能' },
      { title: '沙盒电脑与文件', summary: '浏览 Bot 生成的文档产物、云端沙盒终端与连接器' },
      { title: '管理全部 Bot', summary: '在同一账号下直接新建、克隆 Bot 或创建多 Bot 群聊房间' }
    ],
    shape: 'blob',
    color: 'blue',
    grokState: 'happy'
  },
  {
    id: 'meta-muse',
    title: 'Meta Muse',
    settingsTab: 'muse-accounts',
    accountRule: '支持接入多个独立 Muse 账号，并支持邮箱列表批量自动导入',
    importMethods: '支持弹窗登录、邮箱验证码批量导入、代理池自动分配',
    workbenchCards: [
      { title: '额度与动作审批', summary: '实时查看账号额度，处理待确认的操作请求' },
      { title: '多会话与定时任务', summary: '切换历史会话或管理周期执行的自动化任务' },
      { title: '文件库与云电脑', summary: '预览下载工作区文件，随时打开内置网页视图' },
      { title: '目标与长期记忆', summary: '维护当前助手的目标设定、记忆条目与外部连接器' }
    ],
    shape: 'sparkle',
    color: 'violet',
    grokState: 'working'
  },
  {
    id: 'hark',
    title: 'Hark',
    settingsTab: 'hark-accounts',
    accountRule: '每个 Hark 账号对应独立助手，可同时管理多个工作账号',
    importMethods: '支持 Google / 邮箱窗口登录，或直接粘贴 Session Cookie 导入',
    workbenchCards: [
      { title: '主页卡片与历史会话', summary: '快速切换历史任务流与推荐工作流卡片' },
      { title: '定时巡检任务', summary: '查看和管理自动运行的周期任务' },
      { title: '云端浏览器画面', summary: '实时查看云端浏览器执行进度与生成的文件库' },
      { title: '服务连接器', summary: '管理已授权的工作区应用与登录设备' }
    ],
    shape: 'crystal',
    color: 'cyan',
    grokState: 'thinking'
  },
  {
    id: 'dot',
    title: 'ChatGPT Dot',
    settingsTab: 'dot-accounts',
    accountRule: '支持单条或多行批量导入多个 ChatGPT Dot 账号并随时切换',
    importMethods: '支持弹窗网页登录，或粘贴 AT / RT / JSON 批量导入',
    workbenchCards: [
      { title: '账号状态与角色切换', summary: '一键切换当前账号下的 Orbit 角色与对话模式' },
      { title: '核心目标与记忆迁移', summary: '编辑核心目标，换号时可将记忆一键迁移到新账号' },
      { title: 'Pages 页面与文件库', summary: '浏览和管理对话中沉淀的文档页面与生成图片' }
    ],
    shape: 'star',
    color: 'orange',
    grokState: 'streaming'
  },
  {
    id: 'hermes',
    title: 'Hermes',
    settingsTab: 'hermes-accounts',
    accountRule: '支持同时接入多个本机或远程服务器上的开源 Hermes Agent 实例',
    importMethods: '自动检测本机 ~/.hermes 服务，或填写服务器地址与 API_SERVER_KEY 加密接入',
    workbenchCards: [
      { title: '实时流式对话与工具追踪', summary: '原生 Session SSE 实时展示流式回复、工具调用状态与多模态图片' },
      { title: '危险命令安全审批', summary: '触发高风险命令时在右侧直接一键放行（单次/本次会话/永久）或拒绝' },
      { title: '会话、定时任务与技能库', summary: '管理持久化历史会话、Cron 定时任务、已安装 Skills 与 Toolsets' }
    ],
    shape: 'clover',
    color: 'green',
    grokState: 'working'
  },
  {
    id: 'antigravity',
    title: 'Antigravity',
    settingsTab: 'antigravity-accounts',
    accountRule: '每个 Google 账号独立隔离分区，支持多账号并行调度云端 Antigravity Agent',
    importMethods: '内置安全浏览器直接 Google 登录 antigravity.google.com，无需手动抓包或粘贴 Cookie',
    workbenchCards: [
      { title: '实时 Cascade 流式对话', summary: '直连 Google gRPC-Web 流式接口，实时展示推理、工具调用与云端执行进度' },
      { title: '模型与配额实时切换', summary: '查看账号订阅套餐与可用 Gemini 模型配额，一键切换目标模型' },
      { title: '云端会话、沙盒与 Agents', summary: '同步管理所有云端 Cascades 会话、Capsules 沙盒工作区与自定义云端 Agents' }
    ],
    shape: 'crystal',
    color: 'blue',
    grokState: 'streaming'
  },
  {
    id: 'ds-bot',
    title: 'DS Bot',
    settingsTab: 'ds-bot-accounts',
    accountRule: '1 个 DS Bot 实例自动展开团队内全部 Bot 成员与群聊，并可参与跨平台协作室',
    importMethods: '支持 MCP Token（本机/远程）、Noise_IK 加密配对链接与 DSH Web / Docker 直连',
    workbenchCards: [
      { title: '实时流式对话与多 Bot 同步', summary: '原生直连 DS Bot 团队，支持 1v1 Bot 与群聊对话同步及图片发送' },
      { title: '交互式工具审批与问题回复', summary: '在侧栏直接批准或拒绝危险操作、回答 ask_user 提问卡片' },
      { title: '长期记忆、定时任务与用量', summary: '读写 MEMORY.md 长期记忆、管理定时自动化任务并查看 Token 统计' }
    ],
    shape: 'blob',
    color: 'blue',
    grokState: 'happy'
  }
]

function FullScreenGuideBody({
  isOverlay,
  onClose
}: {
  isOverlay: boolean
  onClose?: () => void
}) {
  const setAddBotOpen = useBotStore((s) => s.setAddBotOpen)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const setOnboardingOpen = useBotStore((s) => s.setOnboardingOpen)

  const [step, setStep] = useState<StepId>('workspace')
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId>('grok')
  const [pokeSignal, setPokeSignal] = useState(0)

  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const activeSpec =
    PLATFORM_GUIDE_ITEMS.find((p) => p.id === selectedPlatform) ?? PLATFORM_GUIDE_ITEMS[0]!
  const inspectorTabs = getPlatformInspector(selectedPlatform).tabs

  useEffect(() => {
    markOnboardingSeen()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (
        !onClose &&
        document.querySelector('[role="dialog"][data-state="open"]')
      ) return
      if (e.key === 'ArrowRight' && stepIndex < STEPS.length - 1) {
        e.preventDefault()
        setStep(STEPS[stepIndex + 1]!.id)
        setPokeSignal((n) => n + 1)
      } else if (e.key === 'ArrowLeft' && stepIndex > 0) {
        e.preventDefault()
        setStep(STEPS[stepIndex - 1]!.id)
        setPokeSignal((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [stepIndex, onClose])

  const dismissAndAddBot = (platformId?: PlatformId) => {
    markOnboardingSeen()
    setOnboardingOpen(false)
    onClose?.()
    setAddBotOpen(true, platformId ?? null)
  }

  const dismissAndOpenSettings = (
    tab:
      | 'overview'
      | 'grok-accounts'
      | 'muse-accounts'
      | 'hark-accounts'
      | 'dot-accounts'
      | 'hermes-accounts'
      | 'antigravity-accounts'
      | 'ds-bot-accounts'
  ) => {
    markOnboardingSeen()
    setOnboardingOpen(false)
    onClose?.()
    setSettingsOpen(true, tab)
  }

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-ink select-none">
      {/* Top Bar (respects macOS traffic lights when full-screen overlay) */}
      <header
        className={cn(
          'drag-region flex h-[60px] shrink-0 items-center justify-between border-b border-line/70 px-6',
          isOverlay && runtimePlatform === 'darwin' && 'pl-[92px]'
        )}
      >
        <div className="no-drag flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setPokeSignal((n) => n + 1)}
            className="press grid size-8 place-items-center rounded-xl bg-surface ring-1 ring-line"
          >
            <GrokBotMark
              seed={`guide-${step}-${selectedPlatform}`}
              shape={activeSpec.shape}
              color={activeSpec.color}
              grokState={activeSpec.grokState}
              followPointer
              pokeSignal={pokeSignal}
              sizePx={24}
            />
          </button>
          <span className="text-[14px] font-semibold tracking-tight text-ink">BotArk 操作指南</span>
        </div>

        {/* Step Pills */}
        <nav className="no-drag flex items-center gap-1 rounded-full bg-sunken p-1" aria-label="指南步骤">
          {STEPS.map((item) => {
            const active = item.id === step
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setStep(item.id)
                  setPokeSignal((n) => n + 1)
                }}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all',
                  active
                    ? 'bg-surface text-ink shadow-soft'
                    : 'text-ink-secondary hover:text-ink'
                )}
              >
                <span className="font-mono text-[11px] opacity-60">{item.indexLabel}</span>
                <span>{item.title}</span>
              </button>
            )
          })}
        </nav>

        <div className="no-drag flex items-center gap-2">
          {onClose ? (
            <IconButton label="关闭指南" onClick={onClose}>
              <X />
            </IconButton>
          ) : (
            <Button size="sm" variant="primary" onClick={() => dismissAndAddBot('grok')}>
              <Plus className="size-3.5" /> 添加账号
            </Button>
          )}
        </div>
      </header>

      {/* Main Full-Screen Stage */}
      <main className="flex min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-12">
        <div className="mx-auto my-auto w-full max-w-[1040px]">
          {step === 'workspace' && (
            <div key="workspace" className="grid animate-veil-in items-center gap-10 lg:grid-cols-[1fr_1.25fr]">
              {/* Left Explanation */}
              <div className="flex flex-col gap-6">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12.5px] font-medium text-ink-secondary ring-1 ring-line">
                  <ArkPromptSparkSvg className="size-3.5 text-accent-600" />
                  第 1 步 · 三栏协同工作台
                </div>
                <h1 className="text-[28px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[32px]">
                  单聊与多 Agent 群聊合一，按需展开专属操作台
                </h1>
                <div className="flex flex-col gap-3.5 text-[14px] leading-6 text-ink-secondary">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface font-mono text-[12px] font-semibold text-ink ring-1 ring-line">
                      1
                    </span>
                    <p>
                      <strong className="font-semibold text-ink">左侧统一编排</strong>
                      ：置顶常用 Bot、按分组管理，并可随时组建跨平台多 Agent 协作群聊。
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface font-mono text-[12px] font-semibold text-ink ring-1 ring-line">
                      2
                    </span>
                    <p>
                      <strong className="font-semibold text-ink">中间纯净对话流</strong>
                      ：支持流式接力、共识定稿卡片，以及白名单目录与本地 MCP 上下文注入。
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface font-mono text-[12px] font-semibold text-ink ring-1 ring-line">
                      3
                    </span>
                    <p>
                      <strong className="font-semibold text-ink">右侧专属抽屉</strong>
                      ：按 <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink">{shortcutLabel('I')}</kbd> 随时开关当前 Bot 或群聊的深度控制面板。
                    </p>
                  </div>
                </div>
              </div>

              {/* Right Interactive Visual Mockup of 3-Column Layout */}
              <div className="overflow-hidden rounded-3xl border border-line bg-surface p-3 shadow-float">
                <div className="grid h-[380px] grid-cols-[156px_1fr_176px] gap-2.5 rounded-2xl bg-canvas p-2.5">
                  {/* Mock Left Sidebar */}
                  <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-2.5">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between px-1 pb-1">
                        <span className="text-[11px] font-semibold text-ink-muted">左侧 · Bot 列表</span>
                        <span className="grid size-5 place-items-center rounded-full bg-accent-50 text-[12px] font-bold text-accent-600">
                          +
                        </span>
                      </div>
                      {[
                        { name: 'Researcher', tag: 'Grok', active: true, shape: 'blob' as BotShape, color: 'blue' as BotColorId },
                        { name: 'Code Helper', tag: 'Grok', active: false, shape: 'sparkle' as BotShape, color: 'violet' as BotColorId },
                        { name: 'Daily Brief', tag: 'Grok', active: false, shape: 'gem' as BotShape, color: 'green' as BotColorId },
                        { name: 'Meta Muse', tag: 'Muse', active: false, shape: 'crystal' as BotShape, color: 'magenta' as BotColorId },
                        { name: 'Orbit Dot', tag: 'Dot', active: false, shape: 'star' as BotShape, color: 'orange' as BotColorId }
                      ].map((row) => (
                        <div
                          key={row.name}
                          className={cn(
                            'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]',
                            row.active ? 'bg-active font-medium text-ink' : 'text-ink-secondary'
                          )}
                        >
                          <GrokBotMark seed={row.name} shape={row.shape} color={row.color} sizePx={18} />
                          <span className="min-w-0 flex-1 truncate">{row.name}</span>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-ink-secondary">
                        <ArkRelayOrbSvg className="size-3.5 text-accent-600" />
                        <span>协作群聊</span>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-lg bg-sunken px-2 py-1.5 text-[11.5px] font-medium text-ink">
                        <Settings className="size-3.5 text-ink-secondary" />
                        <span>设置与账号</span>
                      </div>
                    </div>
                  </div>

                  {/* Mock Center Chat */}
                  <div className="flex flex-col justify-between rounded-xl border border-line bg-main p-3">
                    <div className="flex items-center justify-between border-b border-line/60 pb-2">
                      <span className="text-[12px] font-semibold text-ink">Researcher</span>
                      <ArkDrawerToggleSvg active className="size-4 text-accent-600" />
                    </div>
                    <div className="flex flex-col items-center gap-2.5 py-4 text-center">
                      <GrokBotMark
                        seed="center-hero"
                        shape="blob"
                        color="blue"
                        grokState="happy"
                        followPointer
                        sizePx={56}
                      />
                      <span className="text-[13px] font-medium text-ink">中间 · 流式对话主屏</span>
                    </div>
                    <div className="flex h-9 items-center rounded-xl border border-line bg-surface px-3 text-[12px] text-ink-muted">
                      输入消息开始对话…
                    </div>
                  </div>

                  {/* Mock Right Workbench */}
                  <div className="flex flex-col gap-2 rounded-xl border border-accent/35 bg-accent-50/20 p-2.5">
                    <span className="px-1 text-[11px] font-semibold text-accent-600">右侧 · 专属操作台</span>
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 text-center text-[11px] font-medium text-ink">
                      <span className="rounded bg-sunken py-1">概览</span>
                      <span className="py-1 text-ink-muted">文件库</span>
                    </div>
                    {['会话记录', '子代理任务', '记忆与技能', '全部 Bot 管理'].map((card) => (
                      <div
                        key={card}
                        className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[11.5px] font-medium text-ink"
                      >
                        {card}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 'accounts' && (
            <div key="accounts" className="flex animate-veil-in flex-col gap-5">
              <div className="flex flex-col gap-2.5">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12px] font-medium text-ink-secondary ring-1 ring-line">
                  <ArkRelayOrbSvg className="size-3.5 text-accent-600" />
                  第 2 步 · 账号接入与编排
                </div>
                <h1 className="text-[26px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[30px]">
                  两个入口接入账号，统一调度六大平台
                </h1>
              </div>

              {/* Two Compact Entry Capsules */}
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => dismissAndAddBot()}
                  className="group press flex items-center gap-3.5 rounded-2xl border border-line/80 bg-surface p-3.5 text-left transition-all hover:border-line-strong hover:shadow-soft"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                    <Plus className="size-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[14.5px] font-semibold text-ink">左上角「＋ 新建」</h3>
                      <kbd className="rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                        {shortcutLabel('N')}
                      </kbd>
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                      一键登录、浏览器授权、粘贴凭据或组建协作群聊
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => dismissAndOpenSettings('overview')}
                  className="group press flex items-center gap-3.5 rounded-2xl border border-line/80 bg-surface p-3.5 text-left transition-all hover:border-line-strong hover:shadow-soft"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken text-ink">
                    <Settings className="size-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[14.5px] font-semibold text-ink">左下角「设置与账号」</h3>
                      <ArrowRight className="size-4 text-ink-muted transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                      全平台健康总览、批量导入、代理池与手机无线同步
                    </p>
                  </div>
                </button>
              </div>

              {/* Balanced 3x2 Grid for All 6 Native Platforms */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {PLATFORM_GUIDE_ITEMS.map((item) => {
                  const descriptor = getPlatform(item.id)
                  return (
                    <div
                      key={item.id}
                      className="flex flex-col justify-between gap-3 rounded-2xl border border-line/80 bg-surface p-4"
                    >
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2.5">
                          <PlatformGlyph platform={descriptor} size="md" />
                          <span className="text-[14.5px] font-semibold text-ink">{item.title}</span>
                        </div>
                        <p className="line-clamp-2 text-[12.5px] leading-[18px] text-ink-secondary">
                          {item.importMethods}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 pt-0.5">
                        <Button
                          size="sm"
                          variant="primary"
                          className="flex-1"
                          onClick={() => dismissAndAddBot(item.id)}
                        >
                          立即添加
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => dismissAndOpenSettings(item.settingsTab)}
                        >
                          账号管理
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'workbench' && (
            <div key="workbench" className="grid animate-veil-in items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
              {/* Left: Platform Switcher & Clean Explanation */}
              <div className="flex flex-col gap-6">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12.5px] font-medium text-ink-secondary ring-1 ring-line">
                  <ArkDrawerToggleSvg active className="size-3.5 text-accent-600" />
                  第 3 步 · 右侧操作台
                </div>
                <h1 className="text-[28px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[32px]">
                  操作台在右侧，随当前 Bot 自动切换能力面板
                </h1>
                <p className="text-[14.5px] leading-6 text-ink-secondary">
                  像 Grok Bot 一样，日常对话保持中间视野干净，需要切换会话、查看子任务、整理记忆、下载文件或管理账号下的其他 Bot 时，直接在右侧操作台完成。
                </p>

                {/* Interactive Platform Selector */}
                <div className="flex flex-wrap gap-2">
                  {PLATFORM_GUIDE_ITEMS.map((item) => {
                    const active = item.id === selectedPlatform
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setSelectedPlatform(item.id)
                          setPokeSignal((n) => n + 1)
                        }}
                        className={cn(
                          'flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[13.5px] font-medium transition-all',
                          active
                            ? 'border-ink bg-ink text-surface shadow-soft'
                            : 'border-line bg-surface text-ink hover:bg-hover'
                        )}
                      >
                        <PlatformGlyph platform={getPlatform(item.id)} size="sm" />
                        <span>{item.title}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Right: Full-Size Clean Right-Side Workbench Preview */}
              <div className="overflow-hidden rounded-3xl border border-line bg-surface p-6 shadow-float">
                <div className="flex items-center justify-between pb-4">
                  <div className="flex items-center gap-3">
                    <GrokBotMark
                      seed={`workbench-${activeSpec.id}`}
                      shape={activeSpec.shape}
                      color={activeSpec.color}
                      grokState={activeSpec.grokState}
                      followPointer
                      pokeSignal={pokeSignal}
                      sizePx={42}
                    />
                    <div>
                      <h3 className="text-[16px] font-semibold text-ink">{activeSpec.title}</h3>
                      <p className="text-[12.5px] text-ink-secondary">在线 · 右侧操作台</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] font-medium text-ink">
                      <MessageSquare className="size-3.5 text-ink-secondary" />
                      新对话
                    </span>
                    <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] font-medium text-ink">
                      <FolderOpen className="size-3.5 text-ink-secondary" />
                      文件库
                    </span>
                  </div>
                </div>

                {/* Clean Inspector Tabs */}
                <div className="mb-4 flex rounded-xl bg-sunken p-1">
                  {inspectorTabs.map((tab, idx) => (
                    <div
                      key={tab.id}
                      className={cn(
                        'flex-1 rounded-lg py-1.5 text-center text-[12.5px] font-medium',
                        idx === 0 ? 'bg-surface text-ink shadow-soft' : 'text-ink-secondary'
                      )}
                    >
                      {t(tab.label)}
                    </div>
                  ))}
                </div>

                {/* Clean Section Cards */}
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {activeSpec.workbenchCards.map((card) => (
                    <div
                      key={card.title}
                      className="flex flex-col gap-1 rounded-2xl border border-line bg-canvas p-3.5"
                    >
                      <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                        <Layers className="size-3.5 text-accent-600" />
                        <span>{card.title}</span>
                      </div>
                      <p className="text-[12.5px] leading-5 text-ink-secondary">{card.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Bottom Bar */}
      <footer className="flex h-[68px] shrink-0 items-center justify-between border-t border-line/70 px-6 sm:px-12">
        <div>
          {stepIndex > 0 ? (
            <Button
              variant="ghost"
              onClick={() => {
                setStep(STEPS[stepIndex - 1]!.id)
                setPokeSignal((n) => n + 1)
              }}
            >
              <ArrowLeft className="size-4" /> 上一步
            </Button>
          ) : onClose ? (
            <Button variant="ghost" onClick={onClose}>
              跳过指南
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5">
          {stepIndex < STEPS.length - 1 ? (
            <Button
              size="lg"
              variant="primary"
              onClick={() => {
                setStep(STEPS[stepIndex + 1]!.id)
                setPokeSignal((n) => n + 1)
              }}
            >
              下一步：{STEPS[stepIndex + 1]!.title}
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => dismissAndOpenSettings('grok-accounts')}
              >
                <Settings className="size-4" /> 打开账号管理
              </Button>
              <Button
                size="lg"
                variant="primary"
                onClick={() => (onClose ? onClose() : dismissAndAddBot('grok'))}
              >
                {onClose ? '开始使用 BotArk' : '立即添加第一个账号'}
              </Button>
            </>
          )}
        </div>
      </footer>
    </div>
  )
}

/**
 * Full-screen welcome stage rendered when the workspace has zero bots.
 */
export function OnboardingStage() {
  return (
    <div className="fixed inset-0 z-40">
      <FullScreenGuideBody isOverlay />
    </div>
  )
}

/**
 * Full-screen interactive product guide launchable anytime from Sidebar, Settings, or `⌘K`.
 */
export function OnboardingDialog() {
  const open = useBotStore((s) => s.onboardingOpen)
  const setOpen = useBotStore((s) => s.setOnboardingOpen)
  const tr = useT()
  useOverlayLock(open)

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          aria-describedby={undefined}
          data-onboarding-dialog
          className="fixed inset-0 z-50 animate-veil-in outline-none"
        >
          <RadixDialog.Title className="sr-only">{tr('BotArk guide')}</RadixDialog.Title>
          <FullScreenGuideBody isOverlay onClose={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export { Compass as OnboardingIcon }
