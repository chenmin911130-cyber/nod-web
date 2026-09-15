import {
  ASK_DRAG_SLOP,
  ENDED_TAP_SLOP,
  IDLE_CAPTURE_CLOCK,
  METER_BAR_PX,
  advanceCaptureClock,
  askBubbleBounds,
  askDragMoved,
  captureClockMs,
  clampAskBubble,
  clockCapture,
  composeSessionKey,
  endedDockFromPointer,
  endedHasContent,
  endedSheetAvailable,
  endedSheetGesture,
  emptyEndShowsReady,
  hideTopStatusRow,
  variantHasSave,
  historyRestoreHidesAsk,
  bottomBarMode,
  listenAskPlacement,
  LISTEN_WEB_CHROME_BOTTOM_PX,
  showNotesEmptyHint,
  nextComposeDraft,
  nextComposeFiles,
  nextComposeSessionId,
  showListenNew,
  volumeBarHeights,
} from './listenChrome'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

function eqArr(got: number[], want: number[], label: string) {
  if (got.length !== want.length || got.some((n, i) => Math.abs(n - want[i]) > 1e-9)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

const listen = { phone: true, workspace: 'meeting' as const, listening: false, paused: false }
const listenContent = { lines: 3, partial: false, catchNotes: 0, notesRaw: '' }

// ---- #193 item 1: top New is only for a finished session with content ----
eq(showListenNew({ ...listen, ended: false, hasContent: false }), false, 'Ready hides New')
eq(showListenNew({ ...listen, ended: false, hasContent: true }), false, 'History restore (not ended) hides New')
eq(showListenNew({ ...listen, listening: true, ended: false, hasContent: true }), false, 'recording hides New')
eq(showListenNew({ ...listen, paused: true, ended: false, hasContent: true }), false, 'paused hides New')
eq(showListenNew({ ...listen, ended: true, hasContent: false }), false, 'empty End stays Ready and hides New')
eq(showListenNew({ ...listen, ended: true, hasContent: true }), true, 'ended with content shows New')
eq(showListenNew({ ...listen, workspace: 'translate', ended: true, hasContent: true }), false, 'Translate never gets New')
eq(showListenNew({ ...listen, workspace: 'interview', ended: true, hasContent: true }), false, 'Live Q&A never gets New')
eq(showListenNew({ phone: false, workspace: 'meeting', listening: false, paused: false, ended: true, hasContent: true }), false, 'desktop has no compact New')

eq(endedHasContent({ lines: 0, partial: false, catchNotes: 0, notesRaw: '' }), false, 'nothing captured is not content')
eq(endedHasContent({ lines: 0, partial: false, catchNotes: 0, notesRaw: '   ' }), false, 'whitespace notes are not content')
eq(endedHasContent({ lines: 1, partial: false, catchNotes: 0, notesRaw: '' }), true, 'a line is content')
eq(endedHasContent({ lines: 0, partial: true, catchNotes: 0, notesRaw: '' }), true, 'a live partial is content')
eq(endedHasContent({ lines: 0, partial: false, catchNotes: 1, notesRaw: '' }), true, 'a catch note is content')
eq(endedHasContent({ lines: 0, partial: false, catchNotes: 0, notesRaw: 'notes' }), true, 'notes are content')
eq(endedHasContent(listenContent), true, 'the shared content shape')

// ---- bottom bar shape (items 4/5) ----
eq(bottomBarMode({ listening: true, paused: false, ended: false, hasContent: true }), 'recording', 'capture draws the rec bar')
eq(bottomBarMode({ listening: false, paused: true, ended: false, hasContent: true }), 'paused', 'pause draws the paused bar')
eq(bottomBarMode({ listening: false, paused: false, ended: true, hasContent: true }), 'ended', 'ended with content draws Continue')
eq(bottomBarMode({ listening: false, paused: false, ended: true, hasContent: false }), 'ready', 'empty end stays Ready')
eq(bottomBarMode({ listening: false, paused: false, ended: false, hasContent: false }), 'ready', 'fresh Ready')
eq(hideTopStatusRow({ variant: 'listen' }), true, 'Listen controls live in the bar')
eq(hideTopStatusRow({ variant: 'translate' }), true, 'Translate controls live in the bar')
eq(hideTopStatusRow({ variant: 'interview' }), false, 'Live Q&A keeps its own top chrome')
eq(variantHasSave({ variant: 'listen' }), true, 'Listen keeps its Save row')
eq(variantHasSave({ variant: 'interview' }), true, 'Live Q&A keeps its Save row')
eq(variantHasSave({ variant: 'translate' }), false, 'Translate offers no Save row (#193 item 8)')

// ---- #193 item 3: dragging the Ask bubble never becomes a tap ----
eq(askDragMoved({ dx: 2, dy: 3 }), false, 'a small wobble is still a tap')
eq(askDragMoved({ dx: ASK_DRAG_SLOP + 1, dy: 0 }), true, 'travel past the slop is a drag')
eq(askDragMoved({ dx: 0, dy: -(ASK_DRAG_SLOP + 2) }), true, 'a drag is a drag in any direction')
const bounds = askBubbleBounds({ viewportW: 390, viewportH: 844, size: 56, gutter: 12, topInset: 60, bottomInset: 76 })
eq(bounds.minX, 12, 'left gutter')
eq(bounds.minY, 72, 'below the top chrome')
eq(bounds.maxX, 390 - 56 - 12, 'right gutter')
eq(bounds.maxY, 844 - 76 - 56 - 12, 'above the bottom bar')
eqArr(
  [clampAskBubble({ x: -40, y: 5000, ...bounds }).x, clampAskBubble({ x: -40, y: 5000, ...bounds }).y],
  [bounds.minX, bounds.maxY],
  'a drag out of the screen is clamped back in',
)
eq(clampAskBubble({ x: 100, y: 300, ...bounds }).x, 100, 'an in-bounds position is kept')
const cramped = askBubbleBounds({ viewportW: 60, viewportH: 100, size: 56, gutter: 12, topInset: 60, bottomInset: 76 })
eqArr([cramped.minX, cramped.maxX], [12, 12], 'a cramped viewport does not invert the bounds')

// ---- #193 item 5: Translate's capture clock ----
const t0 = 1_000_000
const started = advanceCaptureClock(IDLE_CAPTURE_CLOCK, { capture: 'listening', now: t0 })
eq(captureClockMs(started, t0 + 5_000), 5_000, 'the clock runs with capture')
const stillGenerating = advanceCaptureClock(started, { capture: 'listening', now: t0 + 9_000 })
eq(captureClockMs(stillGenerating, t0 + 9_000), 9_000, 'a generating engine does not restart the clock')
const paused = advanceCaptureClock(stillGenerating, { capture: 'paused', now: t0 + 10_000 })
eq(captureClockMs(paused, t0 + 30_000), 10_000, 'pause freezes the clock')
const resumed = advanceCaptureClock(paused, { capture: 'listening', now: t0 + 30_000 })
eq(captureClockMs(resumed, t0 + 32_000), 12_000, 'resume continues from the frozen value')
const stopped = advanceCaptureClock(resumed, { capture: 'off', now: t0 + 40_000 })
eq(captureClockMs(stopped, t0 + 90_000), 20_000, 'Stop keeps the real session length for display')
const restarted = advanceCaptureClock(stopped, { capture: 'listening', now: t0 + 90_000 })
eq(captureClockMs(restarted, t0 + 91_000), 1_000, 'a new session starts from zero')
const pausedThenStopped = advanceCaptureClock(paused, { capture: 'off', now: t0 + 40_000 })
const startedAfterPausedStop = advanceCaptureClock(pausedThenStopped, { capture: 'listening', now: t0 + 50_000 })
eq(captureClockMs(startedAfterPausedStop, t0 + 51_000), 1_000, 'Pause then Stop still makes the next start a new session')
eq(advanceCaptureClock(IDLE_CAPTURE_CLOCK, { capture: 'off', now: t0 }).accumMs, 0, 'idle stays idle')
eq(clockCapture('translate', 'translate', 'listening'), 'listening', 'the clock sees its own workspace')
eq(clockCapture('meeting', 'translate', 'listening'), 'off', 'a Meeting capture never feeds the Translate clock')
eq(captureClockMs({ accumMs: 0, startedAt: null, paused: false }, t0), 0, 'an untouched clock reads zero, not a fake time')
eq(METER_BAR_PX, 22, 'item 6: the meter grew to 22px')

// ---- unchanged #190 behaviour ----
eq(listenAskPlacement({ phone: true, qa: false, ready: true, listening: false, paused: false, ended: false, hasContent: false }), 'hidden', 'Ready has no Ask field')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: true, paused: false, ended: false, hasContent: true }), 'bar', 'recording Ask sits with the bar')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: false, paused: true, ended: false, hasContent: true }), 'bar', 'paused Ask stays with the bar')
eq(showNotesEmptyHint({ ended: false, hasNotes: false }), true, 'fresh Notes still offers Start listening')
eq(showNotesEmptyHint({ ended: true, hasNotes: false }), false, 'Ended Notes does not keep the Start listening CTA')
eq(showNotesEmptyHint({ ended: true, hasNotes: true }), false, 'notes content hides the empty Start hint')
eq(showNotesEmptyHint({ ended: false, hasNotes: true }), false, 'existing notes hide the empty Start hint')
eq(LISTEN_WEB_CHROME_BOTTOM_PX, 56, 'mobile web reserves the Safari/Chrome toolbar')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: false, paused: false, ended: true, hasContent: true }), 'fab', 'ended Ask is a FAB')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: false, paused: false, ended: false, hasContent: true }), 'dock', 'history restore with content still has Ask')
eq(listenAskPlacement({ phone: false, qa: false, ready: false, listening: true, paused: false, ended: false, hasContent: true }), 'field', 'desktop keeps the always-on field')
eq(listenAskPlacement({ phone: true, qa: true, ready: false, listening: true, paused: false, ended: false, hasContent: true }), 'field', 'Live Q&A is out of this chrome')
eq(endedSheetAvailable({ phone: true, qa: false, listening: false, paused: false, ended: true, hasContent: true }), true, 'ended with content uses the result sheet')
eq(endedSheetAvailable({ phone: true, qa: false, listening: false, paused: false, ended: true, hasContent: false }), false, 'empty end is not a result sheet')
eq(endedSheetAvailable({ phone: true, qa: false, listening: true, paused: false, ended: true, hasContent: true }), false, 'live capture is not a result sheet')
eq(emptyEndShowsReady({ ended: true, hasContent: false }), true, 'empty end stays Ready')
eq(historyRestoreHidesAsk({ ended: false, hasContent: true }), false, 'restore with content still shows Ask')
eq(endedSheetGesture('handle'), 'resize', 'handle resizes the ended sheet')
eq(endedSheetGesture('body'), 'scroll', 'body swipe only scrolls')
eq(composeSessionKey('meeting', 3), 'meeting:3', 'compose key is workspace + session id')
eq(nextComposeSessionId('continue', 4), 4, 'Continue keeps the compose session')
eq(nextComposeSessionId('listen_new', 4), 5, 'New session bumps the compose session')
eq(endedDockFromPointer({ startY: 200, endY: 198, moved: false }), 'toggle', 'a tap on the handle toggles')
eq(endedDockFromPointer({ startY: 200, endY: 190, moved: false }), 'toggle', 'the tap slop boundary is still a tap')
eq(endedDockFromPointer({ startY: 200, endY: 140, moved: true }), 'expanded', 'drag up expands')
eq(endedDockFromPointer({ startY: 200, endY: 260, moved: true }), 'default', 'drag down docks default')
eq(ENDED_TAP_SLOP, 10, 'tap slop is shared with the resize handler')
eq(nextComposeDraft('a', 'a', 'hello'), 'hello', 'same session keeps the Ask draft')
eq(nextComposeDraft('a', 'b', 'hello'), '', 'new session does not inherit the draft')
eq(nextComposeFiles('a', 'a', ['x']).join(','), 'x', 'same session keeps Translate attachments')
eq(nextComposeFiles('a', 'b', ['x']).length, 0, 'new session drops Translate attachments')

const staticBars = volumeBarHeights(null)
eq(staticBars.length, 8, 'static meter has eight bars')
if (staticBars.some((h) => h <= 0 || h > 1)) throw new Error('static bars must stay in (0, 1]')
const live = volumeBarHeights(1)
if (live.every((h, i) => h === staticBars[i])) throw new Error('a real amplitude should raise the static shape')

console.log('listenChrome.test.ts ok')
