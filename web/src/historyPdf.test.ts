import { historyPdfArgs } from './historyPdf'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

type Item = { kind: string; text: string; qid: string }
function pTexts(blocks: Array<{ kind: string; text?: string }>): string[] {
  return blocks.filter((b) => b.kind === 'p').map((b) => b.text || '')
}
function session(items: Item[]) {
  return { id: 's1', mode: 'meeting', scene: 'meeting', title: 't', started_at: '2026-09-06T00:00:00Z', items }
}

// A legacy row has no line-id association (its qid differs from the transcript's).
// The dedup must NEVER be a global text match — a real cross-language translation
// (你好 -> "Hello") stays even when someone later says "Hello".
{
  const { blocks } = await historyPdfArgs(
    session([
      { kind: 'transcript', text: '你好', qid: 't1' },
      { kind: 'translate', text: 'Hello', qid: 'a1' },
      { kind: 'transcript', text: 'Hello', qid: 't2' },
    ]),
  )
  eq(pTexts(blocks as any), ['Hello'], 'a real cross-language translation is never dropped by a later same-text line')
}

// An adjacent same-language passthrough (legacy id) IS dropped.
{
  const { blocks } = await historyPdfArgs(
    session([
      { kind: 'transcript', text: 'So the plan is', qid: 't1' },
      { kind: 'translate', text: 'So the plan is', qid: 'a1' },
    ]),
  )
  eq(pTexts(blocks as any), [], 'a legacy adjacent same-text passthrough is dropped')
}

// New format: a row with the SAME qid as its transcript compares to THAT line only.
{
  const dropped = await historyPdfArgs(
    session([{ kind: 'transcript', text: 'OK then', qid: 'x1' }, { kind: 'translate', text: 'OK then', qid: 'x1' }]),
  )
  eq(pTexts(dropped.blocks as any), [], 'same qid + same text -> dropped')
  const kept = await historyPdfArgs(
    session([{ kind: 'transcript', text: 'OK then', qid: 'x1' }, { kind: 'translate', text: '好的', qid: 'x1' }]),
  )
  eq(pTexts(kept.blocks as any), ['好的'], 'same qid + different text -> kept')
}

// #182: a saved Think answer exports its real sources and the retrieval time; a
// plain answer adds no source line at all.
{
  const { blocks } = await historyPdfArgs({
    id: 's3',
    mode: 'interview',
    scene: 'interview',
    title: 'qa',
    started_at: '2026-09-06T00:00:00Z',
    items: [
      { kind: 'question', text: 'what is new?', qid: 'q1' },
      {
        kind: 'answer',
        text: 'an answer',
        qid: 'q1',
        sources: {
          status: 'ok',
          retrieved_at: 1789012800,
          retrieved_at_text: '2026-09-10 04:00 UTC',
          results: [{ title: 'Apple', url: 'https://e.com/a', published_at: '2026-09-10' }],
          note: '',
        },
      },
      { kind: 'question', text: 'plain?', qid: 'q2' },
      { kind: 'answer', text: 'plain answer', qid: 'q2', sources: null },
    ],
  })
  const texts = pTexts(blocks as any)
  const source = texts.find((t) => t.includes('https://e.com/a')) || ''
  if (!source.includes('检索时间：2026-09-10 04:00 UTC')) throw new Error('the PDF must keep the retrieval time')
  if (!source.includes('[1] Apple')) throw new Error('the PDF must keep the real source title')
  eq(texts.filter((t) => t.includes('[1]')).length, 1, 'a plain answer adds no source block')
}
