import type { Lang, MeetingLine, PairLang } from './types'
import { TRANSLATE_LANGS } from './types'
import { IPHONE_COPY, sameSpokenLine } from './iphoneCopy'

function langName(lang: PairLang): string {
  return TRANSLATE_LANGS.find((item) => item.id === lang)?.name ?? 'Chinese'
}

export function outLangRule(outLang: Lang, kind: 'answer' | 'catch-up' | 'json', bilingual = false, biTarget?: PairLang): string {
  if (bilingual) {
    const name = biTarget
      ? langName(biTarget)
      : outLang === 'auto'
        ? 'the listener notes language, or Chinese if unclear'
        : langName(outLang)
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
      return 'OUTPUT LANGUAGE (hard rule): Follow the transcript language. If the transcript mixes languages, write in the majority language. Do not force one language.\n'
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

export function nodTag(
  kind: 'ASK' | 'CATCH' | 'NOTES',
  outLang: Lang,
  bilingual: boolean,
  scene?: ListenScene,
  biTarget?: PairLang,
): string {
  const extra = bilingual ? (biTarget ? `:bi-${biTarget}` : ':bi') : ''
  if (kind === 'NOTES') return `[NOD_NOTES:${scene}:${outLang}${extra}]`
  return `[NOD_${kind}:${outLang}${extra}]`
}

/** Notes Auto follows speech. Bilingual captions only run with a concrete notes language. */
export function notesBilingualOn(notesLang: Lang, translateOn: boolean): boolean {
  return notesLang !== 'auto' && translateOn
}

export function bilingualDisabled(
  notesLang: Lang,
  _translateOn: boolean,
  _notesTranslateTo?: PairLang,
): boolean {
  return notesLang === 'auto'
}

// The notes/translate language selector drives decoupled state. In the Meeting /
// Lecture notes dropdown, picking a concrete language sets BOTH the notes
// language and notesTranslateTo; picking "auto" sets only the notes language.
// In the Translate workspace, changing the target affects only translateTo.
export type LangDispatch =
  | { type: 'translate_to'; lang: PairLang }
  | { type: 'notes_lang'; lang: Lang }
  | { type: 'notes_translate_to'; lang: PairLang }

export function notesLangActions(workspaceMode: string, lang: Lang): LangDispatch[] {
  if (lang === 'auto') return [{ type: 'notes_lang', lang: 'auto' }]
  if (workspaceMode !== 'translate') return [{ type: 'notes_translate_to', lang }, { type: 'notes_lang', lang }]
  return [{ type: 'translate_to', lang }]
}

// Keep the TAIL of a transcript within a character budget so a long meeting
// does not silently drop the first half-hour (the old hardcoded slice(-500)).
export type TranscriptCap<T> = { lines: T[]; dropped: number; fromTs: string | null }
export function capTranscript<T extends { text: string; ts?: string }>(
  lines: T[],
  budgetChars = 120_000,
): TranscriptCap<T> {
  let chars = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    chars += (lines[i].text || '').length + 16
    if (chars > budgetChars) break
    start = i
  }
  const kept = lines.slice(start)
  return { lines: kept, dropped: start, fromTs: kept[0]?.ts ?? null }
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
  speakers: Array<{ label: string; name: string; evidence?: string }>
}

export const LISTEN_SCENES: Array<{ id: ListenScene; label: string }> = [
  { id: 'meeting', label: 'Meeting' },
  { id: 'lecture', label: 'Lecture' },
  { id: 'interview', label: 'Live Q&A' },
]

export const SCENE_HELP: Record<ListenScene, string> = {
  meeting: 'Decisions and action items',
  lecture: 'Key concepts and study notes',
  interview: 'Questions and suggested answers',
}

const SCENE_SECTIONS: Record<ListenScene, NotesSectionId[]> = {
  meeting: ['summary', 'keyPoints', 'decisions', 'actionItems', 'importantDetails', 'followUps'],
  lecture: ['summary', 'keyPoints', 'importantDetails', 'revisionNotes', 'followUps'],
  interview: ['summary', 'takeaways', 'keyPoints', 'importantDetails', 'followUps'],
}

/** Single source of the section order for a scene. Every renderer (Live pane,
 * PDF, copy/Share) must read this, never a local hardcoded array. */
export function sceneSectionOrder(scene: ListenScene): NotesSectionId[] {
  return SCENE_SECTIONS[scene]
}

export const SECTION_TITLE: Record<NotesSectionId, string> = {
  summary: 'Summary',
  takeaways: 'Q&A Takeaways',
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

// Scene chip label: append the people-count badge only for Meeting when it is
// not the default (2). '3–4' uses the en-dash chip display, not the option id.
export function sceneChipLabel(scene: ListenScene, speakersId: MeetingSpeakerId): string {
  const base = sceneLabel(scene)
  if (scene === 'meeting' && speakersId !== '2') {
    const opt = MEETING_SPEAKER_OPTIONS.find((o) => o.id === speakersId)
    return `${base} · ${opt?.chip ?? ''}`
  }
  return base
}

export function listenMetaLine(input: {
  scene: ListenScene
  speakersId: MeetingSpeakerId
  speechLang: Lang
  notesLang: Lang
  qa?: boolean
}): string {
  const speech =
    input.speechLang === 'auto'
      ? IPHONE_COPY.autoDetectFrom
      : (TRANSLATE_LANGS.find((item) => item.id === input.speechLang)?.name || 'English')
  const parts = [sceneChipLabel(input.scene, input.speakersId), speech]
  if (!input.qa) {
    parts.push(
      input.notesLang === 'auto'
        ? IPHONE_COPY.autoNotes
        : `${TRANSLATE_LANGS.find((item) => item.id === input.notesLang)?.name || 'English'} notes`,
    )
  }
  return parts.join(' · ')
}

export function settingsLocked(input: { capture: string }): boolean {
  return input.capture === 'listening' || input.capture === 'recording' || input.capture === 'paused'
}

export function listenSettingsBlocked(input: { capture: string; workspaceMode?: string }): boolean {
  if (input.workspaceMode === 'translate') return false
  return settingsLocked({ capture: input.capture })
}

export function applyListenSetting(opts: {
  capture: string
  workspaceMode: string
  send: () => void
  apply: () => void
}): 'locked' | 'applied' {
  if (listenSettingsBlocked({ capture: opts.capture, workspaceMode: opts.workspaceMode })) return 'locked'
  opts.apply()
  opts.send()
  return 'applied'
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
    speakers: [],
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

function asSpeakers(value: unknown): NotesDoc['speakers'] {
  if (!Array.isArray(value)) return []
  const out: NotesDoc['speakers'] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as { label?: unknown; name?: unknown; evidence?: unknown }
    const label = String(row.label || '').trim()
    const name = String(row.name || '').trim()
    if (!label || !name || name === label) continue
    const evidence = String(row.evidence || '').trim()
    out.push(evidence ? { label, name, evidence } : { label, name })
  }
  return out
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
    doc.speakers = asSpeakers(parsed.speakers)
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
    title: sectionTitle(scene, id),
    items: itemsForSection(doc, id),
  }))
}

export function visibleSections(scene: ListenScene, doc: NotesDoc): Array<{ id: NotesSectionId; title: string; items: string[] }> {
  return exportNoteSections(scene, doc).filter((section) => section.items.length)
}

export const MEETING_SPEAKER_OPTIONS = [
  { id: '2', label: '2 people', chip: '2', count: 2 },
  { id: '3-4', label: '3-4 people', chip: '3–4', count: 4 },
  { id: '5+', label: '5+ people', chip: '5+', count: 6 },
] as const
export type MeetingSpeakerId = (typeof MEETING_SPEAKER_OPTIONS)[number]['id']
const MEETING_SPEAKER_KEY = 'nod_meeting_speakers'

export function meetingSpeakerId(): MeetingSpeakerId {
  try {
    const raw = localStorage.getItem(MEETING_SPEAKER_KEY) as MeetingSpeakerId | null
    return MEETING_SPEAKER_OPTIONS.some((o) => o.id === raw) ? (raw as MeetingSpeakerId) : '2'
  } catch {
    return '2'
  }
}

export function meetingSpeakerCount(): number {
  return MEETING_SPEAKER_OPTIONS.find((o) => o.id === meetingSpeakerId())?.count ?? 2
}

export function setMeetingSpeaker(id: MeetingSpeakerId): void {
  try {
    localStorage.setItem(MEETING_SPEAKER_KEY, id)
  } catch {
    /* private mode / quota */
  }
}

export function speakersExpected(scene: ListenScene, count?: number): number {
  if (scene === 'meeting') return count ?? 2
  return scene === 'lecture' ? 4 : 2
}

export function speakerLabel(scene: ListenScene, index: number): string {
  if (scene === 'lecture') {
    if (index === 0) return 'Lecturer'
    return index === 1 ? 'Audience' : `Audience ${index}`
  }
  if (scene === 'interview') {
    if (index === 0) return 'Interviewer'
    if (index === 1) return 'Candidate'
    return `Speaker ${index + 1}`
  }
  if (index === 0) return 'Host'
  return index === 1 ? 'Guest' : `Guest ${index}`
}

function isUsableSpeakerId(id: string): boolean {
  const key = id.trim().toLowerCase()
  return Boolean(key) && key !== 'pending' && key !== 'none' && key !== 'unknown'
}

export function bindSpeakerName(
  names: Record<string, string>,
  speakerId: string | undefined,
  scene: ListenScene,
): Record<string, string> {
  const id = (speakerId || '').trim()
  if (!isUsableSpeakerId(id) || names[id]) return names
  const index = Object.keys(names).length
  const used = new Set(Object.values(names))
  let label = speakerLabel(scene, index)
  if (used.has(label)) label = `${label} ${index + 1}`
  return { ...names, [id]: label }
}

export function resolveSpeakerName(names: Record<string, string>, speakerId?: string): string {
  const id = (speakerId || '').trim()
  if (!id) return ''
  return names[id] || id
}

export function promoteLectureSpeakers(
  lines: MeetingLine[],
  names: Record<string, string>,
  locked: Record<string, boolean>,
): Record<string, string> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const id = (line.speaker || '').trim()
    if (!isUsableSpeakerId(id)) continue
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!ranked.length || ranked[0][1] < 3) return names
  // Hysteresis: if the current (unlocked) Lecturer is still within 80% of the
  // top count, hold the labels instead of flipping the tag on a shift/tie —
  // otherwise the tag bounces between two ids through a Q&A-dense stretch.
  const currentLecturer = Object.keys(names).find((id) => names[id] === 'Lecturer' && !locked[id])
  if (currentLecturer != null && (counts.get(currentLecturer) || 0) >= ranked[0][1] * 0.8) {
    return names
  }
  const next = { ...names }
  ranked.forEach(([id], i) => {
    if (!locked[id]) next[id] = speakerLabel('lecture', i)
  })
  return next
}

const HOST_HINT = /然后呢|对吧|好的[，,]|那[么呃]*[，,]|所以说|怎么看|能不能|到底该怎么|tell me|what about|\bhow (?:do|would|can)\b|\bso[,?]|right\?/i
const ASK_HINT = /[?？]|吗[.。!！]?$|呢[.。!！]?$|怎么|为什么|\bwhat\b|\bwhy\b|\bhow\b/

export function hostLikeness(text: string): number {
  const raw = (text || '').trim()
  if (!raw) return 0
  const han = (raw.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (raw.match(/[A-Za-z]/g) || []).length
  let score = 0
  if (HOST_HINT.test(raw)) score += 3
  if (ASK_HINT.test(raw)) score += 2
  if (raw.length < 22) score += 1
  if (raw.length > 70) score -= 2
  if (latin > 20 && latin > han * 2) score -= 2
  return score
}

export function promoteMeetingSpeakers(
  lines: MeetingLine[],
  names: Record<string, string>,
  locked: Record<string, boolean>,
  scene: ListenScene = 'meeting',
): Record<string, string> {
  const roleScene = scene === 'interview' ? 'interview' : 'meeting'
  const scores = new Map<string, number>()
  for (const line of lines) {
    const id = (line.speaker || '').trim()
    if (!isUsableSpeakerId(id)) continue
    scores.set(id, (scores.get(id) || 0) + hostLikeness(line.text))
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (ranked.length < 2) return names
  const next = { ...names }
  ranked.forEach(([id], i) => {
    if (!locked[id]) next[id] = speakerLabel(roleScene, i)
  })
  return next
}

export function lastTwoMinutes(lines: MeetingLine[], now = Date.now()): MeetingLine[] {
  const cutoff = now - 120_000
  const windowed = lines.filter((line) => (line.at ?? 0) >= cutoff)
  return windowed.length ? windowed : lines.slice(-8)
}

export function transcriptBlock(
  lines: MeetingLine[],
  bilingual = false,
  names: Record<string, string> = {},
): string {
  return lines
    .map((line) => {
      const who = resolveSpeakerName(names, line.speaker)
      const head = `${line.ts}${who ? ` ${who}` : ''}  ${line.text}`
      const tr = line.translation || ''
      // A translation identical to its source (same-language passthrough) is not
      // a real translation — feed it once, in the source column only, so Notes /
      // Ask input and the exported live PDF never repeat the same text twice.
      return bilingual && tr && !sameSpokenLine(line.text, tr) ? `${head}\n       ${tr}` : head
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

/** Summary / notes body in the configured notes language only. */
export function notesBodyText(text: string): string {
  return parseBiLines(text)
    .map((block) => (block.tr || block.src).trim())
    .filter(Boolean)
    .join('\n')
}

export function askContext(lines: MeetingLine[], ended: boolean, now = Date.now()): MeetingLine[] {
  if (ended || lines.length <= 80) return lines
  const cutoff = now - 20 * 60_000
  const windowed = lines.filter((line) => (line.at ?? 0) >= cutoff)
  return windowed.length ? windowed : lines.slice(-80)
}

export function askPrompt(
  lines: MeetingLine[],
  question: string,
  outLang: Lang = 'zh',
  bilingual = false,
  names: Record<string, string> = {},
  biTarget?: PairLang,
): string {
  const ask = question.trim()
  return (
    `${nodTag('ASK', outLang, bilingual, undefined, biTarget)}\n` +
    outLangRule(outLang, 'answer', bilingual, biTarget) +
    `Listener question: ${ask}\n` +
    `Transcript (use when relevant; if empty, say you have not heard enough yet and still answer what you can):\n` +
    `${transcriptBlock(lines, bilingual, names) || '(empty)'}`
  )
}

export function isAskPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_ASK')
}

export function notesPrompt(
  scene: ListenScene,
  lines: MeetingLine[],
  outLang: Lang = 'zh',
  bilingual = false,
  names: Record<string, string> = {},
  cap?: { dropped: number; fromTs: string | null },
  biTarget?: PairLang,
): string {
  const follow =
    scene === 'lecture'
      ? 'followUps = homework / reading'
      : scene === 'interview'
        ? 'followUps = thank-you note / materials to send'
        : 'followUps = next check-ins'
  return (
    `${nodTag('NOTES', outLang, false, scene, biTarget)}\n` +
    outLangRule(outLang, 'json', false) +
    `Write structured notes for a ${scene}. Use only the transcript. Do not invent names, numbers, or commitments.\n` +
    'Return JSON only with keys: summary (string), takeaways, keyPoints, decisions, actionItems, importantDetails, followUps, revisionNotes, speakers.\n' +
    'Lists are string arrays. actionItems is [{text, owner}] — owner only if spoken.\n' +
    'speakers is [{label, name, evidence}]: label matches the transcript speaker label; name only if explicitly spoken for that speaker; evidence is the short proving quote. Empty array when nobody is named.\n' +
    `Empty arrays when the transcript has nothing. ${follow}. ` +
    (scene === 'lecture' ? 'revisionNotes = exam / formula items. ' : 'revisionNotes usually []. ') +
    (scene === 'interview' ? 'takeaways = questions asked and what they cared about. ' : 'takeaways usually []. ') +
    `Transcript:\n${cap && cap.dropped > 0 ? `(Transcript is truncated: the first ${cap.dropped} lines (before ${cap.fromTs}) are not included.)\n` : ''}${transcriptBlock(lines, bilingual, names) || '(empty)'}`
  )
}

export function isCatchPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_CATCH')
}

export function isNotesPrompt(text: string): boolean {
  return (text || '').trim().startsWith('[NOD_NOTES')
}
