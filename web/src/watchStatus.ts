export type WatchHistItem = { id: string; title: string; text: string }

export type WatchFace = {
  listening: boolean
  hint: string
  original: string
  translation: string
  previous: string
  /** Row id of the live copy; see `buildWatchFace`. */
  copyId: string
  /** The live copy failed on the phone (model/quota), so the Watch can say so. */
  copyFailed: boolean
  history: WatchHistItem[]
}

/** One page of the live original/translation. WCSession dictionaries are ~65 KB,
 *  so a single frame carries at most this many chars; the live copy itself has no
 *  total cap because it is paged (see `watchLiveCopySegments`) and the Watch joins
 *  the pages back into the whole text. History stays a bounded preview. */
export const WATCH_LIVE_COPY_MAX = 12_000
export const WATCH_HIST_LIMIT = 8

type Pair = { id: string; original: string; translation: string; failed?: boolean }
type Line = { id: string; text: string; translation?: string; translateFailed?: boolean }
type Turn = { id: string; q: string; a: string }

export function watchKeepParagraphs(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

export function watchVisibleOriginal(original: string, translation: string): string {
  const src = watchKeepParagraphs(original)
  const dst = watchVisibleTranslation(translation)
  if (!src || !dst) return src
  if (src.toLowerCase() === dst.toLowerCase()) return ''
  return src
}

export function watchVisibleTranslation(text: string): string {
  const raw = text.replace(/[ \t]+/g, ' ').trim()
  if (!raw) return ''
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 2 && lines[0].toLowerCase() === lines[1].toLowerCase()) return lines[0]
  return raw
}

/** One muted line: the finished sentence before the current one. */
export function watchPreviousCaption(pairs: Pair[]): string {
  const done = pairs.filter((p) => (p.translation || p.original).trim())
  if (done.length < 2) return ''
  const prev = done[done.length - 2]
  const current = done[done.length - 1]
  const line = watchVisibleTranslation(prev.translation) || prev.original.replace(/\s+/g, ' ').trim()
  const now = watchVisibleTranslation(current.translation) || current.original.replace(/\s+/g, ' ').trim()
  if (!line || line.toLowerCase() === now.toLowerCase()) return ''
  return line
}

export function clipWatch(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(1, max - 1))}…`
}

/** Sentence / line boundaries used when one paragraph alone exceeds a page. */
const COPY_BREAK_RE = /[^。！？!?；;\n]*[。！？!?；;\n]+|[^。！？!?；;\n]+$/g

/** Split an atomic unit that is still too long, never inside a code point. */
function copyHardSplit(unit: string, max: number): string[] {
  const out: string[] = []
  let current = ''
  for (const char of unit) {
    if (current.length + char.length > max) {
      out.push(current)
      current = ''
    }
    current += char
  }
  if (current) out.push(current)
  return out
}

/** Pieces that each fit `max` and whose concatenation is exactly `text`. */
function copyPieces(text: string, max: number): string[] {
  const pieces: string[] = []
  const paragraphs = text.split('\n\n')
  paragraphs.forEach((paragraph, index) => {
    // Keep the blank line with the paragraph it follows so join() is lossless.
    const unit = index === paragraphs.length - 1 ? paragraph : `${paragraph}\n\n`
    if (unit.length <= max) {
      pieces.push(unit)
      return
    }
    const sentences = unit.match(COPY_BREAK_RE)
    for (const sentence of sentences ?? [unit]) {
      if (sentence.length <= max) pieces.push(sentence)
      else pieces.push(...copyHardSplit(sentence, max))
    }
  })
  return pieces
}

/**
 * Page the live Watch copy. Every page fits `max` and the pages re-join to
 * exactly `watchKeepParagraphs(text)` — nothing is dropped and no ellipsis is
 * added, so the Watch can read a copy of any length. Empty text yields no page.
 */
export function watchLiveCopySegments(text: string, max = WATCH_LIVE_COPY_MAX): string[] {
  const cap = Math.max(1, Math.floor(max))
  const normalized = watchKeepParagraphs(text)
  if (!normalized) return []
  const segments: string[] = []
  let current = ''
  for (const piece of copyPieces(normalized, cap)) {
    if (current && current.length + piece.length > cap) {
      segments.push(current)
      current = ''
    }
    current += piece
  }
  if (current) segments.push(current)
  return segments
}

export function buildWatchFace(input: {
  capture: string
  consentOpen: boolean
  notesAskId: string
  notesRaw: string
  partial: string
  workspaceMode: string
  translateOn: boolean
  translatePairs: Pair[]
  meetingLines: Line[]
  turns?: Turn[]
}): WatchFace {
  // ADR 0001: listening comes from capture, not run. run pulses to 'think'
  // while the engine transcribes/generates a chunk; a live session keeps
  // capture='listening', so the Watch never treats a generating model as
  // "Phone Stop". Only capture='off' (or 'paused') leaves the live UI.
  const listening = input.capture === 'listening' || input.capture === 'recording'
  const lastPair = [...input.translatePairs].reverse().find((p) => p.original.trim())
  const lastTurn = [...(input.turns || [])].reverse().find((t) => t.q.trim() || t.a.trim())
  const lastLine = [...input.meetingLines].reverse().find((ln) => ln.text.trim())

  let original = ''
  let translation = ''
  // Identity of the row the live face shows (#219). The native bridge uses it to
  // tell "same copy, same version" (keep the longer text) apart from "new
  // sentence / New / switch mode at the same version" (replace).
  let copyId = ''
  let copyFailed = false
  if (input.workspaceMode === 'translate' && lastPair) {
    original = lastPair.original
    translation = lastPair.translation
    copyId = lastPair.id
    copyId = lastPair.id
    copyFailed = Boolean(lastPair.failed)
  } else if (input.workspaceMode === 'interview' && lastTurn) {
    original = lastTurn.q
    translation = lastTurn.a
    copyId = lastTurn.id
  } else if (input.workspaceMode !== 'interview' && lastLine) {
    original = lastLine.text
    translation = input.translateOn ? lastLine.translation || '' : ''
    copyId = lastLine.id
    copyId = lastLine.id
    copyFailed = Boolean(lastLine.translateFailed)
  }
  if (listening && input.partial.trim()) {
    if (input.workspaceMode !== 'interview' || !translation.trim()) {
      original = input.partial.trim()
      if (!copyId) copyId = 'partial'
    }
  }
  translation = watchVisibleTranslation(translation)
  original = watchVisibleOriginal(original, translation)

  let hint = 'Ready'
  if (input.consentOpen) hint = 'Confirm on iPhone'
  else if (listening) hint = translation.trim() || original.trim() || 'Watch mic'
  else if (input.notesAskId) hint = 'Writing report on iPhone'
  else if (input.notesRaw.trim()) hint = 'Open iPhone to read the report'
  else if (translation.trim()) hint = 'Translated'

  const history: WatchHistItem[] = []
  if (input.workspaceMode === 'translate') {
    for (const p of input.translatePairs.slice(-WATCH_HIST_LIMIT).reverse()) {
      const text = (p.translation || p.original).trim()
      if (!text) continue
      history.push({
        id: p.id,
        title: clipWatch(p.original, 40),
        text: clipWatch(text, 280),
      })
    }
  } else {
    for (const ln of input.meetingLines.slice(-WATCH_HIST_LIMIT).reverse()) {
      const text = (input.translateOn && ln.translation ? ln.translation : ln.text).trim()
      if (!text) continue
      history.push({
        id: ln.id,
        title: clipWatch(ln.text, 40),
        text: clipWatch(text, 280),
      })
    }
  }

  const previousPairs = input.workspaceMode === 'interview'
    ? (input.turns || []).map((t) => ({ id: t.id, original: t.q, translation: t.a }))
    : input.workspaceMode === 'translate'
      ? input.translatePairs
      : []
  const previous = clipWatch(watchPreviousCaption(previousPairs), 72)

  return {
    listening,
    hint: clipWatch(hint, 140),
    // The live copy is returned whole: `pushWatchStatus` pages it for the Watch.
    original: watchKeepParagraphs(original),
    translation: watchKeepParagraphs(translation),
    previous,
    copyId,
    copyFailed,
    history,
  }
}
