export type WatchHistItem = { id: string; title: string; text: string }

export type WatchFace = {
  listening: boolean
  hint: string
  original: string
  translation: string
  previous: string
  /** Row id of the live copy; see `buildWatchFace`. */
  copyId: string
  history: WatchHistItem[]
}

type Pair = { id: string; original: string; translation: string }
type Line = { id: string; text: string; translation?: string }
type Turn = { id: string; q: string; a: string }

export function watchVisibleOriginal(original: string, translation: string): string {
  const src = original.replace(/\s+/g, ' ').trim()
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
  if (input.workspaceMode === 'translate' && lastPair) {
    original = lastPair.original
    translation = lastPair.translation
    copyId = lastPair.id
  } else if (input.workspaceMode === 'interview' && lastTurn) {
    original = lastTurn.q
    translation = lastTurn.a
    copyId = lastTurn.id
  } else if (input.workspaceMode !== 'interview' && lastLine) {
    original = lastLine.text
    translation = input.translateOn ? lastLine.translation || '' : ''
    copyId = lastLine.id
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
    for (const p of input.translatePairs.slice(-8).reverse()) {
      const text = (p.translation || p.original).trim()
      if (!text) continue
      history.push({
        id: p.id,
        title: clipWatch(p.original, 40),
        text: clipWatch(text, 280),
      })
    }
  } else {
    for (const ln of input.meetingLines.slice(-8).reverse()) {
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
    original: clipWatch(original, 800),
    translation: clipWatch(translation, 800),
    previous,
    copyId,
    history,
  }
}
