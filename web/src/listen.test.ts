import { LISTEN_SCENES, MEETING_SPEAKER_OPTIONS, SCENE_HELP, bilingualDisabled, capTranscript, emptyNotes, exportNoteSections, nodTag, notesBodyText, notesPrompt, outLangRule, promoteLectureSpeakers, sceneChipLabel, sceneLabel, sceneSectionOrder, speakersExpected, transcriptBlock } from './listen'
import type { MeetingLine } from './types'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(nodTag('NOTES', 'zh', false, 'meeting'), '[NOD_NOTES:meeting:zh]', 'notes tag keeps scene')

// D (phase 1): Bilingual is dead when Notes = Auto. But an already-ON Bilingual
// must stay toggleable OFF, so it is only disabled when it is NOT on.
if (bilingualDisabled('auto', false) !== true) throw new Error('auto + off disables bilingual')
if (bilingualDisabled('auto', true) !== false) throw new Error('auto + on stays toggleable')
if (bilingualDisabled('zh', true) !== false) throw new Error('concrete notes lang enables bilingual')

// B(1): capTranscript keeps the tail within a character budget, reports the drop.
const capLines = [
  { id: '1', ts: '0:00', text: 'line one' },
  { id: '2', ts: '0:05', text: 'line two' },
  { id: '3', ts: '0:10', text: 'line three' },
]
const capTrailing = capTranscript(capLines, 40)
if (capTrailing.dropped !== 2 || capTrailing.fromTs !== '0:10' || capTrailing.lines.map((l) => l.id).join(',') !== '3') {
  throw new Error(`cap keeps tail, got ${JSON.stringify(capTrailing)}`)
}
const capAll = capTranscript(capLines, 1000)
if (capAll.dropped !== 0 || capAll.fromTs !== '0:00' || capAll.lines.length !== 3) throw new Error('cap under budget keeps all')
const capBoundary = capTranscript(capLines, 52)
if (capBoundary.dropped !== 1 || capBoundary.fromTs !== '0:05' || capBoundary.lines.map((l) => l.id).join(',') !== '2,3') {
  throw new Error(`cap boundary, got ${JSON.stringify(capBoundary)}`)
}
const cappedNotes = notesPrompt('meeting', capTrailing.lines, 'zh', false, {}, { dropped: capTrailing.dropped, fromTs: capTrailing.fromTs })
if (!cappedNotes.includes('Transcript is truncated') || !cappedNotes.includes('first 2')) throw new Error('notes prompt shows truncation notice')

// C: meeting speaker count drives max_speakers; only meeting is overridable.
eq(speakersExpected('meeting'), 2, 'meeting default 2')
eq(speakersExpected('meeting', 4), 4, 'meeting override 4')
eq(speakersExpected('meeting', 6), 6, 'meeting override 6')
eq(speakersExpected('lecture'), 4, 'lecture stays 4')
eq(speakersExpected('interview', 6), 2, 'interview ignores override')
eq(MEETING_SPEAKER_OPTIONS.map((o) => o.count).join(','), '2,4,6', 'bucket counts')

// item1: scene chip label shows the people-count badge only for non-default Meeting.
eq(sceneChipLabel('meeting', '2'), 'Meeting', 'meeting default 2 has no badge')
eq(sceneChipLabel('meeting', '3-4'), 'Meeting · 3–4', 'meeting 3-4 badge uses en-dash')
eq(sceneChipLabel('meeting', '5+'), 'Meeting · 5+', 'meeting 5+ badge')
eq(sceneChipLabel('lecture', '5+'), 'Lecture', 'lecture ignores the speaker badge')

eq(sceneLabel('interview'), 'Live Q&A')
eq(LISTEN_SCENES.find((s) => s.id === 'interview')?.label, 'Live Q&A')
eq(sceneLabel('meeting'), 'Meeting')
eq(sceneLabel('lecture'), 'Lecture')
eq(SCENE_HELP.meeting, 'Decisions and action items', 'meeting blurb')
eq(SCENE_HELP.lecture, 'Key concepts and study notes', 'lecture blurb')
eq(SCENE_HELP.interview, 'Questions and suggested answers', 'live qa blurb')

// item1: the lecture section order is defined once (SCENE_SECTIONS), the single
// source every renderer (Live pane / PDF / copy-Share) reads.
eq(sceneSectionOrder('lecture'), ['summary', 'keyPoints', 'importantDetails', 'revisionNotes', 'followUps'], 'lecture section order is SCENE_SECTIONS')

// item5: promoteLectureSpeakers direct tests + a rank-hold hysteresis.
const mkLine = (id: string, speaker: string): MeetingLine => ({ id, ts: '0:00', text: 'x', speaker })
const lines = (A: number, B: number, a = 'A', b = 'B'): MeetingLine[] => {
  const out: MeetingLine[] = []
  for (let i = 0; i < A; i++) out.push(mkLine(`a${i}`, a))
  for (let i = 0; i < B; i++) out.push(mkLine(`b${i}`, b))
  return out
}
// (a) fewer than 3 usable lines keeps names as-is.
eq(promoteLectureSpeakers(lines(2, 0), {}, {}), {}, 'fewer than 3 lines keeps labels')
// (b) A 5, B 2 → A=Lecturer, B=Audience.
eq(promoteLectureSpeakers(lines(5, 2), {}, {}), { A: 'Lecturer', B: 'Audience' }, 'most lines become Lecturer')
// (c) A already Lecturer, A 4 / B 5 → hold A (within 80% of the top).
eq(promoteLectureSpeakers(lines(4, 5), { A: 'Lecturer', B: 'Audience' }, {}), { A: 'Lecturer', B: 'Audience' }, 'hold current Lecturer within 80% of the top')
// (d) A 4 / B 6 → B clears 80% (4 < 4.8) so the tag switches.
eq(promoteLectureSpeakers(lines(4, 6), { A: 'Lecturer', B: 'Audience' }, {}), { A: 'Audience', B: 'Lecturer' }, 'switch when the leader clears 80%')
// (e) locked[A] keeps A's name even when it would be re-ranked.
eq(promoteLectureSpeakers(lines(5, 2), { A: 'Lecturer' }, { A: true }), { A: 'Lecturer', B: 'Audience' }, 'locked speaker keeps its label')

// item6: exportNoteSections titles follow the scene, not the generic SECTION_TITLE.
{
  const d = emptyNotes()
  d.keyPoints = ['Flux is the rate of flow']
  eq(exportNoteSections('lecture', d).find((s) => s.id === 'keyPoints')?.title, 'Concepts', 'lecture keyPoints title uses the scene title')
}

const zhNotes = notesPrompt(
  'meeting',
  [{ id: '1', ts: '0:01', text: 'We ship Friday.', translation: '我们周五发。' }],
  'zh',
  true,
)
if (zhNotes.includes('BILINGUAL')) throw new Error('Summary must not ask for bilingual captions')
if (!zhNotes.includes('Chinese only')) throw new Error('Summary must follow the notes language')
if (zhNotes.includes(':bi]')) throw new Error('NOTES tag stays single-language')

eq(notesBodyText('We ship Friday.\n>> 我们周五发。'), '我们周五发。', 'old bilingual notes keep the notes-language line')
eq(notesBodyText('我们周五发。'), '我们周五发。', 'single-language notes stay as written')

// Same-language passthrough dedup: a translation identical to its source (after
// whitespace normalization) is not a real translation — feed it once, source only.
{
  const tb = transcriptBlock(
    [
      { id: '1', ts: '0:01', text: 'The host introduces the tutorial.', translation: 'The host introduces the tutorial.' },
      { id: '3', ts: '0:12', text: 'We ship Friday.', translation: '我们周五发。' },
    ],
    true,
  )
  const lines = tb.split('\n').map((l) => l.trim())
  const sourceOnce = lines.filter((l) => l.includes('The host introduces the tutorial.')).length
  if (sourceOnce !== 1) throw new Error(`same-language passthrough shows the source once, got ${sourceOnce}`)
  if (!lines.includes('我们周五发。')) throw new Error('a genuinely different translation still gets its own row')
}
{
  // Whitespace-only difference between source and translation -> still one copy.
  const tb = transcriptBlock([{ id: '1', ts: '0:01', text: 'We ship Friday.', translation: 'We ship   Friday.' }], true)
  if (tb.split('\n').filter((l) => l.includes('We ship Friday.')).length !== 1) {
    throw new Error('whitespace difference is normalized and shown once')
  }
}
{
  // Bilingual off: transcriptBlock never includes a translation column.
  const tb = transcriptBlock([{ id: '1', ts: '0:01', text: 'We ship Friday.', translation: '我们周五发。' }], false)
  if (tb.includes('我们周五发。')) throw new Error('bilingual off never adds the translation rows')
}
