import { speakerSuggestions } from './speakerSuggest'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(
  speakerSuggestions({
    speakers: [{ label: 'Host', name: 'Tom', evidence: "I'm Tom" }],
    speakerNames: { '1': 'Host', '2': 'Guest' },
    decided: {},
  }),
  [{ speakerId: '1', name: 'Tom', evidence: "I'm Tom" }],
  'label Host maps to speaker id 1',
)

eq(
  speakerSuggestions({
    speakers: [{ label: 'Nobody', name: 'Tom' }],
    speakerNames: { '1': 'Host' },
    decided: {},
  }),
  [],
  'unknown label is dropped',
)

eq(
  speakerSuggestions({
    speakers: [{ label: 'Host', name: 'Tom' }],
    speakerNames: { '1': 'Host' },
    decided: { '1': 'confirmed' },
  }),
  [],
  'confirmed id is dropped',
)

eq(
  speakerSuggestions({
    speakers: [{ label: 'Host', name: 'Tom' }],
    speakerNames: { '1': 'Host' },
    decided: { '1': 'dismissed' },
  }),
  [],
  'dismissed id is dropped',
)

eq(
  speakerSuggestions({
    speakers: [{ label: 'Guest', name: 'Maya' }],
    speakerNames: { A: 'Maya', B: 'Guest' },
    decided: {},
  }),
  [],
  'name already used by another id is dropped',
)

eq(
  speakerSuggestions({
    speakers: [
      { label: 'Host', name: 'Tom', evidence: 'first' },
      { label: 'Host', name: 'Thomas', evidence: 'second' },
      { label: 'Guest', name: 'Alice' },
    ],
    speakerNames: { '1': 'Host', '2': 'Guest' },
    decided: {},
  }),
  [
    { speakerId: '1', name: 'Tom', evidence: 'first' },
    { speakerId: '2', name: 'Alice' },
  ],
  'same id keeps the first nomination only',
)

console.log('speakerSuggest.test.ts ok')
