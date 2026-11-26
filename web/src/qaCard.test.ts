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

const numbered = qaAnswerParts('1. First item\n2. Second item\n3. Third item')
eq(numbered.hero, null, 'numbered list has no hero stat')
eq(numbered.summary, '1. First item\n2. Second item\n3. Third item', 'numbered list keeps newlines')
eq(numbered.more, '', 'numbered list stays together')

const bullets = qaAnswerParts('Key points:\n• Alpha\n• Beta')
eq(bullets.summary, 'Key points:\n• Alpha\n• Beta', 'bullet list keeps newlines')

const code = qaAnswerParts('    def foo():\n        return 1')
eq(code.hero, null, 'indented code has no hero stat')
eq(code.summary, '    def foo():\n        return 1', 'indented code keeps leading spaces and newlines')

const mixed = qaAnswerParts('\nHere is the helper:\n\n    def foo():\n        return 1\n')
eq(mixed.summary, 'Here is the helper:\n\n    def foo():\n        return 1', 'multi-line answer keeps blank lines and indent')
