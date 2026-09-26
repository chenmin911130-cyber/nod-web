import type { MeetingLine, PairLang } from './types'

/** Oldest untranslated line waits this long before the picker switches from newest-first to FIFO. */
export const BACKLOG_MS = 4000

/** Incomplete last line waits this long before auto-translate (no sentence end). */
export const COMPLETE_QUIET_MS = 2500

const SENTENCE_END_RE = /[.!?…。！？](?:["'""''）)]*)?\s*$/u

function isTranslateCandidate(line: MeetingLine, asked: Set<string>): boolean {
  return Boolean(line.text.trim()) && !line.translation && !line.translateFailed && !asked.has(line.id)
}

export function meetingLineComplete(line: MeetingLine, lines: MeetingLine[], nowMs: number): boolean {
  const text = line.text.trim()
  if (!text) return false
  if (SENTENCE_END_RE.test(text)) return true
  const idx = lines.findIndex((ln) => ln.id === line.id)
  if (idx >= 0 && idx < lines.length - 1) return true
  const waitSince = lineTranslationWaitSince(line)
  return nowMs - waitSince >= COMPLETE_QUIET_MS
}

export function lineTranslationWaitSince(line: MeetingLine): number {
  return line.updatedAt ?? line.at ?? 0
}

/** True when an in-flight meeting-line translate should be cancelled on line_update. False when a user Ask is pending (cancel_generate would drop it). */
export function shouldCancelOnExtend(
  lineId: string,
  inflightId: string | null,
  askId: string,
  bindId: string,
  userAskPending: boolean,
): boolean {
  if (userAskPending) return false
  return inflightId === lineId && Boolean(askId) && bindId === lineId
}

/**
 * Pick the next meeting line to translate: the newest line that has no
 * translation, did not give up (translateFailed), and is not already queued
 * (asked). A line whose translation gave up after the retry budget is skipped
 * so we never re-send it in a tight loop against a misbehaving model.
 *
 * When the oldest untranslated line has waited at least {@link BACKLOG_MS} since
 * its last final text / line_update (`updatedAt` or `at`), pick the oldest instead so backlog
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
    if (!meetingLineComplete(line, lines, nowMs)) continue
    const waitSince = lineTranslationWaitSince(line)
    if (waitSince < oldestAt) {
      oldestAt = waitSince
      oldest = line
    }
  }
  if (oldest !== undefined && oldestAt <= nowMs - BACKLOG_MS) return oldest

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (isTranslateCandidate(line, asked) && meetingLineComplete(line, lines, nowMs)) return line
  }
  return undefined
}

/** Ms until an incomplete last-line candidate becomes quiet-complete; null when nothing to wait for. */
export function nextMeetingTranslateWakeMs(
  lines: MeetingLine[],
  asked: Set<string>,
  nowMs = Date.now(),
): number | null {
  if (nextMeetingLineToTranslate(lines, asked, nowMs) !== undefined) return null
  let minWake: number | null = null
  for (const line of lines) {
    if (!isTranslateCandidate(line, asked)) continue
    if (meetingLineComplete(line, lines, nowMs)) continue
    const remaining = COMPLETE_QUIET_MS - (nowMs - lineTranslationWaitSince(line))
    if (remaining <= 0) continue
    if (minWake === null || remaining < minWake) minWake = remaining
  }
  return minWake
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
