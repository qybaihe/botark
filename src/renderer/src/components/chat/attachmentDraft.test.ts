import { describe, expect, it, vi } from 'vitest'
import { createAttachmentDraft } from './attachmentDraft'

describe('attachment drafts', () => {
  it('blocks sending immediately and preserves selection order across overlapping reads', async () => {
    const draft = createAttachmentDraft(() => undefined)
    const slow = new File(['a'], 'first.png')
    let finish!: (data: ArrayBuffer) => void
    vi.spyOn(slow, 'arrayBuffer').mockReturnValue(new Promise((resolve) => { finish = resolve }))

    const first = draft.add([slow])
    expect(draft.forSend()).toBeNull()
    await draft.add([new File(['b'], 'second.txt')])
    expect(draft.forSend()).toBeNull()
    finish(new Uint8Array([97]).buffer)
    await first

    expect(draft.forSend()).toMatchObject([
      { name: 'first.png', mimeType: 'image/png', dataBase64: 'YQ==' },
      { name: 'second.txt', dataBase64: 'Yg==' }
    ])
  })

  it('keeps files that read successfully and requires failed files to be removed before sending', async () => {
    const changed = vi.fn()
    const draft = createAttachmentDraft(changed)
    const failed = new File(['a'], 'failed.txt')
    vi.spyOn(failed, 'arrayBuffer').mockRejectedValue(new Error('unreadable'))
    const big = new File(['not really this large'], 'large.png')
    vi.spyOn(big, 'size', 'get').mockReturnValue(21 * 1024 * 1024)
    const empty = new File([], 'empty.txt')

    await draft.add([failed, big, empty, new File(['ok'], 'good.txt')])

    const entries = changed.mock.lastCall![0]
    expect(entries.map((entry: { status: string }) => entry.status)).toEqual([
      'read-failed', 'too-large', 'empty', 'ready'
    ])
    expect(draft.forSend()).toBeNull()
    for (const entry of entries.slice(0, 3)) draft.remove(entry.file.id)
    expect(draft.forSend()).toMatchObject([{ name: 'good.txt', dataBase64: 'b2s=' }])
  })

  it('does not restore a removed or cleared file when its read completes', async () => {
    const changed = vi.fn()
    const draft = createAttachmentDraft(changed)
    const slow = new File(['a'], 'old.txt')
    let finish!: (data: ArrayBuffer) => void
    vi.spyOn(slow, 'arrayBuffer').mockReturnValue(new Promise((resolve) => { finish = resolve }))

    const first = draft.add([slow])
    draft.remove(changed.mock.lastCall![0][0].file.id)
    expect(draft.forSend()).toEqual([])
    draft.clear()
    await draft.add([new File(['b'], 'new.txt')])
    finish(new Uint8Array([97]).buffer)
    await first

    expect(draft.forSend()).toMatchObject([{ name: 'new.txt' }])
  })
})
