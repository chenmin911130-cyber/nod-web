import {
  looksLikeTarget,
  translateAskIdAfterDone,
  translateDoneBelongsToAsk,
  translateShouldPassthrough,
} from './translateGate'

function eq<T>(got: T, want: T, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(translateDoneBelongsToAsk('qid-2', 'qid-2'), true, 'this translate\'s done closes the gate')
eq(translateDoneBelongsToAsk('qid-2', 'qid-1'), false, 'the previous line\'s done must not finish the next translate')
eq(translateDoneBelongsToAsk('qid-2', ''), false, 'empty-id done (quota / empty ask) must not finish a translate')
eq(translateDoneBelongsToAsk('qid-2', undefined), false, 'missing done id must not finish a translate')
eq(translateDoneBelongsToAsk('', 'qid-2'), false, 'done before the question bind must not close an empty ask id')

eq(translateAskIdAfterDone('qid-2', 'qid-1'), 'qid-2', 'foreign done keeps the bind so chunks still apply')
eq(translateAskIdAfterDone('qid-2', ''), 'qid-2', 'empty done keeps the bind')
eq(translateAskIdAfterDone('qid-2', 'qid-2'), '', 'matching done clears the bind')

eq(
  translateShouldPassthrough('What\'s yours?', 'zh', 'en'),
  false,
  'short English must go to the LLM, not passthrough',
)
eq(
  translateShouldPassthrough(
    'The weather is not good, but my mood is very good because I will walking with my dog and my husband and we can go for 新美楼 for lunch.',
    'zh',
    'zh',
  ),
  false,
  'mixed English + a Chinese name tagged zh must still translate',
)
eq(
  translateShouldPassthrough('你好。', 'zh', 'zh'),
  true,
  'a Chinese line may passthrough when the target is Chinese',
)
eq(looksLikeTarget('嗯', 'zh'), false, 'a one-character filler is not "already Chinese"')
eq(
  translateShouldPassthrough('Quiero comer algo antes de la reunion', 'en', 'es'),
  false,
  'Spanish -> English must go to the LLM, not passthrough',
)
eq(
  translateShouldPassthrough('Dobbiamo finire il lavoro entro domani', 'en', 'it'),
  false,
  'Italian -> English must go to the LLM',
)
eq(
  translateShouldPassthrough('Quiero comer algo antes de la reunion', 'en', undefined),
  true,
  'no STT tag falls back to the glyph check (Spanish looks like English)',
)

console.log('translateGate ok')
