import { describe, expect, it, vi } from 'vitest'
import { attachGoogleOAuthWebContentsGuard } from './googleOAuthUaGuard'

const NATIVE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth'
const MANUS_CALLBACK_URL = 'https://api.manus.im/api/oauth2_callback/google'

function makeWc(initialUrl: string) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let url = initialUrl
  let ua = NATIVE_UA
  const wc = {
    isDestroyed: () => false,
    getURL: () => url,
    getUserAgent: () => ua,
    setUserAgent: vi.fn((next: string) => {
      ua = next
    }),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb])
    }
  }
  const emit = (event: string, target: string) => {
    for (const cb of listeners.get(event) ?? []) cb({}, target)
  }
  return { wc, emit, setUrl: (next: string) => (url = next) }
}

const ses = { getUserAgent: () => NATIVE_UA }

describe('attachGoogleOAuthWebContentsGuard', () => {
  it('never calls setUserAgent while a page is committed (it would reload cue.im/login and cancel the Google navigation)', () => {
    const { wc, emit, setUrl } = makeWc('https://cue.im/login')
    attachGoogleOAuthWebContentsGuard(wc as never, ses as never)

    emit('will-navigate', GOOGLE_AUTH_URL)
    setUrl('https://accounts.google.com/v3/signin/identifier')
    emit('will-redirect', MANUS_CALLBACK_URL)
    emit('will-navigate', 'https://cue.im/')

    expect(wc.setUserAgent).not.toHaveBeenCalled()
  })

  it('still cleans the UA for a fresh popup whose first navigation is Google', () => {
    const { wc, emit } = makeWc('')
    attachGoogleOAuthWebContentsGuard(wc as never, ses as never)

    emit('will-navigate', GOOGLE_AUTH_URL)

    expect(wc.setUserAgent).toHaveBeenCalledTimes(1)
    const applied = wc.setUserAgent.mock.calls[0]?.[0] ?? ''
    expect(applied).not.toContain('Electron')
    expect(applied).toContain('Chrome/156.0.8078.75')
  })
})
