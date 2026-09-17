/**
 * #281 — 122 Axios role gaps (Meeting).
 *
 * Two lines were still wrong after #277/#279:
 *  - 03:28 the host question kept the guest's leading `Yeah.`
 *  - 03:33 the G7 long-table narration was labelled Host because it ends in the
 *    oral tag `right?`
 *
 * This file drives the real `web/src/listen.ts` helpers. It intentionally re-asserts
 * the #277 goldens that #281 could regress, because `listen.test.ts` aborts earlier
 * on an unrelated stale assertion (`notesTranscriptTooThin` vs `NOTES_MIN_CHARS`)
 * and never reaches them.
 */
import type { MeetingLine } from './types'
import { bindSpeakerName, expandSplitMeetingLines, inferMeetingLineLabel, resolveMeetingLineLabel, splitMeetingTurn, transcriptBlock } from './listen'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

const label = (text: string) => inferMeetingLineLabel(text, 'meeting')

// --------------------------------------------------------------------------
// #281 requirement 1 — a trailing tag question must not force Host
// --------------------------------------------------------------------------
const G7_LONG_TABLE =
  'And then I walked into the room and it was just sort of funny, because it was a very long table, right?'
eq(label(G7_LONG_TABLE), 'Guest', '03:33 G7 long table with a trailing right? is Guest')

eq(label('How many of them believe that?'), 'Host', 'a real question stays Host')
eq(
  label('What are some of those things you did differently'),
  'Host',
  'a real question without a ? stays Host',
)
eq(
  label('You mentioned the G7, right?'),
  'Host',
  'a tag on a host line without first-person narration stays Host',
)
eq(
  label('I said, what are we doing, right?'),
  'Host',
  'a real question before the tag stays Host',
)
eq(label('You know?'), 'Host', 'a bare tag with no narration is not a guest monologue')

// --------------------------------------------------------------------------
// #281 requirement 2 — a leading `Yeah.` peels off the host question
// --------------------------------------------------------------------------
const ackSplit = splitMeetingTurn('Yeah. How many of them believe that?')
eq(ackSplit, ['Yeah.', 'How many of them believe that?'], 'leading Yeah. splits off the question')
eq(label(ackSplit[0]), 'Guest', 'the acknowledgement is Guest')
eq(label(ackSplit[1]), 'Host', 'the question is Host')

const ackVariants = [
  'Yep. How many of them believe that?',
  'Uh-huh. What are some of those things you did differently?',
]
for (const variant of ackVariants) {
  const parts = splitMeetingTurn(variant)
  eq(parts.length, 2, `ack variant splits: ${variant}`)
  eq(label(parts[0]), 'Guest', `ack variant head is Guest: ${variant}`)
  eq(label(parts[1]), 'Host', `ack variant question is Host: ${variant}`)
}

const turn122 =
  'Yeah. How many of them believe that? All of them. But I was just being funny. I was just being funny, because they were all sitting.'
const parts122 = splitMeetingTurn(turn122)
eq(parts122[0], 'Yeah.', '122 turn: Yeah. is its own line')
eq(parts122[1], 'How many of them believe that?', '122 turn: question has no leading Yeah')
if (parts122.some((p) => /^Yeah\.\s+How many/i.test(p))) throw new Error('122 turn: Yeah must not stay glued to the question')
const allOfThem = parts122.find((p) => p.startsWith('All of them'))
if (!allOfThem) throw new Error('122 turn: All of them. must stay its own line')
eq(label(allOfThem), 'Guest', '122 turn: All of them answer is Guest')

// A guest continuation after Yeah must NOT be split.
eq(
  splitMeetingTurn('Yeah. I was just being funny.'),
  ['Yeah. I was just being funny.'],
  'Yeah. plus a non-question continuation stays one line',
)

// The 03:33 narration has no leading acknowledgement to split.
eq(splitMeetingTurn(G7_LONG_TABLE), [G7_LONG_TABLE], 'G7 narration is not split by the ack rule')

// --------------------------------------------------------------------------
// #277 goldens — must keep passing (the issue forbids regressions here)
// --------------------------------------------------------------------------
const names = bindSpeakerName(bindSpeakerName({}, 'B', 'meeting'), 'A', 'meeting')
const resolved = (text: string) => resolveMeetingLineLabel({ text, speaker: 'B' }, 'meeting', names, {})

const welcomeDirty =
  'Mr. President, welcome to the Axios Show. Thank you. We wanted to make this more of a conversation than a typical interview where we are just going to hop around from topic to topic, and we wanted to do Axios likes to do one big thing. And so the one big thing we want to talk about is power and how you think about it and how you wield it.'
const welcomeParts = splitMeetingTurn(welcomeDirty)
if (welcomeParts.length < 3) throw new Error('#277 welcome dirty line must split at least three ways')
eq(resolved(welcomeParts[0]), 'Host', '#277 welcome chunk is Host')
eq(resolved(welcomeParts[1]), 'Guest', '#277 embedded Thank you is Guest')
eq(resolved(welcomeParts[2]), 'Host', '#277 opening after Thank you is Host')
if (welcomeParts[0].includes('Thank you')) throw new Error('#277 welcome chunk must not include Thank you')

const qaSplit = splitMeetingTurn(
  "Differently or better than you did before? Well, it's a terrible answer actually, but I don't think about it.",
)
eq(qaSplit.length, 2, '#277 question + Well splits')
eq(label(qaSplit[0]), 'Host', '#277 question half is Host')
eq(label(qaSplit[1]), 'Guest', '#277 Well answer is Guest')

eq(
  label("I can't believe it. I was just being cute, funny. I wasn't trying to be the boss."),
  'Guest',
  '#277 cute boss monologue is Guest',
)
eq(
  label("And so a decade ago, you first became president, and you've had loads of experience since then."),
  'Host',
  '#277 00:30 host setup without a trailing question mark is Host',
)
eq(
  label(
    "And so when you're compared to somebody like that, you look maybe better than you are. That's possible. But I feel that it's a very powerful term.",
  ),
  'Guest',
  '#277 01:49 guest And so line is not host-to-guest',
)

const g7Split = splitMeetingTurn(
  "But we had a great administration, but this one is, I think, better. You mentioned the G7. You saw a number of world leaders. You walked in and you said, I'm the boss.",
)
eq(g7Split.length, 2, '#277 guest answer + G7 question splits')
eq(label(g7Split[0]), 'Guest', '#277 03:19 better answer is Guest')
eq(label(g7Split[1]), 'Host', '#277 03:19 You mentioned the G7 is Host')

const leaderSplit = splitMeetingTurn(
  "You have experience, obviously, with world leaders from your 2 terms. What's your definition of a great leader? How do you define great? Well, you have so many different types of leaders.",
)
eq(leaderSplit.length, 2, '#277 great leader question + Well splits')
eq(label(leaderSplit[0]), 'Host', '#277 great leader questions are Host')
eq(label(leaderSplit[1]), 'Guest', '#277 Well types of leaders is Guest')

const expanded: MeetingLine[] = expandSplitMeetingLines([
  { id: '1', ts: '3:28', text: 'Yeah. How many of them believe that?', speaker: 'B' },
  { id: '2', ts: '3:33', text: G7_LONG_TABLE, speaker: 'B' },
])
const block = transcriptBlock(expanded, false, names, 'meeting', {})
if (block.includes('3:28 Host\nYeah')) throw new Error('#281 the ack line must not be Host')
if (block.includes('3:33 Host')) throw new Error('#281 the G7 narration must not be Host')

console.log('meetingRoles.test.ts: ok')
