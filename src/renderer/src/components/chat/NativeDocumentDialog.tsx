import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, FileCode, FileText, Maximize2, Minimize2, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { MarkdownText } from './MarkdownText'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'

export interface NativeDocumentTarget {
  accountId: string
  title: string
  /** Optional inline markdown/text already available in the message/widget. */
  markdown?: string
  /** Optional raw HTML already available. */
  html?: string
  /** Optional VM workspace path (`workspace/...`) or remote URL/fileId to load. */
  path?: string
  mimeType?: string
  platformId?: string
  agentId?: string
  sessionId?: string
}

function documentTargetKey(target: NativeDocumentTarget): string {
  return JSON.stringify([
    target.platformId, target.accountId, target.agentId, target.sessionId, target.path, target.title,
    target.mimeType, target.markdown, target.html
  ])
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') ||
    mime === 'image/svg+xml' ||
    /^application\/(?:[^/]+\+)?(?:json|xml|markdown|javascript|x-javascript|x-sh|x-yaml|yaml)$/.test(mime)
}

function base64Bytes(base64: string) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

interface DocumentContent {
  content: string
  rawBase64?: string
  mime: string
}

interface DownloadedDocument {
  dataBase64?: string
  mimeType?: string
  text?: unknown
}

function downloadedContent(
  data: DownloadedDocument,
  target: NativeDocumentTarget,
  fallbackMime: string
): DocumentContent {
  const mime = (data.mimeType || target.mimeType || fallbackMime).split(';')[0]!.trim().toLowerCase()
  const rawBase64 = typeof data.dataBase64 === 'string' ? data.dataBase64 : undefined
  const isText = isTextMime(mime)
  if (rawBase64 === undefined && (!isText || typeof data.text !== 'string')) {
    throw new Error(t('Document preview is unavailable'))
  }
  let content = ''
  if (isText) {
    if (typeof data.text === 'string') content = data.text
    else if (rawBase64 !== undefined) content = new TextDecoder().decode(base64Bytes(rawBase64))
  }
  return { rawBase64, mime, content }
}

async function loadDocument(target: NativeDocumentTarget): Promise<DocumentContent> {
  if (target.markdown) return { content: target.markdown, mime: 'text/markdown' }
  if (target.html) return { content: target.html, mime: 'text/html' }
  const rawPath = target.path?.trim()
  if (!rawPath) {
    if (target.markdown !== undefined) return { content: target.markdown, mime: 'text/markdown' }
    if (target.html !== undefined) return { content: target.html, mime: 'text/html' }
    throw new Error(t('Document preview is unavailable'))
  }
  const bridge = getBridge()
  const isHttpUrl = /^https?:\/\//i.test(rawPath)
  const isDotFileId = /^(CalpicoFile_|file_|libfile_|sediment:\/\/|dotfile:\/\/|dotatt:\/\/)/i.test(rawPath)
  const isHarkFile =
    target.platformId === 'hark' ||
    /^(harkatt:\/\/|harkfile:\/\/)/i.test(rawPath) ||
    /hark\.com|hark\.ai/i.test(rawPath)

  const isGrokFile =
    target.platformId === 'grok' ||
    /^(grokstore:\/\/|grokatt:\/\/|grokdoc:\/\/)/i.test(rawPath)

  if (isGrokFile && bridge?.grok?.rpc) {
    let groupChatId: string | undefined
    let storeId: string | undefined
    let documentId: string | undefined
    if (rawPath.startsWith('grokdoc://')) {
      // grokdoc://<groupChatId>/<storeId>/<documentId>
      const parts = rawPath.slice('grokdoc://'.length).split('/')
      groupChatId = parts[0]
      storeId = parts[1]
      documentId = parts.slice(2).join('/')
    }
    const grokRes = await bridge.grok.rpc({
      accountId: target.accountId,
      op: 'downloadAttachment',
      agentId: target.agentId,
      sessionId: target.sessionId,
      path: !groupChatId && !isHttpUrl ? rawPath : undefined,
      url: isHttpUrl ? rawPath : undefined,
      groupChatId,
      storeId,
      documentId,
      name: target.title
    })
    if (grokRes.ok && grokRes.data && typeof grokRes.data === 'object') {
      return downloadedContent(grokRes.data as DownloadedDocument, target, 'text/markdown')
    }
    if (!grokRes.ok) {
      throw new Error(grokRes.message || `Grok document load failed (${grokRes.status})`)
    }
  }

  if (isHarkFile && bridge?.hark?.rpc) {
    const cleanRef = rawPath.replace(/^(harkatt|harkfile):\/\//i, '')
    const harkRes = await bridge.hark.rpc({
      accountId: target.accountId,
      op: 'downloadArtifact',
      url: /^https?:\/\//i.test(cleanRef) ? cleanRef : undefined,
      fileId: !/^https?:\/\//i.test(cleanRef) ? cleanRef : undefined,
      name: target.title
    })
    if (harkRes.ok && harkRes.data && typeof harkRes.data === 'object') {
      return downloadedContent(harkRes.data as DownloadedDocument, target, 'text/plain')
    }
    if (!harkRes.ok) {
      throw new Error(harkRes.message || `Hark document load failed (${harkRes.status})`)
    }
  }

  const isMuseUrl = target.platformId === 'meta-muse' || /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(rawPath)

  if ((isHttpUrl || isDotFileId) && bridge?.dot?.rpc && target.platformId !== 'hark' && !isMuseUrl) {
    const dotRes = await bridge.dot.rpc({
      accountId: target.accountId,
      op: 'downloadFile',
      url: isHttpUrl ? rawPath : undefined,
      fileId: !isHttpUrl ? rawPath.replace(/^(sediment|dotfile|dotatt):\/\//i, '') : undefined,
      name: target.title
    })
    if (dotRes.ok && dotRes.data && typeof dotRes.data === 'object') {
      return downloadedContent(dotRes.data as DownloadedDocument, target, 'text/plain')
    }
    if (!isHttpUrl && !dotRes.ok) {
      throw new Error(dotRes.message || `Download failed (${dotRes.status})`)
    }
  }

  if (isHttpUrl && bridge?.hark?.rpc) {
    const harkRes = await bridge.hark.rpc({
      accountId: target.accountId,
      op: 'downloadArtifact',
      url: rawPath,
      name: target.title
    })
    if (harkRes.ok && harkRes.data && typeof harkRes.data === 'object') {
      return downloadedContent(harkRes.data as DownloadedDocument, target, 'text/plain')
    }
  }

  const muse = bridge?.muse
  if (muse && (!target.platformId || target.platformId === 'meta-muse' || isMuseUrl)) {
    const cleanPath = rawPath.replace(/^\/+/, '')
    let previewError: unknown
    if (muse.previewWorkspaceFile) {
      try {
        const res = await muse.previewWorkspaceFile(target.accountId, cleanPath)
        return downloadedContent(res, target, 'text/markdown')
      } catch (error) {
        previewError = error
      }
    }
    if (muse.rpc) {
      const raw = await muse.rpc({
        accountId: target.accountId,
        method: 'fs.read',
        params: { path: cleanPath }
      })
      const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const rawBase64 = typeof o['data_base64'] === 'string' ? o['data_base64'] : undefined
      const mime = o['mimeType'] || o['mime_type']
      const inline = typeof o['content'] === 'string' ? o['content'] : o['text']
      if (rawBase64 !== undefined || typeof inline === 'string') {
        return downloadedContent({
          dataBase64: rawBase64,
          mimeType: typeof mime === 'string' ? mime : undefined,
          text: inline
        }, target, 'text/markdown')
      }
      if (raw == null) throw new Error(t('Document preview is unavailable'))
      return { content: JSON.stringify(raw, null, 2), mime: 'application/json' }
    }
    if (previewError) throw previewError
  }
  throw new Error(t('Document preview is unavailable'))
}

type DocumentRequest = { targetKey: string; requestId: number }
type DocumentLoad = DocumentRequest & (
  | { status: 'loading' }
  | { status: 'loaded'; data: DocumentContent }
  | { status: 'error'; error: string }
)

function useDocumentContent(target: NativeDocumentTarget) {
  const targetKey = useMemo(() => documentTargetKey(target), [target])
  const sequence = useRef(0)
  const currentTarget = useRef({ target, targetKey })
  const [load, setLoad] = useState<DocumentLoad>()

  useLayoutEffect(() => {
    currentTarget.current = { target, targetKey }
  }, [target, targetKey])

  const reload = useCallback(async () => {
    const current = currentTarget.current
    if (current.targetKey !== targetKey) return
    const request = { targetKey, requestId: ++sequence.current }
    setLoad({ ...request, status: 'loading' })
    try {
      const data = await loadDocument(current.target)
      if (sequence.current === request.requestId) setLoad({ ...request, status: 'loaded', data })
    } catch (error) {
      if (sequence.current === request.requestId) {
        setLoad({ ...request, status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }, [targetKey])

  useLayoutEffect(() => {
    void reload()
    return () => { sequence.current++ }
  }, [reload])

  const current = load?.targetKey === targetKey && load.requestId === sequence.current ? load : undefined
  const data = current?.status === 'loaded' ? current.data : undefined
  return {
    targetKey,
    requestId: current?.requestId,
    loading: !current || current.status === 'loading',
    ready: data !== undefined,
    error: current?.status === 'error' ? current.error : undefined,
    content: data?.content ?? '',
    rawBase64: data?.rawBase64,
    mime: data?.mime ?? '',
    reload
  }
}

function triggerTargetDownload(
  target: NativeDocumentTarget,
  content: string,
  rawBase64: string | undefined,
  mime: string,
  isHtml: boolean,
  isMarkdown: boolean
) {
  let blob: Blob
  if (rawBase64 !== undefined) {
    blob = new Blob([base64Bytes(rawBase64)], { type: mime || 'application/octet-stream' })
  } else {
    blob = new Blob([content], { type: `${mime || 'text/plain'};charset=utf-8` })
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const cleanTargetPath =
    target.path && !/^https?:\/\/|^(sediment|dotfile|dotatt|harkatt|harkfile):\/\//i.test(target.path)
      ? target.path.split('/').pop()
      : undefined
  const filename =
    (target.title && /\.[a-z0-9]{1,8}$/i.test(target.title) ? target.title : undefined) ||
    cleanTargetPath ||
    (isHtml
      ? `${target.title || 'document'}.html`
      : isMarkdown
        ? `${target.title || 'document'}.md`
        : target.title || 'document.txt')
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function useBase64BlobUrl(rawBase64: string | undefined, mime: string, enabled: boolean): string | null {
  const [blob, setBlob] = useState<{ data: string; mime: string; url: string }>()
  useEffect(() => {
    if (!enabled || !rawBase64) {
      setBlob(undefined)
      return
    }
    const url = URL.createObjectURL(new Blob([base64Bytes(rawBase64)], { type: mime || 'application/octet-stream' }))
    setBlob({ data: rawBase64, mime, url })
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [rawBase64, mime, enabled])
  return enabled && blob && blob.data === rawBase64 && blob.mime === mime ? blob.url : null
}

function useCopyDocument(content: string, requestId: number | undefined) {
  const [copiedId, setCopiedId] = useState<number>()
  const current = useRef(requestId)
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined)
  useLayoutEffect(() => {
    current.current = requestId
    return () => {
      current.current = undefined
      clearTimeout(reset.current)
    }
  }, [requestId])

  const copyContent = () => {
    if (!requestId || !content || current.current !== requestId) return
    void navigator.clipboard.writeText(content).then(() => {
      if (current.current !== requestId) return
      setCopiedId(requestId)
      clearTimeout(reset.current)
      reset.current = setTimeout(() => setCopiedId(undefined), 1600)
    }, () => {})
  }
  return { copied: requestId !== undefined && copiedId === requestId, copyContent }
}

function ZoomableImagePreview({ src, alt, maxHeightClass }: { src: string; alt: string; maxHeightClass: string }) {
  const [zoom, setZoom] = useState<number>(1)
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4 shadow-soft">
      <div className="flex items-center justify-end gap-1 text-[11px] text-ink-secondary">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
          className="inline-flex items-center gap-0.5 rounded-md bg-hover px-2 py-1 hover:bg-active hover:text-ink"
          title="缩小"
        >
          <ZoomOut className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="rounded-md bg-hover px-2 py-1 tabular-nums hover:bg-active hover:text-ink"
          title="重置缩放"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
          className="inline-flex items-center gap-0.5 rounded-md bg-hover px-2 py-1 hover:bg-active hover:text-ink"
          title="放大"
        >
          <ZoomIn className="size-3.5" />
        </button>
      </div>
      <div className="flex justify-center overflow-auto rounded-xl bg-sunken/50 p-3">
        <img
          src={src}
          alt={alt}
          style={zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: 'top center' } : undefined}
          className={cn(maxHeightClass, 'max-w-full rounded-lg object-contain transition-transform duration-150')}
        />
      </div>
    </div>
  )
}

/**
 * Right-side Split-Pane Document / Artifact Canvas Viewer (aligned with ChatGPT Canvas / Claude Artifacts / Muse Workspace).
 */
export function DocumentCanvasPane({
  target,
  onClose,
  onOpenNestedDoc
}: {
  target: NativeDocumentTarget
  onClose: () => void
  onOpenNestedDoc?: (next: NativeDocumentTarget) => void
}) {
  const { targetKey, requestId, loading, ready, error, content, rawBase64, mime, reload } = useDocumentContent(target)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const { copied, copyContent } = useCopyDocument(content, requestId)
  const [expandedModal, setExpandedModal] = useState(false)

  useEffect(() => {
    setMode('rendered')
  }, [targetKey])

  const lowerName = (target.path || target.title || '').toLowerCase()
  const isMarkdown =
    mime.includes('markdown') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    Boolean(target.markdown)
  const isHtml =
    mime.includes('html') ||
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.htm') ||
    Boolean(target.html)
  const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(lowerName)
  const isVideo = mime.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|avi)(?:[?#].*)?$/i.test(lowerName)
  const isAudio = mime.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#].*)?$/i.test(lowerName)
  const isPdf = mime === 'application/pdf' || /\.pdf(?:[?#].*)?$/i.test(lowerName)
  const binaryBlobUrl = useBase64BlobUrl(
    rawBase64,
    isPdf ? 'application/pdf' : isVideo ? (mime.startsWith('video/') ? mime : 'video/mp4') : isAudio ? (mime.startsWith('audio/') ? mime : 'audio/mpeg') : mime,
    Boolean(rawBase64 && (isVideo || isAudio || isPdf))
  )

  return (
    <aside
      aria-label="Document Viewer"
      className="flex h-full w-[46%] min-w-[380px] max-w-[680px] shrink-0 flex-col border-l border-line bg-surface animate-veil-in"
    >
      {/* Top Canvas Header */}
      <div className="drag-region flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <div className="no-drag flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
            <FileText className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[13.5px] font-semibold text-ink">
              {target.title || target.path?.split('/').pop() || 'Document'}
            </h3>
            <p className="truncate text-[11px] text-ink-muted">
              {isHtml ? 'HTML Artifact' : isMarkdown ? 'Article / Markdown' : target.path || mime || 'Document'}
            </p>
          </div>
        </div>

        <div className="no-drag flex shrink-0 items-center gap-1">
          {(isMarkdown || isHtml) && (
            <div className="mr-1 flex rounded-lg bg-hover p-0.5 text-[11.5px]">
              <button
                type="button"
                onClick={() => setMode('rendered')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors',
                  mode === 'rendered' ? 'bg-surface text-ink shadow-soft' : 'text-ink-secondary hover:text-ink'
                )}
              >
                <FileText className="size-3" /> 排版
              </button>
              <button
                type="button"
                onClick={() => setMode('source')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors',
                  mode === 'source' ? 'bg-surface text-ink shadow-soft' : 'text-ink-secondary hover:text-ink'
                )}
              >
                <FileCode className="size-3" /> 源码
              </button>
            </div>
          )}
          {target.path && (
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void reload()} title={t('Refresh')}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={!ready || !content} onClick={copyContent} title={copied ? '已复制' : t('Copy')}>
            {copied ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!ready}
            onClick={() => ready && triggerTargetDownload(target, content, rawBase64, mime, isHtml, isMarkdown)}
            title={t('Download')}
          >
            <Download className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpandedModal(true)}
            title="弹窗大屏阅读"
          >
            <Maximize2 className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} title="关闭文档侧栏">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Document Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas/40 p-5">
        {loading ? (
          <div className="py-16 text-center text-[13px] text-ink-muted">{t('Loading preview…')}</div>
        ) : error ? (
          <div className="rounded-xl border border-status-error/20 bg-status-error/5 p-4 text-[13px] text-status-error">
            {error}
          </div>
        ) : isImage && rawBase64 ? (
          <ZoomableImagePreview
            src={`data:${mime.startsWith('image/') ? mime : 'image/png'};base64,${rawBase64}`}
            alt={target.title}
            maxHeightClass="max-h-[70vh]"
          />
        ) : isVideo && binaryBlobUrl ? (
          <div className="flex justify-center rounded-2xl border border-line bg-surface p-4 shadow-soft">
            <video controls playsInline preload="metadata" src={binaryBlobUrl} className="max-h-[72vh] w-full rounded-xl bg-black" />
          </div>
        ) : isAudio && binaryBlobUrl ? (
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-soft">
            <p className="mb-3 text-[13px] font-medium text-ink">{target.title}</p>
            <audio controls preload="metadata" src={binaryBlobUrl} className="w-full" />
          </div>
        ) : isPdf && binaryBlobUrl ? (
          <iframe
            title={target.title}
            src={binaryBlobUrl}
            className="h-full min-h-[560px] w-full rounded-2xl border border-line bg-white shadow-soft"
          />
        ) : mode === 'rendered' && isMarkdown ? (
          <article className="mx-auto max-w-[640px] rounded-2xl border border-line bg-surface px-7 py-6 text-[14.5px] leading-[1.7] text-ink shadow-soft">
            <MarkdownText
              text={content}
              onFileLinkClick={(path, label) =>
                onOpenNestedDoc?.({
                  accountId: target.accountId,
                  title: label || path.split('/').pop() || 'Document',
                  path,
                  platformId: target.platformId
                })
              }
            />
          </article>
        ) : mode === 'rendered' && isHtml ? (
          <iframe
            title={target.title}
            sandbox="allow-scripts"
            srcDoc={content}
            className="h-full min-h-[520px] w-full rounded-2xl border border-line bg-white shadow-soft"
          />
        ) : (
          <pre className="overflow-auto rounded-2xl border border-line bg-sunken p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
            {content || '（空文件）'}
          </pre>
        )}
      </div>

      {expandedModal && (
        <NativeDocumentDialog target={target} onClose={() => setExpandedModal(false)} />
      )}
    </aside>
  )
}

export function NativeDocumentDialog({
  target,
  onClose
}: {
  target: NativeDocumentTarget | null
  onClose: () => void
}) {
  return target ? <OpenNativeDocumentDialog target={target} onClose={onClose} /> : null
}

function OpenNativeDocumentDialog({ target, onClose }: { target: NativeDocumentTarget; onClose: () => void }) {
  const { targetKey, requestId, loading, ready, error, content, rawBase64, mime, reload } = useDocumentContent(target)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const { copied, copyContent } = useCopyDocument(content, requestId)

  useEffect(() => {
    setMode('rendered')
  }, [targetKey])

  const lowerName = (target.path || target.title || '').toLowerCase()
  const isMarkdown =
    mime.includes('markdown') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    Boolean(target.markdown)
  const isHtml = mime.includes('html') || lowerName.endsWith('.html') || lowerName.endsWith('.htm') || Boolean(target.html)
  const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(lowerName)
  const isVideo = mime.startsWith('video/') || /\.(mp4|m4v|webm|mov|mkv|avi)(?:[?#].*)?$/i.test(lowerName)
  const isAudio = mime.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#].*)?$/i.test(lowerName)
  const isPdf = mime === 'application/pdf' || /\.pdf(?:[?#].*)?$/i.test(lowerName)
  const binaryBlobUrl = useBase64BlobUrl(
    rawBase64,
    isPdf ? 'application/pdf' : isVideo ? (mime.startsWith('video/') ? mime : 'video/mp4') : isAudio ? (mime.startsWith('audio/') ? mime : 'audio/mpeg') : mime,
    Boolean(rawBase64 && (isVideo || isAudio || isPdf))
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={target.title || target.path || 'Document'}
      className="max-w-[820px]"
    >
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="flex items-center gap-1.5">
          {(isMarkdown || isHtml) && (
            <div className="flex rounded-lg bg-hover p-0.5 text-[12px]">
              <button
                type="button"
                onClick={() => setMode('rendered')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors',
                  mode === 'rendered' ? 'bg-surface text-ink shadow-soft' : 'text-ink-secondary hover:text-ink'
                )}
              >
                <FileText className="size-3.5" /> 排版视图
              </button>
              <button
                type="button"
                onClick={() => setMode('source')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors',
                  mode === 'source' ? 'bg-surface text-ink shadow-soft' : 'text-ink-secondary hover:text-ink'
                )}
              >
                <FileCode className="size-3.5" /> 源码
              </button>
            </div>
          )}
          {target.path && (
            <span className="max-w-[320px] truncate font-mono text-[11px] text-ink-muted" title={target.path}>
              {target.path}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {target.path && (
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void reload()}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> {t('Refresh')}
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={!ready || !content} onClick={copyContent}>
            {copied ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
            {copied ? '已复制' : t('Copy')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready}
            onClick={() => ready && triggerTargetDownload(target, content, rawBase64, mime, isHtml, isMarkdown)}
          >
            <Download className="size-3.5" /> {t('Download')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} title="收起至侧栏">
            <Minimize2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Viewer Body */}
      {loading ? (
        <div className="py-12 text-center text-[13px] text-ink-muted">{t('Loading preview…')}</div>
      ) : error ? (
        <div className="rounded-xl border border-status-error/20 bg-status-error/5 p-4 text-[13px] text-status-error">
          {error}
        </div>
      ) : isImage && rawBase64 ? (
        <ZoomableImagePreview
          src={`data:${mime.startsWith('image/') ? mime : 'image/png'};base64,${rawBase64}`}
          alt={target.title}
          maxHeightClass="max-h-[58vh]"
        />
      ) : isVideo && binaryBlobUrl ? (
        <div className="flex justify-center rounded-xl bg-sunken p-4">
          <video controls playsInline preload="metadata" src={binaryBlobUrl} className="max-h-[62vh] w-full rounded-lg bg-black" />
        </div>
      ) : isAudio && binaryBlobUrl ? (
        <div className="rounded-xl border border-line bg-surface p-5">
          <p className="mb-3 text-[13px] font-medium text-ink">{target.title}</p>
          <audio controls preload="metadata" src={binaryBlobUrl} className="w-full" />
        </div>
      ) : isPdf && binaryBlobUrl ? (
        <iframe
          title={target.title}
          src={binaryBlobUrl}
          className="h-[64vh] w-full rounded-xl border border-line bg-white"
        />
      ) : mode === 'rendered' && isMarkdown ? (
        <article className="max-h-[66vh] overflow-y-auto rounded-xl border border-line bg-surface p-6 text-[14.5px] leading-[1.7] text-ink shadow-soft">
          <MarkdownText text={content} />
        </article>
      ) : mode === 'rendered' && isHtml ? (
        <iframe
          title={target.title}
          sandbox="allow-scripts"
          srcDoc={content}
          className="h-[64vh] w-full rounded-xl border border-line bg-white"
        />
      ) : (
        <pre className="max-h-[66vh] overflow-auto rounded-xl border border-line bg-sunken p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
          {content || '（空文件）'}
        </pre>
      )}
    </Dialog>
  )
}
