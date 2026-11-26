import type { HermesApprovalView, MuseMediaPartView, MuseToolCallView } from './ipc'

export type MobilePlatformId = 'meta-muse' | 'grok' | 'hark' | 'dot' | 'hermes' | 'antigravity' | 'cue' | 'ds-bot'
export type MobileConnectionStatus = 'online' | 'busy' | 'attention' | 'offline' | 'error'

export const MOBILE_SYNC_CHANNELS = {
  getState: 'bothub:mobile-sync:get-state',
  start: 'bothub:mobile-sync:start',
  stop: 'bothub:mobile-sync:stop',
  rotatePairing: 'bothub:mobile-sync:rotate-pairing',
  setIncludeDirectCredentials: 'bothub:mobile-sync:set-include-direct-credentials',
  revokeDevice: 'bothub:mobile-sync:revoke-device',
  exportOfflineBundle: 'bothub:mobile-sync:export-offline-bundle',
  pushSnapshot: 'bothub:mobile-sync:push-snapshot',
  pushEvent: 'bothub:mobile-sync:push-event',
  stateChanged: 'bothub:mobile-sync:state-changed',
  command: 'bothub:mobile-sync:command',
  sendCommand: 'bothub:mobile-sync:send-command',
  sendCommandResult: 'bothub:mobile-sync:send-command-result'
} as const

export interface MobileSyncedAccount {
  id: string
  platformId: MobilePlatformId
  displayName: string
  handle: string
  status: MobileConnectionStatus
  statusDetail?: string
}

export interface MobileSyncedGroup {
  id: string
  name: string
  collapsed: boolean
}

export interface MobileSyncedBot {
  id: string
  platformId: MobilePlatformId
  name: string
  avatar?: string
  avatarShape?: string
  avatarColor?: string
  emoji?: string
  groupId: string
  pinned?: boolean
  activeAccountId: string
  activeSessionId?: string
  lastActivityAt: number
}

export interface MobileSyncedMessage {
  id: string
  botId: string
  accountId: string
  role: 'user' | 'bot'
  text: string
  createdAt: number
  delivery?: 'sending' | 'accepted' | 'sent' | 'failed' | 'no-reply'
  error?: string
  tools?: MuseToolCallView[]
  media?: MuseMediaPartView[]
}

export interface MobileWorkspaceSnapshot {
  version: 1
  updatedAtMs: number
  hostName: string
  selectedBotId: string | null
  groups: MobileSyncedGroup[]
  bots: MobileSyncedBot[]
  accounts: Record<string, MobileSyncedAccount>
  messages: Record<string, MobileSyncedMessage[]>
  approvals: Record<string, HermesApprovalView[]>
}

// Optional metadata used only on the existing desktop snapshot IPC channel.
export interface MobileWorkspaceSnapshotUpdate extends MobileWorkspaceSnapshot {
  snapshotRequestId?: string
  publishSnapshot?: boolean
}

export interface DirectHermesCredential {
  accountId: string
  botId?: string
  botName?: string
  baseUrl: string
  apiKey?: string
  model?: string
  displayName?: string
}

export interface PairedMobileDeviceView {
  deviceId: string
  deviceName: string
  deviceModel?: string
  pairedAtMs: number
  lastSeenAtMs: number
  connected: boolean
}

export interface MobileSyncStateView {
  running: boolean
  port: number | null
  hosts: string[]
  primaryHost: string | null
  hostName: string
  fingerprint: string
  pairUri: string | null
  pairExpiresAtMs: number | null
  includeDirectCredentials: boolean
  devices: PairedMobileDeviceView[]
  snapshotRequestId?: string
  error?: string
}

export type MobileBridgeLiveEvent =
  | {
      type: 'snapshot'
      snapshot: MobileWorkspaceSnapshot
    }
  | {
      type: 'message_delta'
      botId: string
      accountId: string
      messageId: string
      text: string
      tools?: MuseToolCallView[]
      media?: MuseMediaPartView[]
    }
  | {
      type: 'message'
      botId: string
      message: MobileSyncedMessage
    }
  | {
      type: 'typing'
      botId: string
      isTyping: boolean
    }
  | {
      type: 'status'
      accountId: string
      status: MobileConnectionStatus
      detail?: string
    }
  | {
      type: 'approvals'
      accountId: string
      pending: HermesApprovalView[]
    }

export interface MobileOutboundAttachment {
  name: string
  mimeType: string
  dataUrl: string
  size?: number
}

export interface MobileSendCommand {
  botId: string
  text: string
  clientMessageId: string
  attachments?: MobileOutboundAttachment[]
}

export type MobileSendResult =
  | { ok: true; messageId: string }
  | { ok: false; status: 400 | 404 | 409 | 503; message: string }

export type MobileRelayCommand =
  | {
      kind: 'stopGeneration'
      botId: string
    }
  | {
      kind: 'newSession'
      botId: string
    }
  | {
      kind: 'decideApproval'
      accountId: string
      platformId: MobilePlatformId
      approvalId: string
      decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always'
    }

export interface PairingUriParts {
  version: number
  hosts: string[]
  port: number
  token: string
  key: string
  name: string
  fp: string
}

export function buildPairingUri(parts: PairingUriParts): string {
  const params = new URLSearchParams({
    v: String(parts.version),
    hosts: parts.hosts.join(','),
    port: String(parts.port),
    token: parts.token,
    key: parts.key,
    name: parts.name,
    fp: parts.fp
  })
  return `botark://pair?${params.toString()}`
}

export function parsePairingUri(raw: string): PairingUriParts | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'botark:' || u.host !== 'pair') return null
    const v = Number.parseInt(u.searchParams.get('v') || '1', 10)
    const hosts = (u.searchParams.get('hosts') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const port = Number.parseInt(u.searchParams.get('port') || '0', 10)
    const token = (u.searchParams.get('token') || '').trim()
    const key = (u.searchParams.get('key') || '').trim()
    const name = (u.searchParams.get('name') || 'BotArk Desktop').trim()
    const fp = (u.searchParams.get('fp') || '').trim()
    if (!hosts.length || !Number.isFinite(port) || port <= 0 || port > 65535 || !token || !key) {
      return null
    }
    return { version: v, hosts, port, token, key, name, fp }
  } catch {
    return null
  }
}
