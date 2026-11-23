import { parseComputerContext } from '@/components/muse/computerContext'
import { memo, useEffect, useState } from 'react'
import { AlertCircle, Check, Clock3, Copy, CornerDownRight, Download, ExternalLink, FileText, Film, Globe, Image as ImageIcon, KeyRound, Loader2, Maximize2, Monitor, Music, RotateCw, Wrench, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatBytes, formatClock } from '@/lib/format'
import { useBotStore } from '@/store/botStore'
import type { ChatMediaPart, ChatMessage, ChatOptionWidget, ChatRichWidget, ChatToolCall } from '@/types'
import { getBridge } from '@/lib/bridge'
import { ArkExportDocSvg, ArkHandoffCurveSvg, ArkShieldVaultSvg } from '@/components/ui/ArkGlyphs'
import { ConnectorIcon } from '@/components/ui/ConnectorIcon'
import { SwitchPill } from '@/components/ui/Controls'
import { Select } from '@/components/ui/Select'
import { MarkdownText } from './MarkdownText'
import { NativeDocumentDialog, type NativeDocumentTarget } from './NativeDocumentDialog'
import { triggerShareConversation } from './ShareConversationDialog'
import { t } from '@/lib/i18n'

interface MessageBubbleProps {
  message: ChatMessage
  /** First bubble of a run from the same sender (gets the tail corner). */
  isFirstInRun: boolean
  /** Last bubble of a run (shows the meta line). */
  isLastInRun: boolean
  /** Shown in the meta line when a bot has several accounts. */
  accountLabel?: string
  onRetry?: (messageId: string) => void
}

function DeliveryState({ message, onRetry }: Pick<MessageBubbleProps, 'message' | 'onRetry'>) {
  switch (message.delivery) {
    case 'sending':
      return (
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" aria-hidden /> {t('Sending…')}
        </span>
      )
    case 'accepted':
      return (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="size-3 animate-spin" aria-hidden /> {t('Delivered · replying')}
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-status-error-ink">
          <AlertCircle className="size-3" aria-hidden />
          {message.error ?? t('Not sent')}
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              className="inline-flex items-center gap-1 rounded px-1 font-medium underline-offset-2 hover:underline"
            >
              <RotateCw className="size-3" aria-hidden /> {t('Retry')}
            </button>
          )}
        </span>
      )
    case 'no-reply':
      // Delivered: resending would post the message a second time, so say so.
      return (
        <span className="inline-flex items-center gap-1.5 text-status-attention-ink">
          <AlertCircle className="size-3" aria-hidden />
          {message.error ?? t('Delivered, but no reply')}
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              title={t('Sends the same message again')}
              className="inline-flex items-center gap-1 rounded px-1 font-medium underline-offset-2 hover:underline"
            >
              <RotateCw className="size-3" aria-hidden /> {t('Send again')}
            </button>
          )}
        </span>
      )
    case 'sent':
      return <Check className="size-3" aria-label={t('Sent')} />
    default:
      return null
  }
}

function ToolChips({ tools }: { tools: ChatToolCall[] }) {
  if (!tools.length) return null
  return (
    <ul className="mb-1.5 flex max-w-[78%] flex-col gap-1" aria-label={t('Tools')}>
      {tools.map((tool) => (
        <li
          key={tool.id}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-secondary shadow-soft"
        >
          {tool.status === 'running' ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-600" aria-hidden />
          ) : (
            <Wrench className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{tool.name}</span>
          {tool.toolType && tool.toolType !== tool.name && (
            <span className="shrink-0 text-ink-muted">{tool.toolType}</span>
          )}
          <span className="shrink-0 tabular-nums text-ink-muted">
            {tool.status === 'running'
              ? t('Running')
              : tool.status === 'errored'
                ? t('Failed')
                : t('Done')}
          </span>
        </li>
      ))}
      {tools.some((t) => t.summary) && (
        <li className="px-1 text-[11px] text-ink-muted">
          {tools
            .filter((t) => t.summary)
            .map((tool) => tool.summary)
            .join(' · ')}
        </li>
      )}
    </ul>
  )
}

function isHttp(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

function looksLikeImage(part: ChatMediaPart): boolean {
  if (part.kind === 'image') return true
  const mime = (part.mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return true
  if (/^data:image\//i.test(part.path || '')) return true
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(part.path || part.name || '')
}

function looksLikeAudio(part: ChatMediaPart): boolean {
  const mime = (part.mimeType || '').toLowerCase()
  if (mime.startsWith('audio/')) return true
  if (/^data:audio\//i.test(part.path || '')) return true
  return /\.(mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#].*)?$/i.test(part.path || part.name || '')
}

function looksLikeVideo(part: ChatMediaPart): boolean {
  const mime = (part.mimeType || '').toLowerCase()
  if (mime.startsWith('video/')) return true
  if (/^data:video\//i.test(part.path || '')) return true
  return /\.(mp4|m4v|webm|mov|mkv|avi)(?:[?#].*)?$/i.test(part.path || part.name || '')
}

function isHarkMedia(accountId: string | undefined, path: string): boolean {
  return (
    (Boolean(accountId) && useBotStore.getState().accounts[accountId!]?.platformId === 'hark') ||
    /^(harkatt|harkfile):\/\//i.test(path) ||
    /hark\.com|hark\.ai/i.test(path)
  )
}

function isMuseMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  const owner = accountId ? useBotStore.getState().accounts[accountId]?.platformId : undefined
  if (owner) return owner === 'meta-muse'
  return /^\/?(?:fs\/raw\/)?workspace\//i.test(trimmed) ||
    /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(trimmed)
}

function isDotMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  if (/^(CalpicoFile_|file_|libfile_|sediment:\/\/|dotfile:\/\/|dotatt:\/\/)/i.test(trimmed)) return true
  if (/^https?:\/\/(?:[^/]*\.)?chatgpt\.com\/backend-api\//i.test(trimmed)) return true
  if (accountId && useBotStore.getState().accounts[accountId]?.platformId === 'dot') return true
  return false
}

function isGrokMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  if (/^(grokatt|grokstore):\/\//i.test(trimmed)) return true
  if (accountId && useBotStore.getState().accounts[accountId]?.platformId === 'grok') return true
  return false
}

function isMuseAuthHttpUrl(path: string): boolean {
  return /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(path.trim())
}

function needsAuthProxyHttpUrl(path: string): boolean {
  const trimmed = path.trim()
  return (
    /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(trimmed) ||
    /^https?:\/\/app\.hark\.com\/api\//i.test(trimmed) ||
    /^https?:\/\/(?:[^/]*\.)?chatgpt\.com\/backend-api\//i.test(trimmed)
  )
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function saveDataOrUrlToDisk(src: string, filename: string, mimeType?: string): void {
  const safeName = filename || 'media'
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    if (comma > 0) {
      const header = src.slice(5, comma)
      const detectedMime = header.split(';')[0] || mimeType || 'application/octet-stream'
      const b64 = src.slice(comma + 1)
      const blob = new Blob([base64ToBytes(b64)], { type: detectedMime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = safeName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      return
    }
  }
  const a = document.createElement('a')
  a.href = src
  a.download = safeName
  if (isHttp(src)) {
    a.target = '_blank'
    a.rel = 'noreferrer'
  }
  a.click()
}

function sniffImageMimeFromBase64(b64: string): string | undefined {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('UklGR')) return 'image/webp'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('PHN2Zy') || b64.startsWith('PD94bW')) return 'image/svg+xml'
  return undefined
}

function extractWorkspaceMarkdownImages(text: string): ChatMediaPart[] {
  if (!text || !text.includes('![')) return []
  const out: ChatMediaPart[] = []
  const seen = new Set<string>()
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const alt = m[1]?.trim() || undefined
    const raw = m[2]?.trim() || ''
    if (!raw || /^data:image\//i.test(raw)) continue
    if (/^https?:\/\//i.test(raw) && !isMuseAuthHttpUrl(raw)) continue
    if (
      !/^\/?(?:fs\/raw\/)?workspace\//i.test(raw) &&
      !isMuseAuthHttpUrl(raw) &&
      !/\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(raw)
    ) {
      continue
    }
    const normalized = isMuseAuthHttpUrl(raw)
      ? raw
      : raw.replace(/^\/?fs\/raw\//i, '').replace(/^\/+/, '')
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push({
      kind: 'image',
      path: normalized,
      name: alt || normalized.split('/').pop()?.split('?')[0] || normalized
    })
  }
  return out
}

async function downloadHarkMedia(accountId: string, part: ChatMediaPart) {
  const bridge = getBridge()?.hark
  if (!bridge?.rpc) throw new Error('Hark download unavailable')
  const cleanRef = part.path.trim().replace(/^(harkatt|harkfile):\/\//i, '')
  const result = await bridge.rpc({
    accountId,
    op: 'downloadArtifact',
    url: /^https?:\/\//i.test(cleanRef) ? cleanRef : undefined,
    fileId: !/^https?:\/\//i.test(cleanRef) ? cleanRef : undefined,
    name: part.name
  })
  if (!result.ok) throw new Error(result.message || `Hark download failed (${result.status})`)
  if (!result.data || typeof result.data !== 'object') throw new Error('Hark download returned no data')
  return result.data as { dataBase64: string; mimeType: string; filename?: string }
}

async function downloadDotMedia(accountId: string, part: ChatMediaPart) {
  const bridge = getBridge()?.dot
  if (!bridge?.rpc) throw new Error('Dot download unavailable')
  const rawPath = part.path.trim()
  const isHttpUrl = /^https?:\/\//i.test(rawPath)
  const result = await bridge.rpc({
    accountId,
    op: 'downloadFile',
    url: isHttpUrl ? rawPath : undefined,
    fileId: !isHttpUrl ? rawPath.replace(/^(sediment|dotfile|dotatt):\/\//i, '') : undefined,
    name: part.name
  })
  if (!result.ok) throw new Error(result.message || `Dot download failed (${result.status})`)
  if (!result.data || typeof result.data !== 'object') throw new Error('Dot download returned no data')
  const d = result.data as { dataBase64: string; mimeType: string; filename?: string; name?: string }
  return { dataBase64: d.dataBase64, mimeType: d.mimeType, filename: d.filename || d.name }
}

async function downloadGrokMedia(accountId: string, part: ChatMediaPart) {
  const grok = getBridge()?.grok
  if (!grok?.rpc) throw new Error('Grok download unavailable')
  const storeState = useBotStore.getState()
  const ownerBot =
    storeState.bots.find(
      (b) => b.platformId === 'grok' && b.accountIds.includes(accountId) && b.selectedAgentId
    ) ?? storeState.bots.find((b) => b.accountIds.includes(accountId))
  const dl = await grok.rpc({
    accountId,
    op: 'downloadAttachment',
    agentId: ownerBot?.selectedAgentId,
    path: part.path,
    name: part.name
  })
  if (!dl.ok || !dl.data || typeof dl.data !== 'object') {
    throw new Error(dl.ok ? 'Grok download returned no data' : dl.message || 'Grok download failed')
  }
  const d = dl.data as { dataBase64: string; mimeType: string; filename?: string }
  if (!d.dataBase64) throw new Error('Grok download returned empty data')
  return d
}

async function fetchPlatformMediaBytes(
  accountId: string,
  part: ChatMediaPart
): Promise<{ dataBase64: string; mimeType: string; filename?: string } | null> {
  const rawPath = (part.path || '').trim()
  if (rawPath.startsWith('data:')) {
    const comma = rawPath.indexOf(',')
    if (comma > 0) {
      const mime = rawPath.slice(5, comma).split(';')[0] || part.mimeType || 'application/octet-stream'
      return { dataBase64: rawPath.slice(comma + 1), mimeType: mime, filename: part.name }
    }
  }
  if (isMuseMedia(accountId, rawPath)) {
    const muse = getBridge()?.muse
    if (muse?.previewWorkspaceFile) {
      const preview = await muse.previewWorkspaceFile(accountId, rawPath)
      return { dataBase64: preview.dataBase64, mimeType: preview.mimeType, filename: part.name }
    }
  }
  if (isHarkMedia(accountId, rawPath)) {
    return downloadHarkMedia(accountId, part)
  }
  if (isDotMedia(accountId, rawPath)) {
    return downloadDotMedia(accountId, part)
  }
  if (isGrokMedia(accountId, rawPath)) {
    return downloadGrokMedia(accountId, part)
  }
  return null
}

function ImageLightbox({
  src,
  alt,
  filename,
  onClose
}: {
  src: string
  alt: string
  filename: string
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [copiedImg, setCopiedImg] = useState(false)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))
      if (e.key === '-') setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
      if (e.key === '0') setZoom(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyImageToClipboard = async () => {
    try {
      const res = await fetch(src)
      const rawBlob = await res.blob()
      const pngBlob =
        rawBlob.type === 'image/png'
          ? rawBlob
          : await new Promise<Blob>((resolve, reject) => {
              const img = new Image()
              img.crossOrigin = 'anonymous'
              img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = img.naturalWidth
                canvas.height = img.naturalHeight
                const ctx = canvas.getContext('2d')
                ctx?.drawImage(img, 0, 0)
                canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png')
              }
              img.onerror = reject
              img.src = src
            })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setCopiedImg(true)
      setTimeout(() => setCopiedImg(false), 1600)
    } catch {
      /* ignore if clipboard image API unavailable */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/82 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <div
        className="mb-3 flex w-full max-w-4xl items-center justify-between gap-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-[13px] font-medium text-white/90">{filename}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            title="缩小 (-)"
            className="grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <ZoomOut className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title="重置缩放 (0)"
            className="rounded-full bg-white/15 px-2.5 py-1 text-[11.5px] font-medium tabular-nums text-white hover:bg-white/25"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
            title="放大 (+)"
            className="grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <ZoomIn className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void copyImageToClipboard()}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/25"
          >
            {copiedImg ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
            {copiedImg ? '已复制' : '复制图片'}
          </button>
          <button
            type="button"
            onClick={() => saveDataOrUrlToDisk(src, filename)}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/25"
          >
            <Download className="size-3.5" /> 保存图片
          </button>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div className="flex max-h-[82vh] max-w-[92vw] items-center justify-center overflow-auto" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt={alt}
          style={zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: 'center center' } : undefined}
          className="max-h-[80vh] max-w-[88vw] rounded-xl object-contain shadow-2xl transition-transform duration-150"
        />
      </div>
    </div>
  )
}

function WorkspaceImage({
  part,
  accountId
}: {
  part: ChatMediaPart
  accountId?: string
}) {
  const initialDirectSrc =
    /^data:image\//i.test(part.path) || (isHttp(part.path) && !needsAuthProxyHttpUrl(part.path))
      ? part.path
      : null
  const [src, setSrc] = useState<string | null>(initialDirectSrc)
  const [failed, setFailed] = useState(false)
  const [triedProxy, setTriedProxy] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    const nextDirect =
      /^data:image\//i.test(part.path) || (isHttp(part.path) && !needsAuthProxyHttpUrl(part.path))
        ? part.path
        : null
    setSrc(nextDirect)
    setFailed(false)
    setTriedProxy(false)
  }, [part.path])

  useEffect(() => {
    if (src || failed || !accountId) return
    let cancelled = false
    void (async () => {
      try {
        const fetched = await fetchPlatformMediaBytes(accountId, part)
        if (cancelled) return
        if (!fetched?.dataBase64) {
          setFailed(true)
          return
        }
        const mime =
          (fetched.mimeType && fetched.mimeType.toLowerCase().startsWith('image/')
            ? fetched.mimeType
            : undefined) ||
          sniffImageMimeFromBase64(fetched.dataBase64) ||
          (part.mimeType?.toLowerCase().startsWith('image/') ? part.mimeType : undefined) ||
          (looksLikeImage(part) ? 'image/png' : '')
        if (!mime) {
          setFailed(true)
          return
        }
        setSrc(`data:${mime};base64,${fetched.dataBase64}`)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, part, src, failed, retryNonce])

  const filename = part.name || (!isHttp(part.path) ? part.path.split('/').pop() : undefined) || 'image.png'

  if (src) {
    return (
      <>
        <div className="group/img relative bg-sunken/30">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block w-full cursor-zoom-in text-left"
            title="点击放大查看"
          >
            <img
              src={src}
              alt={part.name || part.path}
              className="max-h-72 max-w-full object-contain"
              onError={() => {
                if (isHttp(src) && !triedProxy && accountId) {
                  setTriedProxy(true)
                  setSrc(null)
                } else {
                  setSrc(null)
                  setFailed(true)
                }
              }}
            />
          </button>
          <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/img:opacity-100">
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              title="放大查看"
              className="pointer-events-auto grid size-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/75"
            >
              <ZoomIn className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => saveDataOrUrlToDisk(src, filename, part.mimeType)}
              title="保存图片"
              className="pointer-events-auto grid size-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/75"
            >
              <Download className="size-3.5" />
            </button>
          </div>
        </div>
        {lightboxOpen && (
          <ImageLightbox
            src={src}
            alt={part.name || part.path}
            filename={filename}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    )
  }
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-[12px]">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
        <ImageIcon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block max-w-56 truncate font-medium text-ink">{part.name || part.path}</span>
        <span className="block truncate text-caption text-ink-muted" title={part.path}>
          {failed ? t('Preview unavailable') : t('Loading preview…')}
        </span>
      </span>
      {failed && accountId && (
        <button
          type="button"
          onClick={() => {
            setFailed(false)
            setTriedProxy(false)
            setRetryNonce((n) => n + 1)
          }}
          className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-active"
        >
          重试
        </button>
      )}
    </div>
  )
}

function WorkspaceAV({
  part,
  accountId,
  kind
}: {
  part: ChatMediaPart
  accountId?: string
  kind: 'audio' | 'video'
}) {
  const initialDirectSrc =
    /^data:(?:audio|video)\//i.test(part.path) || (isHttp(part.path) && !needsAuthProxyHttpUrl(part.path))
      ? part.path
      : null
  const [src, setSrc] = useState<string | null>(initialDirectSrc)
  const [failed, setFailed] = useState(false)
  const [triedProxy, setTriedProxy] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    const nextDirect =
      /^data:(?:audio|video)\//i.test(part.path) || (isHttp(part.path) && !needsAuthProxyHttpUrl(part.path))
        ? part.path
        : null
    setSrc(nextDirect)
    setFailed(false)
    setTriedProxy(false)
  }, [part.path])

  useEffect(() => {
    if (src || failed || !accountId) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const fetched = await fetchPlatformMediaBytes(accountId, part)
        if (cancelled) return
        if (!fetched?.dataBase64) {
          setFailed(true)
          return
        }
        const mt = (fetched.mimeType || part.mimeType || '').toLowerCase()
        const fallbackMime = kind === 'audio' ? 'audio/mpeg' : 'video/mp4'
        const effectiveMime =
          kind === 'audio'
            ? mt.startsWith('audio/')
              ? mt
              : fallbackMime
            : mt.startsWith('video/')
              ? mt
              : fallbackMime
        const blob = new Blob([base64ToBytes(fetched.dataBase64)], { type: effectiveMime })
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [accountId, part, src, failed, kind, retryNonce])

  const filename =
    part.name ||
    (!isHttp(part.path) ? part.path.split('/').pop() : undefined) ||
    (kind === 'audio' ? 'audio.mp3' : 'video.mp4')

  const handleMediaError = () => {
    if (src && isHttp(src) && !triedProxy && accountId) {
      setTriedProxy(true)
      setSrc(null)
    } else {
      setSrc(null)
      setFailed(true)
    }
  }

  if (src) {
    return (
      <div className="px-2.5 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink">
            {kind === 'video' ? (
              <Film className="size-3.5 shrink-0 text-accent-600" aria-hidden />
            ) : (
              <Music className="size-3.5 shrink-0 text-accent-600" aria-hidden />
            )}
            <span className="max-w-56 truncate">{filename}</span>
          </span>
          <button
            type="button"
            onClick={() => saveDataOrUrlToDisk(src, filename, part.mimeType)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-active hover:text-ink"
            title="下载保存"
          >
            <Download className="size-3" /> 保存
          </button>
        </div>
        {kind === 'audio' ? (
          <audio controls preload="metadata" src={src} onError={handleMediaError} className="w-full max-w-md" />
        ) : (
          <video
            controls
            playsInline
            preload="metadata"
            src={src}
            onError={handleMediaError}
            className="max-h-72 w-full max-w-md rounded-lg bg-black"
          />
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-[12px]">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
        {kind === 'video' ? <Film className="size-4" aria-hidden /> : <Music className="size-4" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block max-w-56 truncate font-medium text-ink">{filename}</span>
        <span className="block truncate text-caption text-ink-muted" title={part.path}>
          {failed ? t('Preview unavailable') : t('Loading preview…')}
        </span>
      </span>
      {failed && accountId && (
        <button
          type="button"
          onClick={() => {
            setFailed(false)
            setTriedProxy(false)
            setRetryNonce((n) => n + 1)
          }}
          className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-active"
        >
          重试
        </button>
      )}
    </div>
  )
}

function MediaParts({
  parts,
  accountId,
  onOpenDoc
}: {
  parts: ChatMediaPart[]
  accountId?: string
  onOpenDoc?: (target: NativeDocumentTarget) => void
}) {
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  if (!parts.length) return null

  const handleDirectDownload = async (part: ChatMediaPart) => {
    if (!accountId) return
    const key = part.path || part.name || ''
    setDownloadingKey(key)
    setDownloadError(null)
    try {
      const rawPath = (part.path || '').trim()
      const isHttpUrl = /^https?:\/\//i.test(rawPath)
      const fetched = await fetchPlatformMediaBytes(accountId, part)

      const dataBase64 = fetched?.dataBase64 || ''
      const mimeType = fetched?.mimeType || part.mimeType || 'application/octet-stream'
      const filename =
        fetched?.filename ||
        part.name ||
        (!isHttpUrl && !rawPath.startsWith('data:') ? rawPath.split('/').pop() : undefined) ||
        'attachment'

      if (dataBase64) {
        const blob = new Blob([base64ToBytes(dataBase64)], { type: mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      } else if (isHttpUrl) {
        window.open(rawPath, '_blank', 'noopener,noreferrer')
      } else {
        throw new Error('Download unavailable')
      }
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadingKey(null)
    }
  }

  const allImages = parts.length >= 2 && parts.every((p) => looksLikeImage(p))

  return (
    <>
      <ul
        className={cn(
          'mb-1.5 max-w-[78%] gap-1.5',
          allImages ? 'grid grid-cols-2' : 'flex flex-col'
        )}
        aria-label={t('Media')}
      >
      {parts.map((part) => {
        const isHttpUrl = isHttp(part.path)
        const subtitle = isHttpUrl
          ? part.mimeType || '可预览 / 下载文件'
          : part.path
        const key = part.path || part.name || 'part'
        return (
          <li
            key={key}
            className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft"
          >
            {looksLikeImage(part) ? (
              <WorkspaceImage part={part} accountId={accountId} />
            ) : looksLikeAudio(part) ? (
              <WorkspaceAV part={part} accountId={accountId} kind="audio" />
            ) : looksLikeVideo(part) ? (
              <WorkspaceAV part={part} accountId={accountId} kind="video" />
            ) : (
              <div className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px]">
                <button
                  type="button"
                  onClick={() => {
                    if (accountId && onOpenDoc) {
                      onOpenDoc({
                        accountId,
                        title: part.name || (!isHttpUrl ? part.path.split('/').pop() : undefined) || 'Document',
                        path: part.path,
                        mimeType: part.mimeType
                      })
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-85"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block max-w-56 truncate font-medium text-ink">
                      {part.name || part.path}
                    </span>
                    <span className="block truncate text-caption text-ink-muted" title={subtitle}>
                      {subtitle}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (accountId && onOpenDoc) {
                        onOpenDoc({
                          accountId,
                          title: part.name || (!isHttpUrl ? part.path.split('/').pop() : undefined) || 'Document',
                          path: part.path,
                          mimeType: part.mimeType
                        })
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-active"
                  >
                    <Maximize2 className="size-3" /> 预览
                  </button>
                  <button
                    type="button"
                    disabled={downloadingKey === key}
                    onClick={() => void handleDirectDownload(part)}
                    className="inline-flex items-center gap-1 rounded-full bg-accent-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-accent-700 disabled:opacity-50"
                  >
                    <Download className="size-3" /> {downloadingKey === key ? '下载中…' : '下载'}
                  </button>
                </div>
              </div>
            )}
          </li>
        )
      })}
      </ul>
      {downloadError && <p className="mb-1.5 text-[12px] text-status-error-ink">{downloadError}</p>}
    </>
  )
}

function RichWidgets({
  widgets,
  botId,
  accountId,
  onOpenDoc
}: {
  widgets: ChatRichWidget[]
  botId: string
  accountId: string
  onOpenDoc: (target: NativeDocumentTarget) => void
}) {
  const sendMessage = useBotStore((s) => s.sendMessage)
  if (!widgets.length) return null
  return (
    <ul className="mb-1.5 flex max-w-[85%] flex-col gap-2" aria-label={t('Widgets')}>
      {widgets.map((w) => {
        if (w.kind === 'shopping_results' || w.kind === 'shopping_results_v2') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{t('Shopping results')}</p>
              <ul className="flex flex-col gap-1.5">
                {w.products.slice(0, 8).map((p, i) => (
                  <li key={`${p.name}-${i}`} className="flex gap-2 text-[12px]">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" className="size-10 rounded-md object-cover" />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{p.name}</span>
                      <span className="block text-ink-muted">
                        {[p.price, p.retailer].filter(Boolean).join(' · ')}
                      </span>
                      {p.url ? (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-600 underline-offset-2 hover:underline"
                        >
                          {t('Open link')}
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-ink-muted">{t('Read-only — checkout not available in BotArk')}</p>
            </li>
          )
        }
        if (w.kind === 'shopping_cart') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1 text-[12px] font-medium text-ink-secondary">
                {t('Shopping cart')}
                {w.retailerName ? ` · ${w.retailerName}` : ''}
              </p>
              <ul className="flex flex-col gap-1 text-[12px]">
                {w.items.slice(0, 12).map((it) => (
                  <li key={it.id} className="flex justify-between gap-2">
                    <span className="truncate text-ink">
                      {it.name} × {it.quantity}
                    </span>
                    {it.linePrice ? <span className="shrink-0 text-ink-muted">{it.linePrice}</span> : null}
                  </li>
                ))}
              </ul>
              {w.subtotal ? (
                <p className="mt-1 text-[12px] font-medium text-ink">
                  {t('Subtotal')}: {w.subtotal}
                </p>
              ) : null}
              <p className="mt-1 text-[11px] text-ink-muted">{t('Read-only — checkout not available in BotArk')}</p>
            </li>
          )
        }
        if (w.kind === 'local_map') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1 text-[12px] font-medium text-ink-secondary">{t('Map')}</p>
              {w.places.length ? (
                <ul className="mb-1.5 flex flex-col gap-1 text-[12px]">
                  {w.places.slice(0, 12).map((pl) => (
                    <li key={pl.id}>
                      <span className="font-medium text-ink">{pl.name}</span>
                      <span className="text-ink-muted">
                        {' '}
                        ({pl.latitude.toFixed(4)}, {pl.longitude.toFixed(4)})
                        {pl.category ? ` · ${pl.category}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {w.html ? (
                <iframe
                  title={t('Map')}
                  sandbox=""
                  srcDoc={w.html}
                  className="h-40 w-full rounded-lg border border-line bg-white"
                />
              ) : null}
            </li>
          )
        }
        if (w.kind === 'marketplace_map') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{t('Marketplace map')}</p>
              <ul className="flex flex-col gap-1.5 text-[12px]">
                {w.listings.slice(0, 12).map((l) => (
                  <li key={l.id} className="flex gap-2">
                    {l.imageUrl ? (
                      <img src={l.imageUrl} alt="" className="size-10 rounded-md object-cover" />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{l.name}</span>
                      <span className="block text-ink-muted">
                        {[l.price, l.latitude != null ? `${l.latitude.toFixed(3)}, ${l.longitude?.toFixed(3)}` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {l.url ? (
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-600 underline-offset-2 hover:underline"
                        >
                          {t('Open link')}
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-ink-muted">{t('Read-only — checkout not available in BotArk')}</p>
            </li>
          )
        }
        if (w.kind === 'html') {
          return (
            <li key={w.widgetId} className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
              <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 text-[12px]">
                <span className="font-medium text-ink-secondary">
                  {t('HTML widget')}
                  {w.downloadable ? ` · ${t('Downloadable')}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: t('HTML widget'),
                      html: w.html,
                      mimeType: 'text/html'
                    })
                  }
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-hover"
                >
                  <Maximize2 className="size-3" /> 原生打开
                </button>
              </div>
              <iframe
                title={t('HTML widget')}
                sandbox=""
                srcDoc={w.html}
                className="h-48 w-full bg-white"
              />
            </li>
          )
        }
        if (w.kind === 'slides') {
          return (
            <li key={w.widgetId} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 shadow-soft">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink">{w.label}</p>
                <p className="truncate text-[12px] text-ink-muted">
                  {t('Slides')} · {w.slug}
                  {w.path ? ` · ${w.path}` : ''}
                </p>
              </div>
              {w.path && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: w.label,
                      path: w.path
                    })
                  }
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hover px-2.5 py-1 text-[11px] font-medium text-accent-600 hover:bg-active"
                >
                  <Maximize2 className="size-3" /> 原生打开
                </button>
              )}
            </li>
          )
        }
        if (w.kind === 'image_options') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">
                {t('Image options')}
                {w.multiSelect ? ` · ${t('Multi-select')}` : ''}
              </p>
              <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {w.images.slice(0, 12).map((img, i) => {
                  const picked =
                    (w.selectedPath && w.selectedPath === img.path) ||
                    (w.selectedIndices && w.selectedIndices.includes(i))
                  return (
                    <li
                      key={`${img.path}-${i}`}
                      className={
                        picked
                          ? 'overflow-hidden rounded-lg border-2 border-accent-600 bg-accent-50'
                          : 'overflow-hidden rounded-lg border border-line bg-surface-muted'
                      }
                      title={img.path}
                    >
                      <WorkspaceImage
                        part={{
                          kind: 'image',
                          path: img.path,
                          name: img.path.split('/').pop() || img.path,
                          imageId: img.imageId
                        }}
                        accountId={accountId}
                      />
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        }
        if (w.kind === 'text_with_button') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-3 shadow-soft">
              {w.text ? (
                <div className="mb-2 text-[13px] leading-5 text-ink">
                  <MarkdownText text={w.text} />
                </div>
              ) : null}
              {w.buttons.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {w.buttons.map((b, i) => {
                    const harkProvider = b.command?.startsWith('hark:connect:')
                      ? b.command.slice('hark:connect:'.length).trim()
                      : undefined
                    if (b.url) {
                      return (
                        <a
                          key={`${b.label}-${i}`}
                          href={b.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-full bg-accent-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-accent-700"
                        >
                          <ConnectorIcon id={harkProvider} name={b.label} className="size-4 border-0 bg-transparent shadow-none" />
                          {b.label}
                        </a>
                      )
                    }
                    return (
                      <button
                        key={`${b.label}-${i}`}
                        type="button"
                        onClick={async () => {
                          if (harkProvider && getBridge()?.hark?.rpc) {
                            try {
                              const res = await getBridge()!.hark!.rpc({
                                accountId,
                                op: 'call',
                                method: 'POST',
                                path: '/connectors/link-sessions',
                                body: {
                                  provider: harkProvider,
                                  returnUrl: 'https://app.hark.com/settings/connected-accounts',
                                  origin: 'chat'
                                }
                              })
                              if (res.ok && res.data && typeof res.data === 'object') {
                                const d = res.data as Record<string, unknown>
                                const startUrl = String(d['startUrl'] ?? d['url'] ?? d['authUrl'] ?? '')
                                if (startUrl.startsWith('http')) {
                                  await getBridge()?.muse?.openHttps?.(startUrl)
                                  return
                                }
                              }
                            } catch {
                              /* fall through to sendMessage */
                            }
                          }
                          void sendMessage(botId, b.actionText || b.label)
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1 text-[12px] font-medium text-ink hover:bg-hover"
                      >
                        <ConnectorIcon id={harkProvider ?? b.label} name={b.label} className="size-4 border-0 bg-transparent shadow-none" />
                        {b.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </li>
          )
        }
        if (w.kind === 'generic_list') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              {w.title && <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{w.title}</p>}
              <ul className="divide-y divide-line text-[12px]">
                {w.items.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{it.title}</span>
                      {it.subtitle && <span className="block truncate text-ink-muted">{it.subtitle}</span>}
                    </span>
                    {it.url ? (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[11px] text-accent-600 hover:bg-hover"
                      >
                        {t('Open link')}
                      </a>
                    ) : it.sendText ? (
                      <button
                        type="button"
                        onClick={() => void sendMessage(botId, it.sendText!)}
                        className="shrink-0 rounded-full border border-line-strong px-2.5 py-0.5 text-[11px] font-medium text-ink hover:bg-hover"
                      >
                        {t('Send')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          )
        }
        if (w.kind === 'voice_options') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">{t('Voice options')}</p>
              <div className="flex flex-wrap gap-1.5">
                {w.voices.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => void sendMessage(botId, v.name)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-[12px] transition-colors',
                      v.selected
                        ? 'border-accent-600 bg-accent-50 font-medium text-accent-600'
                        : 'border-line-strong bg-surface text-ink hover:bg-hover'
                    )}
                    title={v.description}
                  >
                    {v.selected ? `✓ ${v.name}` : v.name}
                  </button>
                ))}
              </div>
            </li>
          )
        }
        if (w.kind === 'markdown') {
          const docTitle = w.title || w.path?.split('/').pop() || 'Markdown 文档'
          const wordCount = (w.markdown || '').trim().length
          return (
            <li
              key={w.widgetId}
              className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft transition-shadow hover:shadow-md"
            >
              <div className="flex items-center justify-between gap-3 border-b border-line bg-sunken/40 px-3.5 py-2.5">
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: docTitle,
                      markdown: w.markdown || undefined,
                      path: w.path,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">{docTitle}</span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      文章 / 文档卡片{wordCount > 0 ? ` · ${wordCount} 字` : ''}
                      {w.path ? ` · ${w.path}` : ''}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenDoc({
                      accountId,
                      title: docTitle,
                      markdown: w.markdown || undefined,
                      path: w.path,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-600 px-3 py-1 text-[11.5px] font-medium text-white shadow-hairline hover:bg-accent-700"
                >
                  <Maximize2 className="size-3" /> 右侧画布阅读
                </button>
              </div>
              {w.markdown && (
                <div className="relative max-h-60 overflow-hidden px-4 py-3 text-[13.5px] leading-relaxed text-ink">
                  <MarkdownText
                    text={w.markdown}
                    onFileLinkClick={(path, label) => onOpenDoc({ accountId, title: label, path })}
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" />
                </div>
              )}
            </li>
          )
        }
        if (w.kind === 'hotel_results') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">酒店推荐</p>
              <ul className="flex flex-col gap-1.5 text-[12px]">
                {w.hotels.map((h, i) => (
                  <li key={`${h.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-hover/40 px-2.5 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{h.name}</span>
                      <span className="block truncate text-[11px] text-ink-muted">
                        {[h.rating && `★ ${h.rating}`, h.price, h.location].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {h.url && (
                      <a
                        href={h.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-accent-600 hover:underline"
                      >
                        查看 <ExternalLink className="size-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          )
        }
        if (w.kind === 'idea_cards') {
          return (
            <li key={w.widgetId} className="rounded-xl border border-line bg-surface p-2.5 shadow-soft">
              <p className="mb-1.5 text-[12px] font-medium text-ink-secondary">灵感卡片</p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {w.cards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void sendMessage(botId, c.prompt || c.title)}
                    className="flex flex-col items-start rounded-lg border border-line bg-hover/30 p-2 text-left transition-colors hover:bg-hover"
                  >
                    <span className="text-[12.5px] font-medium text-ink">{c.title}</span>
                    {c.subtitle && <span className="mt-0.5 line-clamp-2 text-[11px] text-ink-muted">{c.subtitle}</span>}
                  </button>
                ))}
              </div>
            </li>
          )
        }
        if (w.kind === 'grok_form') {
          return (
            <GrokFormCard
              key={w.widgetId}
              widget={w}
              botId={botId}
              accountId={accountId}
            />
          )
        }
        if (w.kind === 'session_card') {
          return (
            <SessionInteractiveCard
              key={w.widgetId}
              widget={w}
              accountId={accountId}
            />
          )
        }
        return null
      })}
    </ul>
  )
}

function SessionInteractiveCard({
  widget,
  accountId
}: {
  widget: Extract<ChatRichWidget, { kind: 'session_card' }>
  accountId: string
}) {
  const openWebSessionAt = useBotStore((s) => s.openWebSessionAt)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  useEffect(() => {
    let current = true
    const muse = getBridge()?.muse
    setPreviewSrc(null)
    setPreviewError('')
    setLoading(false)
    if (widget.cardType === 'vault' || !muse || (!widget.taskId && !widget.previewSha256)) return
    setLoading(true)
    void (async () => {
      let taskId = widget.taskId
      let sha = widget.previewSha256
      if (!taskId || !sha || refresh > 0) {
        const snapshot = parseComputerContext(await muse.rpc({ accountId, method: 'computer.context', params: {} }))
        // Match the card to the task before accepting a newer account-level preview.
        if (taskId ? snapshot.taskId === taskId : sha === snapshot.sha256) {
          taskId = snapshot.taskId
          sha = snapshot.sha256 ?? sha
        }
      }
      if (!current || !taskId || !sha) return
      const res = await muse.rpc({ accountId, method: 'computer.preview', params: { task_id: taskId, sha256: sha } })
      const data = res as { dataBase64?: string; contentType?: string } | null
      if (current && data?.dataBase64) setPreviewSrc(`data:${data.contentType || 'image/png'};base64,${data.dataBase64}`)
    })().catch((err) => {
      if (current && refresh > 0) setPreviewError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [accountId, widget.cardType, widget.previewSha256, widget.taskId, refresh])

  const isVault = widget.cardType === 'vault'
  const isSaved = widget.status === '已登录'

  const openInApp = () => {
    openWebSessionAt(widget.url || null)
  }

  const openPopup = () => {
    const targetUrl = widget.url || 'https://muse.ai'
    void getBridge()?.webViews?.openInPartition?.({
      accountId,
      url: targetUrl,
      title: widget.title
    })
  }

  return (
    <li className="max-w-md overflow-hidden rounded-2xl border border-line/80 bg-surface p-3.5 shadow-soft">
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-xl',
              isVault
                ? isSaved
                  ? 'bg-status-online/12 text-status-online-ink'
                  : 'bg-accent-50 text-accent-600'
                : 'bg-accent-50 text-accent-600'
            )}
          >
            {isVault ? (
              <ArkShieldVaultSvg className="size-4" />
            ) : widget.cardType === 'computer' ? (
              <Monitor className="size-4" />
            ) : (
              <Globe className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold text-ink">{widget.title}</p>
            <p className="truncate text-[11.5px] text-ink-muted">
              {widget.subtitle || widget.status || (isVault ? '安全存储' : '正在工作')}
            </p>
          </div>
        </div>
        {widget.status && (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
              isSaved
                ? 'bg-status-online/12 text-status-online-ink'
                : 'bg-hover text-ink-secondary'
            )}
          >
            {widget.status}
          </span>
        )}
      </div>

      {previewSrc && (
        <button
          type="button"
          onClick={openInApp}
          className="mt-2.5 block w-full overflow-hidden rounded-xl border border-line bg-black/5"
        >
          <img src={previewSrc} alt={widget.title} className="max-h-44 w-full object-contain" />
        </button>
      )}

      {previewError && <p role="status" className="mt-2 text-[12px] text-status-error">{previewError}</p>}
      <div className="mt-3 flex items-center gap-2">
        {!isVault && (widget.taskId || widget.previewSha256) && (
          <button type="button" aria-label="刷新截图" title="刷新截图" disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
            className="press-icon grid size-8 shrink-0 place-items-center rounded-full border border-line text-ink-secondary">
            <RotateCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </button>
        )}
        <button
          type="button"
          onClick={openInApp}
          className="press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-main px-3 text-[12.5px] font-medium text-ink ring-1 ring-line-strong hover:bg-hover"
        >
          {widget.actionLabel || (isVault ? '在应用内填写安全卡片' : '打开浏览器')}
        </button>
        <button
          type="button"
          onClick={openPopup}
          title="在独立安全分区窗口打开"
          className="press-icon grid size-8 shrink-0 place-items-center rounded-full border border-line text-ink-secondary hover:bg-hover hover:text-ink"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

function GrokFormCard({
  widget,
  botId,
  accountId
}: {
  widget: Extract<ChatRichWidget, { kind: 'grok_form' }>
  botId: string
  accountId: string
}) {
  const botMeta = useBotStore((s) => s.bots.find((b) => b.id === botId))
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of widget.fields) {
      init[f.id] = f.options?.[0]?.id ?? ''
    }
    return init
  })
  const [saveToVault, setSaveToVault] = useState(widget.formKind === 'secret-request')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(Boolean(widget.submitted))
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting || submitted) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) {
      setErrMsg('Grok IPC 不可用')
      return
    }
    const agentId = botMeta?.selectedAgentId ?? ''
    const sessionId = botMeta?.activeSessionId ?? ''

    for (const f of widget.fields) {
      if (f.required && !values[f.id]?.trim()) {
        setErrMsg(`请填写必填项：${f.label}`)
        return
      }
    }

    setSubmitting(true)
    setErrMsg(null)
    try {
      let res: { ok: boolean; message?: string }
      if (widget.formKind === 'messaging-card') {
        res = await grok.rpc({
          accountId,
          op: 'answerMessagingCard',
          cardId: widget.entryId,
          version: widget.cardVersion ?? 1,
          answer: 'SUBMIT',
          values
        })
      } else if (widget.formKind === 'secret-request') {
        const firstField = widget.fields[0]
        const secretValue = (firstField ? values[firstField.id] : '') ?? ''
        res = await grok.rpc({
          accountId,
          op: 'submitSecret',
          agentId,
          entryId: widget.entryId,
          value: secretValue,
          sessionId
        })
      } else {
        res = await grok.rpc({
          accountId,
          op: 'submitUserForm',
          agentId,
          entryId: widget.entryId,
          values,
          saveToVault,
          sessionId
        })
      }
      if (!res.ok) {
        setErrMsg(res.message || '提交失败')
        return
      }
      setSubmitted(true)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : '提交出错')
    } finally {
      setSubmitting(false)
    }
  }

  const hasSecretField = widget.formKind === 'secret-request' || widget.fields.some((f) => f.secret)

  return (
    <li className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
      <div className="mb-2.5 flex items-start gap-2">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
          <KeyRound className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">
            {widget.title || (widget.formKind === 'secret-request' ? '提供密钥凭据' : '填写表单信息')}
          </p>
          {widget.subtitle && (
            <p className="mt-0.5 text-[11.5px] text-ink-muted">{widget.subtitle}</p>
          )}
        </div>
        {submitted && (
          <span className="inline-flex items-center gap-1 rounded-full bg-status-online/10 px-2 py-0.5 text-[11px] font-medium text-status-online">
            <Check className="size-3" /> 已提交
          </span>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2.5">
        {widget.fields.map((field) => (
          <label key={field.id} className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium text-ink-secondary">
              {field.label}
              {field.required && <span className="ml-0.5 text-status-error">*</span>}
            </span>
            {field.options && field.options.length > 0 ? (
              <Select
                size="sm"
                disabled={submitted || submitting}
                value={values[field.id] ?? field.options[0]?.id ?? ''}
                onValueChange={(next) => setValues((prev) => ({ ...prev, [field.id]: next }))}
                options={field.options.map((opt) => ({ value: opt.id, label: opt.label }))}
              />
            ) : field.type === 'textarea' ? (
              <textarea
                rows={3}
                disabled={submitted || submitting}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600 disabled:opacity-60"
              />
            ) : (
              <input
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                disabled={submitted || submitting}
                value={values[field.id] ?? ''}
                placeholder={field.placeholder}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600 disabled:opacity-60"
              />
            )}
          </label>
        ))}

        {hasSecretField && widget.formKind === 'user-form' && !submitted && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-sunken/45 px-2.5 py-1.5 text-[11.5px] text-ink-secondary">
            <span>存入安全凭据库（Secret Vault）</span>
            <SwitchPill checked={saveToVault} onCheckedChange={setSaveToVault} />
          </div>
        )}

        {errMsg && <p className="text-[11.5px] text-status-error">{errMsg}</p>}

        {!submitted && (
          <div className="mt-0.5 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent-600 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-hairline hover:bg-accent-700 disabled:opacity-50"
            >
              {submitting && <Loader2 className="size-3.5 animate-spin" />}
              {submitting ? '提交中…' : '提交'}
            </button>
          </div>
        )}
      </form>
    </li>
  )
}

function OptionChips({ message, widget }: { message: ChatMessage; widget: ChatOptionWidget }) {
  const selectChatOption = useBotStore((s) => s.selectChatOption)
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const selected = widget.selectedText
  const filled = widget.buttonStyle === 'center_aligned_filled'
  const disabled = Boolean(selected)

  const pick = (text: string, index: number) => {
    if (disabled) return
    void selectChatOption(message.botId, message.id, widget.widgetId, text, index)
  }

  return (
    <div className="mt-2 flex max-w-[78%] flex-col gap-2" data-muse-option-widget={widget.widgetId}>
      <div className="flex flex-wrap gap-1.5">
        {widget.options.map((opt, index) => {
          const isSel = selected === opt
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled && !isSel}
              onClick={() => pick(opt, index)}
              className={cn(
                'rounded-full px-3 py-1.5 text-[13px] transition-colors',
                filled
                  ? 'bg-accent-600 text-white hover:bg-accent-600/90'
                  : 'border border-dashed border-line-strong bg-surface text-ink hover:bg-hover',
                isSel && 'ring-2 ring-accent-600',
                disabled && !isSel && 'opacity-50'
              )}
            >
              {isSel ? `✓ ${opt}` : opt}
            </button>
          )
        })}
        {widget.customInputPlaceholder && !selected && (
          <button
            type="button"
            onClick={() => setCustomOpen((v) => !v)}
            className="rounded-full border border-dashed border-line-strong bg-surface px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-hover"
          >
            自定义…
          </button>
        )}
      </div>
      {customOpen && !selected && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const text = customText.trim()
            if (!text) return
            pick(text, -1)
          }}
        >
          <input
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={widget.customInputPlaceholder || '输入名字'}
            className="min-w-0 flex-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-accent"
            autoFocus
          />
          <button
            type="submit"
            className="rounded-full bg-accent-600 px-3 py-1.5 text-[13px] text-white"
          >
            发送
          </button>
        </form>
      )}
    </div>
  )
}

function UserAttachmentItem({
  file
}: {
  file: NonNullable<ChatMessage['attachments']>[number]
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [avUrl, setAvUrl] = useState<string | null>(null)
  const isImage = file.mimeType.startsWith('image/') && Boolean(file.dataBase64)
  const isVideo = file.mimeType.startsWith('video/') && Boolean(file.dataBase64)
  const isAudio = file.mimeType.startsWith('audio/') && Boolean(file.dataBase64)

  useEffect(() => {
    if ((!isVideo && !isAudio) || !file.dataBase64) {
      setAvUrl(null)
      return
    }
    const blob = new Blob([base64ToBytes(file.dataBase64)], { type: file.mimeType })
    const url = URL.createObjectURL(blob)
    setAvUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file.dataBase64, file.mimeType, isVideo, isAudio])

  if (isImage && file.dataBase64) {
    const dataSrc = `data:${file.mimeType};base64,${file.dataBase64}`
    return (
      <>
        <li className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block cursor-zoom-in"
            title={file.name}
          >
            <img src={dataSrc} alt={file.name} className="max-h-56 max-w-64 object-contain" />
          </button>
        </li>
        {lightboxOpen && (
          <ImageLightbox
            src={dataSrc}
            alt={file.name}
            filename={file.name}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    )
  }

  if ((isVideo || isAudio) && avUrl) {
    return (
      <li className="overflow-hidden rounded-xl border border-line bg-surface px-2.5 py-2 shadow-soft">
        <p className="mb-1 max-w-56 truncate text-[12px] font-medium text-ink">{file.name}</p>
        {isVideo ? (
          <video controls playsInline preload="metadata" src={avUrl} className="max-h-56 w-full max-w-sm rounded-lg bg-black" />
        ) : (
          <audio controls preload="metadata" src={avUrl} className="w-64 max-w-full" />
        )}
      </li>
    )
  }

  return (
    <li className="flex items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pr-3 pl-2 shadow-soft">
      <span className="grid size-7 place-items-center rounded-lg bg-accent-50 text-accent-600">
        {file.mimeType.startsWith('image/') ? (
          <ImageIcon className="size-4" aria-hidden />
        ) : file.mimeType.startsWith('video/') ? (
          <Film className="size-4" aria-hidden />
        ) : file.mimeType.startsWith('audio/') ? (
          <Music className="size-4" aria-hidden />
        ) : (
          <FileText className="size-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0">
        <span className="block max-w-48 truncate text-ui font-medium">{file.name}</span>
        <span className="block text-caption text-ink-muted">{formatBytes(file.size)}</span>
      </span>
    </li>
  )
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isFirstInRun: _isFirstInRun,
  isLastInRun,
  accountLabel,
  onRetry
}: MessageBubbleProps) {
  const mine = message.role === 'user'
  const optionWidgets = (!mine && message.widgets?.filter((w) => w.kind === 'option')) || []
  const tools = (!mine && message.tools) || []
  const baseMedia = (!mine && message.media) || []
  const inlineWorkspaceImgs = !mine ? extractWorkspaceMarkdownImages(message.text) : []
  const media =
    inlineWorkspaceImgs.length === 0
      ? baseMedia
      : [
          ...baseMedia,
          ...inlineWorkspaceImgs.filter((img) => !baseMedia.some((existing) => existing.path === img.path))
        ]
  const rich = (!mine && message.richWidgets) || []
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)
  const setReplyTarget = useBotStore((s) => s.setReplyTarget)
  const openWebSessionAt = useBotStore((s) => s.openWebSessionAt)
  const botMeta = useBotStore((s) => s.bots.find((b) => b.id === message.botId))
  const [docTarget, setDocTarget] = useState<NativeDocumentTarget | null>(null)
  const [articleExpanded, setArticleExpanded] = useState(false)
  const [copiedMsg, setCopiedMsg] = useState(false)
  const [reactedEmoji, setReactedEmoji] = useState<string | null>(null)

  const supportsInAppWeb =
    botMeta?.platformId === 'meta-muse' ||
    botMeta?.platformId === 'hark' ||
    botMeta?.platformId === 'dot' ||
    botMeta?.platformId === 'antigravity'

  /**
   * Keep cloud browser, cloud computer, and credential vault links inside BotArk's
   * isolated account partition (#34) instead of bouncing out to external Chrome.
   */
  const handleMarkdownLinkClick = (href: string, label: string): boolean => {
    if (!supportsInAppWeb) return false
    const isPlatformDomain = /^https?:\/\/([^/]+\.)?(muse\.ai|hark\.com|chatgpt\.com|antigravity\.google\.com)(\/|$)/i.test(href)
    const isRelativeAction = !/^https?:\/\//i.test(href)
    const isSessionActionLabel =
      /登录|安全存储|安全卡片|密码|浏览器|云电脑|验证码|授权|sign\s*in|log\s*in|vault|browser/i.test(label) ||
      /安全卡片|密码只进安全存储|打开浏览器|云浏览器|云电脑/i.test(message.text || '')

    if (isPlatformDomain || isRelativeAction) {
      openWebSessionAt(/^https?:\/\//i.test(href) ? href : null)
      return true
    }
    if (isSessionActionLabel && /^https?:\/\//i.test(href)) {
      if (getBridge()?.webViews?.openInPartition) {
        void getBridge()!.webViews!.openInPartition({
          accountId: message.accountId,
          url: href,
          title: label
        })
      } else {
        openWebSessionAt(href)
      }
      return true
    }
    return false
  }

  const needsInlineSessionShortcut =
    !mine &&
    supportsInAppWeb &&
    !rich.some((w) => w.kind === 'session_card') &&
    /安全卡片|密码只进安全存储|安全存储|浏览器正在|打开浏览器|云端?浏览器|云电脑|需要你输入验证码/i.test(message.text || '')

  const openDocument = (target: NativeDocumentTarget) => {
    setActiveDocument({
      ...target,
      platformId: target.platformId ?? botMeta?.platformId,
      agentId: target.agentId ?? botMeta?.selectedAgentId
    })
  }

  const reactGrokMessage = (emoji: string) => {
    if (botMeta?.platformId !== 'grok' || !botMeta.selectedAgentId) return
    const grok = getBridge()?.grok
    if (!grok?.rpc) return
    const entryId = message.id.replace(/^grok_(u_)?/, '')
    setReactedEmoji(emoji)
    void grok
      .rpc({
        accountId: message.accountId,
        op: 'reactMessage',
        agentId: botMeta.selectedAgentId,
        entryId,
        emoji,
        sessionId: botMeta.activeSessionId ?? ''
      })
      .catch(() => setReactedEmoji(null))
  }

  const isLongMarkdownReport =
    !mine &&
    message.text.length > 360 &&
    (/(^|\n)#{1,4}\s+|\n\|.+\|\n|```/.test(message.text) || message.text.length > 800)
  const reportTitleMatch = !mine ? /^(?:---[\s\S]*?---\s*)?#+\s+(.+)$/m.exec(message.text) : null
  const reportTitle = reportTitleMatch?.[1]?.replace(/[*`]/g, '').trim() || '文章 / 报告文档'

  const copyMessageText = () => {
    if (!message.text) return
    void navigator.clipboard.writeText(message.text).then(
      () => {
        setCopiedMsg(true)
        setTimeout(() => setCopiedMsg(false), 1600)
      },
      () => {}
    )
  }

  const quoteReplyMessage = () => {
    const entryId = message.id.replace(/^grok_(u_)?/, '')
    const rawSnippet = (message.text || '').replace(/\s+/g, ' ').trim()
    const quote = rawSnippet.length > 140 ? `${rawSnippet.slice(0, 140)}…` : rawSnippet || '引用消息'
    setReplyTarget(message.botId, {
      messageId: message.id,
      entryId,
      quote,
      role: message.role
    })
    window.dispatchEvent(new CustomEvent('bothub:focus-composer'))
  }

  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      {/* 0. Quoted message snippet when user replied to a bubble */}
      {message.replyQuote && (
        <div
          className={cn(
            'mb-1 flex max-w-[72%] items-center gap-1.5 rounded-xl border border-line bg-sunken/45 px-2.5 py-1 text-[11.5px] text-ink-secondary',
            mine && 'self-end'
          )}
        >
          <CornerDownRight className="size-3 shrink-0 text-accent-600" aria-hidden />
          <span className="truncate">{message.replyQuote}</span>
        </div>
      )}

      {/* 1. Tool execution trace / thinking status above the assistant reply */}
      {!mine && tools.length > 0 && <ToolChips tools={tools} />}

      {/* 2. User uploaded attachment chips / image & video previews */}
      {message.attachments && message.attachments.length > 0 && (
        <ul className={cn('mb-1.5 flex max-w-[78%] flex-wrap gap-1.5', mine && 'justify-end')}>
          {message.attachments.map((file) => (
            <UserAttachmentItem key={file.id} file={file} />
          ))}
        </ul>
      )}

      {/* 3. Message text or structured inline Article / Document Card */}
      {message.text &&
        (isLongMarkdownReport ? (
          <div className="w-full max-w-[82%] overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
            {/* Article Card Header */}
            <div className="flex items-center justify-between gap-3 border-b border-line bg-sunken/40 px-4 py-2.5">
              <button
                type="button"
                onClick={() =>
                  openDocument({
                    accountId: message.accountId,
                    title: reportTitle,
                    markdown: message.text,
                    mimeType: 'text/markdown'
                  })
                }
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                  <FileText className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">{reportTitle}</span>
                  <span className="block truncate text-[11px] text-ink-muted">
                    Markdown 文章卡片 · {message.text.length} 字 · 支持右侧画布沉浸阅读
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {message.text.length > 720 && (
                  <button
                    type="button"
                    onClick={() => setArticleExpanded((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-hover hover:text-ink"
                  >
                    {articleExpanded ? '收起预览' : '展开全文'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    openDocument({
                      accountId: message.accountId,
                      title: reportTitle,
                      markdown: message.text,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-full bg-accent-600 px-3 py-1 text-[11.5px] font-medium text-white shadow-hairline hover:bg-accent-700"
                >
                  <Maximize2 className="size-3" /> 右侧画布阅读
                </button>
              </div>
            </div>

            {/* Article Card Body */}
            <div
              className={cn(
                'relative px-5 py-4 text-[14px] leading-[1.68] text-ink',
                !articleExpanded && message.text.length > 720 && 'max-h-[340px] overflow-hidden'
              )}
            >
              <MarkdownText
                text={message.text}
                suppressWorkspaceImages={media.length > 0}
                onLinkClick={handleMarkdownLinkClick}
                onFileLinkClick={(path, label) =>
                  openDocument({
                    accountId: message.accountId,
                    title: label || path.split('/').pop() || 'Document',
                    path
                  })
                }
              />
              {!articleExpanded && message.text.length > 720 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface via-surface/85 to-transparent" />
              )}
            </div>

            {!articleExpanded && message.text.length > 720 && (
              <div className="flex items-center justify-between border-t border-line/70 bg-sunken/25 px-4 py-1.5 text-[11.5px] text-ink-secondary">
                <button
                  type="button"
                  onClick={() => setArticleExpanded(true)}
                  className="font-medium text-ink-secondary hover:text-ink"
                >
                  点击展开完整长文（共 {message.text.length} 字）
                </button>
                <button
                  type="button"
                  onClick={() =>
                    openDocument({
                      accountId: message.accountId,
                      title: reportTitle,
                      markdown: message.text,
                      mimeType: 'text/markdown'
                    })
                  }
                  className="font-medium text-accent-600 hover:underline"
                >
                  在右侧分栏打开 →
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'max-w-[78%] rounded-[18px] px-3.5 py-2 text-[14px] leading-6',
              mine ? 'bg-bubble-user text-canvas whitespace-pre-wrap break-words' : 'bg-bubble text-ink',
              message.delivery === 'sending' && 'opacity-70',
              message.delivery === 'failed' && 'bg-status-error/10 text-ink ring-1 ring-status-error/30'
            )}
          >
            {mine ? (
              message.text
            ) : (
              <MarkdownText
                text={message.text}
                suppressWorkspaceImages={media.length > 0}
                onLinkClick={handleMarkdownLinkClick}
                onFileLinkClick={(path, label) =>
                  openDocument({
                    accountId: message.accountId,
                    title: label || path.split('/').pop() || 'Document',
                    path
                  })
                }
              />
            )}
          </div>
        ))}

      {/* 3b. Inline shortcut pill when assistant mentions in-page Secure Vault / Cloud Browser (#34) */}
      {needsInlineSessionShortcut && (
        <button
          type="button"
          onClick={() => openWebSessionAt(null)}
          className="press mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-1 text-[12px] font-medium text-ink shadow-soft hover:bg-hover"
        >
          {/安全卡片|安全存储|密码/.test(message.text || '') ? (
            <>
              <ArkShieldVaultSvg className="size-3.5 text-accent-600" />
              <span>在应用内打开安全卡片 / 原生页</span>
            </>
          ) : (
            <>
              <Globe className="size-3.5 text-accent-600" />
              <span>在应用内查看实时云浏览器</span>
            </>
          )}
        </button>
      )}

      {/* 4. Media / File / Artifact cards below message text */}
      {!mine && media.length > 0 && (
        <div className={cn('w-full', message.text && 'mt-2')}>
          <MediaParts parts={media} accountId={message.accountId} onOpenDoc={openDocument} />
        </div>
      )}

      {/* 5. Rich widgets / interactive cards / CTA buttons below message text */}
      {!mine && rich.length > 0 && (
        <div className={cn('w-full', (message.text || media.length > 0) && 'mt-2')}>
          <RichWidgets
            widgets={rich}
            botId={message.botId}
            accountId={message.accountId}
            onOpenDoc={openDocument}
          />
        </div>
      )}

      <NativeDocumentDialog target={docTarget} onClose={() => setDocTarget(null)} />

      {/* 6. Interactive option chips */}
      {optionWidgets.map((w) => (
        <OptionChips key={w.widgetId || w.options.join('|')} message={message} widget={w} />
      ))}

      {(isLastInRun || message.delivery === 'failed' || message.delivery === 'no-reply' || !mine) && (
        <div
          className={cn(
            'mt-1 flex h-5 items-center gap-2 px-1.5 text-[11px] text-ink-muted transition-opacity duration-150',
            message.delivery === 'failed' || message.delivery === 'sending' || message.delivery === 'accepted' || message.delivery === 'no-reply'
              ? 'opacity-100'
              : 'opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100'
          )}
        >
          {accountLabel && <span className="text-ink-secondary">{accountLabel}</span>}
          {accountLabel && <span aria-hidden>·</span>}
          <time dateTime={new Date(message.createdAt).toISOString()} className="tabular-nums">
            {formatClock(message.createdAt)}
          </time>
          {mine ? (
            <div className="flex items-center gap-1.5">
              {message.text && (
                <button
                  type="button"
                  onClick={quoteReplyMessage}
                  title="引用回复"
                  className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <ArkHandoffCurveSvg className="size-3" />
                  <span>引用</span>
                </button>
              )}
              <DeliveryState message={message} onRetry={onRetry} />
            </div>
          ) : (
            message.text && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={quoteReplyMessage}
                  title="引用此消息回复"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <ArkHandoffCurveSvg className="size-3" />
                  <span>引用</span>
                </button>
                <button
                  type="button"
                  onClick={copyMessageText}
                  title={t('Copy')}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  {copiedMsg ? <Check className="size-3 text-status-online" /> : <Copy className="size-3" />}
                  <span>{copiedMsg ? '已复制' : t('Copy')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => triggerShareConversation({ botId: message.botId, messageId: message.id })}
                  title="生成共享页面"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <ArkExportDocSvg className="size-3" />
                  <span>分享</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    openDocument({
                      accountId: message.accountId,
                      title: reportTitle,
                      markdown: message.text,
                      mimeType: 'text/markdown'
                    })
                  }
                  title="在右侧画布展开阅读"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
                >
                  <Maximize2 className="size-3" />
                  <span>右侧阅读</span>
                </button>
                {botMeta?.platformId === 'grok' && botMeta.selectedAgentId && (
                  <div className="ml-0.5 inline-flex items-center gap-0.5">
                    {(['👍', '❤️', '🔥'] as const).map((emo) => (
                      <button
                        key={emo}
                        type="button"
                        onClick={() => reactGrokMessage(emo)}
                        title={`回应 ${emo}`}
                        className={cn(
                          'rounded px-1 py-0.5 text-[11px] hover:bg-hover',
                          reactedEmoji === emo && 'bg-accent-50 ring-1 ring-accent-500/40'
                        )}
                      >
                        {emo}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
})
