import type { MeetingLine } from './types'

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
