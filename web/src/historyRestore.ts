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
  elapsedMs: number
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

export type RestoreOffer = {
  id: string
  title: string
  startedAt: string | null
  sttSeconds?: number
}

export type RestoreLaunchSurface = 'none' | 'page'

export const RESTORE_DISMISSED_KEY = 'nod.restoreDismissed'

/**
 * Opening the app never asks Save. A crash leftover (pending, never End / Not now)
 * is laid back onto Listen. End / Not now write the id into dismissedIds so the
 * next launch is a clean Ready.
 */
export function restoreLaunchSurface(input: {
  listening: boolean
  paused: boolean
  hasContent: boolean
  pendingId: string
  dismissedIds: readonly string[]
  workspaceMode?: string
}): RestoreLaunchSurface {
  if (!input.pendingId) return 'none'
  if (input.dismissedIds.includes(input.pendingId)) return 'none'
  if (input.workspaceMode && input.workspaceMode !== 'meeting') return 'none'
  if (restoreShouldNotAsk({
    listening: input.listening,
    paused: input.paused,
    hasContent: input.hasContent,
  })) return 'none'
  return 'page'
}

export function sessionIsUnsaved(session: { kept?: boolean } | null | undefined): boolean {
  return session?.kept === false
}

function historyStartedAtMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

/** Merge saved + pending History, then rank by start time newest-first. Unsaved is a label, not a pin. */
export function mergePendingHistory<T extends { id: string; started_at?: string | null }>(
  saved: T[],
  pending: T[],
): Array<T & { kept: boolean }> {
  const unsaved = pending.filter((row) => row.id).map((row) => ({ ...row, kept: false }))
  const ids = new Set(unsaved.map((row) => row.id))
  const merged = [
    ...unsaved,
    ...saved.filter((row) => !ids.has(row.id)).map((row) => ({
      ...row,
      kept: (row as T & { kept?: boolean }).kept !== false,
    })),
  ]
  return merged
    .map((row, index) => ({ row, index, ms: historyStartedAtMs(row.started_at) }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .map((item) => item.row)
}

export type LocalPhoneCapture = {
  captureId: string
  sessionId: string
  bytes: number
  sealed: boolean
  intent: string
  modifiedAt: string
}

export function localCaptureHistoryId(row: Pick<LocalPhoneCapture, 'captureId' | 'sessionId'>): string {
  return row.sessionId || `local:${row.captureId}`
}

/** Phone-held Watch captures that are not already a History row. Reuses Unsaved. */
export function mergeLocalCaptures<T extends { id: string; started_at?: string | null }>(
  sessions: T[],
  local: LocalPhoneCapture[],
  toRow: (row: LocalPhoneCapture) => T,
): T[] {
  const ids = new Set(sessions.map((s) => s.id))
  const extra = local
    .filter((row) => row.intent !== 'discard' && row.bytes > 0)
    .filter((row) => !ids.has(localCaptureHistoryId(row)))
    .map(toRow)
  if (!extra.length) return sessions
  return mergePendingHistory(sessions, extra)
}

export type NativeSaveJob = {
  sessionId: string
  captureId?: string
  save: string
  error?: string
}

/** Native keep status rides on the History row. Does not hide a phone original. */
export function overlayNativeSaveJobs<T extends { id: string }>(
  sessions: T[],
  jobs: NativeSaveJob[],
): Array<T & { nativeSave?: string; captureId?: string; nativeError?: string }> {
  const byId = new Map(jobs.filter((j) => j.sessionId).map((j) => [j.sessionId, j]))
  return sessions.map((s) => {
    const job = byId.get(s.id)
    if (!job) return s
    return { ...s, nativeSave: job.save, captureId: job.captureId, nativeError: job.error }
  })
}

export function rememberRestoreDismissed(ids: readonly string[], id: string): string[] {
  if (!id || ids.includes(id)) return [...ids]
  return [...ids, id]
}

export function parseRestoreDismissed(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

export function serializeRestoreDismissed(ids: readonly string[]): string {
  return JSON.stringify(ids)
}

export function restoreOfferBody(offer: Pick<RestoreOffer, 'title' | 'startedAt' | 'sttSeconds'>, nowMs = Date.now()): string {
  const title = (offer.title || 'Untitled').trim() || 'Untitled'
  const when = historyRowWhen(offer.startedAt, offer.sttSeconds || 0, nowMs)
  return when ? `${title} · ${when}` : title
}

/** Attached restore must match this usage session; never fall back to another row. */
export function pickAttachedSession<T extends { id: string }>(
  sessions: readonly T[],
  usageSessionId: string,
): T | undefined {
  if (!usageSessionId) return undefined
  return sessions.find((row) => row.id === usageSessionId)
}

export function attachRestoreIsCurrent(startedSeq: number, currentSeq: number): boolean {
  return startedSeq > 0 && startedSeq === currentSeq
}

/**
 * History snapshot is the base (includes lock-screen rows JS never saw).
 * Live rows with a higher rev overlay that id; live-only ids (arrived during the
 * fetch) append so restore cannot wipe new transcripts.
 */
export function mergeAttachedLines(restored: MeetingLine[], live: MeetingLine[]): MeetingLine[] {
  const liveById = new Map(live.map((line) => [line.id, line]))
  const seen = new Set<string>()
  const out: MeetingLine[] = []
  for (const line of restored) {
    const newer = liveById.get(line.id)
    if (newer && (newer.rev ?? 0) > (line.rev ?? 0)) out.push(newer)
    else out.push(line)
    seen.add(line.id)
  }
  for (const line of live) {
    if (seen.has(line.id)) continue
    out.push(line)
    seen.add(line.id)
  }
  return out
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
    elapsedMs: restoreElapsedMs({ lines, sttSeconds: session.stt_seconds }),
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

export function elapsedMsFromTranscriptTs(ts: string): number {
  const parts = (ts || '').trim().split(':')
  if (parts.length === 2 && parts.every((part) => /^\d+$/.test(part))) {
    return (Number(parts[0]) * 60 + Number(parts[1])) * 1000
  }
  if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
    return (Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])) * 1000
  }
  return 0
}

export function restoreElapsedMs(input: { lines: Array<{ ts?: string }>; sttSeconds?: number }): number {
  let fromTs = 0
  for (const line of input.lines) {
    fromTs = Math.max(fromTs, elapsedMsFromTranscriptTs(line.ts || ''))
  }
  const fromStt = Math.max(0, Math.round((input.sttSeconds || 0) * 1000))
  return Math.max(fromTs, fromStt)
}

export function restoreSessionClock(elapsedMs: number, now = Date.now()): {
  meetingStartedAt: number
  meetingEnded: true
  meetingElapsedMs: number
  partial: string
} {
  const ms = Math.max(0, elapsedMs)
  return {
    meetingStartedAt: now - ms,
    meetingEnded: true,
    meetingElapsedMs: ms,
    partial: '',
  }
}

/** Live attach: keep the clock running so lock-screen time is not marked ended. */
export function restoreAttachedClock(elapsedMs: number, now = Date.now()): {
  meetingStartedAt: number
  meetingEnded: false
  meetingElapsedMs: number
  partial: string
} {
  const ms = Math.max(0, elapsedMs)
  return {
    meetingStartedAt: now - ms,
    meetingEnded: false,
    meetingElapsedMs: ms,
    partial: '',
  }
}

/** Which Start branch a restored or ended Meeting takes. Path A and B must agree. */
export function startMeetingKind(s: {
  meetingStartedAt: number | null
  meetingEnded: boolean
  hasContent: boolean
}): 'listen_new' | 'meeting_resume' | 'meeting_clock' {
  if (s.meetingStartedAt == null) return 'listen_new'
  if (s.meetingEnded) return s.hasContent ? 'meeting_resume' : 'listen_new'
  return 'meeting_clock'
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
