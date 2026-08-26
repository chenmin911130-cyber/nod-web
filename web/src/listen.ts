import type { MeetingLine, PairLang } from './types'
import { TRANSLATE_LANGS } from './types'

function langName(lang: PairLang): string {
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name ?? 'Chinese'
}

export type ListenScene = 'meeting' | 'lecture' | 'interview'

export type NotesSectionId =
  | 'summary'
  | 'takeaways'
  | 'keyPoints'
  | 'decisions'
  | 'actionItems'
  | 'importantDetails'
  | 'followUps'
  | 'revisionNotes'

export type NotesDoc = {
  summary: string
  takeaways: string[]
  keyPoints: string[]
  decisions: string[]
  actionItems: Array<{ text: string; owner?: string }>
  importantDetails: string[]
  followUps: string[]
  revisionNotes: string[]
}

export const LISTEN_SCENES: Array<{ id: ListenScene; label: string }> = [
  { id: 'meeting', label: 'Meeting' },
  { id: 'lecture', label: 'Lecture' },
  { id: 'interview', label: 'Interview' },
]

const SCENE_SECTIONS: Record<ListenScene, NotesSectionId[]> = {
  meeting: ['summary', 'keyPoints', 'decisions', 'actionItems', 'importantDetails', 'followUps'],
  lecture: ['summary', 'keyPoints', 'importantDetails', 'revisionNotes', 'followUps'],
  interview: ['summary', 'takeaways', 'keyPoints', 'importantDetails', 'followUps'],
}

export const SECTION_TITLE: Record<NotesSectionId, string> = {
  summary: 'Summary',
  takeaways: 'Q&A / Key Takeaways',
  keyPoints: 'Key Points',
  decisions: 'Decisions',
  actionItems: 'Action Items',
  importantDetails: 'Important Details',
  followUps: 'Follow-ups',
  revisionNotes: 'Revision Notes',
}

const LECTURE_TITLE: Partial<Record<NotesSectionId, string>> = {
  summary: 'Lecture overview',
  keyPoints: 'Concepts',
  importantDetails: 'Examples & details',
  revisionNotes: 'Revise · exam / formulas',
  followUps: 'Homework & reading',
}

export function sectionTitle(scene: ListenScene, id: NotesSectionId): string {
  if (scene === 'lecture') return LECTURE_TITLE[id] ?? SECTION_TITLE[id]
  return SECTION_TITLE[id]
}

export function sceneLabel(scene: ListenScene): string {
  return LISTEN_SCENES.find((s) => s.id === scene)?.label ?? 'Meeting'
}

export function emptyNotes(): NotesDoc {
  return {
    summary: '',
    takeaways: [],
    keyPoints: [],
    decisions: [],
    actionItems: [],
    importantDetails: [],
    followUps: [],
    revisionNotes: [],
  }
}

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function asActions(value: unknown): Array<{ text: string; owner?: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') {
        const text = item.trim()
        return text ? { text } : null
      }
      if (!item || typeof item !== 'object') return null
      const row = item as { text?: unknown; owner?: unknown }
      const text = String(row.text || '').trim()
      if (!text) return null
      const owner = String(row.owner || '').trim()
      return owner ? { text, owner } : { text }
    })
    .filter((row): row is { text: string; owner?: string } => Boolean(row))
}

export function parseNotes(raw: string): NotesDoc {
  const doc = emptyNotes()
  const text = (raw || '').trim()
  if (!text) return doc
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    doc.summary = text
    return doc
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    doc.summary = String(parsed.summary || '').trim()
    doc.takeaways = asList(parsed.takeaways)
    doc.keyPoints = asList(parsed.keyPoints)
    doc.decisions = asList(parsed.decisions)
    doc.actionItems = asActions(parsed.actionItems)
    doc.importantDetails = asList(parsed.importantDetails)
    doc.followUps = asList(parsed.followUps)
    doc.revisionNotes = asList(parsed.revisionNotes)
    return doc
  } catch {
    doc.summary = text
    return doc
  }
}

function itemsForSection(doc: NotesDoc, id: NotesSectionId): string[] {
  if (id === 'summary') return doc.summary.trim() ? [doc.summary.trim()] : []
  if (id === 'actionItems') {
    return doc.actionItems
      .map((row) => (row.owner ? `${row.owner} — ${row.text}` : row.text))
      .filter(Boolean)
  }
  const items = doc[id]
  return Array.isArray(items) ? items.filter(Boolean) : []
}

export function exportNoteSections(scene: ListenScene, doc: NotesDoc): Array<{ id: NotesSectionId; title: string; items: string[] }> {
  return SCENE_SECTIONS[scene].map((id) => ({
    id,
    title: SECTION_TITLE[id],
    items: itemsForSection(doc, id),
  }))
}

export function visibleSections(scene: ListenScene, doc: NotesDoc): Array<{ id: NotesSectionId; title: string; items: string[] }> {
  return exportNoteSections(scene, doc)
    .filter((section) => section.items.length)
    .map((section) => ({ ...section, title: sectionTitle(scene, section.id) }))
}

export function lastTwoMinutes(lines: MeetingLine[], now = Date.now()): MeetingLine[] {
  const cutoff = now - 120_000
  const windowed = lines.filter((line) => (line.at ?? 0) >= cutoff)
  return windowed.length ? windowed : lines.slice(-8)
}

export function transcriptBlock(lines: MeetingLine[]): string {
  return lines.map((line) => `${line.ts}  ${line.text}`).join('\n')
}

export function catchupPrompt(lines: MeetingLine[], question = '', outLang: PairLang = 'zh'): string {
  const body = transcriptBlock(lines)
  const ask = question.trim()
  const name = langName(outLang)
  return (
    `[NOD_CATCH:${outLang}]\n` +
    `OUTPUT LANGUAGE (hard rule): Write the entire catch-up in ${name} only. Do not follow the transcript language.\n` +
    'Catch the listener up on ONLY this recent stretch. Listening is still going. Do not recap the whole session.\n' +
    (ask ? `Listener question: ${ask}\n` : '') +
    `Recent transcript (~2 minutes):\n${body || '(empty)'}`
  )
}

export function notesPrompt(scene: ListenScene, lines: MeetingLine[], outLang: PairLang = 'zh'): string {
  const name = langName(outLang)
  const follow =
    scene === 'lecture'
      ? 'followUps = homework / reading'
      : scene === 'interview'
        ? 'followUps = thank-you note / materials to send'
        : 'followUps = next check-ins'
  return (
    `[NOD_NOTES:${scene}:${outLang}]\n` +
    `OUTPUT LANGUAGE (hard rule): Every JSON string value must be in ${name} only. Do not follow the transcript language.\n` +
    `Write structured notes for a ${scene}. Use only the transcript. Do not invent names, numbers, or commitments.\n` +
    'Return JSON only with keys: summary (string), takeaways, keyPoints, decisions, actionItems, importantDetails, followUps, revisionNotes.\n' +
    'Lists are string arrays. actionItems is [{text, owner}] — owner only if spoken.\n' +
    `Empty arrays when the transcript has nothing. ${follow}. ` +
    (scene === 'lecture' ? 'revisionNotes = exam / formula items. ' : 'revisionNotes usually []. ') +
    (scene === 'interview' ? 'takeaways = questions asked and what they cared about. ' : 'takeaways usually []. ') +
    `Transcript:\n${transcriptBlock(lines) || '(empty)'}`
  )
}

export function isCatchPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_CATCH')
}

export function isNotesPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_NOTES')
}
