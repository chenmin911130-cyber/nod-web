import {
  isTranslateChunk,
  looksLikeTarget,
  matchesLockedFrom,
  routeTranslateChunk,
  sttTag,
  translateAskIdAfterDone,
  translateDoneBelongsToAsk,
  translateDoneDecision,
  translateShouldPassthrough,
  wrongScriptForTarget,
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
  false,
  'Spanish->en with no STT tag (Auto) must go to the LLM, not pass through',
)
eq(translateShouldPassthrough('Hello there', 'en', 'en'), true, 'English tagged en with an en target passes through')
eq(translateShouldPassthrough('Hello there', 'en', undefined), false, 'no STT tag -> LLM even for a Latin target')
eq(translateShouldPassthrough('Bonjour, comment allez-vous', 'fr', 'fr'), true, 'French tagged fr with a fr target passes through')
eq(translateShouldPassthrough('Bonjour, comment allez-vous', 'fr', undefined), false, 'French with no tag -> LLM (Auto must not glyph-guess a Latin language)')

// sttTag: a guessed glyph language must never be written into lang/from — only a
// raw STT tag that is a known translate language is trusted.
eq(sttTag('en'), 'en', 'a known STT tag is trusted')
eq(sttTag('es'), 'es', 'a Latin STT tag is trusted')
eq(sttTag('xx'), undefined, 'an unknown tag is dropped')
eq(sttTag(undefined), undefined, 'no tag is dropped')
eq(sttTag('zh'), 'zh', 'a CJK STT tag is trusted')
eq(translateShouldPassthrough('Quiero comer algo antes de la reunion', 'en', sttTag(undefined)), false, 'a Spanish line under an en target with no STT tag goes to the LLM')
eq(translateShouldPassthrough('Let us move on', 'en', 'en'), true, 'an en-tagged English line under an en target passes through')

// wrongScriptForTarget (moved here from App.tsx): a Latin target flags a model
// output that carries a marker for a *different* Latin language, or is majority
// CJK/Hangul. A target's own markers never flag correct output.
eq(wrongScriptForTarget('Dobbiamo finire il lavoro entro domani perché', 'en'), true, 'Italian output for an en target is wrong-language')
eq(wrongScriptForTarget('We should finish by tomorrow', 'en'), false, 'English output for an en target is fine')
eq(wrongScriptForTarget('我们明天完成', 'en'), true, 'Chinese output for an en target is wrong-language (unchanged)')
eq(wrongScriptForTarget('明天', 'en'), false, 'too few chars is never judged wrong-language')
eq(wrongScriptForTarget('¿Cómo está usted?', 'es'), false, 'Spanish output for an es target is fine (own markers ignored)')
eq(wrongScriptForTarget('Wie geht es dir, nicht wahr?', 'de'), false, 'German output for a de target is fine (own markers ignored)')
eq(wrongScriptForTarget('Não posso ir hoje', 'pt'), false, 'Portuguese output for a pt target is fine (own markers ignored)')
eq(wrongScriptForTarget('Dobbiamo finire il lavoro perché', 'es'), true, 'Italian output for an es target is still wrong-language')

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
eq(translateDoneDecision({ ok: true, translated: true, wrongScript: true, retries: 3 }), 'fail', 'wrongScript exhausted -> fail (a wrong-language output gives up, not accept)')

// isTranslateChunk: a chunk can only join the translate stream when it carries
// the id stamped on the translate `question`. With no translateAskId (e.g.
// during a Notes stream), NO chunk may be adopted as a translate chunk — that
// was how Notes JSON landed in a meeting line's translation.
eq(isTranslateChunk('', 'N'), false, 'no translateAskId -> never a translate chunk')
eq(isTranslateChunk('', 'T'), false, 'empty translateAskId adopts nothing')
eq(isTranslateChunk('T', 'T'), true, 'the stamped translate id belongs to the stream')
eq(isTranslateChunk('T', 'N'), false, 'a foreign id (Notes) is not a translate chunk')

console.log('translateGate ok')
