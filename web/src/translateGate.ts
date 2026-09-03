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
export function translateShouldPassthrough(text: string, to: PairLang, _fromTag?: string): boolean {
  return looksLikeTarget(text, to)
}

/** A `done` closes this translate only when it carries this ask's server id. */
export function translateDoneBelongsToAsk(askId: string, doneId?: string): boolean {
  return Boolean(askId) && Boolean(doneId) && askId === doneId
}

/** Keep the bind so later chunks still land when a foreign / empty `done` arrives. */
export function translateAskIdAfterDone(askId: string, doneId?: string): string {
  return translateDoneBelongsToAsk(askId, doneId) ? '' : askId
}
