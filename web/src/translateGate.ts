import type { PairLang } from './types'

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

/**
 * Skip the LLM only when the text itself is already the target language.
 * STT's from-tag must not decide this — mixed EN+zh is often tagged zh.
 * EXCEPT when translating INTO English: Latin scripts all look like English, so
 * an AssemblyAI Latin from-tag (es/fr/de/it/pt) means the source is genuinely
 * that language and must go to the LLM, not passthrough.
 */
export function translateShouldPassthrough(text: string, to: PairLang, fromTag?: PairLang): boolean {
  if (to === 'en' && fromTag && LATIN_TARGETS.has(fromTag)) return false
  return looksLikeTarget(text, to)
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
