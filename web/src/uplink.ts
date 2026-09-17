import { IPHONE_COPY } from './iphoneCopy'

/** JS must not also send PCM on the control socket while native uplink is live. */
export function uplinkShouldForwardPcmFromJs(opts: { nativeApp: boolean; hasToken: boolean }): boolean {
  return !opts.nativeApp || !opts.hasToken
}

/** Store the token only after native startUplink resolves. Failure keeps JS PCM. */
export function uplinkTokenAfterNativeStart(startOk: boolean, token: string): string {
  return startOk ? token : ''
}

export type UplinkTokenAction = 'ignore' | 'start' | 'replace'

/**
 * What to do with an `audio_uplink` token from the server (#279).
 *
 * A control re-attach used to re-announce the token and the phone stood up a
 * SECOND `/ws/audio` while the first was still streaming. Exactly one native
 * uplink socket may exist: the same token (or one already starting) is ignored,
 * and a genuinely different token replaces the live one (stop, then start) rather
 * than running two at once.
 */
export function uplinkTokenAction(opts: {
  token: string
  activeToken: string
  startingToken: string
}): UplinkTokenAction {
  const next = (opts.token || '').trim()
  if (!next) return 'ignore'
  if (next === opts.activeToken || next === opts.startingToken) return 'ignore'
  // A start is already in flight; stacking another would open a second socket.
  if (opts.startingToken) return 'ignore'
  return opts.activeToken ? 'replace' : 'start'
}

/** Reconnect the control WS with `?attach=` so the server can reclaim a parked Session. */
export function controlWsUrl(base: string, attachToken: string): string {
  if (!attachToken) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}attach=${encodeURIComponent(attachToken)}`
}

/** Native PCM socket. Always derived from the bare `/ws` URL, never the attach URL. */
export function audioUplinkWsUrl(controlUrl: string, token: string): string {
  const path = controlUrl.replace(/\/ws(?:\?.*)?$/, '/ws/audio')
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}token=${encodeURIComponent(token)}`
}

export type UplinkFailureKind = 'unavailable' | 'failed'

function uplinkErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') return ''
  if ('message' in err) return String((err as { message: unknown }).message || '')
  return String(err)
}

function uplinkErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return ''
  return String((err as { code: unknown }).code || '')
}

function uplinkErrorIsUnimplemented(err: unknown): boolean {
  const code = uplinkErrorCode(err).toUpperCase()
  const text = uplinkErrorText(err)
  return code === 'UNIMPLEMENTED' || /not implemented/i.test(text)
}

function stripUplinkSecrets(text: string): string {
  return text.replace(/token=[^&\s"'`]+/gi, 'token=')
}

/** User-facing uplink failure. Never includes plugin method names or stack. */
export function uplinkFailureFromError(err: unknown): { kind: UplinkFailureKind; text: string } {
  if (uplinkErrorIsUnimplemented(err)) {
    return { kind: 'unavailable', text: IPHONE_COPY.uplinkUnavailable }
  }
  return { kind: 'failed', text: IPHONE_COPY.uplinkFailed }
}

export function shouldEmitUplinkNotice(last: string, next: string): boolean {
  return last !== next
}

/** Diagnostic fields only. Strip tokens; keep method names for install/version checks. */
export function uplinkFailureLog(err: unknown): { code: string; message: string } {
  return {
    code: uplinkErrorCode(err) || 'unknown',
    message: stripUplinkSecrets(uplinkErrorText(err)),
  }
}
