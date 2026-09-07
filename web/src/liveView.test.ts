import { emptyNotes, sectionTitle, sceneSectionOrder } from './listen'
import {
  LIVE_MIC_HOLD_MS,
  formatActionItem,
  iphoneSummaryHeading,
  liveHeardLines,
  liveNotesLine,
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

eq(
  liveHeardLines({ lines: [], partial: 'We need to finalize the launch date before Friday.' }),
  { headline: 'We need to finalize the launch date before Friday.', previous: '' },
  'partial is the Live headline',
)
eq(
  liveHeardLines({
    lines: [
      { text: 'Sarah will confirm the marketing budget tomorrow.' },
      { text: 'We need to finalize the launch date before Friday.' },
    ],
    partial: '',
  }),
  {
    headline: 'We need to finalize the launch date before Friday.',
    previous: 'Sarah will confirm the marketing budget tomorrow.',
  },
  'Live keeps the latest line large and the one before it faded',
)

eq(
  liveNotesLine({
    lines: [{ text: 'On finalise la date avant vendredi.', translation: 'We finalize the date before Friday.' }],
    partial: '',
    translateOn: true,
  }),
  'We finalize the date before Friday.',
  'a confirmed line may show one notes-language line',
)
eq(
  liveNotesLine({
    lines: [{ text: 'On finalise la date avant vendredi.', translation: 'We finalize the date before Friday.' }],
    partial: 'Et le budget…',
    translateOn: true,
  }),
  '',
  'Live waits for the sentence to confirm before adding notes language',
)
eq(
  liveNotesLine({
    lines: [
      { text: 'Sarah will confirm the budget.', translation: 'Sarah 明天确认预算。' },
      { text: 'We finalize the date before Friday.', translation: '我们周五前定上线日。' },
    ],
    partial: '',
    translateOn: true,
  }),
  '我们周五前定上线日。',
  'only the current sentence gets a notes line',
)
eq(
  liveNotesLine({
    lines: [{ text: 'We finalize the date before Friday.', translation: 'We finalize the date before Friday.' }],
    partial: '',
    translateOn: true,
  }),
  '',
  'same-language notes do not add a second line',
)
eq(
  liveNotesLine({
    lines: [{ text: 'On finalise la date avant vendredi.', translation: 'We finalize the date before Friday.' }],
    partial: '',
    translateOn: false,
  }),
  '',
  'notes language stays off when More accurate is off',
)
eq(
  liveNotesLine({
    lines: [{ text: 'On finalise la date avant vendredi.', translation: '' }],
    partial: '',
    translateOn: true,
  }),
  '',
  'Live is not a translator — no pending dots while notes language is still coming',
)
eq(
  liveNotesLine({
    lines: [{ text: 'On finalise la date avant vendredi.', translation: '{ "summary": "On finalise la date avant vendredi.", "keyPoints": [] }' }],
    partial: '',
    translateOn: true,
  }),
  '',
  'Notes JSON leaked into a line translation is not shown as the live notes line',
)
eq(
  liveNotesLine({
    lines: [{ text: 'On finalise la date avant vendredi.', translation: '[{"summary":"x"}]' }],
    partial: '',
    translateOn: true,
  }),
  '',
  'a JSON array starting with [ is also hidden',
)
eq(
  liveNotesLine({
    lines: [{ text: '今天讲了 GPU 的浮点运算。', translation: '今天讲了 GPU 的浮点运算。' }],
    partial: '',
    translateOn: true,
  }),
  '',
  'a same-language detected turn still hides the notes line',
)
eq(
  liveNotesLine({
    lines: [{ text: '今天讲了 GPU 的浮点运算。', translation: '笔记本：今天讲了 GPU 的浮点运算。' }],
    partial: '',
    translateOn: true,
  }),
  '笔记本：今天讲了 GPU 的浮点运算。',
  'a real translation still shows',
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
