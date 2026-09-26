import type { MeetingLine, PairLang } from './types'

/**
 * Apply a server `line_update` (a continuation of an open meeting line): replace
 * the line's text, refresh lang/speaker, CLEAR its translation + give-up flag (the
 * source changed, so any half-sentence translation is stale) and bump rev. `ts` is
 * kept (the first fragment's timestamp). An unknown id is ignored, so a stale
 * event after clear / workspace switch never resurrects a line.
 */
export function applyLineUpdate(
  lines: MeetingLine[],
  id: string,
  text: string,
  lang?: string,
  speaker?: string,
  rev = 0,
  at?: number,
): MeetingLine[] {
  const touchedAt = at ?? Date.now()
  return lines.map((ln) =>
    ln.id === id
      ? {
          ...ln,
          text,
          lang: (lang as PairLang) || ln.lang,
          speaker: speaker !== undefined ? speaker : ln.speaker,
          translation: '',
          translateFailed: false,
          rev,
          at: touchedAt,
        }
      : ln,
  )
}

/**
 * Apply a translate stream chunk to a meeting line ONLY when the line id matches
 * the bind AND its rev matches the rev recorded when the ask was sent. A chunk
 * that arrives after a `line_update` (rev bumped) is stale and must not land on
 * the extended line (which is waiting for a fresh translation). No bind-line-id
 * fallback (the old `findIndex !translation` guess) — a stale chunk from a
 * previous ask could otherwise write into the wrong, just-cleared row.
 */
export function applyLineTranslationRev(
  lines: MeetingLine[],
  bindId: string,
  bindRev: number,
  chunk: string,
): MeetingLine[] {
  if (!bindId || !chunk) return lines
  const idx = lines.findIndex((line) => line.id === bindId && (line.rev ?? 0) === bindRev)
  if (idx < 0) return lines
  const next = lines.slice()
  next[idx] = { ...next[idx], translation: (next[idx].translation || '') + chunk }
  return next
}

/**
 * A `done` is stale when the meeting line it was answering has since been
 * extended (rev bumped): the old translation no longer applies. This drives the
 * reducer to clear + re-ask instead of accepting a half-sentence translation.
 */
export function staleTranslateDone(bindId: string, bindRev: number, line?: MeetingLine): boolean {
  return Boolean(line) && line!.id === bindId && (line!.rev ?? 0) !== bindRev
}
