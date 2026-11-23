import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Monitor } from 'lucide-react'
import type { HarkBrowserPreview } from '@shared/harkBrowserPreview'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'

export function HarkBrowserCard({ accountId, sessionId }: { accountId: string; sessionId?: string }) {
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<HarkBrowserPreview | null>(null)
  const [image, setImage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const streamRevision = useRef(0)
  const hark = getBridge()?.hark

  useEffect(() => hark?.onEvent((event) => {
    if (event.type === 'projectHistory' && event.accountId === accountId && event.conversationId === sessionId
      && event.browserPreview !== undefined) {
      streamRevision.current++
      setPanel(event.browserPreview)
    }
  }), [hark, accountId, sessionId])

  useEffect(() => {
    if (!open || !hark) return
    let current = true
    const before = streamRevision.current
    setLoading(true)
    setError('')
    void hark.rpc({ accountId, op: 'browserPreview', conversationId: sessionId }).then((res) => {
      if (!current || before !== streamRevision.current) return
      if (!res.ok) throw new Error(res.message)
      setPanel(res.data as HarkBrowserPreview | null)
    }).catch((err) => {
      if (current) setError(String(err instanceof Error ? err.message : err))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [open, hark, accountId, sessionId, revision])

  const key = panel?.screenshotKey
  const url = panel?.screenshotUrl
  useEffect(() => {
    setImage('')
    if (!open || !hark || (!key && !url)) return
    let current = true
    setError('')
    void hark.rpc({ accountId, op: 'downloadArtifact', fileId: key, url: key ? undefined : url }).then((res) => {
      if (!res.ok) throw new Error(res.message)
      const data = res.data as { mimeType: string; dataBase64: string }
      if (!data?.mimeType?.startsWith('image/') || !data.dataBase64) throw new Error('截图不可用')
      if (current) setImage(`data:${data.mimeType};base64,${data.dataBase64}`)
    }).catch((err) => {
      if (current) setError(String(err instanceof Error ? err.message : err))
    })
    return () => { current = false }
  }, [open, hark, accountId, key, url, revision])

  if (!hark) return null
  return (
    <section className="mx-5 mb-1 shrink-0 rounded-xl border border-line bg-surface px-3 text-[12px]">
      <div className="flex items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-ink-secondary">
          <Monitor className="size-4 shrink-0" /><span className="shrink-0">远程浏览器</span>
          <span className="truncate">{panel?.label}</span>
          <ChevronDown className={open ? 'ml-auto size-4 rotate-180' : 'ml-auto size-4'} />
        </button>
        {open && <RefreshButton loading={loading} onClick={() => setRevision((r) => r + 1)} />}
      </div>
      {open && <div className="pb-2">
        {image && <img src={image} alt="Hark 远程浏览器截图" className="max-h-[24vh] w-full rounded-lg bg-sunken object-contain" />}
        <p className="truncate text-ink-muted" role="status">{error || (loading ? '正在刷新…' : panel
          ? panel.status + (image ? '' : key || url ? ' · 正在加载截图…' : ' · 暂无截图')
          : '当前对话暂无浏览器任务')}</p>
      </div>}
    </section>
  )
}
