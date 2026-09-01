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

/** History search is case-insensitive over title, scene, transcript, and notes. */
export function historySessionMatches(
  session: Pick<HistorySession, 'title' | 'mode' | 'scene' | 'copy_text' | 'started_at'> & {
    items?: Array<{ text?: string }>
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    session.title || '',
    modeOf(session),
    sceneOf(session),
    session.copy_text || '',
    session.started_at || '',
    ...(session.items || []).map((item) => item.text || ''),
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
}

/** Meeting / Lecture can save after Stop or Pause. Live listen and empty sessions do not. */
export function sessionShouldOfferSave(input: {
  workspaceMode: string
  ended: boolean
  kept: boolean
  hasContent: boolean
  listening?: boolean
}): boolean {
  if (input.workspaceMode !== 'meeting' || input.kept || !input.hasContent || input.listening) return false
  return input.ended || !input.listening
}

/** Engine save_prompt only opens the Meeting / Lecture dialog, and never after Keep. */
export function sessionShouldOpenSavePrompt(input: {
  workspaceMode: string
  kept: boolean
}): boolean {
  return input.workspaceMode === 'meeting' && !input.kept
}

/** Save commits the draft to History. Content is always kept; recording is optional. */
export function sessionSaveKeep(opts: { audio?: boolean } = {}): { content: true; audio: boolean } {
  return { content: true, audio: opts.audio !== false }
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
