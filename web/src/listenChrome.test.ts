import {
  askToggleAffectsCapture,
  emptyEndShowsReady,
  endedSheetAvailable,
  endedSheetGesture,
  hideListenStatusRow,
  historyRestoreHidesAsk,
  listenAskPlacement,
  nextComposeDraft,
  nextComposeFiles,
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

eq(showListenNew({ phone: true, workspace: 'meeting', listening: false, paused: false }), true, 'Listen ready shows New')
eq(showListenNew({ phone: true, workspace: 'meeting', listening: true, paused: false }), false, 'recording hides New')
eq(showListenNew({ phone: true, workspace: 'meeting', listening: false, paused: true }), false, 'paused hides New')
eq(showListenNew({ phone: true, workspace: 'meeting', listening: false, paused: false }), true, 'ended/ready still shows New')
eq(showListenNew({ phone: true, workspace: 'translate', listening: false, paused: false }), false, 'Translate never gets Listen New')
eq(showListenNew({ phone: true, workspace: 'interview', listening: false, paused: false }), false, 'Live Q&A never gets Listen New')
eq(showListenNew({ phone: false, workspace: 'meeting', listening: false, paused: false }), false, 'desktop has no compact New')

eq(hideListenStatusRow({ variant: 'listen', chrome: 'recording' }), true, 'Listen rec bar leaves the top row')
eq(hideListenStatusRow({ variant: 'listen', chrome: 'paused' }), true, 'Listen paused bar leaves the top row')
eq(hideListenStatusRow({ variant: 'listen', chrome: 'ended' }), true, 'Listen ended Continue lives in the sheet')
eq(hideListenStatusRow({ variant: 'listen', chrome: 'ready' }), false, 'Listen Ready Start stays on top')
eq(hideListenStatusRow({ variant: 'translate', chrome: 'recording' }), false, 'Translate keeps its own rec chrome')
eq(hideListenStatusRow({ variant: 'interview', chrome: 'recording' }), false, 'Q&A keeps the existing top rec row')

eq(listenAskPlacement({ phone: true, qa: false, ready: true, listening: false, paused: false, ended: false, hasContent: false }), 'hidden', 'Ready has no Ask field')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: true, paused: false, ended: false, hasContent: true }), 'bar', 'recording Ask sits in the rec bar')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: false, paused: true, ended: false, hasContent: true }), 'bar', 'paused Ask stays in the rec bar')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: false, paused: false, ended: true, hasContent: true }), 'fab', 'ended Ask is a FAB')
eq(listenAskPlacement({ phone: true, qa: false, ready: false, listening: false, paused: false, ended: false, hasContent: true }), 'dock', 'history restore with content still has Ask')
eq(listenAskPlacement({ phone: false, qa: false, ready: false, listening: true, paused: false, ended: false, hasContent: true }), 'field', 'desktop keeps the always-on field')
eq(listenAskPlacement({ phone: true, qa: true, ready: false, listening: true, paused: false, ended: false, hasContent: true }), 'field', 'Live Q&A is out of this chrome')

eq(endedSheetAvailable({ phone: true, qa: false, listening: false, paused: false, ended: true, hasContent: true }), true, 'ended with content uses the result sheet')
eq(endedSheetAvailable({ phone: true, qa: false, listening: false, paused: false, ended: true, hasContent: false }), false, 'empty end is not a result sheet')
eq(endedSheetAvailable({ phone: true, qa: false, listening: true, paused: false, ended: true, hasContent: true }), false, 'live capture is not a result sheet')
eq(endedSheetAvailable({ phone: true, qa: false, listening: false, paused: false, ended: false, hasContent: true }), false, 'history restore is not the ended sheet')
eq(emptyEndShowsReady({ ended: true, hasContent: false }), true, 'empty end stays Ready')
eq(historyRestoreHidesAsk({ ended: false, hasContent: true }), false, 'restore with content still shows Ask')
eq(historyRestoreHidesAsk({ ended: false, hasContent: false }), true, 'empty restore has nothing to ask')

eq(endedSheetGesture('handle'), 'resize', 'handle resizes the ended sheet')
eq(endedSheetGesture('tabs'), 'resize', 'tab bar may resize the ended sheet')
eq(endedSheetGesture('body'), 'scroll', 'body swipe only scrolls')

eq(nextComposeDraft('a', 'a', 'hello'), 'hello', 'same session keeps the Ask draft')
eq(nextComposeDraft('a', 'b', 'hello'), '', 'new session does not inherit the draft')
eq(nextComposeDraft('', 'b', 'hello'), '', 'missing previous key drops the draft')
eq(nextComposeFiles('a', 'a', ['x']).join(','), 'x', 'same session keeps Translate attachments')
eq(nextComposeFiles('a', 'b', ['x']).length, 0, 'new session drops Translate attachments')

eq(askToggleAffectsCapture(true), false, 'opening Ask does not stop capture')
eq(askToggleAffectsCapture(false), false, 'closing Ask does not stop capture')

const staticBars = volumeBarHeights(null)
eq(staticBars.length, 8, 'static meter has eight bars')
if (staticBars.some((h) => h <= 0 || h > 1)) throw new Error('static bars must stay in (0, 1]')
eqArr(volumeBarHeights(null), volumeBarHeights(null), 'no amplitude stays static across reads')
const live = volumeBarHeights(1)
if (live.every((h, i) => h === staticBars[i])) throw new Error('a real amplitude should raise the static shape')

console.log('listenChrome.test.ts ok')
