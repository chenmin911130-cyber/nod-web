export type WatchHistItem = { id: string; title: string; text: string; failed?: boolean }

export type WatchFace = {
  listening: boolean
  hint: string
  original: string
  translation: string
  previous: string
  history: WatchHistItem[]
  failed: boolean
}

type Pair = { id: string; original: string; translation: string; failed?: boolean }
type Line = { id: string; text: string; translation?: string }
type Turn = { id: string; q: string; a: string; failed?: boolean }

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

export function watchReadingAnchor(input: {
  atLatest: boolean
  newUnit: boolean
  pillShown: boolean
}): { scroll: boolean; pill: boolean } {
  if (input.atLatest) {
    return { scroll: input.newUnit, pill: false }
  }
  if (input.newUnit) return { scroll: false, pill: true }
  return { scroll: false, pill: input.pillShown }
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
  if (input.workspaceMode === 'translate' && lastPair) {
    original = lastPair.original
    translation = lastPair.translation
  } else if (input.workspaceMode === 'interview' && lastTurn) {
    original = lastTurn.q
    translation = lastTurn.a
  } else if (input.workspaceMode !== 'interview' && lastLine) {
    original = lastLine.text
    translation = input.translateOn ? lastLine.translation || '' : ''
  }
  if (listening && input.partial.trim()) {
    if (input.workspaceMode !== 'interview' || !translation.trim()) {
      original = input.partial.trim()
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

  const latestPair = [...input.translatePairs].reverse().find((p) => p.original.trim() || p.translation.trim())
  const failed = input.workspaceMode === 'translate'
    ? latestPair?.failed === true
    : input.workspaceMode === 'interview'
      ? lastTurn?.failed === true
      : false

  const history: WatchHistItem[] = []
  if (input.workspaceMode === 'translate') {
    for (const p of input.translatePairs.slice(-8).reverse()) {
      if (!p.original.trim() && !p.translation.trim()) continue
      history.push({
        id: p.id,
        title: clipWatch(p.original, 40),
        text: clipWatch(p.translation, 280),
        ...(p.failed ? { failed: true } : {}),
      })
    }
  } else if (input.workspaceMode === 'interview') {
    for (const t of (input.turns || []).slice(-8).reverse()) {
      if (!t.q.trim() && !t.a.trim()) continue
      history.push({
        id: t.id,
        title: clipWatch(t.q, 40),
        text: clipWatch(t.a, 280),
        ...(t.failed ? { failed: true } : {}),
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
    history,
    failed,
  }
}
