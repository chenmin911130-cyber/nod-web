import { emptyNotes } from './listen'
import {
  LIVE_MIC_HOLD_MS,
  formatActionItem,
  iphoneSummaryHeading,
  liveHeardLines,
  liveInsightCards,
  liveNotesLine,
  liveStageMode,
  summaryPlainText,
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

eq(formatActionItem({ text: 'Confirm marketing budget tomorrow.', owner: 'Sarah' }), 'Sarah \u2192 Confirm marketing budget tomorrow.', 'owner sits in front of the action')
eq(liveInsightCards(emptyNotes()), [], 'no invented insights before notes exist')
eq(
  liveInsightCards({
    ...emptyNotes(),
    keyPoints: ['Launch date needs confirmation before Friday.'],
    actionItems: [{ text: 'Confirm marketing budget tomorrow.', owner: 'Sarah' }],
  }),
  [
    { kind: 'keyPoint', title: 'Key Point', text: 'Launch date needs confirmation before Friday.' },
    { kind: 'actionItem', title: 'Action Item', text: 'Sarah \u2192 Confirm marketing budget tomorrow.' },
  ],
  'Live cards reuse the latest notes, they do not guess',
)

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
    'Action Items',
    '• David → Finish QA',
    '',
    'Decisions',
    '• Target Tuesday',
  ].join('\n'),
  'Copy/Share uses the structured Summary, not raw JSON',
)
