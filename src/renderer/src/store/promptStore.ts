import { createId } from '@shared/id'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface PromptTemplate {
  id: string
  trigger: string
  title: string
  content: string
  category: string
  pinned: boolean
  usageCount: number
  builtIn?: boolean
  createdAt: number
  updatedAt: number
}

type Draft = Pick<PromptTemplate, 'trigger' | 'title' | 'content' | 'category'>
const triggerPattern = /^[\p{L}\p{M}\p{N}_-]+$/u
const normalizeTrigger = (value: string) => value.trim().replace(/^\/+/, '').toLowerCase()

export interface SlashQuery {
  query: string
  replaceStart: number
  replaceEnd: number
}

export function parseSlashQuery(text: string, caret: number): SlashQuery | null {
  if (!Number.isInteger(caret) || caret <= 0 || caret > text.length) return null
  const match = /(?:^|\s)\/([\p{L}\p{M}\p{N}_-]*)$/u.exec(text.slice(0, caret))
  if (!match) return null
  const suffix = /^\S*/u.exec(text.slice(caret))![0]
  if (suffix && !triggerPattern.test(suffix)) return null
  return { query: match[1], replaceStart: caret - match[1].length - 1, replaceEnd: caret + suffix.length }
}

function fuzzyMatch(field: string, query: string) {
  let start = 0
  for (const char of query) {
    const index = field.indexOf(char, start)
    if (index < 0) return false
    start = index + char.length
  }
  return true
}

export function filterPromptTemplates(templates: readonly PromptTemplate[], query: string): PromptTemplate[] {
  const term = normalizeTrigger(query)
  return templates.map((template) => {
    const trigger = normalizeTrigger(template.trigger)
    const fields = [trigger, template.title, template.category, template.content].map((s) => s.toLowerCase())
    let rank = 0
    if (!term) rank = 1
    else if (trigger === term) rank = 5
    else if (trigger.startsWith(term)) rank = 4
    else if (fields.some((s) => s.includes(term))) rank = 3
    else if (fields.some((s) => fuzzyMatch(s, term))) rank = 2
    return { template, rank }
  }).filter(({ rank }) => rank > 0).sort((a, b) =>
    b.rank - a.rank || Number(b.template.pinned) - Number(a.template.pinned) ||
    b.template.usageCount - a.template.usageCount
  ).map(({ template }) => template)
}

export function expandPromptTemplate(content: string, ctx: { date?: string; botName?: string; clipboard?: string } = {}) {
  const values = { date: ctx.date ?? '', bot: ctx.botName ?? '', clipboard: ctx.clipboard ?? '' }
  let text = ''
  let end = 0
  let cursorOffset: number | undefined
  for (const match of content.matchAll(/\{\{(date|bot|clipboard|cursor)\}\}/g)) {
    text += content.slice(end, match.index)
    if (match[1] === 'cursor') cursorOffset ??= text.length
    else text += values[match[1] as keyof typeof values]
    end = match.index + match[0].length
  }
  text += content.slice(end)
  return { text, cursorOffset: cursorOffset ?? text.length }
}

const starters: Draft[] = [
  { trigger: 'review', title: '代码审查', category: '开发', content: '请审查以下代码，按严重程度列出问题、触发条件和修改建议，并指出缺少的测试。\n\n{{cursor}}' },
  { trigger: 'summarize', title: '结构化总结', category: '阅读', content: '请总结以下材料，分别列出核心结论、支持证据和待确认的问题。\n\n{{cursor}}' },
  { trigger: 'translate', title: '中英精准互译', category: '写作', content: '请将下文译为另一种语言（中文或英文），保留专业术语、语气和段落格式。\n\n{{cursor}}' },
  { trigger: 'explain', title: '原理解析', category: '学习', content: '请用一个具体例子解释以下概念，再说明它的工作原理和适用边界。\n\n{{cursor}}' },
  { trigger: 'plan', title: '实施计划', category: '规划', content: '今天是 {{date}}。请把以下目标拆成实施步骤，为每步列出依赖、交付物和验收条件。\n\n{{cursor}}' },
  { trigger: 'polish', title: '润色改写', category: '写作', content: '请润色以下文字，保留原意和事实，使表达简洁自然。直接给出改写稿。\n\n{{cursor}}' }
]

function defaults(): PromptTemplate[] {
  const now = Date.now()
  return starters.map((item) => ({
    ...item, id: 'starter-' + item.trigger, pinned: false, builtIn: true, usageCount: 0, createdAt: now, updatedAt: now
  }))
}

function cleanDraft(draft: Draft): Draft {
  const trigger = normalizeTrigger(draft.trigger)
  if (!triggerPattern.test(trigger)) throw new Error('Use letters, numbers, hyphens or underscores for the trigger.')
  if (!draft.title.trim() || !draft.content.trim()) throw new Error('A title and prompt are required.')
  return { trigger, title: draft.title.trim(), category: draft.category.trim(), content: draft.content }
}

export function exportPromptTemplatesJson(templates: readonly PromptTemplate[]) {
  return JSON.stringify({ version: 1, templates }, null, 2)
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function decodeTemplates(data: unknown): PromptTemplate[] {
  if (!Array.isArray(data)) throw new Error('Invalid prompt library file.')
  const ids = new Set<string>()
  const triggers = new Set<string>()
  const templates: PromptTemplate[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object' ||
      ['trigger', 'title', 'content'].some((key) => typeof item[key] !== 'string') ||
      (item.category !== undefined && typeof item.category !== 'string')) throw new Error('Invalid prompt library file.')
    const draft = cleanDraft({ ...item, category: item.category ?? '' })
    if (triggers.has(draft.trigger)) continue
    triggers.add(draft.trigger)
    let id = typeof item.id === 'string' && item.id.trim() ? item.id : 'import-' + draft.trigger
    while (ids.has(id)) id += '-copy'
    ids.add(id)
    templates.push({
      ...draft, id, pinned: item.pinned === true, builtIn: item.builtIn === true,
      usageCount: validNumber(item.usageCount) ? item.usageCount : 0,
      createdAt: validNumber(item.createdAt) ? item.createdAt : 0,
      updatedAt: validNumber(item.updatedAt) ? item.updatedAt : 0
    })
  }
  return templates
}

export function parseImportedPromptTemplates(rawJson: string): PromptTemplate[] {
  const parsed = JSON.parse(rawJson)
  if (Array.isArray(parsed)) return decodeTemplates(parsed)
  if (parsed?.version !== 1) throw new Error('Unsupported prompt library format.')
  return decodeTemplates(parsed.templates)
}

interface PromptState {
  templates: PromptTemplate[]
  libraryOpen: boolean
  setLibraryOpen: (open: boolean) => void
  save: (draft: Draft, id?: string) => void
  remove: (id: string) => void
  togglePin: (id: string) => void
  recordUse: (id: string) => void
  importJson: (json: string) => number
  restoreDefaults: () => void
}

function availableTrigger(base: string, used: Set<string>) {
  let trigger = base
  for (let suffix = 2; used.has(trigger); suffix++) trigger = base + '-' + suffix
  return trigger
}

export const usePromptStore = create<PromptState>()(persist((set, get) => ({
  templates: defaults(),
  libraryOpen: false,
  setLibraryOpen: (libraryOpen) => set({ libraryOpen }),
  save: (draft, id) => {
    const cleaned = cleanDraft(draft)
    const { templates } = get()
    if (templates.some((t) => t.id !== id && t.trigger === cleaned.trigger)) throw new Error('This trigger is already in use.')
    const now = Date.now()
    if (id) {
      set({ templates: templates.map((t) => t.id === id ? { ...t, ...cleaned, updatedAt: now } : t) })
    } else {
      set({ templates: [...templates, { ...cleaned, id: createId('prompt'), pinned: false, usageCount: 0, createdAt: now, updatedAt: now }] })
    }
  },
  remove: (id) => set((s) => ({ templates: s.templates.filter((t) => t.id !== id) })),
  togglePin: (id) => set((s) => ({ templates: s.templates.map((t) => t.id === id ? { ...t, pinned: !t.pinned, updatedAt: Date.now() } : t) })),
  recordUse: (id) => set((s) => ({ templates: s.templates.map((t) => t.id === id ? { ...t, usageCount: t.usageCount + 1 } : t) })),
  importJson: (json) => {
    const incoming = parseImportedPromptTemplates(json)
    const existing = get().templates
    const triggers = new Set(existing.map((t) => t.trigger))
    const additions = incoming.filter((t) => !triggers.has(t.trigger)).map((t) => ({
      ...t, id: createId('prompt'), builtIn: false
    }))
    if (additions.length) set({ templates: [...existing, ...additions] })
    return additions.length
  },
  restoreDefaults: () => {
    const custom = get().templates.filter((t) => !t.builtIn)
    const used = new Set(custom.map((t) => t.trigger))
    const restored = defaults().map((t) => ({ ...t, trigger: availableTrigger(t.trigger, used) }))
    set({ templates: [...restored, ...custom] })
  }
}), {
  name: 'bothub-prompts',
  partialize: ({ templates }) => ({ templates }),
  storage: createJSONStorage(() => ({
    getItem(key) { try { return localStorage.getItem(key) } catch { return null } },
    setItem(key, value) { try { localStorage.setItem(key, value) } catch { /* Keep the current session usable. */ } },
    removeItem(key) { try { localStorage.removeItem(key) } catch { /* Storage may be unavailable. */ } }
  })),
  merge: (saved, state) => {
    if (!saved || typeof saved !== 'object' || !('templates' in saved)) return state
    try { return { ...state, templates: decodeTemplates(saved.templates) } } catch { return state }
  }
}))
