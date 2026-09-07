import { KEYBOARD_OPEN_PX, keyboardFrame, keyboardOverlap, visualBoxForFrame } from './keyboardInset'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

eq(keyboardOverlap(852, null), 0, 'no visual viewport means no keyboard overlap')
eq(
  keyboardOverlap(852, { height: 852, offsetTop: 0 }),
  0,
  'full-height visual viewport is idle',
)
eq(
  keyboardOverlap(852, { height: 500, offsetTop: 0 }),
  352,
  'keyboard overlap is the missing visual height',
)
eq(
  keyboardOverlap(852, { height: 500, offsetTop: 40 }),
  312,
  'iOS scroll offset is not counted twice as overlap',
)

eq(
  keyboardFrame(852, { height: 852, offsetTop: 0 }),
  { height: 852, shiftY: 0, overlap: 0, open: false },
  'idle frame fills the layout height',
)
eq(
  keyboardFrame(852, { height: 500, offsetTop: 0 }),
  { height: 500, shiftY: 0, overlap: 352, open: true },
  'open keyboard pins the app to the visible height',
)
eq(
  keyboardFrame(852, { height: 480, offsetTop: 36 }),
  { height: 480, shiftY: 36, overlap: 336, open: true },
  'iOS focus-scroll is undone by shifting the pinned frame back',
)
eq(
  keyboardFrame(852, null),
  { height: 852, shiftY: 0, overlap: 0, open: false },
  'missing visual viewport keeps the layout height',
)
eq(
  keyboardFrame(852, { height: 852, offsetTop: 0 }, true),
  { height: 852, shiftY: 0, overlap: 0, open: true },
  'a focused field is keyboard-open even if the WebView already resized',
)

eq(KEYBOARD_OPEN_PX, 80, 'small toolbar jitter is not a keyboard')
eq(keyboardFrame(852, { height: 800, offsetTop: 0 }).open, false, 'a 52px shrink stays closed')

eq(visualBoxForFrame(null, true), null, 'native visual box stays null without a viewport')
eq(
  visualBoxForFrame({ height: 516, offsetTop: 60 }, true),
  { height: 516, offsetTop: 0 },
  'native keyboard does not shift the pinned frame by offsetTop',
)
eq(
  visualBoxForFrame({ height: 516, offsetTop: 60 }, false),
  { height: 516, offsetTop: 60 },
  'web still reports iOS visualViewport offsetTop',
)
