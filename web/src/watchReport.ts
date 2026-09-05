/** Last Watch report so unlocking the iPhone can reopen Notes after a WebView kill. */

import { capTranscript } from './listen'

export const WATCH_REPORT_KEY = 'nod_watch_report'
export const WATCH_REPORT_SNAP_KEY = 'nod_watch_report_snap'
export const WATCH_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type WatchReportMark = { at: number }

export type WatchReportLine = {
  id: string
  ts: string
  text: string
  speaker?: string
  at?: number
}

export type WatchReportSnapshot = {
  at: number
  mode: 'meeting'
  scene: 'meeting' | 'lecture'
  notes: string
  lines: WatchReportLine[]
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / private mode */
  }
}

export function isFreshWatchReport(at: number, now = Date.now()): boolean {
  return Number.isFinite(at) && now - at >= 0 && now - at <= WATCH_REPORT_MAX_AGE_MS
}

export function isWatchReportScene(scene: string, mode: string): boolean {
  if (mode === 'translate' || mode === 'interview') return false
  const next = (scene || '').toLowerCase()
  return next === 'meeting' || next === 'lecture' || next === ''
}

export function markWatchReport(now = Date.now()): WatchReportMark {
  const mark = { at: now }
  writeJson(WATCH_REPORT_KEY, mark)
  return mark
}

export function readWatchReport(now = Date.now()): WatchReportMark | null {
  const mark = readJson<WatchReportMark>(WATCH_REPORT_KEY)
  if (!mark || typeof mark.at !== 'number' || !isFreshWatchReport(mark.at, now)) {
    if (mark) clearWatchReport()
    return null
  }
  return mark
}

export function clearWatchReport(): void {
  try {
    localStorage.removeItem(WATCH_REPORT_KEY)
    localStorage.removeItem(WATCH_REPORT_SNAP_KEY)
  } catch {
    /* ignore */
  }
}

export function snapshotFromWorkspace(input: {
  at?: number
  mode: string
  scene: string
  notes: string
  lines: WatchReportLine[]
}): WatchReportSnapshot | null {
  if (!isWatchReportScene(input.scene, input.mode)) return null
  const scene = input.scene === 'lecture' ? 'lecture' : 'meeting'
  return {
    at: input.at ?? Date.now(),
    mode: 'meeting',
    scene,
    notes: input.notes,
    lines: capTranscript(input.lines).lines.map((ln) => ({
      id: ln.id,
      ts: ln.ts,
      text: ln.text,
      speaker: ln.speaker || '',
      at: ln.at,
    })),
  }
}

export function writeWatchReportSnapshot(snap: WatchReportSnapshot): void {
  writeJson(WATCH_REPORT_SNAP_KEY, snap)
}

export function readWatchReportSnapshot(now = Date.now()): WatchReportSnapshot | null {
  const snap = readJson<WatchReportSnapshot>(WATCH_REPORT_SNAP_KEY)
  if (!snap || typeof snap.at !== 'number' || !isFreshWatchReport(snap.at, now)) return null
  if (!isWatchReportScene(snap.scene, snap.mode)) return null
  if (!Array.isArray(snap.lines)) return null
  return snap
}

export function shouldRestoreWatchReport(opts: {
  mark: WatchReportMark | null
  listening: boolean
  busy: boolean
  hasWorkspace: boolean
}): boolean {
  if (!opts.mark) return false
  if (opts.listening || opts.busy || opts.hasWorkspace) return false
  return true
}

export function pickWatchReportSession<T extends { mode: string; scene?: string }>(sessions: T[]): T | null {
  for (const session of sessions) {
    if (!isWatchReportScene(session.scene || '', session.mode)) continue
    return session
  }
  return null
}

export function snapshotToHistoryItems(snap: WatchReportSnapshot): Array<{ kind: string; text: string; at?: string | null }> {
  const items = snap.lines.map((ln) => ({
    kind: 'transcript',
    text: ln.text,
    at: typeof ln.at === 'number' && ln.at > 0 ? new Date(ln.at).toISOString() : null,
  }))
  if (snap.notes.trim()) items.push({ kind: 'notes', text: snap.notes, at: null })
  return items
}
