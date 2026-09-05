import { PDF_BRAND, pdfBrandMark, pdfDefaultTitle, pdfDownloadName } from './pdfBrand'
import {
  chipsHtml,
  footerHtml,
  mastHtml,
  sectionChunks,
  templateCss,
  templateFonts,
  type ListenPdfDoc,
} from './pdfTemplates'

export type { ListenPdfDoc }

export type PdfTheme = 'plain' | 'meeting' | 'lecture'

export type PdfBlock = {
  kind: 'h1' | 'h2' | 'p' | 'meta' | 'bullet' | 'action' | 'decision' | 'flash' | 'concept' | 'line'
  text: string
  owner?: string
  ts?: string
  speaker?: string
}

export type PdfOptions = {
  theme?: PdfTheme
  subtitle?: string
  meta?: string[]
  doc?: ListenPdfDoc
  filename?: string
}

const PAGE_W = 595
const PAGE_H = 842
const SCALE = 2
const CANVAS_W = PAGE_W * SCALE
const CANVAS_H = PAGE_H * SCALE

type Theme = {
  name: PdfTheme
  paper: string
  ink: string
  muted: string
  accent: string
  accentSoft: string
  header: string
  headerText: string
  headerMuted: string
  card: string
  line: string
  badge: string
  kind: string
  font: string
  titleFont: string
}

const FONTS = '"Segoe UI","Microsoft YaHei UI","Noto Sans SC",sans-serif'
const TITLE_FONTS = 'Georgia,"Songti SC","SimSun",serif'

const THEMES: Record<PdfTheme, Theme> = {
  plain: {
    name: 'plain',
    paper: '#ffffff',
    ink: '#102033',
    muted: '#5b6b80',
    accent: '#0e7490',
    accentSoft: '#e8f7fb',
    header: '#ffffff',
    headerText: '#102033',
    headerMuted: '#5b6b80',
    card: '#ffffff',
    line: '#d7e0ea',
    badge: '#0e7490',
    kind: 'NOTES',
    font: FONTS,
    titleFont: FONTS,
  },
  meeting: {
    name: 'meeting',
    paper: '#f4f7fb',
    ink: '#102033',
    muted: '#5d6d82',
    accent: '#0891b2',
    accentSoft: '#e8f7fb',
    header: '#0b1424',
    headerText: '#eef5ff',
    headerMuted: '#9ab0c9',
    card: '#ffffff',
    line: '#d5deea',
    badge: '#22d3ee',
    kind: 'MEETING NOTES',
    font: FONTS,
    titleFont: TITLE_FONTS,
  },
  lecture: {
    name: 'lecture',
    paper: '#f6f1e6',
    ink: '#1c1712',
    muted: '#6b5e4e',
    accent: '#0f766e',
    accentSoft: '#ecf6f3',
    header: '#161410',
    headerText: '#f6efe2',
    headerMuted: '#c4b59a',
    card: '#fffdf8',
    line: '#e4d8c4',
    badge: '#f5d38a',
    kind: 'STUDY NOTES',
    font: FONTS,
    titleFont: TITLE_FONTS,
  },
}

export async function renderPdfFile(title: string, blocks: PdfBlock[], options: PdfOptions = {}): Promise<{ bytes: Uint8Array; name: string }> {
  let pages: Array<{ jpeg: Uint8Array; w: number; h: number }> = []
  if (options.doc && (options.doc.theme === 'meeting' || options.doc.theme === 'lecture')) {
    try {
      pages = await renderTemplatePages(options.doc)
    } catch {
      pages = []
    }
  }
  if (!pages.length) pages = await renderPages(title, blocks, options)
  if (pages.length === 0) throw new Error('Nothing to export')
  const bytes = buildPdf(title, pages)
  const raw = (options.filename || '').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  const name = pdfDownloadName(raw || `${pdfDefaultTitle(title)} ${new Date().toISOString().slice(0, 10)}`)
  return { bytes, name }
}

export async function downloadPdf(title: string, blocks: PdfBlock[], options: PdfOptions = {}): Promise<string> {
  const { bytes, name } = await renderPdfFile(title, blocks, options)
  const { isNativeApp } = await import('./native')
  if (isNativeApp()) {
    const { saveNativeFiles } = await import('./watch')
    await saveNativeFiles([{ bytes, name }])
    return name
  }
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/pdf' }))
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

const SHEET_W = 794
const SHEET_H = 1123

async function renderTemplatePages(doc: ListenPdfDoc): Promise<Array<{ jpeg: Uint8Array; w: number; h: number }>> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = `position:fixed;left:-12000px;top:0;width:${SHEET_W}px;height:${SHEET_H}px;border:0;opacity:0;pointer-events:none`
  document.body.appendChild(iframe)
  const idoc = iframe.contentDocument
  if (!idoc) {
    iframe.remove()
    throw new Error('PDF frame unavailable')
  }
  idoc.open()
  idoc.write(
    `<!doctype html><html><head><meta charset="utf-8" />` +
      `<link rel="stylesheet" href="${templateFonts(doc.theme)}" />` +
      `<style>${templateCss(doc.theme)}</style></head><body></body></html>`,
  )
  idoc.close()
  await Promise.race([idoc.fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 1200))])

  const chunks = sectionChunks(doc)
  const sheets: HTMLElement[] = []
  let sheet = makeSheet(idoc, doc, false)
  let body = sheet.querySelector('.body') as HTMLElement
  sheets.push(sheet)

  const overflows = () => sheet.scrollHeight > SHEET_H + 1

  for (const html of chunks) {
    const wrap = idoc.createElement('div')
    wrap.innerHTML = html
    const nodes = [...wrap.childNodes]
    for (const node of nodes) {
      body.appendChild(node)
      if (!overflows()) continue
      body.removeChild(node)
      if (body.childNodes.length === 0) {
        body.appendChild(node)
        continue
      }
      sheet = makeSheet(idoc, doc, true)
      body = sheet.querySelector('.body') as HTMLElement
      sheets.push(sheet)
      if (node instanceof HTMLElement && node.classList.contains('line') && !body.querySelector('h2, .sec')) {
        const head = idoc.createElement('div')
        head.innerHTML = doc.theme === 'lecture' ? '<p class="sec">CLASSROOM STREAM</p>' : '<h2>Transcript</h2>'
        while (head.firstChild) body.appendChild(head.firstChild)
      }
      body.appendChild(node)
    }
  }

  const total = sheets.length
  sheets.forEach((page, i) => {
    const foot = page.querySelector('.foot')
    if (foot) foot.outerHTML = footerHtml(doc, i + 1, total)
  })

  const pages: Array<{ jpeg: Uint8Array; w: number; h: number }> = []
  try {
    for (const page of sheets) pages.push(await captureSheet(page, doc.theme === 'lecture' ? '#f6f1e6' : '#f4f7fb'))
  } finally {
    iframe.remove()
  }
  return pages
}

function makeSheet(idoc: Document, doc: ListenPdfDoc, slim: boolean): HTMLElement {
  const sheet = idoc.createElement('article')
  sheet.className = 'sheet'
  sheet.innerHTML = `${mastHtml(doc, slim)}${slim ? '' : chipsHtml(doc)}<div class="body"></div>${footerHtml(doc, 1, 1)}`
  idoc.body.appendChild(sheet)
  return sheet
}

async function captureSheet(sheet: HTMLElement, paper: string): Promise<{ jpeg: Uint8Array; w: number; h: number }> {
  const css = [...(sheet.ownerDocument?.querySelectorAll('style') || [])].map((node) => node.textContent || '').join('\n')
  const clone = sheet.cloneNode(true) as HTMLElement
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  const style = sheet.ownerDocument!.createElement('style')
  style.textContent = css
  clone.insertBefore(style, clone.firstChild)
  const xhtml = new XMLSerializer().serializeToString(clone)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}" height="${SHEET_H}">` +
    `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = SHEET_W * SCALE
    canvas.height = SHEET_H * SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { jpeg: await canvasToJpeg(canvas), w: canvas.width, h: canvas.height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not render PDF page'))
    img.src = src
  })
}

async function renderPages(title: string, blocks: PdfBlock[], options: PdfOptions): Promise<Array<{ jpeg: Uint8Array; w: number; h: number }>> {
  const theme = THEMES[options.theme || 'plain']
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')

  const pages: Array<{ jpeg: Uint8Array; w: number; h: number }> = []
  const pad = 36 * SCALE
  const footerH = 28 * SCALE
  let y = 0
  let pageIndex = 0

  const headerH = (first: boolean) => {
    if (options.theme === 'plain') return first ? 28 * SCALE : 20 * SCALE
    return first ? 118 * SCALE : 52 * SCALE
  }

  const startPage = (first: boolean) => {
    pageIndex += 1
    ctx.fillStyle = theme.paper
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    drawHeader(ctx, theme, title, options, first, pad)
    y = pad + headerH(first) + (first && options.theme !== 'plain' ? 10 * SCALE : 0)
  }

  const flushPage = async () => {
    drawFooter(ctx, theme, title, pageIndex)
    const jpeg = await canvasToJpeg(canvas)
    pages.push({ jpeg, w: CANVAS_W, h: CANVAS_H })
  }

  const bottom = () => CANVAS_H - pad - footerH

  const ensure = async (need: number) => {
    if (y + need <= bottom()) return
    await flushPage()
    startPage(false)
  }

  startPage(true)
  for (const block of blocks) {
    if (options.theme === 'plain') {
      await drawPlainBlock(ctx, block, pad, async (need) => {
        if (y + need > bottom()) {
          await flushPage()
          startPage(false)
        }
      }, (next) => { y = next }, () => y, theme)
      continue
    }
    await drawThemedBlock(ctx, block, theme, pad, () => y, ensure, (next) => { y = next })
  }
  await flushPage()
  return pages
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  title: string,
  options: PdfOptions,
  first: boolean,
  pad: number,
) {
  const h = first && options.theme !== 'plain' ? 118 * SCALE : options.theme === 'plain' ? 8 * SCALE : 52 * SCALE
  if (options.theme === 'plain') return

  ctx.fillStyle = theme.header
  ctx.fillRect(0, 0, CANVAS_W, h)

  if (first) {
    ctx.fillStyle = theme.badge
    ctx.fillRect(pad, pad + 6 * SCALE, 4 * SCALE, 72 * SCALE)

    ctx.font = `700 ${10 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.badge
    ctx.fillText(PDF_BRAND, pad + 18 * SCALE, pad + 16 * SCALE)

    ctx.font = `700 ${9 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.headerMuted
    ctx.fillText(theme.kind, pad + 18 * SCALE, pad + 32 * SCALE)

    ctx.font = `600 ${22 * SCALE}px ${theme.titleFont}`
    ctx.fillStyle = theme.headerText
    const lines = wrap(ctx, title, CANVAS_W - pad * 2 - 18 * SCALE)
    ctx.fillText(lines[0] || title, pad + 18 * SCALE, pad + 58 * SCALE)

    const meta = (options.meta || []).filter(Boolean).join('  ·  ')
    if (meta) {
      ctx.font = `400 ${10 * SCALE}px ${theme.font}`
      ctx.fillStyle = theme.headerMuted
      ctx.fillText(meta, pad + 18 * SCALE, pad + 80 * SCALE)
    }
    if (options.theme === 'lecture') {
      ctx.fillStyle = theme.badge
      ctx.fillRect(pad, h - 3 * SCALE, 72 * SCALE, 3 * SCALE)
      ctx.fillStyle = theme.accent
      ctx.fillRect(pad + 72 * SCALE, h - 3 * SCALE, 88 * SCALE, 3 * SCALE)
      ctx.fillStyle = '#e8d5b0'
      ctx.fillRect(pad + 160 * SCALE, h - 3 * SCALE, CANVAS_W - pad * 2 - 160 * SCALE, 3 * SCALE)
    }
    return
  }

  ctx.font = `700 ${9 * SCALE}px ${theme.font}`
  ctx.fillStyle = theme.badge
  ctx.fillText(PDF_BRAND, pad, 28 * SCALE)
  ctx.font = `600 ${11 * SCALE}px ${theme.font}`
  ctx.fillStyle = theme.headerText
  ctx.fillText(title, pad + 36 * SCALE, 28 * SCALE)
  ctx.font = `400 ${9 * SCALE}px ${theme.font}`
  ctx.fillStyle = theme.headerMuted
  ctx.fillText(theme.kind, CANVAS_W - pad - ctx.measureText(theme.kind).width, 28 * SCALE)
}

function drawFooter(ctx: CanvasRenderingContext2D, theme: Theme, title: string, page: number) {
  const y = CANVAS_H - 22 * SCALE
  ctx.font = `500 ${8 * SCALE}px ${theme.font}`
  ctx.fillStyle = theme.muted
  ctx.fillText(pdfBrandMark(title), 36 * SCALE, y)
  const mark = String(page)
  ctx.fillText(mark, CANVAS_W - 36 * SCALE - ctx.measureText(mark).width, y)
}

async function drawPlainBlock(
  ctx: CanvasRenderingContext2D,
  block: PdfBlock,
  pad: number,
  ensure: (need: number) => Promise<void>,
  setY: (y: number) => void,
  getY: () => number,
  theme: Theme,
) {
  const style = styleOf(block.kind, theme)
  ctx.font = style.font
  const lines = wrap(ctx, block.text || ' ', CANVAS_W - pad * 2)
  const lineH = style.size * 1.45
  await ensure(style.gap + lines.length * lineH)
  let y = getY() + style.gap
  ctx.fillStyle = style.color
  for (const line of lines) {
    await ensure(lineH)
    y = getY() === y ? y : getY()
    ctx.font = style.font
    ctx.fillStyle = style.color
    ctx.fillText(line, pad, y + style.size)
    y += lineH
    setY(y)
  }
}

async function drawThemedBlock(
  ctx: CanvasRenderingContext2D,
  block: PdfBlock,
  theme: Theme,
  pad: number,
  getY: () => number,
  ensure: (need: number) => Promise<void>,
  setY: (y: number) => void,
) {
  const width = CANVAS_W - pad * 2

  if (block.kind === 'h1' || block.kind === 'meta') return

  if (block.kind === 'h2') {
    await ensure(28 * SCALE)
    const y = getY()
    ctx.font = `700 ${9 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.accent
    ctx.fillText(block.text.toUpperCase(), pad, y + 18 * SCALE)
    setY(y + 26 * SCALE)
    return
  }

  if (block.kind === 'p') {
    ctx.font = `400 ${12 * SCALE}px ${theme.titleFont}`
    const lines = wrap(ctx, block.text, width - 24 * SCALE)
    const boxH = 18 * SCALE + lines.length * 18 * SCALE
    await ensure(boxH + 10 * SCALE)
    const y = getY()
    roundRect(ctx, pad, y, width, boxH, 0)
    ctx.fillStyle = theme.card
    ctx.fill()
    ctx.strokeStyle = theme.line
    ctx.lineWidth = 1 * SCALE
    ctx.stroke()
    ctx.fillStyle = theme.badge
    ctx.fillRect(pad, y, 3 * SCALE, boxH)
    ctx.fillStyle = theme.ink
    let ty = y + 18 * SCALE
    for (const line of lines) {
      ctx.fillText(line, pad + 14 * SCALE, ty)
      ty += 18 * SCALE
    }
    setY(y + boxH + 12 * SCALE)
    return
  }

  if (block.kind === 'decision' || block.kind === 'bullet') {
    ctx.font = `400 ${11.5 * SCALE}px ${theme.font}`
    const lines = wrap(ctx, block.text, width - 28 * SCALE)
    const h = Math.max(20 * SCALE, lines.length * 16 * SCALE)
    await ensure(h + 8 * SCALE)
    const y = getY()
    ctx.fillStyle = theme.accent
    ctx.beginPath()
    ctx.arc(pad + 5 * SCALE, y + 8 * SCALE, 3 * SCALE, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = theme.ink
    let ty = y + 12 * SCALE
    for (const line of lines) {
      ctx.fillText(line, pad + 16 * SCALE, ty)
      ty += 16 * SCALE
    }
    setY(y + h + 6 * SCALE)
    return
  }

  if (block.kind === 'action') {
    const { owner, text } = splitAction(block)
    ctx.font = `400 ${11.5 * SCALE}px ${theme.font}`
    const lines = wrap(ctx, text, width - (owner ? 92 * SCALE : 28 * SCALE))
    const h = Math.max(24 * SCALE, 8 * SCALE + lines.length * 16 * SCALE)
    await ensure(h + 6 * SCALE)
    const y = getY()
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 1.4 * SCALE
    ctx.strokeRect(pad, y + 2 * SCALE, 10 * SCALE, 10 * SCALE)
    let x = pad + 18 * SCALE
    if (owner) {
      ctx.font = `700 ${9 * SCALE}px ${theme.font}`
      const pill = owner.toUpperCase()
      const pw = ctx.measureText(pill).width + 12 * SCALE
      ctx.fillStyle = theme.accentSoft
      ctx.fillRect(x, y, pw, 16 * SCALE)
      ctx.fillStyle = theme.accent
      ctx.fillText(pill, x + 6 * SCALE, y + 12 * SCALE)
      x += pw + 8 * SCALE
    }
    ctx.font = `400 ${11.5 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.ink
    let ty = y + 12 * SCALE
    for (const line of lines) {
      ctx.fillText(line, x, ty)
      ty += 16 * SCALE
    }
    setY(y + h + 6 * SCALE)
    return
  }

  if (block.kind === 'concept') {
    ctx.font = `400 ${12 * SCALE}px ${theme.font}`
    const lines = wrap(ctx, block.text, width - 44 * SCALE)
    const h = Math.max(28 * SCALE, 8 * SCALE + lines.length * 17 * SCALE)
    await ensure(h + 8 * SCALE)
    const y = getY()
    ctx.strokeStyle = theme.line
    ctx.beginPath()
    ctx.moveTo(pad, y)
    ctx.lineTo(pad + width, y)
    ctx.stroke()
    ctx.font = `600 ${16 * SCALE}px ${theme.titleFont}`
    ctx.fillStyle = theme.accent
    const n = (block.owner || '').padStart(2, '0') || '·'
    ctx.fillText(n, pad, y + 22 * SCALE)
    ctx.font = `400 ${12 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.ink
    let ty = y + 18 * SCALE
    for (const line of lines) {
      ctx.fillText(line, pad + 36 * SCALE, ty)
      ty += 17 * SCALE
    }
    setY(y + h + 4 * SCALE)
    return
  }

  if (block.kind === 'flash') {
    ctx.font = `400 ${11.5 * SCALE}px ${theme.font}`
    const lines = wrap(ctx, block.text, width - 24 * SCALE)
    const h = 28 * SCALE + lines.length * 16 * SCALE
    await ensure(h + 8 * SCALE)
    const y = getY()
    ctx.fillStyle = theme.name === 'lecture' ? '#fff7ed' : theme.accentSoft
    ctx.fillRect(pad, y, width, h)
    ctx.strokeStyle = theme.name === 'lecture' ? '#f0d3a8' : theme.line
    ctx.strokeRect(pad, y, width, h)
    ctx.font = `700 ${8 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.name === 'lecture' ? '#b45309' : theme.accent
    ctx.fillText((block.owner || 'REVISE').toUpperCase(), pad + 12 * SCALE, y + 14 * SCALE)
    ctx.font = `400 ${11.5 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.ink
    let ty = y + 30 * SCALE
    for (const line of lines) {
      ctx.fillText(line, pad + 12 * SCALE, ty)
      ty += 16 * SCALE
    }
    setY(y + h + 8 * SCALE)
    return
  }

  if (block.kind === 'line') {
    const who = block.speaker || ''
    const stamp = block.ts || ''
    ctx.font = `400 ${10.5 * SCALE}px ${theme.font}`
    const lines = wrap(ctx, block.text, width - 118 * SCALE)
    const h = Math.max(18 * SCALE, lines.length * 14 * SCALE)
    await ensure(h + 6 * SCALE)
    const y = getY()
    ctx.fillStyle = theme.muted
    ctx.fillText(stamp, pad, y + 12 * SCALE)
    ctx.font = `700 ${10 * SCALE}px ${theme.font}`
    ctx.fillStyle = who.toLowerCase().includes('audience') ? '#b45309' : theme.accent
    ctx.fillText(who, pad + 48 * SCALE, y + 12 * SCALE)
    ctx.font = `400 ${10.5 * SCALE}px ${theme.font}`
    ctx.fillStyle = theme.ink
    let ty = y + 12 * SCALE
    for (const line of lines) {
      ctx.fillText(line, pad + 118 * SCALE, ty)
      ty += 14 * SCALE
    }
    ctx.strokeStyle = theme.line
    ctx.beginPath()
    ctx.moveTo(pad, y + h + 2 * SCALE)
    ctx.lineTo(pad + width, y + h + 2 * SCALE)
    ctx.stroke()
    setY(y + h + 6 * SCALE)
  }
}

function splitAction(block: PdfBlock): { owner: string; text: string } {
  if (block.owner) return { owner: block.owner, text: block.text }
  const parts = block.text.split(/\s+[—–-]\s+/)
  if (parts.length >= 2) return { owner: parts[0], text: parts.slice(1).join(' — ') }
  return { owner: '', text: block.text }
}

function styleOf(kind: PdfBlock['kind'], theme: Theme) {
  if (kind === 'h1') return { font: `700 ${22 * SCALE}px ${theme.font}`, size: 22 * SCALE, color: theme.ink, gap: 8 * SCALE }
  if (kind === 'h2') return { font: `700 ${12 * SCALE}px ${theme.font}`, size: 12 * SCALE, color: theme.accent, gap: 22 * SCALE }
  if (kind === 'meta') return { font: `400 ${11 * SCALE}px ${theme.font}`, size: 11 * SCALE, color: theme.muted, gap: 6 * SCALE }
  return { font: `400 ${13 * SCALE}px ${theme.font}`, size: 13 * SCALE, color: theme.ink, gap: 8 * SCALE }
}

const CJK_ATOM_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

function wrapTokens(text: string): string[] {
  // Latin words are atomic (never break mid-word); CJK chars are each their
  // own atom (break is fine between glyphs); spaces separate Latin words.
  const atoms: string[] = []
  let word = ''
  for (const ch of text) {
    if (/\s/.test(ch) || CJK_ATOM_RE.test(ch)) {
      if (word) {
        atoms.push(word)
        word = ''
      }
      atoms.push(ch)
    } else {
      word += ch
    }
  }
  if (word) atoms.push(word)
  return atoms
}

export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const raw = (text || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const para of raw) {
    if (!para) {
      out.push('')
      continue
    }
    let line = ''
    for (const atom of wrapTokens(para)) {
      if (!line && /\s/.test(atom)) continue // never start a line with a space
      const next = line + atom
      const fits = ctx.measureText(next).width <= maxWidth
      if (fits) {
        line = next
      } else if (line) {
        // break at the atom boundary (a space or a word) — never mid-word
        out.push(line.trimEnd())
        line = /\s/.test(atom) ? '' : atom
      } else {
        // a single atom is wider than the line: fall back to char-level break
        for (const ch of atom) {
          const cnext = line + ch
          if (ctx.measureText(cnext).width > maxWidth && line) {
            out.push(line.trimEnd())
            line = ch === ' ' ? '' : ch
          } else {
            line = cnext
          }
        }
      }
    }
    if (line) out.push(line.trimEnd())
  }
  return out.length ? out : ['']
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  if (!r) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
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
      0.88,
    )
  })
}

function buildPdf(title: string, pages: Array<{ jpeg: Uint8Array; w: number; h: number }>): Uint8Array<ArrayBuffer> {
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
  obj(infoObj, `<< /Title ${pdfTitleLiteral(title)} /Producer (${PDF_BRAND}) >>`)
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

// /Title holds text a reader decodes as PDFDocEncoding (≈ Latin-1), so any
// non-ASCII title written as raw UTF-8 turns into mojibake ("capacitÃ€…").
// Per the PDF spec, non-ASCII text is written as a UTF-16BE hex string with a
// BOM. Pure-ASCII titles stay as a plain escaped literal (compact, unchanged).
export function pdfTitleLiteral(title: string): string {
  const clean = pdfDefaultTitle(title)
  if (/^[\x00-\x7f]*$/.test(clean)) return `(${pdfEscape(clean)})`
  return `<${utf16BEHex(clean)}>`
}

function utf16BEHex(text: string): string {
  let hex = 'FEFF' // byte-order mark
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp > 0xffff) {
      const c = cp - 0x10000
      const hi = 0xd800 + (c >> 10)
      const lo = 0xdc00 + (c & 0x3ff)
      hex += hi.toString(16).padStart(4, '0')
      hex += lo.toString(16).padStart(4, '0')
    } else {
      hex += cp.toString(16).padStart(4, '0')
    }
  }
  return hex.toUpperCase()
}
