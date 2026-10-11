import {
  EN_IPHONE_COPY,
  ZH_IPHONE_COPY,
} from './iphoneCopyLocales'
import {
  gapFromEvent,
  gapFromHistoryItem,
  gapLabel,
  insertGap,
  interleaveGaps,
  tsToMs,
} from './listenGap'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

eq(gapFromEvent({ type: 'listen_gap', id: 'gap-1', from_ms: 1, to_ms: 2 }), { id: 'gap-1', fromMs: 1, toMs: 2 }, 'valid event')
eq(gapFromEvent({ type: 'listen_gap', id: '', from_ms: 1, to_ms: 2 }), null, 'empty id')
eq(gapFromEvent({ type: 'listen_gap', id: 'g', from_ms: 1.5, to_ms: 2 }), null, 'non-int')
eq(gapFromEvent({ type: 'listen_gap', id: 'g', from_ms: 5, to_ms: 5 }), null, 'to<=from')

const g1 = { id: 'gap-1', fromMs: 1000, toMs: 2000 }
const g2 = { id: 'gap-2', fromMs: 500, toMs: 800 }
eq(insertGap([g1], g2), [g2, g1], 'insert sorts')
eq(insertGap([g1], g1), [g1], 'dedupe id')

eq(
  gapLabel({ id: 'g', fromMs: 65_000, toMs: 125_000 }, EN_IPHONE_COPY),
  'Not recorded 01:05–02:05 (about 60 s)',
  'en label mm:ss',
)
eq(
  gapLabel({ id: 'g', fromMs: 3_665_000, toMs: 3_726_000 }, EN_IPHONE_COPY),
  'Not recorded 1:01:05–1:02:06 (about 61 s)',
  'en label h:mm:ss',
)
eq(
  gapLabel({ id: 'g', fromMs: 20_000, toMs: 40_000 }, ZH_IPHONE_COPY),
  '未录制 00:20–00:40（约 20 秒）',
  'zh label',
)

eq(tsToMs('01:05'), 65_000, 'mm:ss to ms')
eq(tsToMs('1:01:05'), 3_665_000, 'h:mm:ss to ms')

eq(
  interleaveGaps(
    [{ ts: '01:00', text: 'a' }, { ts: '02:00', text: 'b' }],
    [{ id: 'gap-1', fromMs: 90_000, toMs: 100_000 }],
  ).map((row) => ('gap' in row ? 'gap' : row.line.text)),
  ['a', 'gap', 'b'],
  'gap before matching line',
)
eq(
  interleaveGaps([{ ts: '00:10', text: 'only' }], [{ id: 'g', fromMs: 120_000, toMs: 130_000 }]).length,
  2,
  'gap appended at end',
)
eq(
  interleaveGaps([], [{ id: 'g', fromMs: 0, toMs: 1000 }]),
  [{ gap: { id: 'g', fromMs: 0, toMs: 1000 } }],
  'empty lines only gap',
)

const upserted = insertGap(
  [{ id: 'gap-1', fromMs: 1000, toMs: 2000 }],
  { id: 'gap-1', fromMs: 1000, toMs: 5000 },
)
eq(upserted, [{ id: 'gap-1', fromMs: 1000, toMs: 5000 }], 'insertGap replaces same id')

eq(
  interleaveGaps([{ ts: '00:01', text: 'a' }, { ts: '00:02', text: 'b' }], []).map((row) => ('index' in row ? row.index : -1)),
  [0, 1],
  'line entries carry source index',
)

console.log('ok')
