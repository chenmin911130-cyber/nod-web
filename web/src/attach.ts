export type AttachKind = 'pdf' | 'office' | 'image' | 'text'

export interface LocalAttach {
  id: string
  name: string
  mime: string
  size: number
  data: string
  kind: AttachKind
}

export interface AttachPayload {
  name: string
  mime: string
  data: string
}

export const ATTACH_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_FILES = 5

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const TEXT_EXT = new Set(['txt', 'md'])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function kindOf(name: string, mime: string): AttachKind | null {
  const ext = extOf(name)
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image'
  if (OFFICE_EXT.has(ext)) return 'office'
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) return 'text'
  return null
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result || '')
      const comma = raw.indexOf(',')
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw)
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export async function collectAttaches(
  list: FileList | File[],
  existing: LocalAttach[],
): Promise<{ files: LocalAttach[]; error?: string }> {
  const next = existing.slice()
  for (const file of Array.from(list)) {
    if (next.length >= MAX_FILES) {
      return { files: next, error: `Up to ${MAX_FILES} files` }
    }
    if (file.size > MAX_BYTES) {
      return { files: next, error: `${file.name} is larger than 8 MB` }
    }
    const kind = kindOf(file.name, file.type)
    if (!kind) {
      return { files: next, error: 'Use Office, PDF, or image files' }
    }
    const data = await readBase64(file)
    next.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      data,
      kind,
    })
  }
  return { files: next }
}

export function toPayload(files: LocalAttach[]): AttachPayload[] {
  return files.map(({ name, mime, data }) => ({ name, mime, data }))
}
