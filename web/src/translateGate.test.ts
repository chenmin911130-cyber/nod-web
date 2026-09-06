import {
  looksLikeTarget,
  matchesLockedFrom,
  routeTranslateChunk,
  translateAskIdAfterDone,
  translateDoneBelongsToAsk,
  translateDoneDecision,
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

// matchesLockedFrom: a Latin lock is already constrained to that Latin
// language, so a guessed / STT 'en' tag (a short or ambiguous turn) must not
// veto it; only a genuinely different script (CJK) or a distinct non-en tag does.
eq(
  matchesLockedFrom('Dobbiamo finire il lavoro entro domani', 'it', 'en'),
  true,
  'Italian lock: an en tag must not veto a Latin turn',
)
eq(
  matchesLockedFrom('Dobbiamo finire il lavoro entro domani', 'it', null),
  true,
  'Italian lock: no tag falls through to the glyph check',
)
eq(
  matchesLockedFrom('Dobbiamo finire il lavoro entro domani', 'it', 'es'),
  true,
  'Italian lock: a nearby Latin mis-tag (es) also must not veto',
)
eq(matchesLockedFrom('你好世界', 'it', 'zh'), false, 'Italian lock: a real CJK tag vetoes')
eq(
  matchesLockedFrom('Hello world this is fine', 'it', null),
  true,
  'Italian lock: a plain English line still passes (the lock is about script, not word-guess)',
)

// routeTranslateChunk: a translate LLM chunk lands only in the current
// workspace's container, never in a stale meeting/lecture line list.
eq(routeTranslateChunk('translate', true, true, true), 'pairs', 'translate workspace writes pairs, not stale meeting lines')
eq(routeTranslateChunk('meeting', true, true, true), 'meeting', 'meeting workspace with translateOn writes meeting lines')
eq(routeTranslateChunk('meeting', true, false, true), 'drop', 'meeting workspace with no meeting lines drops')
eq(routeTranslateChunk('meeting', false, true, true), 'drop', 'meeting workspace with translateOn off drops')
eq(routeTranslateChunk('interview', true, true, true), 'drop', 'interview workspace never routes a translate chunk')
eq(routeTranslateChunk('translate', true, false, false), 'drop', 'translate workspace with no container drops')

// translateDoneDecision: only a matching `done` (or the timeout) decides the
// outcome; the old phase(off, idle) fallback is gone.
eq(translateDoneDecision({ ok: true, translated: true, wrongScript: false, retries: 1 }), 'accept', 'ok + translation -> accept')
eq(translateDoneDecision({ ok: true, translated: false, wrongScript: false, retries: 1 }), 'retry', 'ok + empty -> retry within budget')
eq(translateDoneDecision({ ok: true, translated: false, wrongScript: false, retries: 3 }), 'fail', 'ok + empty exhausted -> fail')
eq(translateDoneDecision({ ok: false, translated: true, wrongScript: false, retries: 1 }), 'retry', 'ok:false + partial -> retry')
eq(translateDoneDecision({ ok: false, translated: true, wrongScript: false, retries: 3 }), 'fail', 'ok:false + partial exhausted -> fail')
eq(translateDoneDecision({ ok: false, translated: false, wrongScript: false, retries: 1 }), 'retry', 'ok:false + empty -> retry')
eq(translateDoneDecision({ ok: true, translated: true, wrongScript: true, retries: 1 }), 'retry', 'wrongScript -> retry within budget')
eq(translateDoneDecision({ ok: true, translated: true, wrongScript: true, retries: 3 }), 'accept', 'wrongScript exhausted -> accept (keep what we got)')

console.log('translateGate ok')
