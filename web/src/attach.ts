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

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

function mimeOf(name: string, mime: string): string {
  if (mime && mime !== 'application/octet-stream') return mime
  return IMAGE_MIME[extOf(name)] || mime || 'application/octet-stream'
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

function compressImage(file: File, mime: string): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const edge = Math.max(img.width, img.height)
      const scale = edge > 1600 ? 1600 / edge : 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no canvas'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg'
      const dataUrl = canvas.toDataURL(outMime, 0.82)
      const comma = dataUrl.indexOf(',')
      resolve({ data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, mime: outMime })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
}

async function readAttachData(file: File, kind: AttachKind): Promise<{ data: string; mime: string }> {
  const mime = mimeOf(file.name, file.type)
  if (kind !== 'image') {
    return { data: await readBase64(file), mime }
  }
  if (file.size <= 900_000 && (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp')) {
    return { data: await readBase64(file), mime }
  }
  try {
    return await compressImage(file, mime)
  } catch {
    return { data: await readBase64(file), mime }
  }
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
    const { data, mime } = await readAttachData(file, kind)
    next.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      mime,
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
