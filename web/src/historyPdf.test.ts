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
