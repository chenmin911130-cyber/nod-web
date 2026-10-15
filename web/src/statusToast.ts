import { IPHONE_COPY } from './iphoneCopy'
import { EN_IPHONE_COPY, iphoneCopyFor } from './iphoneCopyLocales'

/** AssemblyAI streaming reconnect — must surface as a toast, not match /^Transcrib/. */
export function statusIsSttReconnect(text: string): boolean {
  const t = text.trim()
  return t === 'Transcription dropped — reconnecting' || t.startsWith('Transcription dropped —')
}

/** Status strings that must not float over the phone title bar. */
export function statusIsAmbient(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (statusIsSttReconnect(t)) return false
  if (/^(Starting|Ready|Listening|Recording|Calibrat|Transcrib|Checking|Generating|Thinking)/i.test(t)) return true
  if (t.startsWith('I caught part')) return true
  if (
    t.startsWith(EN_IPHONE_COPY.speechPrefix) ||
    t.startsWith(iphoneCopyFor('zh').speechPrefix)
  ) {
    return true
  }
  if (t.startsWith('Mode ·')) return true
  if (/^Opened .+ session$/.test(t)) return true
  return false
}

export function statusIsStickyUplink(text: string): boolean {
  const t = text.trim()
  return t === IPHONE_COPY.uplinkUnavailable || t === IPHONE_COPY.uplinkFailed
}

export function statusIsOfflineStop(text: string): boolean {
  return text.trim().startsWith('Listening stopped — the phone was offline')
}

export function statusShouldOverlayToast(text: string): boolean {
  return !statusIsAmbient(text) && !statusIsStickyUplink(text)
}

/** Keep a capability notice until uplink recovers or a later non-ambient status replaces it. */
export function nextStatusText(prev: string, incoming: string): string {
  const next = incoming.trim()
  if (!next) return ''
  if (statusIsStickyUplink(prev) && statusIsAmbient(next)) return prev
  return incoming
}
