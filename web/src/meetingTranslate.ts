import type { MeetingLine, PairLang } from './types'

/** Oldest untranslated line waits this long before the picker switches from newest-first to FIFO. */
export const BACKLOG_MS = 4000

function isTranslateCandidate(line: MeetingLine, asked: Set<string>): boolean {
  return !line.translation && !line.translateFailed && !asked.has(line.id)
}

/**
 * Pick the next meeting line to translate: the newest line that has no
 * translation, did not give up (translateFailed), and is not already queued
 * (asked). A line whose translation gave up after the retry budget is skipped
 * so we never re-send it in a tight loop against a misbehaving model.
 *
 * When the oldest untranslated line has waited at least {@link BACKLOG_MS} since
 * its last final text / line_update (`at`), pick the oldest instead so backlog
 * does not starve older lines.
 */
export function nextMeetingLineToTranslate(
  lines: MeetingLine[],
  asked: Set<string>,
  nowMs = Date.now(),
): MeetingLine | undefined {
  let oldest: MeetingLine | undefined
  let oldestAt = Infinity
  for (const line of lines) {
    if (!isTranslateCandidate(line, asked)) continue
    const at = line.at ?? 0
    if (at < oldestAt) {
      oldestAt = at
      oldest = line
    }
  }
  if (oldest !== undefined && oldestAt <= nowMs - BACKLOG_MS) return oldest

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (isTranslateCandidate(line, asked)) return line
  }
  return undefined
}

/**
 * A meeting line that gave up (translateFailed) becomes retryable when the
 * translation target changes — reset the give-up flag (its translation stays
 * empty) so pump re-picks it under the new target. Same target leaves the lines
 * untouched. The caller clears the asked/retry refs so the line is not skipped
 * as already-queued.
 */
export function meetingLinesAfterTargetChange(lines: MeetingLine[], prevLang: PairLang, lang: PairLang): MeetingLine[] {
  if (lang === prevLang) return lines
  return lines.map((ln) => (ln.translateFailed ? { ...ln, translateFailed: false } : ln))
}

/** notes_translate_to reducer: reset give-up flags while live; after End, leave lines alone. */
export function applyNotesTranslateTo(
  lines: MeetingLine[],
  prevLang: PairLang,
  lang: PairLang,
  meetingEnded: boolean,
): MeetingLine[] {
  if (lang === prevLang || meetingEnded) return lines
  return meetingLinesAfterTargetChange(lines, prevLang, lang)
}
