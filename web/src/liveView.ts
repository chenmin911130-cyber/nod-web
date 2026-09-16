import { showLineTranslation } from './iphoneCopy'
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

export type LiveAskStatus = 'pending' | 'done' | 'failed'

export type LiveFeedLine = {
  type: 'line'
  id: string
  ts: string
  speaker: string
  text: string
  at: number
  /** Unfinalized tail from the live partial, rendered inline after ``text``. */
  liveTail?: string
}

export type LiveFeedAsk = {
  type: 'ask'
  id: string
  question: string
  answer: string
  status: LiveAskStatus
  at: number
}

export type LiveFeedItem = LiveFeedLine | LiveFeedAsk

export function askOutcome(input: {
  note: { text: string }
  busy: boolean
  lastError?: string | null
}): LiveAskStatus {
  if ((input.note.text || '').trim()) return 'done'
  if (input.lastError) return 'failed'
  if (input.busy) return 'pending'
  return 'failed'
}

export function isCatchAskCurrent(noteId: string, catchAskId?: string): boolean {
  return noteId === catchAskId || noteId === '__pending__' || noteId.startsWith('__pending__:')
}

function joinLiveFragments(left: string, right: string): string {
  const a = (left || '').trim()
  const b = (right || '').trim()
  if (!a) return b
  if (!b) return a
  if (a.endsWith('-') || b.startsWith('-')) return `${a}${b}`
  return `${a} ${b}`
}

/** Merge consecutive finals from the same speaker into one linear bubble. */
export function mergeLiveSpeakerRuns(items: LiveFeedItem[]): LiveFeedItem[] {
  const out: LiveFeedItem[] = []
  for (const item of items) {
    if (item.type !== 'line') {
      out.push(item)
      continue
    }
    const prev = out[out.length - 1]
    if (prev && prev.type === 'line' && speakerKey(prev.speaker) === speakerKey(item.speaker)) {
      prev.text = joinLiveFragments(prev.text, item.text)
      prev.ts = item.ts || prev.ts
      prev.at = Math.max(prev.at, item.at)
      if (item.liveTail) prev.liveTail = item.liveTail
    } else {
      out.push({ ...item })
    }
  }
  return out
}

export function liveFeed(input: {
  lines: Array<{ id: string; ts: string; speaker?: string; text: string; at?: number }>
  partial: string
  partialSpeaker?: string
  max?: number
  catchNotes?: CatchNote[]
  busy?: boolean
  catchAskId?: string
  lastError?: string | null
  /** Meeting / interview keep one bubble per turn; lecture may linearize same-speaker runs. */
  mergeSameSpeaker?: boolean
}): {
  items: LiveFeedItem[]
  draft: { speaker: string; text: string } | null
} {
  const max = input.max ?? 4
  const lines: LiveFeedLine[] = input.lines.slice(-max).map((line) => ({
    type: 'line',
    id: line.id,
    ts: line.ts,
    speaker: line.speaker || '',
    text: line.text,
    at: line.at ?? 0,
  }))
  const asks: LiveFeedAsk[] = (input.catchNotes || [])
    .filter((note) => note.kind === 'ask')
    .map((note) => {
      const current = isCatchAskCurrent(note.id, input.catchAskId)
      return {
        type: 'ask',
        id: note.id,
        question: note.question || '',
        answer: note.text || '',
        status: askOutcome({
          note,
          busy: Boolean(input.busy && current),
          lastError: current ? input.lastError : null,
        }),
        at: note.at ?? 0,
      }
    })
  const sorted = [...lines, ...asks].sort((a, b) => a.at - b.at)
  const items = input.mergeSameSpeaker === false ? sorted : mergeLiveSpeakerRuns(sorted)
  const text = (input.partial || '').trim()
  if (!text) return { items, draft: null }
  const speaker = input.partialSpeaker || ''
  const last = items[items.length - 1]
  if (last && last.type === 'line' && speakerKey(last.speaker) === speakerKey(speaker)) {
    last.liveTail = text
    return { items, draft: null }
  }
  return { items, draft: { speaker, text } }
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

export type TranscriptGroupLine = {
  id?: string
  ts: string
  text: string
  speaker?: string
  translation?: string
  translateFailed?: boolean
}

export type TranscriptGroup = {
  speaker: string
  startTs: string
  lines: TranscriptGroupLine[]
  draft?: { text: string; speaker: string }
}

function speakerKey(speaker?: string): string {
  return (speaker || '').trim()
}

/** One card per speaker group: join rapid STT fragments into linear text. */
export function mergeGroupDisplayLines(lines: TranscriptGroupLine[]): TranscriptGroupLine[] {
  if (lines.length <= 1) return lines
  const text = lines.map((line) => (line.text || '').trim()).filter(Boolean).join(' ')
  if (!text) return lines
  const last = lines[lines.length - 1]
  return [{ ...lines[0], text, translation: last.translation, translateFailed: last.translateFailed }]
}

/** Join rapid STT fragments within one speaker group into one card. */
export function transcriptDisplayLines(_scene: ListenScene, lines: TranscriptGroupLine[]): TranscriptGroupLine[] {
  return mergeGroupDisplayLines(lines)
}

/** Same-speaker runs merge in Live; speaker changes still start a new bubble. */
export function mergeLiveSpeakerRunsForScene(_scene: ListenScene): boolean {
  return true
}

export function groupTranscript(
  lines: TranscriptGroupLine[],
  partial?: { text?: string; speaker?: string } | null,
): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  for (const line of lines) {
    const speaker = speakerKey(line.speaker)
    const last = groups[groups.length - 1]
    if (last && last.speaker === speaker && !last.draft) {
      last.lines.push(line)
    } else {
      groups.push({ speaker, startTs: line.ts || '', lines: [line] })
    }
  }
  const draftText = (partial?.text || '').trim()
  if (!draftText) return groups
  const speaker = speakerKey(partial?.speaker)
  const last = groups[groups.length - 1]
  const draft = { text: draftText, speaker }
  if (last && last.speaker === speaker) {
    last.draft = draft
    return groups
  }
  groups.push({ speaker, startTs: '', lines: [], draft })
  return groups
}
