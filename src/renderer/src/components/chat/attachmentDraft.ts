import type { AttachmentMeta } from '@adapters/types'
import { createId } from '@shared/id'

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_FILE_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type DraftAttachment = {
  file: AttachmentMeta
  status: 'reading' | 'ready' | 'too-large' | 'empty' | 'read-failed'
}

function inferBrowserFileMime(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.mkv')) return 'video/x-matroska'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return file.type || 'application/octet-stream'
}

function queueFile(file: File): DraftAttachment {
  const mimeType = inferBrowserFileMime(file)
  const limit = mimeType.startsWith('image/') ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_FILE_ATTACHMENT_BYTES
  return {
    file: {
      id: createId('att'),
      name: file.name || `attachment.${mimeType.split('/')[1] || 'bin'}`,
      size: file.size,
      mimeType
    },
    status: file.size === 0 ? 'empty' : file.size > limit ? 'too-large' : 'reading'
  }
}

async function readFile(file: File, entry: DraftAttachment): Promise<DraftAttachment> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length === 0) return { ...entry, status: 'empty' }
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return { file: { ...entry.file, dataBase64: btoa(binary) }, status: 'ready' }
  } catch {
    return { ...entry, status: 'read-failed' }
  }
}

/** Keeps file selection synchronous so a submit in the same event turn sees it. */
export function createAttachmentDraft(onChange: (entries: DraftAttachment[]) => void) {
  let entries: DraftAttachment[] = []
  const update = (next: DraftAttachment[]) => {
    entries = next
    onChange(next)
  }

  return {
    async add(files: FileList | File[]): Promise<void> {
      const batch = Array.from(files, (file) => ({ file, entry: queueFile(file) }))
      if (batch.length === 0) return
      update([...entries, ...batch.map(({ entry }) => entry)])
      await Promise.all(batch.map(async ({ file, entry }) => {
        if (entry.status !== 'reading') return
        const result = await readFile(file, entry)
        // The user can remove an attachment before its read finishes.
        if (!entries.includes(entry)) return
        update(entries.map((item) => item === entry ? result : item))
      }))
    },
    remove(id: string) {
      update(entries.filter((entry) => entry.file.id !== id))
    },
    clear() {
      update([])
    },
    forSend(): AttachmentMeta[] | null {
      return entries.every((entry) => entry.status === 'ready') ? entries.map((entry) => entry.file) : null
    }
  }
}
