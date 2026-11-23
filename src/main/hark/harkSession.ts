import { extractHandle, getAuthSession, getProfile, HarkApiError, type HarkAuthSession } from './harkClient'

export type HarkSessionProbe =
  | {
      session: NonNullable<HarkAuthSession>
      handle?: string
      displayName?: string
      userId?: string
    }
  | { signedIn: false }

export async function probeHarkSession(
  accountId: string,
  options?: { reportConnectionErrors?: boolean }
): Promise<HarkSessionProbe> {
  let profileFailed = false
  try {
    const profile = await getProfile(accountId, true) as { email?: unknown; name?: unknown; nickname?: unknown } | null
    if (typeof profile?.email === 'string' && profile.email.trim()) {
      const name = typeof profile.nickname === 'string' && profile.nickname.trim()
        ? profile.nickname
        : typeof profile.name === 'string' ? profile.name : undefined
      const session = { user: { email: profile.email, name } }
      return { session, ...extractHandle(session) }
    }
  } catch (error) {
    if (error instanceof HarkApiError && error.status === 401) return { signedIn: false }
    profileFailed = true
  }
  try {
    const session = await getAuthSession(accountId)
    if (session && (session.user || session.session)) {
      return { session, ...extractHandle(session) }
    }
    if (profileFailed && options?.reportConnectionErrors) throw new Error('Hark profile lookup failed')
  } catch (error) {
    if (options?.reportConnectionErrors && !(error instanceof HarkApiError && error.status === 401)) {
      throw new Error('无法验证 Hark 会话，请检查网络或代理后再刷新')
    }
    // Login polling treats failed probes as pending until the window closes.
    if (process.env['BOTHUB_HARK_DEBUG'] === '1') {
      console.warn('[hark] get-session probe failed')
    }
  }
  return { signedIn: false }
}
