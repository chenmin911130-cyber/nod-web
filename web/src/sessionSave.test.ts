import {
  KEEP_ACK_TIMEOUT_MS,
  KEEP_CAPTURE_SETTLE_MS,
  applyKeepAck,
  applyKeepFailed,
  beginSave,
  bumpGeneration,
  decideNewSession,
  emptySaveBook,
  keepAfterNotesStillValid,
  keepShouldWaitForCapture,
  savePromptSurface,
  setPendingAfterSave,
} from './sessionSave'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(KEEP_ACK_TIMEOUT_MS, 15_000, 'keep timeout is 15s')

const fresh = emptySaveBook()
eq(fresh.status, 'undecided', 'empty book is undecided')
eq(fresh.liveId, null, 'empty book has no live id')
eq(fresh.generation, 0, 'empty book starts at generation 0')
eq(fresh.offered, false, 'empty book is not offered')
eq(fresh.pendingAfterSave, 'none', 'empty book has no pending leave')

// ack id ≠ liveId → state unchanged, no pending action
{
  const book = setPendingAfterSave(beginSave(fresh, 'live-a'), 'new')
  const { book: next, action } = applyKeepAck(book, 'live-b', 'live-a', book.generation)
  if (next !== book) throw new Error('mismatched ack id must leave the book untouched')
  eq(action, 'none', 'mismatched ack must not return pendingAfterSave')
  eq(next.status, 'saving', 'mismatched ack must not mark saved')
  eq(next.pendingAfterSave, 'new', 'mismatched ack must keep pendingAfterSave on the book')
}

// ack id = liveId but generation already bumped → drop
{
  const saving = beginSave(fresh, 'live-a')
  const gen = saving.generation
  const bumped = bumpGeneration(saving)
  const { book: next, action } = applyKeepAck(bumped, 'live-a', 'live-a', gen)
  if (next !== bumped) throw new Error('bumped generation must drop a matching-id ack')
  eq(action, 'none', 'bumped generation must not return pendingAfterSave')
  eq(next.status, 'saving', 'bumped generation must not mark saved')
}

// saving → timeout → failed; failed → beginSave → saving → ack → saved
{
  let book = setPendingAfterSave(beginSave(fresh, 'live-a'), 'new')
  book = applyKeepFailed(book, 'timeout')
  eq(book.status, 'failed', 'timeout moves saving → failed')
  eq(book.pendingAfterSave, 'new', 'timeout keeps pendingAfterSave')
  book = beginSave(book, 'live-a')
  eq(book.status, 'saving', 'retry beginSave moves failed → saving')
  const { book: saved, action } = applyKeepAck(book, 'live-a', 'live-a', book.generation)
  eq(saved.status, 'saved', 'matching ack marks saved')
  eq(action, 'new', 'pendingAfterSave is returned once on saved')
  eq(saved.pendingAfterSave, 'none', 'pendingAfterSave is cleared after it is returned')
  const again = applyKeepAck(saved, 'live-a', 'live-a', saved.generation)
  eq(again.action, 'none', 'pendingAfterSave is not returned a second time')
}

{
  const idle = applyKeepFailed(fresh, 'timeout')
  if (idle !== fresh) throw new Error('failed apply on undecided must be a no-op')
}

// savePromptSurface
eq(
  savePromptSurface({ phone: true, workspaceMode: 'meeting', kept: false, offered: false, hasContent: true }),
  'banner',
  'phone first offer + meeting + content → banner',
)
eq(
  savePromptSurface({ phone: true, workspaceMode: 'meeting', kept: false, offered: true, hasContent: true }),
  'none',
  'already offered → none',
)
eq(
  savePromptSurface({ phone: true, workspaceMode: 'meeting', kept: true, offered: false, hasContent: true }),
  'none',
  'kept → none',
)
eq(
  savePromptSurface({ phone: false, workspaceMode: 'meeting', kept: false, offered: false, hasContent: true }),
  'modal',
  'non-phone meeting with content → modal',
)
eq(
  savePromptSurface({ phone: true, workspaceMode: 'translate', kept: false, offered: false, hasContent: true }),
  'none',
  'translate → none',
)
eq(
  savePromptSurface({ phone: true, workspaceMode: 'meeting', kept: false, offered: false, hasContent: false }),
  'none',
  'no content → none',
)
eq(
  savePromptSurface({ phone: false, workspaceMode: 'interview', kept: false, offered: false, hasContent: true }),
  'none',
  'interview → none',
)

// keepAfterNotes with old generation discarded
{
  const book = beginSave(fresh, 'live-a')
  const job = { liveId: 'live-a', generation: book.generation }
  if (!keepAfterNotesStillValid(job, book)) throw new Error('current generation keepAfterNotes must stay valid')
  if (keepAfterNotesStillValid(job, bumpGeneration(book))) {
    throw new Error('keepAfterNotes with old generation must be discarded')
  }
  if (keepAfterNotesStillValid({ liveId: 'other', generation: book.generation }, book)) {
    throw new Error('keepAfterNotes with a liveId mismatch must be discarded')
  }
}

eq(KEEP_CAPTURE_SETTLE_MS, 800, 'capture settle is 800ms')

const baseLeave = {
  capture: 'off',
  busy: false,
  hasContent: true,
  kept: false,
  workspaceMode: 'meeting',
}

eq(decideNewSession({ ...baseLeave, hasContent: false }), 'clear', 'no content → clear')
eq(decideNewSession({ ...baseLeave, kept: true, capture: 'off' }), 'clear', 'kept and not recording → clear')
eq(decideNewSession({ ...baseLeave, capture: 'listening' }), 'sheet', 'unsaved recording → sheet')
eq(decideNewSession({ ...baseLeave, capture: 'paused' }), 'sheet', 'unsaved paused → sheet')
eq(decideNewSession({ ...baseLeave, capture: 'off' }), 'sheet', 'unsaved ended → sheet')
eq(decideNewSession({ ...baseLeave, capture: 'listening', busy: true }), 'sheet', 'busy + unsaved → sheet')
eq(
  decideNewSession({ ...baseLeave, workspaceMode: 'translate', capture: 'listening', hasContent: true }),
  'clear',
  'translate → clear',
)

eq(
  keepShouldWaitForCapture({ capture: 'listening', lastLineAt: 1_000, now: 10_000 }),
  true,
  'listening still waits',
)
eq(
  keepShouldWaitForCapture({ capture: 'paused', lastLineAt: 1_000, now: 10_000 }),
  true,
  'paused still waits',
)
eq(
  keepShouldWaitForCapture({ capture: 'off', lastLineAt: 9_400, now: 10_000 }),
  true,
  'off + line within 800ms waits',
)
eq(
  keepShouldWaitForCapture({ capture: 'off', lastLineAt: 9_200, now: 10_000 }),
  false,
  'off + silent 800ms goes',
)
eq(
  keepShouldWaitForCapture({ capture: 'off', lastLineAt: null, now: 10_000 }),
  false,
  'off + no line goes',
)

// Save and start new: unmatched ack does not clear; matching ack clears once
{
  let book = setPendingAfterSave(beginSave(fresh, 'live-leave'), 'new')
  const stale = applyKeepAck(book, 'other-id', 'live-leave', book.generation)
  eq(stale.action, 'none', 'wrong id ack does not clear')
  eq(stale.book.pendingAfterSave, 'new', 'wrong id keeps pending new')
  eq(stale.book.status, 'saving', 'wrong id stays saving')
  const hit = applyKeepAck(book, 'live-leave', 'live-leave', book.generation)
  eq(hit.action, 'new', 'matching ack clears once')
  eq(hit.book.status, 'saved', 'matching ack marks saved')
  const twice = applyKeepAck(hit.book, 'live-leave', 'live-leave', hit.book.generation)
  eq(twice.action, 'none', 'matching ack does not clear a second time')
}

// fail → stay on session → retry → matching ack → clear
{
  let book = setPendingAfterSave(beginSave(fresh, 'live-retry'), 'new')
  book = applyKeepFailed(book, 'error')
  eq(book.status, 'failed', 'save failure stays failed on the same book')
  eq(book.pendingAfterSave, 'new', 'save failure keeps pending new')
  eq(book.liveId, 'live-retry', 'save failure stays on the same session id')
  book = beginSave(book, 'live-retry')
  eq(book.status, 'saving', 'retry starts saving again')
  const { book: saved, action } = applyKeepAck(book, 'live-retry', 'live-retry', book.generation)
  eq(action, 'new', 'retry ack then clears')
  eq(saved.status, 'saved', 'retry ack marks saved')
}

console.log('sessionSave.test.ts ok')
