/**
 * Per-account watch controller for Cue by Manus (`cueWatchManager.ts`).
 * Mirrors `grokWatchManager.ts`: isolates watch loops, pending approvals,
 * watched sessions, and stream fan-out per `accountId`, and cleans up all watches on quit.
 */
import type { CueTurnEvent } from '../../adapters/cue/events'
import { stopCueChatSocket } from './cueChatSocket'

export interface CueAccountWatchController {
  accountId: string
  agentIds: Set<string>
  sessionAgents: Map<string, string>
  aborted: boolean
  abortController: AbortController
  pendingApprovals: Map<string, Record<string, unknown>>
}

const watches = new Map<string, CueAccountWatchController>()
let eventEmitter: ((event: CueTurnEvent) => void) | undefined

export function setCueWatchEventEmitter(emitter: (event: CueTurnEvent) => void): void {
  eventEmitter = emitter
}

export function emitCueWatchEvent(event: CueTurnEvent): void {
  try {
    eventEmitter?.(event)
  } catch (err) {
    console.error('[cue-watch] emitter failed', err)
  }
}

export function getCueAccountWatch(accountId: string): CueAccountWatchController | undefined {
  const ctrl = watches.get(accountId)
  return ctrl && !ctrl.aborted ? ctrl : undefined
}

export function ensureCueAccountWatch(
  accountId: string,
  agentIds: string[] = []
): CueAccountWatchController {
  let existing = watches.get(accountId)
  if (!existing || existing.aborted) {
    existing = {
      accountId,
      agentIds: new Set(agentIds),
      sessionAgents: new Map(),
      aborted: false,
      abortController: new AbortController(),
      pendingApprovals: new Map()
    }
    watches.set(accountId, existing)
  } else {
    for (const id of agentIds) existing.agentIds.add(id)
  }
  return existing
}

export function rebindCueAccountWatch(accountId: string): void {
  const existing = watches.get(accountId)
  const prevAgents = existing ? [...existing.agentIds] : []
  stopCueAccountWatch(accountId)
  if (prevAgents.length > 0) {
    ensureCueAccountWatch(accountId, prevAgents)
  }
}

export function stopCueAccountWatch(accountId: string): void {
  stopCueChatSocket(accountId)
  if (accountId === '*') {
    for (const ctrl of watches.values()) {
      ctrl.aborted = true
      ctrl.abortController.abort()
      ctrl.pendingApprovals.clear()
      ctrl.sessionAgents.clear()
    }
    watches.clear()
    return
  }
  const ctrl = watches.get(accountId)
  if (!ctrl) return
  ctrl.aborted = true
  ctrl.abortController.abort()
  ctrl.pendingApprovals.clear()
  ctrl.sessionAgents.clear()
  watches.delete(accountId)
}

export function listActiveCueWatchedAccounts(): string[] {
  return [...watches.keys()]
}
