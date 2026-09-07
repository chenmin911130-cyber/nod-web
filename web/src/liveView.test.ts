import { emptyNotes, sectionTitle, sceneSectionOrder } from './listen'
import {
  LIVE_MIC_HOLD_MS,
  formatActionItem,
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
      { id: 'a', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.' },
      { id: 'b', ts: '12:18', speaker: '2', text: 'I’ll own the design review.' },
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
      { id: 'b', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.' },
      { id: 'c', ts: '12:18', speaker: '2', text: 'I’ll own the design review.' },
      { id: 'd', ts: '12:26', speaker: '1', text: 'I’ll prepare the checklist.' },
      { id: 'e', ts: '12:34', speaker: '2', text: 'Can we confirm tomorrow?' },
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
      { id: 'a', ts: '12:10', speaker: '1', text: 'Let’s finish the onboarding update by Friday.' },
      { id: 'b', ts: '12:18', speaker: '1', text: 'I’ll prepare the checklist before our next meeting.' },
    ],
    draft: null,
  },
  'two consecutive same-speaker lines are both kept and not merged',
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
