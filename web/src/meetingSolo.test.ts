/**
 * #325 — Meeting solo (1 person): hide Host/Guest labels and merge STT groups.
 */
import type { MeetingLine } from './types'
import {
  resolveMeetingLineLabel,
  setMeetingSpeaker,
  transcriptBlock,
} from './listen'
import { groupTranscript } from './liveView'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

const store = new Map<string, string>()

function installLocalStorage() {
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

function resetLocalStorage() {
  store.clear()
  installLocalStorage()
}

resetLocalStorage()

// 1
resetLocalStorage()
setMeetingSpeaker('1')
eq(
  resolveMeetingLineLabel(
    { text: 'I walked to the store and bought milk.', speaker: 'B' },
    'meeting',
    {},
    {},
  ),
  '',
  'solo_hides_guest',
)

// 2
resetLocalStorage()
setMeetingSpeaker('1')
eq(
  resolveMeetingLineLabel(
    { text: 'How many people came today?', speaker: 'B' },
    'meeting',
    {},
    {},
  ),
  '',
  'solo_hides_host_on_question',
)

// 3
resetLocalStorage()
setMeetingSpeaker('1')
const soloLines: MeetingLine[] = [
  { id: '1', ts: '0:01', text: 'First line here.', speaker: 'A' },
  { id: '2', ts: '0:05', text: 'Second line here.', speaker: 'B' },
]
const soloBlock = transcriptBlock(soloLines, false, {}, 'meeting', {})
if (/\bHost\b/.test(soloBlock)) throw new Error('solo_transcript_has_no_role_word: found Host')
if (/\bGuest\b/.test(soloBlock)) throw new Error('solo_transcript_has_no_role_word: found Guest')

// 4
resetLocalStorage()
setMeetingSpeaker('1')
const adjacent = [
  { ts: '0:01', text: 'Line one.', speaker: 'A' },
  { ts: '0:02', text: 'Line two.', speaker: 'B' },
]
const soloGroups = groupTranscript(adjacent, null, { scene: 'meeting' })
eq(soloGroups.length, 1, 'solo_groups_ignore_stt_id')

// 5
resetLocalStorage()
setMeetingSpeaker('2')
eq(
  resolveMeetingLineLabel(
    { text: 'I walked to the store and bought milk.', speaker: 'B' },
    'meeting',
    {},
    {},
  ),
  'Guest',
  'two_people_unchanged guest',
)
eq(
  resolveMeetingLineLabel(
    { text: 'How many people came today?', speaker: 'B' },
    'meeting',
    {},
    {},
  ),
  'Host',
  'two_people_unchanged host',
)

// 6
resetLocalStorage()
setMeetingSpeaker('1')
eq(
  resolveMeetingLineLabel(
    { text: 'Anything.', speaker: 'B' },
    'meeting',
    { B: 'Min' },
    { B: true },
  ),
  'Min',
  'locked_name_still_wins',
)

// 7
resetLocalStorage()
const lectureLine = { text: 'Some lecture content.', speaker: 'A' }
setMeetingSpeaker('1')
const lectureOne = resolveMeetingLineLabel(lectureLine, 'lecture', {}, {})
setMeetingSpeaker('2')
const lectureTwo = resolveMeetingLineLabel(lectureLine, 'lecture', {}, {})
eq(lectureOne, lectureTwo, 'lecture_and_interview_unchanged lecture')

const interviewLine = { text: 'I walked to the store and bought milk.', speaker: 'B' }
setMeetingSpeaker('1')
const interviewOne = resolveMeetingLineLabel(interviewLine, 'interview', {}, {})
setMeetingSpeaker('2')
const interviewTwo = resolveMeetingLineLabel(interviewLine, 'interview', {}, {})
eq(interviewOne, interviewTwo, 'lecture_and_interview_unchanged interview')

console.log('meetingSolo.test.ts: ok')
