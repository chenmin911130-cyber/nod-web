import { shouldMarkKeptOnAck } from './historyRestore'

function eq(got: unknown, want: unknown, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// A live save has no restored session in flight → the ack marks the current session kept.
eq(shouldMarkKeptOnAck('sess-current', null), true, 'live save ack marks current session kept')

// A keep of the restored (OLD) session acks with its id → must NOT mark the live
// session kept (its own Save prompt on Stop stays available).
eq(shouldMarkKeptOnAck('sess-old', 'sess-old'), false, 'restored-session ack must not mark the live session kept')

// An ack for the live session while a restore was in flight → marks it kept.
eq(shouldMarkKeptOnAck('sess-current', 'sess-old'), true, 'live-session ack marks kept even after a restore')

// A restored keep that never got an id back (undefined ack) is not a match.
eq(shouldMarkKeptOnAck(undefined, 'sess-old'), true, 'missing ack id never matches a restored keep')
