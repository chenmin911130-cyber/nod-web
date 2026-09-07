import type { MeetingLine, PairLang } from './types'

/**
 * Pick the next meeting line to translate: the newest line that has no
 * translation, did not give up (translateFailed), and is not already queued
 * (asked). A line whose translation gave up after the retry budget is skipped
 * so we never re-send it in a tight loop against a misbehaving model.
 */
export function nextMeetingLineToTranslate(lines: MeetingLine[], asked: Set<string>): MeetingLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.translation && !line.translateFailed && !asked.has(line.id)) return line
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
