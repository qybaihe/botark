import { createHash } from 'node:crypto'
import type { CueMediaPayload, CueToolCallPayload } from '@shared/ipc'

export const CUE_CLIENT_VERSION =
  (typeof process !== 'undefined' && process.env?.BOTARK_CUE_CLIENT_VERSION?.trim()) || '1.0.6'

export type CueToolCall = CueToolCallPayload
export type CueMediaPart = CueMediaPayload

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function looksLikeImagePart(
  path: string,
  mimeType?: string,
  name?: string,
  explicitType?: string
): boolean {
  if (explicitType && /^image/i.test(explicitType)) return true
  if (mimeType && /^image\//i.test(mimeType)) return true
  if (/^data:image\//i.test(path)) return true
  return /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(path || name || '')
}

export function normalizeCueMediaItem(raw: unknown): CueMediaPart | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const explicitType = nonEmptyString(rec['type'] ?? rec['kind'] ?? rec['mediaType'])
  if (explicitType && /^(?:text|markdown|plain|thought|reasoning)$/i.test(explicitType)) {
    return null
  }
  const url = nonEmptyString(
    rec['url'] ??
      rec['fileUrl'] ??
      rec['file_url'] ??
      rec['downloadUrl'] ??
      rec['download_url'] ??
      rec['imageUrl'] ??
      rec['image_url'] ??
      rec['src'] ??
      rec['path']
  )
  if (!url) return null
  const name = nonEmptyString(
    rec['filename'] ?? rec['fileName'] ?? rec['file_name'] ?? rec['name'] ?? rec['title']
  )
  const mimeType = nonEmptyString(
    rec['mimeType'] ?? rec['mime_type'] ?? rec['contentType'] ?? rec['content_type']
  )
  const imageId = nonEmptyString(
    rec['fileId'] ?? rec['file_id'] ?? rec['imageId'] ?? rec['image_id'] ?? rec['id']
  )
  const kind: 'image' | 'file' = looksLikeImagePart(url, mimeType, name, explicitType)
    ? 'image'
    : 'file'
  return {
    kind,
    path: url,
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(imageId ? { imageId } : {})
  }
}

export function extractCueEventMedia(ev: Record<string, unknown>): CueMediaPart[] {
  const out: CueMediaPart[] = []
  const seen = new Set<string>()
  const add = (part: CueMediaPart | null) => {
    if (!part || seen.has(part.path)) return
    seen.add(part.path)
    out.push(part)
  }
  for (const key of ['attachments', 'files', 'media', 'artifacts'] as const) {
    const arr = ev[key]
    if (Array.isArray(arr)) {
      for (const item of arr) add(normalizeCueMediaItem(item))
    }
  }
  const contents = ev['contents']
  if (Array.isArray(contents)) {
    for (const item of contents) {
      const part = asRecord(item)
      if (!part) continue
      add(normalizeCueMediaItem(part))
      const nested = asRecord(part['file'] ?? part['image'] ?? part['attachment'])
      if (nested) add(normalizeCueMediaItem(nested))
    }
  }
  return out
}

export function mapCueToolEvent(
  ev: Record<string, unknown>,
  defaultStatus: CueToolCall['status'] = 'completed',
  fallbackId?: string
): CueToolCall | null {
  const name = nonEmptyString(
    ev['toolName'] ?? ev['tool_name'] ?? ev['tool'] ?? ev['name'] ?? ev['action'] ?? ev['title']
  )
  if (!name) return null
  const id =
    nonEmptyString(
      ev['id'] ?? ev['toolCallId'] ?? ev['tool_call_id'] ?? ev['callId'] ?? ev['eventId']
    ) ||
    fallbackId ||
    `cue_tool_${createHash('sha256')
      .update(JSON.stringify([name, ev['title'], ev['command'], ev['timestamp']]))
      .digest('hex')
      .slice(0, 16)}`
  const toolType = nonEmptyString(
    ev['tool'] ?? ev['toolType'] ?? ev['tool_type'] ?? ev['category']
  )
  const rawStatus = nonEmptyString(ev['status'] ?? ev['state'])?.toLowerCase()
  let status: CueToolCall['status'] = defaultStatus
  if (rawStatus) {
    if (rawStatus === 'error' || rawStatus === 'errored' || rawStatus === 'failed') {
      status = 'errored'
    } else if (
      rawStatus === 'running' ||
      rawStatus === 'pending' ||
      rawStatus === 'in_progress' ||
      rawStatus === 'started'
    ) {
      status = 'running'
    } else if (
      rawStatus === 'completed' ||
      rawStatus === 'done' ||
      rawStatus === 'success' ||
      rawStatus === 'finished'
    ) {
      status = 'completed'
    }
  }
  const summary = nonEmptyString(
    ev['title'] ??
      ev['brief'] ??
      ev['description'] ??
      ev['summary'] ??
      ev['command'] ??
      ev['query'] ??
      ev['message']
  )
  return {
    id,
    name,
    ...(toolType ? { toolType } : {}),
    status,
    ...(summary && summary !== name ? { summary } : {})
  }
}

export function mergeCueMediaLists(
  existing: readonly CueMediaPart[],
  incoming: readonly CueMediaPart[]
): CueMediaPart[] {
  if (incoming.length === 0) return [...existing]
  const out = [...existing]
  const seen = new Set(existing.map((item) => item.path))
  for (const part of incoming) {
    if (seen.has(part.path)) continue
    seen.add(part.path)
    out.push(part)
  }
  return out
}
