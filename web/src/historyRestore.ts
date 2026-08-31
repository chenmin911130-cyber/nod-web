import type { HistoryItem, HistorySession } from './components/HistoryPane'
import type { ListenScene } from './listen'
import type { MeetingLine, TranslatePair, Turn, WorkspaceMode } from './types'

export type RestorePayload = {
  mode: WorkspaceMode
  scene: ListenScene
  lines: MeetingLine[]
  turns: Turn[]
  notes: string
  summary: string
  pairs: TranslatePair[]
}

export function sceneOf(session: Pick<HistorySession, 'mode' | 'scene'>): ListenScene {
  const scene = (session.scene || '').toLowerCase()
  if (scene === 'lecture' || scene === 'interview' || scene === 'meeting') return scene
  if (session.mode === 'interview') return 'interview'
  return 'meeting'
}

export function modeOf(session: Pick<HistorySession, 'mode' | 'scene'>): WorkspaceMode {
  if (session.mode === 'translate') return 'translate'
  if (session.mode === 'interview' || sceneOf(session) === 'interview') return 'interview'
  return 'meeting'
}

export function restoreFromSession(session: HistorySession): RestorePayload {
  const scene = sceneOf(session)
  const mode = modeOf(session)
  const items = session.items || []
  const lines: MeetingLine[] = []
  const answers = new Map<string, string>()
  const questions: Array<{ id: string; q: string }> = []
  const notes: string[] = []
  const summaries: string[] = []
  const originals: Array<{ id: string; text: string; ts: string }> = []
  const translations: string[] = []

  items.forEach((item, i) => {
    const text = (item.text || '').trim()
    if (!text) return
    const id = item.qid || `${session.id}-${i}`
    if (item.kind === 'transcript') {
      lines.push({ id, ts: formatItemTs(item, lines.length), text, at: Date.parse(item.at || '') || Date.now() })
      originals.push({ id, text, ts: formatItemTs(item, originals.length) })
    } else if (item.kind === 'question') {
      questions.push({ id, q: text })
    } else if (item.kind === 'answer' || item.kind === 'listen_ask') {
      answers.set(id, text)
    } else if (item.kind === 'notes') {
      notes.push(text)
    } else if (item.kind === 'summary') {
      summaries.push(text)
    } else if (item.kind === 'translate') {
      translations.push(text)
    }
  })

  const turns: Turn[] = questions.map((q, i) => ({
    id: q.id,
    q: q.q,
    a: answers.get(q.id) || [...answers.values()][i] || '',
  }))

  const pairs: TranslatePair[] = originals.map((row, i) => ({
    id: row.id,
    ts: row.ts,
    original: row.text,
    translation: translations[i] || '',
  }))

  return {
    mode,
    scene,
    lines,
    turns,
    notes: notes.join('\n\n'),
    summary: summaries.join('\n\n'),
    pairs,
  }
}

function formatItemTs(item: HistoryItem | undefined, index: number) {
  if (item?.at) {
    const d = new Date(item.at)
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
  }
  return `${String(index + 1).padStart(2, '0')}:00`
}

export async function copyText(text: string): Promise<boolean> {
  const body = (text || '').trim()
  if (!body) return false
  try {
    window.focus()
    await navigator.clipboard.writeText(body)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = body
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '0'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.focus()
      el.select()
      const ok = document.execCommand('copy')
      el.remove()
      return ok
    } catch {
      return false
    }
  }
}
