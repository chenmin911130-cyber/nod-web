import { pdfDownloadName } from './pdfBrand'
import type { PdfBlock, PdfTheme } from './pdf'
import { modeOf, sceneOf } from './historyRestore'
import { sameSpokenLine } from './iphoneCopy'

type PdfSession = {
  id: string
  mode: string
  scene?: string
  title: string
  started_at: string | null
  stt_seconds?: number
  items: Array<{ kind: string; text: string; at?: string | null; qid?: string; speaker?: string }>
  files?: Array<{ kind: string; name: string }>
}

function pdfName(session: PdfSession): string {
  const listed = (session.files || []).find((file) => file.kind === 'pdf')?.name
  if (listed) return pdfDownloadName(listed)
  const scene = sceneOf(session)
  const label = scene.charAt(0).toUpperCase() + scene.slice(1)
  const stamp = (session.started_at || '').slice(0, 10) || 'session'
  return pdfDownloadName(`${label}-${stamp}`)
}

function themeOf(session: PdfSession): PdfTheme {
  const scene = sceneOf(session)
  if (scene === 'lecture') return 'lecture'
  if (scene === 'interview') return 'plain'
  return 'meeting'
}

function formatTs(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function historyPdfArgs(session: PdfSession) {
  const scene = sceneOf(session)
  const mode = modeOf(session)
  const title = session.title || `${scene} session`
  const items = session.items || []
  const blocks: PdfBlock[] = [{ kind: 'h1', text: title }]
  const answers = new Map<string, string>()
  const questions: Array<{ id: string; text: string }> = []
  const transcriptByQid = new Map<string, string>()

  items.forEach((item, idx) => {
    const text = (item.text || '').trim()
    if (!text) return
    const id = item.qid || `${session.id}-${idx}`
    if (item.kind === 'answer' || item.kind === 'listen_ask') answers.set(id, text)
    if (item.kind === 'question') questions.push({ id, text })
    if (item.kind === 'transcript') transcriptByQid.set(id, text)
  })

  questions.forEach((q, idx) => {
    blocks.push({ kind: 'h2', text: q.text })
    blocks.push({ kind: 'p', text: answers.get(q.id) || [...answers.values()][idx] || '—' })
  })

  items.forEach((item, idx) => {
    const text = (item.text || '').trim()
    if (!text) return
    const id = item.qid || `${session.id}-${idx}`
    if (item.kind === 'question' || item.kind === 'answer' || item.kind === 'listen_ask') return
    if (item.kind === 'transcript') {
      blocks.push({ kind: 'line', text, ts: item.at ? formatTs(item.at) : '', speaker: item.speaker || '' })
    } else if (item.kind === 'translate') {
      // A translation identical to its transcript line (same qid, same text) is a
      // same-language passthrough — printing a second paragraph would duplicate
      // the transcript line. (Only reachable once translations carry the line's
      // qid; before that, a translate item has its own id and is left as-is.)
      const orig = transcriptByQid.get(id)
      if (orig && sameSpokenLine(orig, text)) return
      blocks.push({ kind: 'p', text })
    } else {
      blocks.push({ kind: 'h2', text: item.kind })
      blocks.push({ kind: 'p', text })
    }
  })

  if (blocks.length === 1) {
    blocks.push({ kind: 'p', text: 'No transcript or answers saved in this session.' })
  }

  const when = session.started_at ? new Date(session.started_at).toLocaleString() : ''
  return {
    title,
    blocks,
    options: {
      theme: themeOf(session),
      subtitle: `${scene} · ${mode}`,
      meta: [when, session.stt_seconds ? `${Math.round(session.stt_seconds / 60)} min` : ''].filter(Boolean),
      filename: pdfName(session),
    },
  }
}

export async function renderHistoryPdf(session: PdfSession): Promise<{ bytes: Uint8Array; name: string }> {
  const { renderPdfFile } = await import('./pdf')
  const args = await historyPdfArgs(session)
  return renderPdfFile(args.title, args.blocks, args.options)
}

export async function downloadHistoryPdf(session: PdfSession): Promise<string> {
  const { downloadPdf } = await import('./pdf')
  const args = await historyPdfArgs(session)
  return downloadPdf(args.title, args.blocks, args.options)
}
