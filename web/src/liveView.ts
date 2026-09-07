import { sameSpokenLine, showLineTranslation } from './iphoneCopy'
import type { CatchNote } from './types'
import {
  resolveSpeakerName,
  sectionTitle,
  sceneSectionOrder,
  type ListenScene,
  type NotesDoc,
  type NotesSectionId,
} from './listen'

export const LIVE_MIC_HOLD_MS = 2500

export function liveStageMode(input: {
  listening: boolean
  elapsedMs: number
  hasHeardText: boolean
}): 'mic' | 'content' {
  if (input.hasHeardText) return 'content'
  if (input.listening && input.elapsedMs >= LIVE_MIC_HOLD_MS) return 'content'
  return 'mic'
}

export function liveHeardLines(input: {
  lines: Array<{ text: string }>
  partial: string
}): { headline: string; previous: string } {
  const partial = (input.partial || '').trim()
  const finalized = input.lines.map((line) => line.text.trim()).filter(Boolean)
  if (partial) {
    return { headline: partial, previous: finalized[finalized.length - 1] || '' }
  }
  return {
    headline: finalized[finalized.length - 1] || '',
    previous: finalized[finalized.length - 2] || '',
  }
}

export function liveNotesLine(input: {
  lines: Array<{ text: string; translation?: string }>
  partial: string
  translateOn: boolean
}): string {
  if (!input.translateOn) return ''
  if ((input.partial || '').trim()) return ''
  const last = [...input.lines].reverse().find((line) => line.text.trim())
  if (!last) return ''
  const notes = (last.translation || '').replace(/\s+/g, ' ').trim()
  if (!notes || sameSpokenLine(last.text, notes)) return ''
  // If structured Notes JSON leaked into a line's translation, don't show it as
  // the live notes line.
  if (/^[\[{]/.test(notes) || notes.includes('"summary"')) return ''
  return notes
}

export function formatActionItem(row: { text: string; owner?: string }): string {
  const text = row.text.trim()
  const owner = (row.owner || '').trim()
  return owner ? `${owner} \u2192 ${text}` : text
}

export function iphoneSummaryHeading(scene: ListenScene, id: NotesSectionId): string {
  // One heading source: SECTION_TITLE (lecture keeps its own override inside
  // sectionTitle). No scene-specific renames here.
  return sectionTitle(scene, id)
}

export function summaryPlainText(input: {
  scene: ListenScene
  notes: NotesDoc
  catchNotes?: CatchNote[]
}): string {
  const blocks: string[] = []
  const order: NotesSectionId[] = sceneSectionOrder(input.scene)
  for (const id of order) {
    if (id === 'summary') {
      const summary = input.notes.summary.trim()
      if (!summary) continue
      blocks.push(`${iphoneSummaryHeading(input.scene, id)}\n${summary}`)
      continue
    }
    if (id === 'actionItems') {
      const rows = input.notes.actionItems
        .map((row) => formatActionItem(row))
        .filter(Boolean)
      if (!rows.length) continue
      blocks.push(`${iphoneSummaryHeading(input.scene, id)}\n${rows.map((row) => `\u2022 ${row}`).join('\n')}`)
      continue
    }
    const items = input.notes[id]
    if (!Array.isArray(items) || !items.length) continue
    blocks.push(`${iphoneSummaryHeading(input.scene, id)}\n${items.map((item) => `\u2022 ${item}`).join('\n')}`)
  }
  for (const note of input.catchNotes || []) {
    const text = (note.text || '').trim()
    if (!text) continue
    blocks.push(`${note.kind === 'ask' ? 'Ask' : note.title}\n${text}`)
  }
  return blocks.join('\n\n')
}

function transcriptStamp(ts: string): string {
  const raw = (ts || '').trim()
  const parts = raw.split(':')
  if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
    const totalM = Number(parts[0]) * 60 + Number(parts[1])
    return `[${String(totalM).padStart(2, '0')}:${parts[2].padStart(2, '0')}]`
  }
  if (parts.length === 2 && parts.every((part) => /^\d+$/.test(part))) {
    return `[${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}]`
  }
  return raw ? `[${raw}]` : '[00:00]'
}

export function transcriptPlainText(input: {
  lines: Array<{ ts: string; text: string; speaker?: string; translation?: string }>
  speakerNames: Record<string, string>
  translateOn: boolean
}): string {
  return input.lines
    .map((line) => {
      const who = resolveSpeakerName(input.speakerNames, line.speaker)
      const head = who
        ? `${transcriptStamp(line.ts)} ${who}: ${line.text}`
        : `${transcriptStamp(line.ts)} ${line.text}`
      const showTr = showLineTranslation({
        translateOn: input.translateOn,
        original: line.text,
        translation: line.translation || '',
        native: true,
      })
      const tr = (line.translation || '').trim()
      return showTr && tr ? `${head}\n    ${tr}` : head
    })
    .join('\n')
}
