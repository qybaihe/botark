import { describe, expect, it } from 'vitest'
import { parseAnyCueCredentialInput } from './cueAuth'
import { mapCueMembershipQuota } from './cueClient'

describe('Cue multi-account credential parser & quota mapper', () => {
  it('parses all 5 supported Cue credential formats cleanly', () => {
    const apiKey = parseAnyCueCredentialInput('sk-manus-test-key-1234567890')
    expect(apiKey.authKind).toBe('api-key')
    expect(apiKey.apiKey).toBe('sk-manus-test-key-1234567890')

    const headerKey = parseAnyCueCredentialInput('x-manus-api-key: manus-secret-abcdef123456')
    expect(headerKey.authKind).toBe('api-key')
    expect(headerKey.apiKey).toBe('manus-secret-abcdef123456')

    const bearer = parseAnyCueCredentialInput(
      'Bearer eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFsaWNlQGN1ZS5pbSIsImV4cCI6OTk5OTk5OTk5OX0.sig'
    )
    expect(bearer.authKind).toBe('oauth')
    expect(bearer.handle).toBe('alice@cue.im')

    const cookie = parseAnyCueCredentialInput('Cookie: session_id=sess_123456789; theme=dark')
    expect(cookie.authKind).toBe('session')
    expect(cookie.accessToken).toBe('sess_123456789')

    const arr = parseAnyCueCredentialInput(
      JSON.stringify([{ name: 'cue_session', value: 'cookie_val_999', domain: '.cue.im' }])
    )
    expect(arr.authKind).toBe('session')
    expect(arr.accessToken).toBe('cookie_val_999')
  })

  it('clamps over-reserved Cue membership credits to 0 and separates purchased balance', () => {
    const mapped = mapCueMembershipQuota({
      membership: { accessAllowed: true },
      limitCredits: 1000,
      usedCredits: 700,
      reservedCredits: 450,
      purchasedRemainingCredits: 500,
      windowStartMs: 100,
      windowEndMs: 200
    })
    expect(mapped.accessAllowed).toBe(true)
    expect(mapped.weeklyRemainingCredits).toBe(0)
    expect(mapped.remainingPercent).toBe(0)
    expect(mapped.purchasedRemainingCredits).toBe(500)
  })
})
