import type { PlatformDescriptor, PlatformId } from './types'

/**
 * Catalog of platforms shown in the UI. Only "available" platforms with a
 * registered adapter can be used to create bots; the rest render as
 * "coming soon".
 */
export const PLATFORMS: readonly PlatformDescriptor[] = [
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Google 云端智能体 · 模型切换、流式对话与云端沙盒',
    availability: 'available',
    monogram: 'Ag',
    homeUrl: 'https://antigravity.google.com',
    loginUrl: 'https://antigravity.google.com'
  },
  {
    id: 'meta-muse',
    name: 'Meta Muse',
    description: 'Meta 个人智能体 · 对话、连接器与安全审批',
    availability: 'available',
    monogram: 'M',
    homeUrl: 'https://muse.ai'
  },
  {
    id: 'grok',
    name: 'Grok Bot',
    description: 'xAI 自主智能体 · 多 Agent 同步、定时任务与云沙盒',
    availability: 'available',
    monogram: 'G',
    homeUrl: 'https://x.ai/bot',
    loginUrl: 'https://authenticator.cursor.sh'
  },
  {
    id: 'dot',
    name: 'Dot',
    description: 'OpenAI 个人 AI · 长期记忆、Orbit 角色与页面库',
    availability: 'available',
    monogram: 'Do',
    homeUrl: 'https://chatgpt.com/dots',
    loginUrl: 'https://chatgpt.com/dots'
  },
  {
    id: 'hark',
    name: 'Hark',
    description: '个人 AI 助手 · Google 登录、实时对话与云端浏览器',
    availability: 'available',
    monogram: 'H',
    homeUrl: 'https://app.hark.com',
    loginUrl: 'https://app.hark.com/login'
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'Nous 开源智能体 · 直连本机或远程网关，支持流式与审批',
    availability: 'available',
    monogram: 'He',
    homeUrl: 'http://127.0.0.1:8642'
  },
  {
    id: 'cue',
    name: 'Cue',
    description: 'Manus 个人智能体 · 多账号隔离、Agent 协同与云端沙盒',
    availability: 'available',
    monogram: 'Cu',
    homeUrl: 'https://cue.im/',
    loginUrl: 'https://cue.im/login'
  }
]

export function getPlatform(id: PlatformId): PlatformDescriptor {
  const platform = PLATFORMS.find((p) => p.id === id)
  if (!platform) throw new Error(`Unknown platform: ${id}`)
  return platform
}
