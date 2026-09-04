import { formatDetectedAgo, qaAnswerParts, qaDetectedLine } from './qaCard'

function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

eq(formatDetectedAgo(800), 'just now', 'under 1.5s is just now')
eq(formatDetectedAgo(8000), '8s ago', '8 seconds')
eq(qaDetectedLine({ listening: true, msAgo: 8000 }), 'Question detected · listening', 'live question')
eq(qaDetectedLine({ generating: true, msAgo: 8000 }), 'Question detected · answering', 'busy answer')
eq(qaDetectedLine({ msAgo: 8000 }), 'Question detected · 8s ago', 'idle detected line')

const nz = qaAnswerParts('About 5.2 million people live in New Zealand as of 2024. Stats NZ updates the estimate.')
eq(nz.hero, '5.2M', 'keep 5.2 — do not invent 5.3M')
eq(nz.summary, 'About 5.2 million people live in New Zealand as of 2024.', 'first sentence is the summary')
eq(nz.more, 'Stats NZ updates the estimate.', 'later sentences sit behind More')

const noNum = qaAnswerParts('I cut admin export from v1 so the September 8 beta could ship.')
eq(noNum.hero, null, 'a date like September 8 is not a hero stat')
