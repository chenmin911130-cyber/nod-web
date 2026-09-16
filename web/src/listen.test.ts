import { LISTEN_SCENES, MEETING_SPEAKER_OPTIONS, applyListenSetting, askPrompt, bilingualDisabled, bindSpeakerName, capTranscript, emptyNotes, exportNoteSections, inferMeetingLineLabel, lastTwoMinutes, listenAskPayload, listenMetaLine, listenSettingsBlocked, nodTag, notesBodyText, notesBilingualOn, notesLangActions, notesPrompt, notesTranscriptTooThin, outLangRule, parseNotes, promoteLectureSpeakers, resolveMeetingLineLabel, sceneChipLabel, sceneLabel, sceneSectionOrder, settingsLocked, speakerLetterIndex, speakersExpected, transcriptBlock } from './listen'
import { IPHONE_COPY, iphoneCopyFor } from './iphoneCopy'
import type { MeetingLine } from './types'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(nodTag('NOTES', 'zh', false, 'meeting'), '[NOD_NOTES:meeting:zh]', 'notes tag keeps scene')

eq(
  notesLangActions('meeting', 'ja'),
  [{ type: 'notes_translate_to', lang: 'ja' }, { type: 'notes_lang', lang: 'ja' }],
  'meeting concrete notes sets notesTranslateTo, not translateTo',
)
eq(notesLangActions('translate', 'ja'), [{ type: 'translate_to', lang: 'ja' }], 'translate target stays translate_to')
eq(notesLangActions('meeting', 'auto'), [{ type: 'notes_lang', lang: 'auto' }], 'auto notes leaves the bilingual target put')
{
  const rule = outLangRule('auto', 'answer', true, 'ja')
  if (!rule.includes('Japanese')) throw new Error(`bilingual auto rule names Japanese, got ${rule}`)
  if (rule.includes('Chinese if unclear')) throw new Error('bilingual auto rule must not fall back to Chinese if unclear')
}
{
  const prompt = askPrompt(
    [{ id: '1', ts: '0:01', text: 'Hi' }],
    'q',
    'auto',
    notesBilingualOn('auto', true),
    {},
    'ja',
  )
  const first = prompt.split('\n', 1)[0]
  eq(first, '[NOD_ASK:auto]', 'Notes Auto follow-speech Ask is not bilingual')
}
{
  const prompt = askPrompt([{ id: '1', ts: '0:01', text: 'Hi' }], 'q', 'zh', true, {}, 'ja')
  const first = prompt.split('\n', 1)[0]
  eq(first, '[NOD_ASK:zh:bi-ja]', 'concrete notes ask tag carries bi-ja, not a colon-split ja out-lang')
}

eq(notesBilingualOn('auto', true), false, 'Auto notes never overlays a bilingual target')
eq(notesBilingualOn('auto', false), false, 'Auto notes stays follow-speech with bilingual off')
eq(notesBilingualOn('zh', true), true, 'concrete notes language can run bilingual')
eq(notesBilingualOn('zh', false), false, 'concrete notes language still honors bilingual off')

// Notes Auto follows speech: bilingual is off the table until a notes language is picked.
if (bilingualDisabled('auto', false) !== true) throw new Error('auto + off disables bilingual')
if (bilingualDisabled('auto', true) !== true) throw new Error('auto + on still disables bilingual')
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
const cappedNotes = notesPrompt('meeting', capTrailing.lines, 'zh', false, {}, {}, { dropped: capTrailing.dropped, fromTs: capTrailing.fromTs })
if (!cappedNotes.includes('Transcript is truncated') || !cappedNotes.includes('first 2')) throw new Error('notes prompt shows truncation notice')

// C: meeting speaker count drives max_speakers; only meeting is overridable.
eq(speakersExpected('meeting'), 2, 'meeting default 2')
eq(speakersExpected('meeting', 4), 4, 'meeting override 4')
eq(speakersExpected('meeting', 6), 6, 'meeting override 6')
eq(speakersExpected('lecture'), 4, 'lecture stays 4')
eq(speakersExpected('interview', 6), 2, 'interview ignores override')
eq(MEETING_SPEAKER_OPTIONS.map((o) => o.count).join(','), '2,4,6', 'bucket counts')

eq(speakerLetterIndex('A'), 0, 'A maps to host index')
eq(speakerLetterIndex('b'), 1, 'B maps to guest index')
eq(speakerLetterIndex('12'), null, 'numeric ids stay arrival-order')
eq(bindSpeakerName({}, 'B', 'meeting').B, 'Guest', 'B is Guest even when it arrives first')
eq(bindSpeakerName(bindSpeakerName({}, 'B', 'meeting'), 'A', 'meeting').A, 'Host', 'A stays Host when it arrives second')

// item1: scene chip label shows the people-count badge only for non-default Meeting.
eq(sceneChipLabel('meeting', '2'), 'Meeting', 'meeting default 2 has no badge')
eq(sceneChipLabel('meeting', '3-4'), 'Meeting · 3–4', 'meeting 3-4 badge uses en-dash')
eq(sceneChipLabel('meeting', '5+'), 'Meeting · 5+', 'meeting 5+ badge')
eq(sceneChipLabel('lecture', '5+'), 'Lecture', 'lecture ignores the speaker badge')

eq(settingsLocked({ capture: 'off' }), false, 'off is unlocked')
eq(settingsLocked({ capture: 'listening' }), true, 'listening is locked')
eq(settingsLocked({ capture: 'recording' }), true, 'recording is locked')
eq(settingsLocked({ capture: 'paused' }), true, 'paused is locked')
eq(listenSettingsBlocked({ capture: 'listening', workspaceMode: 'meeting' }), true, 'Listen settings block while listening')
eq(listenSettingsBlocked({ capture: 'paused', workspaceMode: 'interview' }), true, 'Listen settings block while paused')
eq(listenSettingsBlocked({ capture: 'off', workspaceMode: 'meeting' }), false, 'Listen settings unlock when capture is off')
eq(listenSettingsBlocked({ capture: 'listening', workspaceMode: 'translate' }), false, 'Translate language switching stays unlocked')
eq(
  listenMetaLine({ scene: 'meeting', speakersId: '3-4', speechLang: 'ja', notesLang: 'zh' }),
  'Meeting · 3–4 · Japanese · Chinese notes',
  'concrete speech and notes languages',
)

{
  let sent = 0
  let applied = 0
  eq(applyListenSetting({
    capture: 'listening',
    workspaceMode: 'meeting',
    send: () => { sent += 1 },
    apply: () => { applied += 1 },
  }), 'locked', 'listening blocks send and apply')
  eq([sent, applied], [0, 0], 'locked listening does not dispatch or send')
}
{
  let sent = 0
  let applied = 0
  eq(applyListenSetting({
    capture: 'recording',
    workspaceMode: 'meeting',
    send: () => { sent += 1 },
    apply: () => { applied += 1 },
  }), 'locked', 'recording blocks send and apply')
  eq([sent, applied], [0, 0], 'locked recording does not dispatch or send')
}
{
  let sent = 0
  let applied = 0
  eq(applyListenSetting({
    capture: 'paused',
    workspaceMode: 'interview',
    send: () => { sent += 1 },
    apply: () => { applied += 1 },
  }), 'locked', 'paused blocks send and apply')
  eq([sent, applied], [0, 0], 'locked paused does not dispatch or send')
}
{
  let sent = 0
  let applied = 0
  eq(applyListenSetting({
    capture: 'off',
    workspaceMode: 'meeting',
    send: () => { sent += 1 },
    apply: () => { applied += 1 },
  }), 'applied', 'ended/ready applies send and state')
  eq([sent, applied], [1, 1], 'unlocked Listen still sends set_*')
}
{
  let sent = 0
  let applied = 0
  eq(applyListenSetting({
    capture: 'listening',
    workspaceMode: 'translate',
    send: () => { sent += 1 },
    apply: () => { applied += 1 },
  }), 'applied', 'Translate workspace is not this lock')
  eq([sent, applied], [1, 1], 'Translate still sends while listening')
}

eq(sceneLabel('interview'), 'Live Q&A')
eq(LISTEN_SCENES.find((s) => s.id === 'interview')?.label, 'Live Q&A')
eq(sceneLabel('meeting'), 'Meeting')
eq(sceneLabel('lecture'), 'Lecture')
eq(iphoneCopyFor('en').sceneHelpMeeting, 'Decisions and action items', 'meeting blurb')
eq(iphoneCopyFor('en').sceneHelpLecture, 'Revision notes and homework', 'lecture blurb')
eq(iphoneCopyFor('en').sceneHelpQa, 'Hear a question, draft an answer', 'live qa blurb')

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

{
  const parsed = parseNotes(JSON.stringify({
    summary: 'Kickoff',
    speakers: [
      { label: 'Host', name: 'Tom', evidence: "Hi, I'm Tom" },
      { label: 'Guest', name: '' },
      { label: 'Host', name: 'Host' },
      { label: '', name: 'Alice' },
    ],
  }))
  eq(parsed.speakers, [{ label: 'Host', name: 'Tom', evidence: "Hi, I'm Tom" }], 'parseNotes keeps named speakers and drops empty / label-as-name')
  eq(parseNotes('{"summary":"x"}').speakers, [], 'missing speakers defaults to empty')
  const withSpeakers = { ...emptyNotes(), speakers: [{ label: 'Host', name: 'Tom' }] }
  if (exportNoteSections('meeting', withSpeakers).some((s) => s.id === 'speakers' as never)) {
    throw new Error('exportNoteSections does not render speakers')
  }
  if (!notesPrompt('meeting', [{ id: '1', ts: '0:01', text: 'Hi' }], 'en').includes('speakers')) {
    throw new Error('notesPrompt lists speakers')
  }
  if (!notesPrompt('meeting', [{ id: '1', ts: '0:01', text: 'Hi' }], 'en').toLowerCase().includes('explicitly spoken')) {
    throw new Error('notesPrompt requires explicitly spoken names')
  }
  if (!notesPrompt('meeting', [{ id: '1', ts: '0:01', text: 'Hi' }], 'en', false, {}, {}, undefined, undefined, true).includes('INCOMPLETE SESSION')) {
    throw new Error('notesPrompt incomplete flag')
  }
}

eq(notesTranscriptTooThin([]), true, 'empty is thin')
eq(notesTranscriptTooThin([{ text: 'Only one short line.' }]), true, 'one line is thin')
eq(
  notesTranscriptTooThin([
    { text: 'First line with enough words to count.' },
    { text: 'Second line continues the meeting transcript with more detail here.' },
  ]),
  false,
  'two substantive lines are not thin',
)

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

// Summarize 2 min: window by line.at. Missing at stays in the recent tail after
// the last clearly-old timestamp; with no timestamps at all, return [] so we
// never recap the whole session.
{
  const now = 1_000_000
  const line = (id: string, at?: number, text = id): MeetingLine => ({ id, ts: '0:00', text, at })
  eq(lastTwoMinutes([], now), [], 'empty transcript is empty')
  eq(
    lastTwoMinutes([line('old', now - 180_000), line('older', now - 121_000)], now).map((l) => l.id),
    [],
    'lines older than 2 min are dropped',
  )
  eq(
    lastTwoMinutes([line('keep', now - 30_000), line('fresh', now - 5_000)], now).map((l) => l.id),
    ['keep', 'fresh'],
    'lines within 2 min are kept',
  )
  eq(
    lastTwoMinutes(
      [line('old', now - 180_000), line('keep', now - 10_000), line('too-old', now - 200_000)],
      now,
    ).map((l) => l.id),
    ['keep'],
    'only in-window timestamps survive even if order is mixed',
  )
  eq(
    lastTwoMinutes(
      [line('old', now - 180_000), line('tail-unstamped'), line('fresh', now - 8_000)],
      now,
    ).map((l) => l.id),
    ['tail-unstamped', 'fresh'],
    'missing at is kept only in the recent tail after the last old timestamp',
  )
  eq(
    lastTwoMinutes([line('a'), line('b')], now).map((l) => l.id),
    [],
    'no timestamps: cannot prove a 2 min window, so do not recap the whole session',
  )
  eq(
    lastTwoMinutes([line('blank', now - 5_000, '   ')], now).map((l) => l.id),
    [],
    'blank text in the window is not speech',
  )
}

{
  const now = 2_000_000
  const old: MeetingLine = { id: 'old', ts: '0:01', text: 'Decide the launch last hour', at: now - 180_000 }
  const recent: MeetingLine = { id: 'new', ts: '0:02', text: 'Ship Friday; Priya owns email', at: now - 20_000 }
  const recap = listenAskPayload(IPHONE_COPY.quickSummarize, [old, recent], false, now)
  if (!recap) throw new Error('Summarize 2 min with recent speech must send an ask')
  eq(recap.display, 'Summarize 2 min', 'Live card question stays the chip label')
  eq(recap.listenerQuestion, IPHONE_COPY.quickSummarizeAsk, 'model gets the short 2 min recap prompt')
  eq(recap.lines.map((l) => l.id), ['new'], 'ask transcript is only the last 2 min')
  const prompt = askPrompt(recap.lines, recap.listenerQuestion, 'en')
  if (prompt.includes('last hour')) throw new Error('2 min ask must not include older transcript')
  if (!prompt.includes('Ship Friday')) throw new Error('2 min ask includes the in-window line')
  if (prompt.includes('[NOD_NOTES')) throw new Error('chip is an Ask, not whole-session Notes')
  eq(listenAskPayload(IPHONE_COPY.quickSummarize, [old], false, now), null, 'no speech in last 2 min does not fire')
  const items = listenAskPayload(IPHONE_COPY.quickActionItems, [old, recent], false, now)
  if (!items) throw new Error('action-item chip still asks')
  eq(items.listenerQuestion, IPHONE_COPY.quickActionItems, 'other chips keep their own question')
  if (!items.lines.some((l) => l.id === 'old')) throw new Error('action-item chip is not forced through the 2 min window')
}

// #275 Axios 2.5min golden: per-line Host/Guest, not STT id binding.
{
  const axiosLines: MeetingLine[] = [
    { id: '1', ts: '0:12', text: 'Mr. President, welcome to the Axios Show on HBO. We are glad you came here in person today.', speaker: 'B' },
    { id: '2', ts: '0:13', text: 'Thank you.', speaker: 'B' },
    { id: '3', ts: '0:14', text: 'We wanted to make this more of a conversation and hop around from topic to topic, and we wanted to do, Axios likes to do one big thing. And so the one big thing we want to talk about is power', speaker: 'B' },
    { id: '4', ts: '0:23', text: 'And how you think about it and in that span of time, what is the one big thing you have learned about wielding power?', speaker: 'B' },
    { id: '5', ts: '0:47', text: "Well, I think you have to do it judiciously. In my first term I learned a lot about wielding power.", speaker: 'B' },
    { id: '6', ts: '2:03', text: "But that's because you've applied lessons from your first term. What are some of those things you did differently", speaker: 'B' },
    { id: '7', ts: '2:14', text: "Well, it's a terrible answer actually, but I don't think about it that way.", speaker: 'B' },
  ]
  const names = bindSpeakerName(bindSpeakerName({}, 'B', 'meeting'), 'A', 'meeting')
  const label = (line: MeetingLine) => resolveMeetingLineLabel(line, 'meeting', names, {})
  eq(label(axiosLines[0]), 'Host', 'welcome is Host even when STT id is B')
  eq(label(axiosLines[1]), 'Guest', 'Thank you is Guest')
  if (axiosLines[0].text.includes('Thank you')) throw new Error('welcome must not include Thank you')
  eq(label(axiosLines[3]), 'Host', 'wielding power question is Host')
  if (!axiosLines[3].text.includes('about wielding power?')) throw new Error('question tail stays on host line')
  eq(label(axiosLines[4]), 'Guest', 'long Well answer is Guest')
  eq(label(axiosLines[5]), 'Host', 'host follow-up question is Host')
  eq(label(axiosLines[6]), 'Guest', 'Well answer opener is Guest')
  eq(inferMeetingLineLabel('Axios likes to do one big thing', 'meeting'), 'Host', 'host continuation phrase')
  const tb = transcriptBlock(axiosLines.slice(0, 2), false, names, 'meeting', {})
  if (!tb.includes('0:12 Host')) throw new Error('transcript block uses inferred Host')
  if (!tb.includes('0:13 Guest')) throw new Error('transcript block uses inferred Guest')
}
