import { SIGN_COVERS, nextSignCover, prevSignCover, signCoverById } from './signCovers'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

eq(
  SIGN_COVERS.map((item) => item.id),
  ['listen', 'understand', 'remember'],
  'login covers follow Listen / Understand / Remember',
)
eq(
  SIGN_COVERS.map((item) => item.src),
  ['/covers/listen.png', '/covers/understand.png', '/covers/remember.png'],
  'covers live under /covers',
)
eq(SIGN_COVERS[0].title, 'Listen.', 'first cover title')
eq(SIGN_COVERS[1].title, 'Understand.', 'second cover title')
eq(SIGN_COVERS[2].title, 'Remember.', 'third cover title')
eq(nextSignCover('listen'), 'understand', 'listen advances to understand')
eq(nextSignCover('understand'), 'remember', 'understand advances to remember')
eq(nextSignCover('remember'), 'listen', 'remember wraps to listen')
eq(prevSignCover('listen'), 'remember', 'listen wraps back to remember')
eq(signCoverById('understand').line, 'Translate every conversation as it happens.', 'understand line')
eq(signCoverById('missing' as 'listen').id, 'listen', 'unknown cover falls back to listen')
