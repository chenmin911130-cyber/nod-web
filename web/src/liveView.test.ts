import { emptyNotes, sectionTitle, sceneSectionOrder } from './listen'
import {
  LIVE_MIC_HOLD_MS,
  askOutcome,
  formatActionItem,
  groupTranscript,
  iphoneSummaryHeading,
  liveFeed,
  liveStageMode,
  summaryPlainText,
  transcriptPlainText,
} from './liveView'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

eq(liveStageMode({ listening: false, elapsedMs: 0, hasHeardText: false }), 'mic', 'idle keeps the big mic')
eq(liveStageMode({ listening: true, elapsedMs: 800, hasHeardText: false }), 'mic', 'first seconds still show the mic')
eq(
  liveStageMode({ listening: true, elapsedMs: LIVE_MIC_HOLD_MS, hasHeardText: false }),
  'content',
  'after a few seconds Live gives the screen to content',
)
eq(
  liveStageMode({ listening: true, elapsedMs: 200, hasHeardText: true }),
  'content',
  'first words switch Live to content immediately',
)
eq(
  liveStageMode({ listening: false, elapsedMs: 0, hasHeardText: true }),
  'content',
  'paused or stopped Live stays on content once words exist',
)

eq(liveFeed({ lines: [], partial: '', partialSpeaker: '' }), { items: [], draft: null }, 'empty Live feed has no items or draft')
eq(
  liveFeed({
    lines: [
      { id: 'a', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.' },
      { id: 'b', ts: '12:18', speaker: '2', text: 'I’ll own the design review.' },
    ],
    partial: '',
  }),
  {
    items: [
      { type: 'line', id: 'a', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.', at: 0 },
      { type: 'line', id: 'b', ts: '12:18', speaker: '2', text: 'I’ll own the design review.', at: 0 },
    ],
    draft: null,
  },
  'fewer than max confirmed lines all stay',
)
eq(
  liveFeed({
    lines: [
      { id: 'a', ts: '12:02', speaker: '1', text: 'Old opener.' },
      { id: 'b', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.' },
      { id: 'c', ts: '12:18', speaker: '2', text: 'I’ll own the design review.' },
      { id: 'd', ts: '12:26', speaker: '1', text: 'I’ll prepare the checklist.' },
      { id: 'e', ts: '12:34', speaker: '2', text: 'Can we confirm tomorrow?' },
    ],
    partial: '',
    max: 4,
  }),
  {
    items: [
      { type: 'line', id: 'b', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.', at: 0 },
      { type: 'line', id: 'c', ts: '12:18', speaker: '2', text: 'I’ll own the design review.', at: 0 },
      { type: 'line', id: 'd', ts: '12:26', speaker: '1', text: 'I’ll prepare the checklist.', at: 0 },
      { type: 'line', id: 'e', ts: '12:34', speaker: '2', text: 'Can we confirm tomorrow?', at: 0 },
    ],
    draft: null,
  },
  'more than max keeps only the last max confirmed lines',
)
eq(
  liveFeed({ lines: [], partial: 'We need to finalize the launch date.', partialSpeaker: '1' }),
  { items: [], draft: { speaker: '1', text: 'We need to finalize the launch date.' } },
  'only a partial becomes the Live draft',
)
eq(
  liveFeed({
    lines: [
      { id: 'a', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.' },
      { id: 'b', ts: '12:18', speaker: '1', text: 'I’ll prepare the checklist before our next meeting.' },
    ],
    partial: '',
  }),
  {
    items: [
      { type: 'line', id: 'a', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.', at: 0 },
      { type: 'line', id: 'b', ts: '12:18', speaker: '1', text: 'I’ll prepare the checklist before our next meeting.', at: 0 },
    ],
    draft: null,
  },
  'two consecutive same-speaker lines are both kept and not merged',
)

eq(askOutcome({ note: { text: '' }, busy: true, lastError: null }), 'pending', 'in-flight empty ask is pending')
eq(askOutcome({ note: { text: 'Tuesday is the launch date.' }, busy: false, lastError: null }), 'done', 'filled ask is done')
eq(askOutcome({ note: { text: '' }, busy: false, lastError: 'Generation failed' }), 'failed', 'empty ask with an error is failed')
eq(askOutcome({ note: { text: '' }, busy: false, lastError: null }), 'failed', 'busy dropped with empty text is failed')
eq(askOutcome({ note: { text: 'Still here' }, busy: false, lastError: 'Generation failed' }), 'done', 'text wins over lastError')

eq(
  liveFeed({
    lines: [
      { id: 'l1', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.', at: 1000 },
      { id: 'l2', ts: '12:18', speaker: '2', text: 'I’ll own the design review.', at: 3000 },
    ],
    partial: '',
    catchNotes: [
      { id: 'a1', title: 'Ask', kind: 'ask', question: 'What is the launch date?', text: 'Friday.', at: 2000 },
    ],
  }),
  {
    items: [
      { type: 'line', id: 'l1', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.', at: 1000 },
      { type: 'ask', id: 'a1', question: 'What is the launch date?', answer: 'Friday.', status: 'done', at: 2000 },
      { type: 'line', id: 'l2', ts: '12:18', speaker: '2', text: 'I’ll own the design review.', at: 3000 },
    ],
    draft: null,
  },
  'ask items interleave with lines by at',
)
eq(
  liveFeed({
    lines: [
      { id: 'a', ts: '12:02', speaker: '1', text: 'Old opener.', at: 100 },
      { id: 'b', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.', at: 200 },
      { id: 'c', ts: '12:18', speaker: '2', text: 'I’ll own the design review.', at: 300 },
      { id: 'd', ts: '12:26', speaker: '1', text: 'I’ll prepare the checklist.', at: 400 },
      { id: 'e', ts: '12:34', speaker: '2', text: 'Can we confirm tomorrow?', at: 500 },
    ],
    partial: '',
    max: 4,
    catchNotes: [
      { id: 'early', title: 'Ask', kind: 'ask', question: 'Early question?', text: 'Early answer.', at: 150 },
      { id: 'late', title: 'Ask', kind: 'ask', question: 'Late question?', text: 'Late answer.', at: 450 },
    ],
  }).items.map((item) => item.id),
  ['early', 'b', 'c', 'd', 'late', 'e'],
  'max trims lines only; every ask stays in the window',
)
eq(
  liveFeed({
    lines: [{ id: 'l1', ts: '12:10', speaker: '1', text: 'Hello', at: 1000 }],
    partial: '',
    catchNotes: [{ id: 'a1', title: 'Ask', kind: 'ask', question: 'What next?', text: '', at: 2000 }],
    busy: true,
    catchAskId: 'a1',
  }).items.find((item) => item.type === 'ask'),
  { type: 'ask', id: 'a1', question: 'What next?', answer: '', status: 'pending', at: 2000 },
  'in-flight ask is pending Thinking…',
)
eq(
  liveFeed({
    lines: [{ id: 'l1', ts: '12:10', speaker: '1', text: 'Hello', at: 1000 }],
    partial: '',
    catchNotes: [{ id: 'a1', title: 'Ask', kind: 'ask', question: 'What next?', text: 'Ship Friday.', at: 2000 }],
    busy: false,
    catchAskId: '',
  }).items.find((item) => item.type === 'ask'),
  { type: 'ask', id: 'a1', question: 'What next?', answer: 'Ship Friday.', status: 'done', at: 2000 },
  'answered ask is done',
)
eq(
  liveFeed({
    lines: [{ id: 'l1', ts: '12:10', speaker: '1', text: 'Hello', at: 1000 }],
    partial: '',
    catchNotes: [{ id: 'a1', title: 'Ask', kind: 'ask', question: 'What next?', text: '', at: 2000 }],
    busy: false,
    catchAskId: 'a1',
    lastError: 'Generation failed',
  }).items.find((item) => item.type === 'ask'),
  { type: 'ask', id: 'a1', question: 'What next?', answer: '', status: 'failed', at: 2000 },
  'empty ask after busy/error is failed',
)
eq(
  liveFeed({
    lines: [{ id: 'l1', ts: '12:10', speaker: '1', text: 'Hello', at: 1000 }],
    partial: '',
    catchNotes: [
      { id: 'c1', title: 'Summary', kind: 'catch', question: '', text: 'Notes chapter.', at: 1500 },
      { id: 'c2', title: 'Summary', text: 'Legacy catch without kind.', at: 1600 },
    ],
  }).items.filter((item) => item.type === 'ask'),
  [],
  'Summary and catch kind notes stay out of the Live feed',
)

eq(formatActionItem({ text: 'Confirm marketing budget tomorrow.', owner: 'Sarah' }), 'Sarah \u2192 Confirm marketing budget tomorrow.', 'owner sits in front of the action')

eq(iphoneSummaryHeading('meeting', 'summary'), 'Summary', 'Summary page uses the shared section title')
eq(iphoneSummaryHeading('meeting', 'keyPoints'), 'Key Points', 'points use the shared section title')
eq(iphoneSummaryHeading('lecture', 'summary'), 'Lecture overview', 'lecture keeps its own heading')

eq(
  summaryPlainText({
    scene: 'meeting',
    notes: {
      ...emptyNotes(),
      summary: 'Tuesday is the tentative launch date.',
      keyPoints: ['Marketing starts Monday'],
      actionItems: [{ text: 'Finish QA', owner: 'David' }],
      decisions: ['Target Tuesday'],
    },
  }),
  [
    'Summary',
    'Tuesday is the tentative launch date.',
    '',
    'Key Points',
    '• Marketing starts Monday',
    '',
    'Decisions',
    '• Target Tuesday',
    '',
    'Action Items',
    '• David → Finish QA',
  ].join('\n'),
  'Copy/Share uses the structured Summary, not raw JSON',
)

// item1: lecture copy/Share order follows sceneSectionOrder('lecture') — the
// single source — and uses the lecture section titles.
const lecText = summaryPlainText({
  scene: 'lecture',
  notes: {
    ...emptyNotes(),
    summary: 'The professor covered electromagnetic flux.',
    keyPoints: ['Flux is the rate of field flow through a surface'],
    importantDetails: ['The unit is the weber'],
    revisionNotes: ['Revise Lenz law'],
    followUps: ['Read chapter 4'],
  },
})
const expectLecOrder = sceneSectionOrder('lecture').map((id) => sectionTitle('lecture', id))
const lecIdx = expectLecOrder.map((t) => lecText.indexOf(t))
if (lecIdx.some((i) => i < 0)) throw new Error(`lecture plain text missing a heading: ${JSON.stringify(expectLecOrder)} in ${JSON.stringify(lecText)}`)
if (lecIdx.some((v, i) => i > 0 && v < lecIdx[i - 1])) throw new Error('lecture headings out of SCENE_SECTIONS order')

eq(
  transcriptPlainText({
    lines: [
      { ts: '00:12', text: 'Let’s finish the onboarding update by Friday.', speaker: '1' },
      { ts: '00:18', text: 'I can take the email draft.', speaker: '2' },
      { ts: '00:24', text: 'Ship it after QA.', speaker: '1' },
    ],
    speakerNames: { '1': 'Speaker 1', '2': 'Speaker 2' },
    translateOn: false,
  }),
  [
    '[00:12] Speaker 1: Let’s finish the onboarding update by Friday.',
    '[00:18] Speaker 2: I can take the email draft.',
    '[00:24] Speaker 1: Ship it after QA.',
  ].join('\n'),
  'Copy writes three timestamped speaker turns',
)

eq(
  transcriptPlainText({
    lines: [
      {
        ts: '00:12',
        text: 'Let’s finish the onboarding update by Friday.',
        speaker: '1',
        translation: '我们周五前完成入职流程更新。',
      },
    ],
    speakerNames: { '1': 'Speaker 1' },
    translateOn: true,
  }),
  [
    '[00:12] Speaker 1: Let’s finish the onboarding update by Friday.',
    '    我们周五前完成入职流程更新。',
  ].join('\n'),
  'Copy indents a real translation on the next line',
)

eq(
  transcriptPlainText({
    lines: [
      {
        ts: '00:12',
        text: 'Let’s finish the onboarding update by Friday.',
        speaker: '1',
        translation: 'Let’s finish the onboarding update by Friday.',
      },
    ],
    speakerNames: { '1': 'Speaker 1' },
    translateOn: true,
  }),
  '[00:12] Speaker 1: Let’s finish the onboarding update by Friday.',
  'Copy does not repeat a same-language translation',
)

eq(
  transcriptPlainText({
    lines: [
      {
        ts: '00:12',
        text: 'Let’s finish the onboarding update by Friday.',
        speaker: '1',
        translation: '我们周五前完成入职流程更新。',
      },
    ],
    speakerNames: { '1': 'Speaker 1' },
    translateOn: false,
  }),
  '[00:12] Speaker 1: Let’s finish the onboarding update by Friday.',
  'Copy stays original-only when translation is off',
)

eq(
  groupTranscript([
    { id: 'a', ts: '00:09', text: 'First.', speaker: '1' },
    { id: 'b', ts: '00:20', text: 'Second.', speaker: '1' },
  ]),
  [
    {
      speaker: '1',
      startTs: '00:09',
      lines: [
        { id: 'a', ts: '00:09', text: 'First.', speaker: '1' },
        { id: 'b', ts: '00:20', text: 'Second.', speaker: '1' },
      ],
    },
  ],
  'consecutive same speaker is one group',
)

eq(
  groupTranscript([
    { id: 'a', ts: '00:09', text: 'Host line.', speaker: '1' },
    { id: 'b', ts: '00:22', text: 'Guest line.', speaker: '2' },
    { id: 'c', ts: '00:31', text: 'Host again.', speaker: '1' },
  ]).map((g) => ({ speaker: g.speaker, startTs: g.startTs, n: g.lines.length })),
  [
    { speaker: '1', startTs: '00:09', n: 1 },
    { speaker: '2', startTs: '00:22', n: 1 },
    { speaker: '1', startTs: '00:31', n: 1 },
  ],
  'alternating speakers start a new group each time',
)

eq(
  groupTranscript(
    [{ id: 'a', ts: '00:09', text: 'Host line.', speaker: '1' }],
    { text: 'As you can see', speaker: '1' },
  ),
  [
    {
      speaker: '1',
      startTs: '00:09',
      lines: [{ id: 'a', ts: '00:09', text: 'Host line.', speaker: '1' }],
      draft: { text: 'As you can see', speaker: '1' },
    },
  ],
  'draft joins the last group when the speaker matches',
)

eq(
  groupTranscript(
    [{ id: 'a', ts: '00:09', text: 'Host line.', speaker: '1' }],
    { text: 'Guest drafting', speaker: '2' },
  ).map((g) => ({ speaker: g.speaker, lines: g.lines.length, draft: g.draft?.text || '' })),
  [
    { speaker: '1', lines: 1, draft: '' },
    { speaker: '2', lines: 0, draft: 'Guest drafting' },
  ],
  'draft of a different speaker is its own last group',
)

eq(
  groupTranscript(
    [
      { id: 'a', ts: '00:05', text: 'No id.', speaker: '' },
      { id: 'b', ts: '00:08', text: 'Still none.', speaker: undefined },
    ],
    { text: 'more', speaker: '' },
  ).map((g) => ({ speaker: g.speaker, n: g.lines.length, draft: Boolean(g.draft) })),
  [{ speaker: '', n: 2, draft: true }],
  'empty speaker ids group together and take the draft',
)
