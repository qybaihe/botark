import { getPlatform } from '@adapters/platforms'
import type { PlatformId } from '@adapters/types'
import { createId } from '@shared/id'
import type { AccountDraft, Bot, BotAccount, BotGroup } from '@/types'

export const PROXY_POOL_PLATFORMS: ReadonlySet<PlatformId> = new Set([
  'meta-muse',
  'grok',
  'dot',
  'hark',
  'antigravity',
  'cue'
])

function nextAvailableName(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function uniqueGroupName(groups: readonly BotGroup[], base = 'New section'): string {
  return nextAvailableName(new Set(groups.map((group) => group.name.toLowerCase())), base)
}

export function uniqueBotName(bots: ReadonlyArray<{ name: string }>, baseName: string): string {
  const base = baseName.trim() || 'Bot'
  return nextAvailableName(new Set(bots.map((bot) => bot.name.trim().toLowerCase())), base)
}

export function nameOrPlatformDefault(name: string, platformId: PlatformId): string {
  return name.trim() || getPlatform(platformId).name
}

export function isGenericGrokName(name: string): boolean {
  return /^Grok(?:\s+Bot)?(?:\s+\d+)?$/i.test(name.trim())
}

export function grokNamesForOtherAccounts(bots: readonly Bot[], accountId: string): ReadonlySet<string> {
  return new Set(
    bots
      .filter((bot) => bot.platformId === 'grok' && !bot.accountIds.includes(accountId))
      .map((bot) => bot.name.trim().toLowerCase())
  )
}

export function disambiguateGrokBotName(
  bots: ReadonlyArray<{ name: string }>,
  rawName: string,
  otherGrokNames: ReadonlySet<string>,
  accountSuffix: string
): string {
  const base = rawName.trim() || 'Grok Bot'
  return otherGrokNames.has(base.toLowerCase()) ? uniqueBotName(bots, `${base} (${accountSuffix})`) : base
}

export function isGenericDsBotName(name: string): boolean {
  return /^DS\s*Bot(?:\s+\d+)?$/i.test(name.trim())
}

export function dsBotNamesForOtherAccounts(bots: readonly Bot[], accountId: string): ReadonlySet<string> {
  return new Set(
    bots
      .filter((bot) => bot.platformId === 'ds-bot' && !bot.accountIds.includes(accountId))
      .map((bot) => bot.name.trim().toLowerCase())
  )
}

export function disambiguateDsBotName(
  bots: ReadonlyArray<{ name: string }>,
  rawName: string,
  otherNames: ReadonlySet<string>,
  accountSuffix: string
): string {
  const base = rawName.trim() || 'DS Bot'
  return otherNames.has(base.toLowerCase()) ? uniqueBotName(bots, `${base} (${accountSuffix})`) : base
}

export function isCuePlaceholderAgentId(id: string | undefined): boolean {
  return !id || id === 'agent-default' || id.startsWith('cue_default_')
}

function cueAgentName(rawName: string): string {
  const name = rawName.trim()
  return /^cue(?:\s+bot)?$/i.test(name) ? '' : name
}

function cueBotBaseName(agentName: string, handle: string): string {
  if (!agentName) return handle ? `Cue · ${handle}` : 'Cue'
  return handle ? `Cue · ${agentName} (${handle})` : `Cue · ${agentName}`
}

export function newCueBotName(bots: ReadonlyArray<{ name: string }>, agentName: string, handle: string): string {
  return uniqueBotName(bots, cueBotBaseName(cueAgentName(agentName), handle))
}

export function syncedCueBotName(
  others: ReadonlyArray<{ name: string }>,
  bot: Pick<Bot, 'name' | 'selectedAgentId'>,
  agent: { id: string; name: string },
  handle: string
): string {
  const previousName = bot.name.trim()
  const agentName = cueAgentName(agent.name)
  const isPlaceholderUpgrade = isCuePlaceholderAgentId(bot.selectedAgentId) &&
    !isCuePlaceholderAgentId(agent.id) &&
    Boolean(agentName) &&
    /^cue(?:\s*·|\s+\d+)?(?:\s+.*)?$/i.test(previousName)
  if (isPlaceholderUpgrade) return uniqueBotName(others, cueBotBaseName(agentName, handle))

  const needsRename = /^cue(?:\s+\d+)?$/i.test(previousName) ||
    others.some((other) => other.name.trim().toLowerCase() === previousName.toLowerCase())
  return needsRename ? uniqueBotName(others, handle ? `Cue · ${handle}` : bot.name) : bot.name
}

/** Turn form drafts into account ids, creating BotAccounts for new ones. */
export function materializeAccounts(
  platformId: PlatformId,
  drafts: AccountDraft[],
  existing: Record<string, BotAccount>
): { ids: string[]; created: Record<string, BotAccount> } {
  const ids: string[] = []
  const created: Record<string, BotAccount> = {}
  for (const draft of drafts) {
    const displayName = draft.displayName.trim() || draft.handle.trim()
    // Keep drafts that already have a partition account id even if the name is empty.
    if (!displayName && !draft.accountId) continue
    if (draft.accountId && existing[draft.accountId]) {
      if (!ids.includes(draft.accountId)) ids.push(draft.accountId)
      continue
    }
    const id = draft.accountId ?? createId('acc')
    created[id] = {
      id,
      platformId,
      displayName: nameOrPlatformDefault(displayName, platformId),
      handle: draft.handle.trim(),
      status: 'offline',
      ...(draft.importKey ? { importKey: draft.importKey } : {})
    }
    ids.push(id)
  }
  return { ids, created }
}

/** Pool bookkeeping lists: cloud platforms (Muse, Grok, Dot, Hark, Antigravity, Cue) can receive 1-to-1 pool assignments. */
export function poolAccountIds(accounts: Record<string, { id: string; platformId: string }>): {
  museIds: string[]
  grokIds: string[]
  dotIds: string[]
  harkIds: string[]
  antigravityIds: string[]
  cueIds: string[]
  keepIds: string[]
  assignableIds: string[]
} {
  const all = Object.values(accounts)
  const museIds = all.filter((a) => a.platformId === 'meta-muse').map((a) => a.id)
  const grokIds = all.filter((a) => a.platformId === 'grok').map((a) => a.id)
  const dotIds = all.filter((a) => a.platformId === 'dot').map((a) => a.id)
  const harkIds = all.filter((a) => a.platformId === 'hark').map((a) => a.id)
  const antigravityIds = all.filter((a) => a.platformId === 'antigravity').map((a) => a.id)
  const cueIds = all.filter((a) => a.platformId === 'cue').map((a) => a.id)
  // Keep `keepIds` as all non-Muse accounts so MuseBatchImport.tsx never drops other platforms' slots.
  const keepIds = all.filter((a) => a.platformId !== 'meta-muse').map((a) => a.id)
  return {
    museIds,
    grokIds,
    dotIds,
    harkIds,
    antigravityIds,
    cueIds,
    keepIds,
    assignableIds: [...museIds, ...grokIds, ...dotIds, ...harkIds, ...antigravityIds, ...cueIds]
  }
}

/** Build `assignProxyPool(accountIds, keepIds)` arguments while protecting all other accounts' slots. */
export function proxyPoolArgsForAccounts(
  accounts: Record<string, { id: string; platformId: string }>,
  targetIds?: readonly string[]
): { accountIds: string[]; keepIds: string[] } {
  const all = Object.values(accounts)
  if (!targetIds) {
    const { assignableIds } = poolAccountIds(accounts)
    const assignedSet = new Set(assignableIds)
    return {
      accountIds: assignableIds,
      keepIds: all.filter((a) => !assignedSet.has(a.id)).map((a) => a.id)
    }
  }
  const filteredTargets = [
    ...new Set(
      targetIds.filter((id) => {
        const acc = accounts[id]
        return !acc || PROXY_POOL_PLATFORMS.has(acc.platformId as PlatformId)
      })
    )
  ]
  const targetSet = new Set(filteredTargets)
  return {
    accountIds: filteredTargets,
    keepIds: all.filter((a) => !targetSet.has(a.id)).map((a) => a.id)
  }
}
