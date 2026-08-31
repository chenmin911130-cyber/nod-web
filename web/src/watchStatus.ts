export type WatchHistItem = { id: string; title: string; text: string }

export type WatchFace = {
  listening: boolean
  hint: string
  original: string
  translation: string
  history: WatchHistItem[]
}

type Pair = { id: string; original: string; translation: string }
type Line = { id: string; text: string; translation?: string }

export function clipWatch(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(1, max - 1))}…`
}

export function buildWatchFace(input: {
  run: string
  consentOpen: boolean
  notesAskId: string
  notesRaw: string
  partial: string
  workspaceMode: string
  translateOn: boolean
  translatePairs: Pair[]
  meetingLines: Line[]
}): WatchFace {
  const listening = input.run === 'listen' || input.run === 'record'
  const lastPair = [...input.translatePairs].reverse().find((p) => p.original.trim())
  const lastLine = [...input.meetingLines].reverse().find((ln) => ln.text.trim())

  let original = ''
  let translation = ''
  if (input.workspaceMode === 'translate' && lastPair) {
    original = lastPair.original
    translation = lastPair.translation
  } else if (lastLine) {
    original = lastLine.text
    translation = input.translateOn ? lastLine.translation || '' : ''
  }
  if (listening && input.partial.trim()) original = input.partial.trim()

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

  return {
    listening,
    hint: clipWatch(hint, 140),
    original: clipWatch(original, 400),
    translation: clipWatch(translation, 400),
    history,
  }
}
