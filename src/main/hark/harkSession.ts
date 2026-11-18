import { extractHandle, getAuthSession, type HarkAuthSession } from './harkClient'

export type HarkSessionProbe =
  | {
      session: NonNullable<HarkAuthSession>
      handle?: string
      displayName?: string
      userId?: string
    }
  | { signedIn: false }

export async function probeHarkSession(accountId: string): Promise<HarkSessionProbe> {
  try {
    const session = await getAuthSession(accountId)
    if (session && (session.user || session.session)) {
      return { session, ...extractHandle(session) }
    }
  } catch {
    // An invalid session must not be authenticated merely because cookies remain.
    if (process.env['BOTHUB_HARK_DEBUG'] === '1') {
      console.warn('[hark] get-session probe failed')
    }
  }
  return { signedIn: false }
}
