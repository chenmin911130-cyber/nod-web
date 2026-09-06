import type { PairLang } from './types'
import { TRANSLATE_LANGS } from './types'

function compact(text: string): string {
  return (text || '').trim().replace(/\s+/g, ' ')
}

const NOT_ENGLISH_MARKS = /[¿¡ñßœæàâçèéêëîïôùûÿáéíóúüäöüßãõàèìòù]/iu
const NOT_ENGLISH_WORDS =
  /\b(?:hola|gracias|buenos|bonjour|bonsoir|merci|salut|pourquoi|êtes|ça|wie geht|nicht|danke|bitte|guten|você|não|olá|obrigado|perché|ciao|grazie|più|cómo|estás|usted|quién|dónde|también|comment ça|comment ca|como estas|qué tal|que tal)\b/iu

/** Script check: the spoken line is already in the target language. */
export function looksLikeTarget(text: string, to: PairLang): boolean {
  const chars = Array.from(compact(text)).filter((c) => !/\s/u.test(c))
  if (chars.length < 2) return false
  const han = chars.filter((c) => /\p{Script=Han}/u.test(c)).length
  const kana = chars.filter((c) => /[\u3040-\u30FF]/.test(c)).length
  const hangul = chars.filter((c) => /\p{Script=Hangul}/u.test(c)).length
  const latin = chars.filter((c) => /[A-Za-zÀ-ÿ]/.test(c)).length
  const n = chars.length
  if (to === 'zh') return han / n >= 0.5 && kana === 0 && hangul === 0
  if (to === 'ja') return kana / n >= 0.12 || ((han + kana) / n >= 0.5 && kana > 0)
  if (to === 'en') {
    const raw = compact(text)
    return latin / n >= 0.7 && han + kana + hangul === 0 && !NOT_ENGLISH_MARKS.test(raw) && !NOT_ENGLISH_WORDS.test(raw)
  }
  return false
}

/**
 * Skip the LLM only when the text itself is already the target language.
 * STT's from-tag must not decide this — mixed EN+zh is often tagged zh.
 */
const LATIN_TARGETS = new Set<PairLang>(['es', 'fr', 'de', 'it', 'pt'])

/** Latin-script targets (incl. 'en') are glyph-indistinguishable from each other. */
const LATIN_SCRIPT_TARGETS = new Set<PairLang>(['en', 'es', 'fr', 'de', 'it', 'pt'])

/**
 * Skip the LLM only when the text is already the target language.
 * STT's from-tag must not decide this — mixed EN+zh is often tagged zh.
 * A Latin target cannot be told from another Latin script by glyphs, so only a
 * matching STT from-tag proves the text is already the target; no tag (Auto) or
 * a mismatched tag goes to the model (the system prompt returns as-is when it
 * is already the target). Costs one small call for a user who speaks the target
 * in Auto mode, but never drops a Spanish/Italian/French/German/Portuguese line.
 */
export function translateShouldPassthrough(text: string, to: PairLang, fromTag?: PairLang): boolean {
  if (LATIN_SCRIPT_TARGETS.has(to)) return Boolean(fromTag) && fromTag === to
  return looksLikeTarget(text, to) // zh/ja: script check is reliable
}

/**
 * Client-side lock guard (mirror of server matches_locked_speech): drop a turn
 * only when it is genuinely a different script (CJK / Hangul), or the word
 * markers confidently name a different Latin language. A guessed or STT 'en'
 * tag must NOT veto a Latin lock — the STT is already constrained to that Latin
 * language, and short/ambiguous turns are often mis-tagged 'en'.
 */
export function matchesLockedFrom(text: string, locked: PairLang, heard: PairLang | null): boolean {
  if (heard && heard !== locked && !(LATIN_TARGETS.has(locked) && (LATIN_TARGETS.has(heard) || heard === 'en'))) return false
  if (locked === 'en' || locked === 'zh' || locked === 'ja') return looksLikeTarget(text, locked)
  if (/[\u4e00-\u9fff\u3040-\u30FF\uac00-\ud7af]/u.test(text)) return false
  const t = compact(text)
  if (/[¿¡ñ]|cómo|está|hola\b/i.test(t)) return locked === 'es'
  if (/[çœæ]|pourquoi|bonjour|\bça\b/i.test(t)) return locked === 'fr'
  if (/[äöüß]|nicht\b|wie geht/i.test(t)) return locked === 'de'
  if (/perché|ciao\b|grazie|più/i.test(t)) return locked === 'it'
  if (/[ãõ]|você|não|olá/i.test(t)) return locked === 'pt'
  return true
}

/** A `done` closes this translate only when it carries this ask's server id. */
export function translateDoneBelongsToAsk(askId: string, doneId?: string): boolean {
  return Boolean(askId) && Boolean(doneId) && askId === doneId
}

/** Keep the bind so later chunks still land when a foreign / empty `done` arrives. */
export function translateAskIdAfterDone(askId: string, doneId?: string): string {
  return translateDoneBelongsToAsk(askId, doneId) ? '' : askId
}

/** Where a translate LLM chunk should land, given the current workspace. */
export function routeTranslateChunk(
  workspaceMode: string,
  translateOn: boolean,
  hasMeetingLines: boolean,
  hasPairs: boolean,
): 'meeting' | 'pairs' | 'drop' {
  if (workspaceMode === 'translate') return hasPairs ? 'pairs' : 'drop'
  if (workspaceMode === 'meeting' && translateOn) return hasMeetingLines ? 'meeting' : 'drop'
  return 'drop'
}

export type TranslateDoneDecision = 'accept' | 'retry' | 'fail'

/**
 * What a matching LLM `done` means for the row being translated. `retries` is
 * the count for THIS attempt (1-based). A wrong-script result is retried within
 * budget and then marked failed, so a wrong-language output shows its give-up
 * state rather than passing off a mis-translation. A genuine `ok:false` with a
 * partial translation counts as one failure too, so a broken stream doesn't
 * silently pass as complete.
 */
export function translateDoneDecision(args: {
  ok: boolean
  translated: boolean
  wrongScript: boolean
  retries: number
}): TranslateDoneDecision {
  if (args.wrongScript) return args.retries <= 2 ? 'retry' : 'fail'
  if (args.translated && !args.ok) return args.retries <= 2 ? 'retry' : 'fail'
  if (args.translated) return 'accept'
  return args.retries <= 2 ? 'retry' : 'fail'
}

/**
 * A chunk belongs to the translate stream only when it carries the id the
 * server stamped on the translate `question` frame. We must NOT "adopt" any
 * unclaimed chunk (e.g. a Notes stream that isn't tagged `[NOD_TRANSLATE`) as a
 * translate chunk — that is how Notes JSON landed in a meeting line's
 * translation. The server always sends the `question` before its chunks.
 */
export function isTranslateChunk(translateAskId: string, evId?: string): boolean {
  return Boolean(translateAskId) && Boolean(evId) && evId === translateAskId
}

/** Shared Latin word/script markers (used by both parseHeardLang and wrongScriptForTarget). */
const ES_LANG_MARK = /[¿¡ñ]|cómo|está/i
const FR_LANG_MARK = /[çœæ]|pourquoi|bonjour|\bça\b/i
const DE_LANG_MARK = /[äöüß]|nicht\b|wie geht/i
const IT_LANG_MARK = /perché|ciao\b|grazie|più/i
const PT_LANG_MARK = /[ãõ]|você|não|olá/i

/**
 * The raw STT language tag, trusted ONLY when it is a known translate language.
 * This is what stamps a meeting line's `lang` and a translate pair's `from` — a
 * glyph guess (parseHeardLang) must never be written into them, because a
 * Latin-script line (es/fr/de/it/pt) is glyph-indistinguishable from English,
 * so a guessed `en` would make passthrough treat "already English" and skip the
 * model (the #25 P1-1 hold-over: a Spanish line in an English target meeting).
 */
export function sttTag(raw: string | undefined): PairLang | undefined {
  return raw && TRANSLATE_LANGS.some((l) => l.id === raw) ? (raw as PairLang) : undefined
}

/**
 * Best-guess the spoken language of a turn from the STT tag, falling back to
 * the text's script/word markers when the tag is absent or unknown. Used ONLY
 * for the heardLang / lock / matches-* heuristics — NEVER to stamp `lang`/`from`
 * (use sttTag for that).
 */
export function parseHeardLang(raw: string | undefined, text: string): PairLang | null {
  if (raw && TRANSLATE_LANGS.some((l) => l.id === raw)) return raw as PairLang
  const t = compact(text)
  if (!t) return null
  if (/[\u3040-\u30FF]/.test(t)) return 'ja'
  if (/\p{Script=Han}/u.test(t)) return 'zh'
  if (ES_LANG_MARK.test(t)) return 'es'
  if (FR_LANG_MARK.test(t)) return 'fr'
  if (DE_LANG_MARK.test(t)) return 'de'
  if (IT_LANG_MARK.test(t)) return 'it'
  if (PT_LANG_MARK.test(t)) return 'pt'
  if (/[A-Za-z]/.test(t)) return 'en'
  return null
}

/**
 * Script/language-level check on a translated line: catches the model answering
 * in a blatantly wrong language so a wrong-language output is retried (and then
 * failed) instead of accepted. CJK targets keep the pure script check (reliable).
 * For a Latin target (en/es/fr/de/it/pt) the text is wrong-language when it
 * carries a non-English Latin marker (the model answered in Spanish / Italian /
 * French / German / Portuguese) or when it is majority CJK/Hangul. Fewer than 4
 * letters is never enough to judge.
 */
export function wrongScriptForTarget(text: string, to: PairLang): boolean {
  const chars = Array.from(compact(text)).filter((c) => /[\p{L}]/u.test(c))
  if (chars.length < 4) return false
  const han = chars.filter((c) => /\p{Script=Han}/u.test(c)).length
  const kana = chars.filter((c) => /[\u3040-\u30FF]/.test(c)).length
  const hangul = chars.filter((c) => /\p{Script=Hangul}/u.test(c)).length
  if (to === 'zh') return han === 0
  if (to === 'ja') return han + kana === 0
  const latinWrong =
    ES_LANG_MARK.test(compact(text)) || FR_LANG_MARK.test(compact(text)) || DE_LANG_MARK.test(compact(text)) ||
    IT_LANG_MARK.test(compact(text)) || PT_LANG_MARK.test(compact(text))
  if (latinWrong) return true
  return (han + kana + hangul) / chars.length >= 0.5
}
