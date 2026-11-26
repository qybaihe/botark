import type { PlatformId } from '@adapters/types'

export type InspectorTabId = 'overview' | 'memory' | 'library' | 'computer' | 'members'

export interface InspectorTabSpec {
  id: InspectorTabId
  /** English i18n key passed to `t(label)`. */
  label: string
}

export interface PlatformInspectorSpec {
  platformId: PlatformId
  displayName: string
  /** Short protocol / runtime tag shown in the inspector hero. */
  protocolLabel: string
  /** Whether the platform has an interactive web app usable in WebSessionPane. */
  supportsWebSession: boolean
  /** Whether ChatHeader offers a one-click "New conversation" button. */
  supportsQuickNewConversation: boolean
  /** Product-specific right-side inspector tabs (only real capabilities, no empty placeholders). */
  tabs: ReadonlyArray<InspectorTabSpec>
}

export const PLATFORM_INSPECTORS: Record<PlatformId, PlatformInspectorSpec> = {
  'meta-muse': {
    platformId: 'meta-muse',
    displayName: 'Muse',
    protocolLabel: 'Noise WSS · Cloud VM',
    supportsWebSession: true,
    supportsQuickNewConversation: true,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'library', label: 'Library' },
      { id: 'computer', label: 'Computer' },
      { id: 'members', label: 'Sharing' }
    ]
  },
  grok: {
    platformId: 'grok',
    displayName: 'Grok Bot',
    protocolLabel: 'Connect-RPC · SandBox',
    supportsWebSession: false,
    supportsQuickNewConversation: true,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'library', label: 'Library' },
      { id: 'computer', label: 'Sandbox' },
      { id: 'members', label: 'Agents' }
    ]
  },
  hark: {
    platformId: 'hark',
    displayName: 'Hark',
    protocolLabel: 'REST + SSE · Browser VM',
    supportsWebSession: true,
    supportsQuickNewConversation: false,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'library', label: 'Library' },
      { id: 'computer', label: 'Computer' },
      { id: 'members', label: 'Devices' }
    ]
  },
  dot: {
    platformId: 'dot',
    displayName: 'Dot',
    protocolLabel: 'Calpico Room · Orbit',
    supportsWebSession: true,
    supportsQuickNewConversation: false,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'memory', label: 'Memory' },
      { id: 'library', label: 'Pages' }
    ]
  },
  hermes: {
    platformId: 'hermes',
    displayName: 'Hermes',
    protocolLabel: 'HTTP/SSE · API Server',
    supportsWebSession: false,
    supportsQuickNewConversation: true,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'computer', label: 'Tools' }
    ]
  },
  antigravity: {
    platformId: 'antigravity',
    displayName: 'Antigravity',
    protocolLabel: 'gRPC-Web · Cloud Agent',
    supportsWebSession: true,
    supportsQuickNewConversation: true,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'computer', label: 'Environments' },
      { id: 'members', label: 'Agents' }
    ]
  },
  cue: {
    platformId: 'cue',
    displayName: 'Cue',
    protocolLabel: 'Connect-RPC + WS · Cue Native',
    supportsWebSession: false,
    supportsQuickNewConversation: false,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'library', label: 'Library' },
      { id: 'computer', label: 'Computer' },
      { id: 'members', label: 'Agents' }
    ]
  },
  'ds-bot': {
    platformId: 'ds-bot',
    displayName: 'DS Bot',
    protocolLabel: 'DSH Native · Noise Relay · MCP',
    supportsWebSession: false,
    supportsQuickNewConversation: false,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'memory', label: 'Memory' },
      { id: 'members', label: 'Agents' }
    ]
  }
}

export function getPlatformInspector(platformId: PlatformId): PlatformInspectorSpec {
  return PLATFORM_INSPECTORS[platformId]
}

export function resolveInspectorTab(
  platformId: PlatformId,
  requestedTab: InspectorTabId
): InspectorTabId {
  const spec = PLATFORM_INSPECTORS[platformId]
  return spec.tabs.some((tab) => tab.id === requestedTab) ? requestedTab : 'overview'
}
