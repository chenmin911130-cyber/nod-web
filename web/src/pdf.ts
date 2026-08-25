export type PdfBlock = { kind: 'h1' | 'h2' | 'p' | 'meta'; text: string }

const PAGE_W = 595
const PAGE_H = 842
const SCALE = 2
const CANVAS_W = PAGE_W * SCALE
const CANVAS_H = PAGE_H * SCALE
const MARGIN = 48 * SCALE

export async function downloadPdf(title: string, blocks: PdfBlock[]): Promise<string> {
  const pages = await renderPages(blocks)
  if (pages.length === 0) throw new Error('Nothing to export')
  const bytes = buildPdf(title, pages)
  const name = `${safeName(title)}.pdf`
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000)
  return name
}

function safeName(title: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = (title || 'Nod').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Nod'
  return `${base} ${stamp}`
}

async function renderPages(blocks: PdfBlock[]): Promise<Array<{ jpeg: Uint8Array; w: number; h: number }>> {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')

  const pages: Array<{ jpeg: Uint8Array; w: number; h: number }> = []
  let y = 0

  const startPage = () => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    y = MARGIN
  }

  const flushPage = async () => {
    const jpeg = await canvasToJpeg(canvas)
    pages.push({ jpeg, w: CANVAS_W, h: CANVAS_H })
  }

  startPage()
  for (const block of blocks) {
    const style = styleOf(block.kind)
    ctx.font = style.font
    const lines = wrap(ctx, block.text || ' ', CANVAS_W - MARGIN * 2)
    const lineH = style.size * 1.45
    const gap = style.gap
    if (y + gap + lines.length * lineH > CANVAS_H - MARGIN) {
      await flushPage()
      startPage()
    }
    y += gap
    ctx.fillStyle = style.color
    for (const line of lines) {
      if (y + lineH > CANVAS_H - MARGIN) {
        await flushPage()
        startPage()
        ctx.font = style.font
        ctx.fillStyle = style.color
      }
      ctx.fillText(line, MARGIN, y + style.size)
      y += lineH
    }
  }
  await flushPage()
  return pages
}

function styleOf(kind: PdfBlock['kind']) {
  if (kind === 'h1') return { font: `700 ${22 * SCALE}px "Segoe UI","Microsoft YaHei UI","Noto Sans SC",sans-serif`, size: 22 * SCALE, color: '#102033', gap: 8 * SCALE }
  if (kind === 'h2') return { font: `700 ${12 * SCALE}px "Segoe UI","Microsoft YaHei UI","Noto Sans SC",sans-serif`, size: 12 * SCALE, color: '#0e7490', gap: 22 * SCALE }
  if (kind === 'meta') return { font: `400 ${11 * SCALE}px "Segoe UI","Microsoft YaHei UI","Noto Sans SC",sans-serif`, size: 11 * SCALE, color: '#5b6b80', gap: 6 * SCALE }
  return { font: `400 ${13 * SCALE}px "Segoe UI","Microsoft YaHei UI","Noto Sans SC",sans-serif`, size: 13 * SCALE, color: '#102033', gap: 8 * SCALE }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const para of raw) {
    if (!para) {
      out.push('')
      continue
    }
    let line = ''
    for (const ch of para) {
      const next = line + ch
      if (ctx.measureText(next).width > maxWidth && line) {
        out.push(line)
        line = ch === ' ' ? '' : ch
      } else {
        line = next
      }
    }
    if (line) out.push(line)
  }
  return out.length ? out : ['']
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('Could not encode PDF page'))
          return
        }
        resolve(new Uint8Array(await blob.arrayBuffer()))
      },
      'image/jpeg',
      0.84,
    )
  })
}

function buildPdf(title: string, pages: Array<{ jpeg: Uint8Array; w: number; h: number }>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets = [0]
  let size = 0

  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk
    parts.push(bytes)
    size += bytes.length
  }

  const obj = (n: number, body: string | Uint8Array | Array<string | Uint8Array>) => {
    offsets[n] = size
    push(`${n} 0 obj\n`)
    if (typeof body === 'string' || body instanceof Uint8Array) push(body)
    else body.forEach(push)
    push('\nendobj\n')
  }

  push('%PDF-1.4\n%\x80\x80\x80\x80\n')
  const pageCount = pages.length
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')
  obj(1, `<< /Type /Catalog /Pages 2 0 R >>`)
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`)
  pages.forEach((page, i) => {
    const pageObj = 3 + i * 3
    const imgObj = pageObj + 1
    const contentObj = pageObj + 2
    obj(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>`)
    obj(imgObj, [
      `<< /Type /XObject /Subtype /Image /Width ${page.w} /Height ${page.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      '\nendstream',
    ])
    const content = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q`
    obj(contentObj, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  const infoObj = 3 + pageCount * 3
  obj(infoObj, `<< /Title (${pdfEscape(title)}) /Producer (Nod) >>`)
  const xrefAt = size
  push(`xref\n0 ${infoObj + 1}\n`)
  push('0000000000 65535 f \n')
  for (let i = 1; i <= infoObj; i++) {
    push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer << /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`)
  const out = new Uint8Array(size)
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}
