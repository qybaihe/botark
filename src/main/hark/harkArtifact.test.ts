import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch }) } }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => id }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: vi.fn() }))

import { downloadHarkArtifact } from './harkClient'

beforeEach(() => {
  fetch.mockReset()
  fetch.mockResolvedValue(
    new Response('# Test document', { headers: { 'Content-Type': 'text/markdown' } })
  )
})

describe('Hark artifact downloads', () => {
  it.each([
    ['url', '/api/files/file-id'],
    ['fileId', '/api/files/file-id']
  ])('resolves a relative API path supplied as %s against the Hark origin', async (kind, path) => {
    const result = await downloadHarkArtifact('account', { [kind]: path, name: 'test.md' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('https://app.hark.com/api/files/file-id')
    expect(fetch.mock.calls[0]?.[0]).not.toContain('/api/api/')
    expect(result.text).toBe('# Test document')
  })

  it('preserves an absolute artifact URL', async () => {
    await downloadHarkArtifact('account', { url: 'https://app.hark.com/api/files/file-id?download=1' })
    expect(fetch).toHaveBeenCalledWith('https://app.hark.com/api/files/file-id?download=1')
  })
})
