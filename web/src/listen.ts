import type { Lang, MeetingLine, PairLang } from './types'
import { TRANSLATE_LANGS } from './types'

function langName(lang: PairLang): string {
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name ?? 'Chinese'
}

function outLangRule(outLang: Lang, kind: 'answer' | 'catch-up' | 'json', bilingual = false): string {
  if (bilingual) {
    const name = outLang === 'auto' ? 'the listener notes language, or Chinese if unclear' : langName(outLang)
    if (kind === 'json') {
      return (
        `BILINGUAL (hard rule): Every JSON string value has TWO lines. Line 1 is the transcript / source language. ` +
        `Line 2 starts with ">> " then the ${name} translation. Never output only one language.\n`
      )
    }
    return (
      `BILINGUAL (hard rule): Every sentence or bullet has TWO lines. ` +
      `Line 1 is the transcript / source language. Line 2 starts with ">> " then the ${name} translation. ` +
      `Never output only one language.\n`
    )
  }
  if (outLang === 'auto') {
    if (kind === 'json') {
      return 'OUTPUT LANGUAGE (hard rule): Write every JSON string in the language of the transcript. If the transcript mixes languages, follow the majority language. Do not force one language.\n'
    }
    return 'OUTPUT LANGUAGE (hard rule): Write in the language of the listener question if it is clear; otherwise follow the transcript. Do not force one language.\n'
  }
  const name = langName(outLang)
  if (kind === 'json') {
    return `OUTPUT LANGUAGE (hard rule): Every JSON string value must be in ${name} only. Do not follow the transcript language.\n`
  }
  if (kind === 'catch-up') {
    return `OUTPUT LANGUAGE (hard rule): Write the entire catch-up in ${name} only. Do not follow the transcript language.\n`
  }
  return `OUTPUT LANGUAGE (hard rule): Write the entire answer in ${name} only. Do not follow the transcript language.\n`
}

function nodTag(kind: 'ASK' | 'CATCH' | 'NOTES', outLang: Lang, bilingual: boolean, scene?: ListenScene): string {
  const extra = bilingual ? ':bi' : ''
  if (kind === 'NOTES') return `[NOD_NOTES:${scene}:${outLang}${extra}]`
  return `[NOD_${kind}:${outLang}${extra}]`
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
    // 有 '{' 但还没等到闭合 '}' → LLM 还在流式输出 JSON，别把半截 JSON 当 summary 渲染
    doc.summary = start >= 0 ? '' : text
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
    // 解析失败：JSON 流没结束（嵌套对象中途）→ 不显示；否则原样显示
    doc.summary = start >= 0 ? '' : text
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

export function transcriptBlock(lines: MeetingLine[], bilingual = false): string {
  return lines
    .map((line) => {
      const head = `${line.ts}  ${line.text}`
      return bilingual && line.translation ? `${head}\n       ${line.translation}` : head
    })
    .join('\n')
}

export type BiLine = { src: string; tr?: string }

export function parseBiLines(text: string): BiLine[] {
  const out: BiLine[] = []
  for (const raw of (text || '').split(/\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^>>\s*/.test(line) && out.length) {
      out[out.length - 1].tr = line.replace(/^>>\s*/, '')
    } else {
      out.push({ src: line })
    }
  }
  return out.length ? out : text.trim() ? [{ src: text.trim() }] : []
}

export function askContext(lines: MeetingLine[], ended: boolean, now = Date.now()): MeetingLine[] {
  if (ended || lines.length <= 80) return lines
  const cutoff = now - 20 * 60_000
  const windowed = lines.filter((line) => (line.at ?? 0) >= cutoff)
  return windowed.length ? windowed : lines.slice(-80)
}

export function askPrompt(lines: MeetingLine[], question: string, outLang: Lang = 'zh', bilingual = false): string {
  const ask = question.trim()
  return (
    `${nodTag('ASK', outLang, bilingual)}\n` +
    outLangRule(outLang, 'answer', bilingual) +
    `Listener question: ${ask}\n` +
    `Transcript (use when relevant; if empty, say you have not heard enough yet and still answer what you can):\n` +
    `${transcriptBlock(lines, bilingual) || '(empty)'}`
  )
}

export function isAskPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_ASK')
}

export function catchupPrompt(lines: MeetingLine[], question = '', outLang: Lang = 'zh', bilingual = false): string {
  const body = transcriptBlock(lines, bilingual)
  const ask = question.trim()
  return (
    `${nodTag('CATCH', outLang, bilingual)}\n` +
    outLangRule(outLang, 'catch-up', bilingual) +
    'Catch the listener up on ONLY this recent stretch. Listening is still going. Do not recap the whole session.\n' +
    (ask ? `Listener question: ${ask}\n` : '') +
    `Recent transcript (~2 minutes):\n${body || '(empty)'}`
  )
}

export function notesPrompt(scene: ListenScene, lines: MeetingLine[], outLang: Lang = 'zh', bilingual = false): string {
  const follow =
    scene === 'lecture'
      ? 'followUps = homework / reading'
      : scene === 'interview'
        ? 'followUps = thank-you note / materials to send'
        : 'followUps = next check-ins'
  return (
    `${nodTag('NOTES', outLang, bilingual, scene)}\n` +
    outLangRule(outLang, 'json', bilingual) +
    `Write structured notes for a ${scene}. Use only the transcript. Do not invent names, numbers, or commitments.\n` +
    'Return JSON only with keys: summary (string), takeaways, keyPoints, decisions, actionItems, importantDetails, followUps, revisionNotes.\n' +
    'Lists are string arrays. actionItems is [{text, owner}] — owner only if spoken.\n' +
    `Empty arrays when the transcript has nothing. ${follow}. ` +
    (scene === 'lecture' ? 'revisionNotes = exam / formula items. ' : 'revisionNotes usually []. ') +
    (scene === 'interview' ? 'takeaways = questions asked and what they cared about. ' : 'takeaways usually []. ') +
    `Transcript:\n${transcriptBlock(lines, bilingual) || '(empty)'}`
  )
}

export function isCatchPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_CATCH')
}

export function isNotesPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_NOTES')
}
