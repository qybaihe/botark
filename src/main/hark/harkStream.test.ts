import type { Session } from 'electron'
import { expect, it, vi } from 'vitest'
import { readHarkStream } from './harkClient'

it('decodes split SSE records for the selected conversation and ignores heartbeat events', async () => {
  const chunks = ['event: ping\r\ndata: beat\r\n\r\ndata: {"text":"', 'line"}\ndata: part two\n\n']
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      for (const part of chunks) controller.enqueue(new TextEncoder().encode(part))
      controller.close()
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const frames: string[] = []
  await readHarkStream({ fetch } as unknown as Session, 'fixture/thread', 'manager', 'initial',
    new AbortController().signal, (frame) => frames.push(frame))
  expect(frames).toEqual(['{"text":"line"}\npart two'])
  const url = new URL((fetch.mock.calls as unknown as [string][])[0]![0])
  expect(url.searchParams.get('conversationId')).toBe('fixture/thread')
})

it('keeps the current browser frame in the selected conversation as Hark updates its activity window', async () => {
  const { HarkConversationSyncState } = await import('./harkClient')
  const { currentHarkBrowser } = await import('@shared/harkBrowserPreview')
  const state = new HarkConversationSyncState()
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: {
    windows: { w: { panels: [
      { dispatchId: 'browser', kind: 'browser', status: 'active', title: 'Schedule', screenshot: { key: 'frame1' } },
      { dispatchId: 'old', kind: 'browser', status: 'completed', screenshot: { key: 'old-frame' } }
    ] } }
  } }))
  expect(currentHarkBrowser(state.extractPanels())).toMatchObject({ label: 'Schedule', screenshotKey: 'frame1' })
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{
    op: 'panel_update', id: 'w', dispatchId: 'browser', fields: { screenshot: { key: 'frame2' } }
  }] }))
  expect(currentHarkBrowser(state.extractPanels())?.screenshotKey).toBe('frame2')
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: {} }))
  expect(currentHarkBrowser(state.extractPanels())).toBeNull()
})
