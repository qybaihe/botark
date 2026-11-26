import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useBotStore } from '@/store/botStore'
import { InfoPanel } from './InfoPanel'
import {
  getPlatformInspector,
  PLATFORM_INSPECTORS,
  resolveInspectorTab
} from './platformInspector'

vi.mock('@/store/botStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/store/botStore')>()
  return {
    ...original,
    useBotStore: Object.assign(vi.fn(original.useBotStore), original.useBotStore)
  }
})

describe('platformInspector', () => {
  it('defines distinct, authentic inspector tabs for each platform', () => {
    expect(PLATFORM_INSPECTORS['meta-muse'].tabs.map((t) => t.id)).toEqual([
      'overview',
      'library',
      'computer',
      'members'
    ])
    expect(PLATFORM_INSPECTORS.grok.tabs.map((t) => t.label)).toEqual([
      'Overview',
      'Library',
      'Sandbox',
      'Agents'
    ])
    expect(PLATFORM_INSPECTORS.hark.tabs.map((t) => t.label)).toEqual([
      'Overview',
      'Library',
      'Computer',
      'Devices'
    ])
    // Dot has no Cloud VM or multi-user room sharing — only Overview, Memory, and Pages.
    expect(PLATFORM_INSPECTORS.dot.tabs.map((t) => t.id)).toEqual([
      'overview',
      'memory',
      'library'
    ])
    // Hermes exposes Gateway Overview + Tools & Skills.
    expect(PLATFORM_INSPECTORS.hermes.tabs.map((t) => t.id)).toEqual(['overview', 'computer'])
    expect(PLATFORM_INSPECTORS.hermes.supportsQuickNewConversation).toBe(true)
    // Cue mirrors Grok Bot's 4 inspector tabs (Overview, Library, Computer, Agents) without empty web session.
    expect(PLATFORM_INSPECTORS.cue.tabs.map((t) => t.id)).toEqual([
      'overview',
      'library',
      'computer',
      'members'
    ])
    expect(PLATFORM_INSPECTORS.cue.supportsQuickNewConversation).toBe(false)
    expect(PLATFORM_INSPECTORS['ds-bot'].tabs.map((t) => t.id)).toEqual([
      'overview',
      'memory',
      'members'
    ])
    expect(PLATFORM_INSPECTORS['ds-bot'].supportsWebSession).toBe(false)
  })

  it('disables web session pane for Grok Bot, Hermes & Cue while keeping it on web-backed platforms', () => {
    expect(getPlatformInspector('grok').supportsWebSession).toBe(false)
    expect(getPlatformInspector('hermes').supportsWebSession).toBe(false)
    expect(getPlatformInspector('cue').supportsWebSession).toBe(false)
    expect(getPlatformInspector('antigravity').supportsWebSession).toBe(true)
    expect(getPlatformInspector('meta-muse').supportsWebSession).toBe(true)
    expect(getPlatformInspector('hark').supportsWebSession).toBe(true)
    expect(getPlatformInspector('dot').supportsWebSession).toBe(true)
  })

  it('falls back to overview when switching to a platform without the previously selected tab', () => {
    expect(resolveInspectorTab('dot', 'computer')).toBe('overview')
    expect(resolveInspectorTab('dot', 'members')).toBe('overview')
    expect(resolveInspectorTab('dot', 'memory')).toBe('memory')
    expect(resolveInspectorTab('meta-muse', 'memory')).toBe('overview')
    expect(resolveInspectorTab('grok', 'computer')).toBe('computer')
    expect(resolveInspectorTab('hermes', 'computer')).toBe('computer')
    expect(resolveInspectorTab('hermes', 'library')).toBe('overview')
  })

  it.each([
    { infoPanelOpen: false, settingsOpen: false },
    { infoPanelOpen: true, settingsOpen: true }
  ])('does not read the selected bot or render inspector sections while hidden (%j)', (visibility) => {
    const getBots = vi.fn(() => {
      throw new Error('The hidden inspector read the bot list')
    })
    const state = { ...useBotStore.getState(), ...visibility, get bots() { return getBots() } }
    vi.mocked(useBotStore).mockImplementationOnce((selector) => selector(state))

    expect(renderToStaticMarkup(createElement(InfoPanel))).toBe('')
    expect(getBots).not.toHaveBeenCalled()
  })
})
