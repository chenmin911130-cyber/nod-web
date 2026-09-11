import type { AnswerSources, Turn } from './types'
import { answerCopyText, applySources, hasSourceBlock, renderableSources, safeLink, sourcesAsText } from './qaSources'

// The repo's web tests carry no node types, so they assert with a tiny local
// helper instead of node:assert.
function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

function deepEq(got: unknown, want: unknown, label: string) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a !== b) throw new Error(`${label}: got ${a} want ${b}`)
}

function ok(value: unknown, label: string) {
  if (!value) throw new Error(label)
}

function sources(over: Partial<AnswerSources> = {}): AnswerSources {
  return {
    status: 'ok',
    retrieved_at: 1789012800,
    retrieved_at_text: '2026-09-10 04:00 UTC',
    results: [{ title: 'Apple News', url: 'https://example.com/apple', published_at: '2026-09-10' }],
    note: '',
    ...over,
  }
}

const turns: Turn[] = [
  { id: 'q1', q: 'first?', a: 'one' },
  { id: 'q2', q: 'second?', a: 'two' },
]

// --- safe links -------------------------------------------------------------
eq(safeLink('https://example.com/a'), 'https://example.com/a', 'https survives')
eq(safeLink('  http://example.com/a  '), 'http://example.com/a', 'http is trimmed')
eq(safeLink('javascript:alert(1)'), null, 'javascript dropped')
eq(safeLink('data:text/html;base64,AAAA'), null, 'data dropped')
eq(safeLink(''), null, 'empty dropped')
eq(safeLink(undefined), null, 'missing dropped')

// --- what a card may render -------------------------------------------------
deepEq(
  renderableSources(sources()).map((s) => s.url),
  ['https://example.com/apple'],
  'a real source renders',
)
deepEq(
  renderableSources(
    sources({
      results: [
        { title: 'a', url: 'https://e.com/a', published_at: null },
        { title: 'a again', url: 'https://e.com/a', published_at: null },
        { title: 'bad', url: 'javascript:alert(1)', published_at: null },
        { title: '  ', url: 'https://e.com/b', published_at: null },
      ],
    }),
  ),
  [
    { title: 'a', url: 'https://e.com/a', published_at: null },
    { title: 'https://e.com/b', url: 'https://e.com/b', published_at: null },
  ],
  'duplicates collapse, unsafe links drop, a missing title falls back to the url',
)
deepEq(renderableSources(undefined), [], 'no sources renders nothing')

// --- attaching to the right turn -------------------------------------------
const attached = applySources(turns, { id: 'q2', ...sources() })
eq(attached.length, 2, 'turn count unchanged')
eq(attached[0].sources, undefined, 'a sibling turn is untouched')
eq(attached[1].sources?.results[0].url, 'https://example.com/apple', 'attached to its own turn')
eq(turns[1].sources, undefined, 'the input turns are not mutated')

// A late lookup for an abandoned session must not create or decorate a turn.
eq(applySources(turns, { id: 'gone', ...sources() }), turns, 'an unknown id is dropped')
eq(applySources(turns, { ...sources() }), turns, 'no id → no attach')

// The block is dropped from what is rendered if it carries nothing.
eq(hasSourceBlock(undefined), false, 'no sources → no block')
eq(hasSourceBlock(sources({ results: [] })), false, 'a plain answer never grows an empty source block')
eq(hasSourceBlock(sources({ status: 'empty', results: [], note: '未找到可用来源' })), true, 'an explicit note renders')
eq(hasSourceBlock(sources()), true, 'real sources render')

// --- copy / export ----------------------------------------------------------
eq(sourcesAsText(undefined), '', 'old records export nothing extra')
eq(sourcesAsText(sources({ results: [] })), '', 'no sources → no text block')
const text = sourcesAsText(sources())
ok(text.includes('[1] Apple News（发布时间 2026-09-10）'), 'export carries the publication date')
ok(text.includes('https://example.com/apple'), 'export carries the real url')
ok(text.includes('检索时间：2026-09-10 04:00 UTC'), 'export carries the retrieval time')
const failed = sourcesAsText(sources({ status: 'failed', results: [], note: '联网检索失败（TimeoutError）' }))
ok(failed.includes('联网检索失败'), 'a failed lookup exports its honest note')
ok(!failed.includes('[1]'), 'a failed lookup exports no fake source')

// The live Copy entry (not only the History export) keeps the sources block.
const copied = answerCopyText('A new model.', sources())
ok(copied.startsWith('A new model.'), 'copy keeps the answer first')
ok(copied.includes('https://example.com/apple'), 'copy keeps the real url')
ok(copied.includes('检索时间：2026-09-10 04:00 UTC'), 'copy keeps the retrieval time')
eq(answerCopyText('Plain answer.', undefined), 'Plain answer.', 'a plain answer copies unchanged')
eq(answerCopyText('', sources()), sourcesAsText(sources()), 'an empty body with sources still copies the sources')
eq(answerCopyText('  ', undefined), '', 'nothing to copy stays nothing')

console.log('qaSources.test.ts: ok')
