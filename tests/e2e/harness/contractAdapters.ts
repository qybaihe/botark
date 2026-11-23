import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type MilestoneTag = 'M1' | 'M2' | 'M3' | 'M4'

export interface TestCtx {
  skip: (note?: string) => void
}

export function isPendingAllowed(): boolean {
  return process.env.BOTARK_E2E_ALLOW_PENDING === '1'
}

export function requireOrSkip(
  ctx: TestCtx,
  milestone: MilestoneTag,
  condition: boolean,
  detail: string
): asserts condition {
  if (condition) return
  if (isPendingAllowed()) {
    ctx.skip(`[PENDING:${milestone}] ${detail}`)
    return
  }
  throw new Error(`[UNIMPLEMENTED_CONTRACT:${milestone}] ${detail}`)
}

export function hasModule(relPath: string): boolean {
  return existsSync(resolve(process.cwd(), relPath))
}

export async function tryImportMain<T = Record<string, unknown>>(
  subpathNoExt: string
): Promise<T | null> {
  const relTs = `src/main/${subpathNoExt}.ts`
  if (!hasModule(relTs)) return null
  const prefix = '@main'
  return (await import(/* @vite-ignore */ `${prefix}/${subpathNoExt}`)) as T
}

export async function tryImportAdapter<T = Record<string, unknown>>(
  subpathNoExt: string
): Promise<T | null> {
  const relTs = `src/adapters/${subpathNoExt}.ts`
  if (!hasModule(relTs)) return null
  const prefix = '@adapters'
  return (await import(/* @vite-ignore */ `${prefix}/${subpathNoExt}`)) as T
}

export async function tryImportRenderer<T = Record<string, unknown>>(
  subpathNoExt: string
): Promise<T | null> {
  const relTs = `src/renderer/src/${subpathNoExt}.ts`
  const relTsx = `src/renderer/src/${subpathNoExt}.tsx`
  if (!hasModule(relTs) && !hasModule(relTsx)) return null
  const prefix = '@'
  return (await import(/* @vite-ignore */ `${prefix}/${subpathNoExt}`)) as T
}

export interface CueContractModules {
  authMod: Record<string, unknown>
  authStoreMod: Record<string, unknown>
  deviceIdMod: Record<string, unknown>
  loginMod: Record<string, unknown>
  clientMod: Record<string, unknown>
  watchMod: Record<string, unknown>
  ipcMod: Record<string, unknown>
  adapterMod: Record<string, unknown>
}

export async function probeCueContracts(ctx: TestCtx): Promise<CueContractModules> {
  const authMod = (await tryImportMain('cue/cueAuth')) ?? (await tryImportMain('cue/cueSandAuth'))
  const authStoreMod = await tryImportMain('cue/cueAuthStore')
  const deviceIdMod = (await tryImportMain('cue/cueDeviceId')) ?? (await tryImportMain('cue/cueMachineId'))
  const loginMod = await tryImportMain('cue/cueLogin')
  const clientMod = (await tryImportMain('cue/cueClient')) ?? (await tryImportMain('cue/connectClient'))
  const watchMod = await tryImportMain('cue/cueWatchManager')
  const ipcMod = await tryImportMain('cue/cueIpc')
  const adapterMod = await tryImportAdapter('cue/CueAdapter')

  const ok = Boolean(
    authMod && authStoreMod && deviceIdMod && loginMod && clientMod && watchMod && ipcMod && adapterMod
  )
  requireOrSkip(
    ctx,
    'M2',
    ok,
    'Cue multi-account modules (src/main/cue/* and src/adapters/cue/CueAdapter.ts) are not yet implemented'
  )

  return {
    authMod: authMod!,
    authStoreMod: authStoreMod!,
    deviceIdMod: deviceIdMod!,
    loginMod: loginMod!,
    clientMod: clientMod!,
    watchMod: watchMod!,
    ipcMod: ipcMod!,
    adapterMod: adapterMod!
  }
}

export function resolveCueDeviceIdFn(deviceIdMod: Record<string, unknown>): {
  getOrCreate: (accountId: string) => string
  peek?: (accountId: string) => string | undefined
} {
  const getOrCreate =
    (deviceIdMod.getOrCreateCueDeviceId as ((id: string) => string) | undefined) ??
    (deviceIdMod.getOrCreateCueMachineId as ((id: string) => string) | undefined)
  const peek =
    (deviceIdMod.peekCueDeviceId as ((id: string) => string | undefined) | undefined) ??
    (deviceIdMod.peekCueMachineId as ((id: string) => string | undefined) | undefined)
  if (!getOrCreate) {
    throw new Error('[UNIMPLEMENTED_CONTRACT:M2] Missing getOrCreateCueDeviceId/getOrCreateCueMachineId')
  }
  return { getOrCreate, peek }
}
