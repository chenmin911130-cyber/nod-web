import { restoreFromSession } from './historyRestore'
import type { HistorySession } from './components/HistoryPane'

function at(h: number, m: number, s = 0): string {
  return new Date(2026, 7, 31, h, m, s).toISOString()
}

function eq(got: string, want: string, label: string) {
  if (got !== want) throw new Error(`${label}: expected "${want}", got "${got}"`)
}

// A translate session stores each line as a transcript+translate pair, so the
// transcript items are interleaved with translate items. The pair's timestamp
// must come from ITS OWN transcript line, not from items[i] where i is the
// transcript-index offset into the full items array.
const session: HistorySession = {
  id: 's1',
  mode: 'translate',
  scene: 'meeting',
  title: 't',
  started_at: null,
  stt_seconds: 0,
  items: [
    { kind: 'transcript', text: 'line one', qid: 't1', at: at(11, 5) },
    { kind: 'translate', text: '第一行', qid: 't1', at: at(11, 5, 1) },
    { kind: 'transcript', text: 'line two', qid: 't2', at: at(11, 6) },
    { kind: 'translate', text: '第二行', qid: 't2', at: at(11, 6, 1) },
  ],
}

const payload = restoreFromSession(session)

eq(payload.pairs.length.toString(), '2', 'pair count')
eq(payload.pairs[0].ts, '11:05', 'first pair ts')
eq(payload.pairs[1].ts, '11:06', 'second pair ts must come from its own transcript line')
