import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./harkClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harkClient')>()),
  getAuthSession: vi.fn(),
  getProfile: vi.fn()
}))

import { getAuthSession, getProfile, HarkApiError } from './harkClient'
import { probeHarkSession } from './harkSession'

const getAuthSessionMock = vi.mocked(getAuthSession)

beforeEach(() => {
  getAuthSessionMock.mockReset()
  vi.mocked(getProfile).mockReset()
})

describe('Hark session validation', () => {
  it.each([null, {}, { user: null, session: null }])(
    'does not authenticate an empty get-session response: %j',
    async (response) => {
      getAuthSessionMock.mockResolvedValue(response)
      await expect(probeHarkSession('account')).resolves.toEqual({ signedIn: false })
    }
  )

  it('does not authenticate when the get-session request throws', async () => {
    getAuthSessionMock.mockRejectedValue(new Error('unauthorized'))
    expect(await probeHarkSession('account')).toEqual({ signedIn: false })
  })

  it('distinguishes a failed refresh from an expired session', async () => {
    getAuthSessionMock.mockRejectedValueOnce(new Error('timeout'))
    await expect(probeHarkSession('account', { reportConnectionErrors: true })).rejects.toThrow('无法验证')
    getAuthSessionMock.mockRejectedValueOnce(new HarkApiError(401, 'Unauthorized'))
    await expect(probeHarkSession('account', { reportConnectionErrors: true })).resolves.toEqual({ signedIn: false })
  })

  it('recognizes a usable account without waiting for get-session when profile is authenticated', async () => {
    vi.mocked(getProfile).mockResolvedValue({ email: 'fixture@example.test', name: 'Fixture' })
    await expect(probeHarkSession('existing-account', { reportConnectionErrors: true })).resolves.toMatchObject({
      handle: 'fixture@example.test',
      displayName: 'Fixture'
    })
    expect(getAuthSessionMock).not.toHaveBeenCalled()
    expect(getProfile).toHaveBeenCalledWith('existing-account', true)
  })

  it('returns profile data for a valid session', async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: 'user', name: 'Hark user' } })
    await expect(probeHarkSession('account')).resolves.toEqual({
      session: { user: { id: 'user', name: 'Hark user' } },
      handle: 'Hark user',
      displayName: 'Hark user',
      userId: 'user'
    })
  })
})
