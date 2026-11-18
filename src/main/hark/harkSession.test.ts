import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./harkClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harkClient')>()),
  getAuthSession: vi.fn()
}))

import { getAuthSession } from './harkClient'
import { probeHarkSession } from './harkSession'

const getAuthSessionMock = vi.mocked(getAuthSession)

beforeEach(() => {
  getAuthSessionMock.mockReset()
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
