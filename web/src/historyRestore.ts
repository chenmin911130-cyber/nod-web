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

/** Meeting / Lecture can save after Stop. Pause, live listen, and empty sessions do not. */
export function sessionShouldOfferSave(input: {
  workspaceMode: string
  ended: boolean
  kept: boolean
  hasContent: boolean
  listening?: boolean
  paused?: boolean
}): boolean {
  if (input.workspaceMode !== 'meeting' || input.kept || !input.hasContent || input.listening || input.paused) return false
  return input.ended || !input.listening
}

/** Engine save_prompt only opens the Meeting / Lecture dialog, never after Keep or Pause. */
export function sessionShouldOpenSavePrompt(input: {
  workspaceMode: string
  kept: boolean
  paused?: boolean
}): boolean {
  return input.workspaceMode === 'meeting' && !input.kept && !input.paused
}

/**
 * Whether a history_kept ack should flip the CURRENT session's kept flag.
 *
 * A keep of a *restored* (previously disconnected) session by id resolves to
 * that OLD session, not the live one — its ack must not mark the live session
 * kept, or the live session's own Save prompt on Stop is suppressed.
 */
export function shouldMarkKeptOnAck(ackId: string | null | undefined, restoredKeepId: string | null): boolean {
  if (restoredKeepId && ackId === restoredKeepId) return false
  return true
}

/** Save commits the draft to History. Content is always kept; recording is optional. */
export function sessionSaveKeep(opts: { audio?: boolean } = {}): { content: true; audio: boolean } {
  return { content: true, audio: opts.audio !== false }
}

/**
 * #36 rule 1/3: the Save UI must appear at most ONCE per live session. `offered`
 * is true once this session generation has already shown the Save dialog (via a
 * Stop offer, a reconnect Restore, or a New-session leave). Auto-offers are gated
 * on it so the same session is never re-prompted; a user-initiated Save (retry
 * after a failed keep, or an explicit click) bypasses it.
 */
export function shouldOfferSaveOnce(input: {
  workspaceMode: string
  ended: boolean
  kept: boolean
  hasContent: boolean
  offered: boolean
  listening?: boolean
  paused?: boolean
}): boolean {
  if (input.offered) return false
  return sessionShouldOfferSave({
    workspaceMode: input.workspaceMode,
    ended: input.ended,
    kept: input.kept,
    hasContent: input.hasContent,
    listening: input.listening,
    paused: input.paused,
  })
}

/**
 * #36 rule 4: a reconnect must not re-prompt the SAME unsaved (pending) session
 * twice. `seen` holds the pending ids already offered; a repeat id → false. The
 * id is recorded the first time it is offered.
 */
export function restoreIdOfferable(seen: Set<string>, id: string): boolean {
  if (!id || seen.has(id)) return false
  seen.add(id)
  return true
}

/**
 * #36 rule 4/5: do not surface a Restore while the user is listening, paused, or
 * the current page already carries content — the reconnect is not interrupting a
 * fresh view.
 */
export function restoreShouldNotAsk(input: { listening: boolean; paused: boolean; hasContent: boolean }): boolean {
  return input.listening || input.paused || input.hasContent
}

export function restoreFromSession(session: HistorySession): RestorePayload {
  const scene = sceneOf(session)
  const mode = modeOf(session)
  const items = session.items || []
  const lines: MeetingLine[] = []
  // transcript qid -> index into `lines`, so a meeting-line translation can be
  // hung on its source line (issue #31 §3.2) instead of a sequential pairs slot.
  const lineByQid = new Map<string, number>()
  const matchedTranslations: Array<{ qid: string; text: string }> = []
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
      const idx = lines.length
      lines.push({ id, ts: formatItemTs(item, session.started_at, lines.length), text, at: Date.parse(item.at || '') || Date.now(), speaker: item.speaker || '' })
      lineByQid.set(id, idx)
      originals.push({ id, text, ts: formatItemTs(item, session.started_at, originals.length) })
    } else if (item.kind === 'question') {
      questions.push({ id, q: text })
    } else if (item.kind === 'answer' || item.kind === 'listen_ask') {
      answers.set(id, text)
    } else if (item.kind === 'notes') {
      notes.push(text)
    } else if (item.kind === 'summary') {
      summaries.push(text)
    } else if (item.kind === 'translate') {
      // A meeting/lecture translation whose qid matches a transcript line hangs
      // on that line. Translate-mode rows (and unmatched/legacy rows) keep the
      // sequential pairing that feeds TranslatePairs.
      if (mode !== 'translate' && item.qid && lineByQid.has(item.qid)) {
        matchedTranslations.push({ qid: item.qid, text })
      } else {
        translations.push(text)
      }
    }
  })

  // Hang matched translations on their lines (applied after the loop in case a
  // translate row precedes its transcript row).
  for (const { qid, text } of matchedTranslations) {
    const idx = lineByQid.get(qid)
    if (idx !== undefined) {
      lines[idx] = { ...lines[idx], translation: text }
    }
  }

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

function formatItemTs(item: HistoryItem | undefined, startedAt: string | null, index: number) {
  const start = startedAt ? Date.parse(startedAt) : NaN
  const t = item?.at ? Date.parse(item.at) : NaN
  if (Number.isFinite(start) && Number.isFinite(t)) {
    // Elapsed time since the session started — matches live captions (mm:ss).
    const sec = Math.max(0, Math.floor((t - start) / 1000))
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  // No session-start anchor: fall back to the wall clock (or the index).
  if (item?.at) {
    const d = new Date(item.at)
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
  }
  return `${String(index + 1).padStart(2, '0')}:00`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clock12(ms: number): string {
  const d = new Date(ms)
  const ap = d.getHours() >= 12 ? 'PM' : 'AM'
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`
}

export function historyDayLabel(startedAt: string | null, nowMs = Date.now()): string {
  const t = startedAt ? Date.parse(startedAt) : NaN
  if (!Number.isFinite(t)) return 'Earlier'
  const day = localDayKey(t)
  if (day === localDayKey(nowMs)) return 'Today'
  const yest = new Date(nowMs)
  yest.setDate(yest.getDate() - 1)
  if (day === localDayKey(yest.getTime())) return 'Yesterday'
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

export function historyRowWhen(startedAt: string | null, sttSeconds: number, nowMs = Date.now()): string {
  const dur = `${Math.max(0, Math.round(sttSeconds / 60))}m`
  const day = historyDayLabel(startedAt, nowMs)
  const t = startedAt ? Date.parse(startedAt) : NaN
  if (day === 'Today' || day === 'Yesterday') return `${day}, ${clock12(t)} • ${dur}`
  if (day === 'Earlier') return dur
  return `${day} • ${dur}`
}

export function groupHistoryByDay<T extends { started_at: string | null }>(
  sessions: T[],
  nowMs = Date.now(),
): Array<{ label: string; sessions: T[] }> {
  const groups = new Map<string, T[]>()
  const order: string[] = []
  for (const session of sessions) {
    const label = historyDayLabel(session.started_at, nowMs)
    if (!groups.has(label)) {
      groups.set(label, [])
      order.push(label)
    }
    groups.get(label)!.push(session)
  }
  return order.map((label) => ({ label, sessions: groups.get(label)! }))
}

export function sessionHasAudio(session: Pick<HistorySession, 'files'>): boolean {
  return (session.files || []).some((file) => file.kind === 'audio')
}

export function resumeResetsKept(input: { kept: boolean; hasContent: boolean }): boolean {
  return input.kept && input.hasContent
}

export function applyMeetingResume<T extends {
  meetingEnded: boolean
  meetingStartedAt: number | null
  meetingElapsedMs: number
}>(state: T, now = Date.now()): T {
  return {
    ...state,
    meetingEnded: false,
    meetingStartedAt: now - state.meetingElapsedMs,
  }
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
