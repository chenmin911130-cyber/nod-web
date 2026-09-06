import {
  applyKeepFailed,
  applyKeptAck,
  beginLiveSession,
  bindLiveSessionId,
  decideSavePrompt,
  emptySaveBook,
  isPlaceholderId,
  KEEP_ACK_TIMEOUT_MS,
  keepAckContinuesPending,
  keepAckMatchesTarget,
  keepAfterNotesStillValid,
  liveDisposition,
  markRestoreSeen,
  restorePromptBody,
  setLiveDisposition,
  shouldBindEngineSessionId,
  shouldShowSaveBanner,
} from './sessionSave'

function eq(got: unknown, want: unknown, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

const meeting = {
  workspaceMode: 'meeting',
  hasContent: true,
  disposition: 'undecided' as const,
}

// --- Four confirmed popup bugs ---

eq(
  decideSavePrompt({ reason: 'stop', ...meeting }).kind,
  'none',
  '1. phone Stop must not open a blocking Save dialog',
)
eq(
  decideSavePrompt({ reason: 'engine', ...meeting }).kind,
  'none',
  '1. engine save_prompt must not open a blocking Save dialog',
)
eq(
  decideSavePrompt({ reason: 'engine', ...meeting, disposition: 'discarded' }).kind,
  'none',
  '1. late save_prompt after Don\'t save must not reopen Save',
)
eq(
  decideSavePrompt({ reason: 'engine', ...meeting, disposition: 'saving' }).kind,
  'none',
  '1. late save_prompt while saving must not reopen Save',
)

eq(
  decideSavePrompt({ reason: 'leave', ...meeting, disposition: 'discarded' }).kind,
  'none',
  '2. Don\'t save is a decision — New session must not ask again',
)
eq(
  decideSavePrompt({ reason: 'leave', ...meeting }).kind,
  'modal',
  '2. leaving an undecided session with content asks once',
)

eq(
  decideSavePrompt({
    reason: 'restore',
    workspaceMode: 'meeting',
    hasContent: false,
    disposition: 'undecided',
    listening: true,
    restore: { id: 'old', title: 'Standup', startedAt: '2026-09-06T01:00:00.000Z' },
  }).kind,
  'none',
  '3. restore must not interrupt a live recording',
)
eq(
  decideSavePrompt({
    reason: 'restore',
    workspaceMode: 'translate',
    hasContent: false,
    disposition: 'undecided',
    listenWanted: true,
    restore: { id: 'old', title: 'Standup', startedAt: '2026-09-06T01:00:00.000Z' },
  }).kind,
  'none',
  '3. restore must not interrupt a listen that already started',
)
eq(
  decideSavePrompt({
    reason: 'restore',
    workspaceMode: 'meeting',
    hasContent: true,
    disposition: 'undecided',
    liveId: 'live-2',
    restore: { id: 'old', title: 'Standup', startedAt: '2026-09-06T01:00:00.000Z' },
  }).kind,
  'none',
  '3. restore must not cover a different session that already has content',
)
const restoreIdle = decideSavePrompt({
  reason: 'restore',
  workspaceMode: 'interview',
  hasContent: false,
  disposition: 'undecided',
  restore: { id: 'old', title: 'Standup', startedAt: '2026-09-06T01:00:00.000Z' },
})
eq(restoreIdle.kind, 'modal', '3. idle reconnect may offer restore')
if (restoreIdle.kind === 'modal') eq(restoreIdle.source, 'restore', '3. restore modal is tagged restore, not live Save')

eq(
  decideSavePrompt({ reason: 'stop', workspaceMode: 'meeting', hasContent: false, disposition: 'undecided' }).kind,
  'none',
  '4. empty Stop must not ask to save',
)
eq(
  shouldShowSaveBanner({
    workspaceMode: 'meeting',
    ended: true,
    hasContent: false,
    disposition: 'undecided',
  }),
  false,
  '4. empty Stop must not show the Save banner',
)
eq(
  decideSavePrompt({ reason: 'leave', ...meeting, disposition: 'saving' }).kind,
  'none',
  '4. saving is decided — do not ask again while Notes finish',
)

// --- Banner after a normal stop ---

eq(
  shouldShowSaveBanner({
    workspaceMode: 'meeting',
    ended: true,
    hasContent: true,
    disposition: 'undecided',
  }),
  true,
  'stopped Meeting with content shows a non-blocking Save entry',
)
eq(
  shouldShowSaveBanner({
    workspaceMode: 'meeting',
    ended: true,
    hasContent: true,
    disposition: 'undecided',
    paused: true,
  }),
  false,
  'Pause must not show Save',
)
eq(
  shouldShowSaveBanner({
    workspaceMode: 'meeting',
    ended: true,
    hasContent: true,
    disposition: 'discarded',
  }),
  false,
  'Don\'t save hides the banner',
)
eq(
  shouldShowSaveBanner({
    workspaceMode: 'meeting',
    ended: true,
    hasContent: true,
    disposition: 'saved',
  }),
  false,
  'already saved hides the banner',
)
eq(
  shouldShowSaveBanner({
    workspaceMode: 'meeting',
    ended: true,
    hasContent: true,
    disposition: 'undecided',
    promptOpen: true,
  }),
  false,
  'blocking prompt and banner are not both open',
)

// --- Per-session book ---

const fresh = emptySaveBook()
eq(isPlaceholderId(fresh.liveId), true, 'new book starts on a local live id')
eq(liveDisposition(fresh), 'undecided', 'new live session is undecided')

const discarded = setLiveDisposition(fresh, 'discarded')
eq(liveDisposition(discarded), 'discarded', 'Don\'t save marks the live session discarded')

const next = beginLiveSession(discarded)
eq(next.liveId === discarded.liveId, false, 'New session gets a new live id')
eq(liveDisposition(next), 'undecided', 'the new live session is undecided again')
eq(next.byId[discarded.liveId], 'discarded', 'the abandoned session stays discarded')

const bound = bindLiveSessionId(fresh, 'sess-1')
eq(bound.liveId, 'sess-1', 'engine save_prompt binds the server session id')
eq(liveDisposition(bound), 'undecided', 'binding keeps the current disposition')

const rebound = bindLiveSessionId(bound, 'sess-1')
eq(rebound.liveId, 'sess-1', 'binding the same id is a no-op')

const late = bindLiveSessionId(beginLiveSession(bound), 'sess-1')
eq(late.liveId === 'sess-1', false, 'a late save_prompt must not steal a newer live session')

eq(shouldBindEngineSessionId({ listening: true, listenWanted: false }), false, 'do not bind ids during a live listen')
eq(shouldBindEngineSessionId({ listening: false, listenWanted: true }), false, 'do not bind ids when a new listen is already wanted')
eq(shouldBindEngineSessionId({ listening: false, listenWanted: false, paused: true }), false, 'do not bind ids while paused')
eq(shouldBindEngineSessionId({ listening: false, listenWanted: false }), true, 'idle stop may adopt the save_prompt id')

const savedLive = applyKeptAck(setLiveDisposition(bound, 'saving'), 'sess-1', 'sess-1')
eq(savedLive.byId['sess-1'], 'saved', 'history_kept for the live id marks it saved')
eq(savedLive.liveId, 'sess-1', 'live id stays on the kept session')

const afterNew = beginLiveSession(setLiveDisposition(bound, 'saving'))
const ackOld = applyKeptAck(afterNew, 'sess-1', 'sess-1')
eq(ackOld.byId['sess-1'], 'saved', 'ack of an old keep still marks that id saved')
eq(liveDisposition(ackOld), 'undecided', 'ack of an old keep must not mark the new live session saved')

eq(KEEP_ACK_TIMEOUT_MS > 0, true, 'keep waits for an ack with a timeout')
eq(
  keepAckMatchesTarget({ intendedId: 'sess-1', liveId: 'sess-1', ackId: 'sess-1' }),
  true,
  'ack for the keep target matches',
)
eq(
  keepAckMatchesTarget({ intendedId: 'sess-1', liveId: 'sess-1', ackId: 'sess-old' }),
  false,
  'another session\'s ack does not match the live keep',
)
eq(
  keepAckMatchesTarget({ intendedId: 'sess-1', liveId: 'sess-1' }),
  false,
  'a keep success requires an ack id',
)
eq(
  keepAckContinuesPending({ pending: 'new', intendedId: 'sess-1', liveId: 'sess-1', ackId: 'sess-1' }),
  true,
  'matching live history_kept continues a waiting New session',
)
eq(
  keepAckContinuesPending({ pending: 'new', intendedId: 'sess-1', liveId: 'sess-1', ackId: 'sess-old' }),
  false,
  'an old session\'s history_kept must not continue New session',
)
eq(
  keepAckContinuesPending({ pending: 'start', intendedId: 'sess-1', liveId: 'live-2', ackId: 'old' }),
  false,
  'restored-session ack must not start a new live listen',
)
eq(
  keepAckContinuesPending({ pending: null, intendedId: 'sess-1', liveId: 'sess-1', ackId: 'sess-1' }),
  false,
  'no waiting action stays put after keep',
)

const deferred = { liveId: fresh.liveId, generation: fresh.generation }
eq(keepAfterNotesStillValid(deferred, fresh), true, 'deferred keep stays valid for this live generation')
eq(keepAfterNotesStillValid(deferred, beginLiveSession(fresh)), false, 'clear / New session invalidates the deferred keep')
const boundSameGen = bindLiveSessionId(fresh, 'sess-bound')
eq(keepAfterNotesStillValid(deferred, boundSameGen), true, 'binding the server id does not drop a deferred keep')

const failed = applyKeepFailed(setLiveDisposition(bound, 'saving'), 'sess-1')
eq(failed.byId['sess-1'], 'undecided', 'keep failure leaves the session undecided so Save can retry')
eq(
  applyKeepFailed(setLiveDisposition(bound, 'saved'), 'sess-1').byId['sess-1'],
  'saved',
  'a failed ack must not un-save an already kept session',
)
eq(
  applyKeepFailed(setLiveDisposition(bound, 'saving'), 'sess-1', 'sess-old').byId['sess-1'],
  'saving',
  'a failed ack for another session must not drop the current save',
)
eq(
  applyKeptAck(setLiveDisposition(bound, 'saving'), 'sess-old', 'sess-1').byId['sess-1'],
  'saving',
  'history_kept for another session must not mark the live keep saved',
)
const reboundSaving = bindLiveSessionId(setLiveDisposition(fresh, 'saving'), 'sess-late')
eq(liveDisposition(applyKeepFailed(reboundSaving, fresh.liveId)), 'undecided', 'timeout after bind still leaves the live session retryable')

eq(
  decideSavePrompt({
    reason: 'restore',
    workspaceMode: 'meeting',
    hasContent: false,
    disposition: 'undecided',
    restore: { id: 'old', title: 'Standup', startedAt: null },
    seenRestoreIds: markRestoreSeen(emptySaveBook(), 'old').seenRestoreIds,
  }).kind,
  'none',
  'the same restore offer is not shown twice',
)

eq(
  decideSavePrompt({ reason: 'user', ...meeting }).kind,
  'modal',
  'tapping Save still opens the keep sheet',
)
eq(
  decideSavePrompt({ reason: 'user', ...meeting, disposition: 'saved' }).kind,
  'none',
  'tapping Save after keep opens History instead',
)
eq(
  decideSavePrompt({ reason: 'leave', workspaceMode: 'interview', hasContent: true, disposition: 'undecided' }).kind,
  'none',
  'Interview does not use the Meeting Save prompt',
)
eq(
  decideSavePrompt({ reason: 'engine', workspaceMode: 'meeting', hasContent: true, disposition: 'undecided', paused: true }).kind,
  'none',
  'Pause must not offer Save',
)

const restoreLine = restorePromptBody(
  { id: 'old', title: 'Standup', startedAt: new Date(2026, 8, 6, 9, 41).toISOString(), sttSeconds: 48 * 60 },
  new Date(2026, 8, 6, 14, 0).getTime(),
)
if (!restoreLine.includes('Standup') || !restoreLine.includes('Today')) {
  throw new Error(`restore copy must include title and time, got "${restoreLine}"`)
}

console.log('sessionSave.test.ts ok')
