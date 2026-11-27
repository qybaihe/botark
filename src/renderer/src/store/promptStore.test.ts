import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expandPromptTemplate, exportPromptTemplatesJson, filterPromptTemplates,
  parseImportedPromptTemplates, parseSlashQuery, usePromptStore, type PromptTemplate
} from './promptStore'

const draft = { trigger: 'review', title: 'Review', category: 'Development', content: 'Read {{cursor}}' }
const template = (fields: Partial<PromptTemplate> = {}): PromptTemplate => ({
  ...draft, id: 'a', pinned: false, usageCount: 0, createdAt: 1, updatedAt: 2, ...fields
})

describe('parseSlashQuery', () => {
  it.each([
    ['/', 1, '', 0, 1], ['/review', 7, 'review', 0, 7],
    ['before /plan after', 10, 'pl', 7, 12], ['a\n/总结', 5, '总结', 2, 5],
    ['/review', 1, '', 0, 7], ['🙂\t/r-1_a', 9, 'r-1_a', 3, 9]
  ] as const)('finds the token in %s with caret %i', (text, caret, query, replaceStart, replaceEnd) => {
    expect(parseSlashQuery(text, caret)).toEqual({ query, replaceStart, replaceEnd })
  })

  it.each([
    ['https://example.org/review', 8], ['https://example.org/review', 26],
    ['src/foo/bar', 5], ['src/foo/bar', 11], ['./folder', 3], ['/src/foo', 3],
    ['//host', 1], ['C:\\docs/foo', 10], ['x/review', 8], ['/review ', 8], [' /x', 1],
    ['/x', 0], ['/x', -1], ['/x', 3], ['/x', 1.5]
  ] as const)('ignores %s at %i', (text, caret) => {
    expect(parseSlashQuery(text, caret)).toBeNull()
  })
})

describe('filterPromptTemplates', () => {
  const items = [
    template({ trigger: 'prep', content: 'Review first', pinned: true, usageCount: 8 }),
    template({ trigger: 'review-team', pinned: true }),
    template({ trigger: 'review-code', usageCount: 12 }),
    template({ trigger: 'review-pr' }),
    template()
  ]
  it('ranks exact triggers, prefixes, pins, and usage without mutating the input', () => {
    expect(filterPromptTemplates(items, '/REVIEW').map((t) => t.trigger)).toEqual(
      ['review', 'review-team', 'review-code', 'review-pr', 'prep']
    )
    expect(filterPromptTemplates(items, '')[0]).toBe(items[0])
    expect(items[0].trigger).toBe('prep')
  })
  it.each(['rvw', 'unique title', 'develp', 'content only'])('matches %s', (query) => {
    expect(filterPromptTemplates([template({ title: 'Unique title', content: 'Content only' })], query)).toHaveLength(1)
  })
  it('returns no unrelated templates', () => expect(filterPromptTemplates(items, 'xyz')).toEqual([]))
})

describe('expandPromptTemplate', () => {
  it('expands in one pass and counts UTF-16 offsets for the textarea', () => {
    const before = '🙂2026-04-15 Bot {{cursor}} $&'
    expect(expandPromptTemplate('🙂{{date}} {{bot}} {{clipboard}}{{cursor}} after', {
      date: '2026-04-15', botName: 'Bot', clipboard: '{{cursor}} $&'
    })).toEqual({ text: before + ' after', cursorOffset: before.length })
  })
  it('uses the first cursor and removes subsequent markers', () => {
    expect(expandPromptTemplate('{{cursor}}a{{cursor}}b', {})).toEqual({ text: 'ab', cursorOffset: 0 })
  })
  it('leaves unknown variables intact and defaults the cursor to the end', () => {
    expect(expandPromptTemplate('{{bot}}{{date}}{{clipboard}}{{unknown}}')).toEqual({ text: '{{unknown}}', cursorOffset: 11 })
  })
})

describe('JSON interchange', () => {
  it('round-trips metadata, placeholders and multiline text', () => {
    const original = template({ content: 'one\n{{cursor}}', builtIn: true, usageCount: 4 })
    expect(parseImportedPromptTemplates(exportPromptTemplatesJson([original]))).toEqual([original])
  })
  it('normalizes and deduplicates trigger names, isolates colliding ids, and keeps safe fields', () => {
    const result = parseImportedPromptTemplates(JSON.stringify([
      { ...draft, trigger: ' /REVIEW ', id: 'one', usageCount: -1, pinned: 'yes', extra: 'unused' },
      draft, { ...draft, trigger: 'plan', id: 'one' }
    ]))
    expect(result.map((t) => t.trigger)).toEqual(['review', 'plan'])
    expect(result[0]).toMatchObject({ pinned: false, usageCount: 0 })
    expect(result[0]).not.toHaveProperty('extra')
    expect(result[1].id).not.toBe(result[0].id)
  })
  it.each(['{', '{}', '{"version":2,"templates":[]}', '[null]', '[{}]',
    JSON.stringify([{ ...draft, title: 3 }]), JSON.stringify([{ ...draft, content: '  ' }]),
    JSON.stringify([{ ...draft, trigger: '/bad/path' }]), JSON.stringify([{ ...draft, category: {} }])
  ])('rejects malformed data (%s)', (raw) => expect(() => parseImportedPromptTemplates(raw)).toThrow())
})

describe('prompt library store', () => {
  const initial = usePromptStore.getInitialState()
  let values: Map<string, string>
  beforeEach(() => {
    values = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
    usePromptStore.setState(initial, true)
  })
  afterEach(() => vi.unstubAllGlobals())
  const state = () => usePromptStore.getState()

  it('creates, edits, pins, counts use, deletes, and keeps custom prompts on restore', () => {
    expect(state().templates.map((t) => t.trigger)).toEqual(['review', 'summarize', 'translate', 'explain', 'plan', 'polish'])
    state().save({ ...draft, trigger: '/NEW' })
    const custom = state().templates.at(-1)!
    state().save({ ...custom, title: 'Updated title' }, custom.id)
    state().togglePin(custom.id)
    state().recordUse(custom.id)
    expect(() => state().save({ ...draft, trigger: 'new' })).toThrow()
    expect(state().templates.at(-1)).toMatchObject({ title: 'Updated title', trigger: 'new', pinned: true, usageCount: 1 })
    const [review, summary] = state().templates
    state().save({ ...review, content: 'changed' }, review.id)
    state().remove(summary.id)
    state().restoreDefaults()
    expect(state().templates).toHaveLength(7)
    expect(state().templates[0].content).toBe(review.content)
    expect(state().templates.at(-1)?.id).toBe(custom.id)
    state().remove(custom.id)
    expect(state().templates).toHaveLength(6)
  })

  it('preserves a custom trigger if a deleted starter is restored', () => {
    state().remove(state().templates[0].id)
    state().save(draft)
    state().restoreDefaults()
    expect(state().templates.filter((t) => t.trigger === 'review')).toHaveLength(1)
    expect(state().templates.find((t) => t.builtIn && t.title === '代码审查')?.trigger).toBe('review-2')
  })

  it('imports atomically and preserves existing templates on repeated imports', () => {
    const input = JSON.stringify([draft, { ...draft, trigger: 'other' }])
    expect(state().importJson(input)).toBe(1)
    expect(state().importJson(input)).toBe(0)
    expect(() => state().importJson(JSON.stringify([{ ...draft, trigger: 'added' }, {}]))).toThrow()
    expect(state().templates).toHaveLength(7)
  })

  it('persists and rehydrates templates without persisting the dialog or reseeding deletions', async () => {
    state().recordUse(state().templates[0].id)
    state().remove(state().templates[1].id)
    state().setLibraryOpen(true)
    const saved = values.get('bothub-prompts')!
    expect(Object.keys(JSON.parse(saved).state)).toEqual(['templates'])
    usePromptStore.setState(initial, true)
    values.set('bothub-prompts', saved)
    await usePromptStore.persist.rehydrate()
    expect(state().templates).toHaveLength(5)
    expect(state().templates[0].usageCount).toBe(1)
    expect(state().libraryOpen).toBe(false)
    state().templates.forEach((t) => state().remove(t.id))
    await usePromptStore.persist.rehydrate()
    expect(state().templates).toEqual([])
  })

  it('keeps usable state with damaged, unavailable, or quota-limited storage', async () => {
    values.set('bothub-prompts', '{')
    await usePromptStore.persist.rehydrate()
    values.set('bothub-prompts', '{"state":{"templates":[{}]},"version":0}')
    await usePromptStore.persist.rehydrate()
    expect(state().templates).toHaveLength(6)
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') }
    })
    await usePromptStore.persist.rehydrate()
    state().save({ ...draft, trigger: 'offline' })
    expect(state().templates.at(-1)?.trigger).toBe('offline')
  })
})
