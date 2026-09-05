import { LISTEN_SCENES, MEETING_SPEAKER_OPTIONS, bilingualDisabled, capTranscript, nodTag, notesBodyText, notesPrompt, outLangRule, sceneChipLabel, sceneLabel, speakersExpected } from './listen'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// A: Summary gets its own language channel.
eq(nodTag('SUMMARY', 'zh', false), '[NOD_SUMMARY:zh]', 'summary tag')
eq(nodTag('SUMMARY', 'auto', true), '[NOD_SUMMARY:auto:bi]', 'summary tag bilingual')
eq(nodTag('NOTES', 'zh', false, 'meeting'), '[NOD_NOTES:meeting:zh]', 'notes tag keeps scene')
if (!outLangRule('zh', 'summary').includes('Chinese only')) throw new Error('summary fixed lang')
if (!outLangRule('auto', 'summary').includes('majority language')) throw new Error('summary auto follows transcript')

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
