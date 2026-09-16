import { notesTranscriptTooThin } from './listen'
import type { MeetingLine } from './types'

/** After a Record session stops, wait until capture is off and the engine is idle. */
export type ListenFlush = 'idle' | 'pending' | 'complete' | 'timeout'

export type ListenFlushEvent = {
  id?: string
  flushId?: string
  sessionId?: string
  ok: boolean
  timeout?: boolean
}

/** One End's flush wait: nonce + session, plus the last accepted seq so a late
 * receipt from the previous End cannot complete the current notes. */
export type ListenFlushWait = {
  status: ListenFlush
  waitId: string
  waitSession: string
  lastId: string
  held: ListenFlushEvent | null
}

export function idleListenFlushWait(): ListenFlushWait {
  return { status: 'idle', waitId: '', waitSession: '', lastId: '', held: null }
}

export function listenFlushEventMatchesWait(wait: ListenFlushWait, ev: ListenFlushEvent): boolean {
  if (wait.status !== 'pending') return false
  if (wait.waitId) {
    return Boolean(ev.flushId) && ev.flushId === wait.waitId
  }
  if (wait.waitSession && ev.sessionId && wait.waitSession !== ev.sessionId) return false
  if (wait.lastId && ev.id && Number(ev.id) <= Number(wait.lastId)) return false
  return true
}

function completeListenFlush(wait: ListenFlushWait, ev: ListenFlushEvent): ListenFlushWait {
  return {
    ...wait,
    status: ev.timeout || ev.ok === false ? 'timeout' : 'complete',
    waitId: '',
    lastId: ev.id || wait.lastId,
    held: ev,
  }
}

export function beginListenFlushWait(prev: ListenFlushWait, waitId: string, sessionId: string): ListenFlushWait {
  const next: ListenFlushWait = {
    ...prev,
    status: 'pending',
    waitId,
    waitSession: sessionId,
  }
  if (next.held && listenFlushEventMatchesWait(next, next.held)) {
    return completeListenFlush(next, next.held)
  }
  return next
}

export function applyListenFlushEvent(prev: ListenFlushWait, ev: ListenFlushEvent): ListenFlushWait {
  if (!listenFlushEventMatchesWait(prev, ev)) {
    return { ...prev, held: ev }
  }
  return completeListenFlush(prev, ev)
}

export function timeoutListenFlushWait(prev: ListenFlushWait): ListenFlushWait {
  if (prev.status !== 'pending') return prev
  return { ...prev, status: 'timeout', waitId: '' }
}

export function idleKeepLastListenFlush(prev: ListenFlushWait): ListenFlushWait {
  return { ...prev, status: 'idle', waitId: '', waitSession: '' }
}

export function shouldGenerateAutoReport(input: {
  flagged: boolean
  heardListen: boolean
  capture: string
  engine: string
  workspaceMode: string
  busy: boolean
  lineCount: number
  lines?: MeetingLine[]
  listenFlush?: ListenFlush
}): 'wait' | 'skip' | 'generate' {
  if (!input.flagged) return 'skip'
  if (input.capture !== 'off' || input.engine !== 'idle') return 'wait'
  if (!input.heardListen) return 'wait'
  if (input.workspaceMode === 'translate') return 'skip'
  if (input.busy) return 'wait'
  if (input.lineCount === 0) return 'skip'
  if (input.lines && notesTranscriptTooThin(input.lines)) return 'skip'
  const needsFlush = input.workspaceMode === 'meeting'
  if (needsFlush) {
    const flush = input.listenFlush ?? 'idle'
    if (flush === 'pending' || flush === 'idle') return 'wait'
  }
  return 'generate'
}

/** A Save / finish tapped while Notes are still streaming must wait for them,
 * or the session is persisted without the Notes section. */
export function keepShouldWaitForNotes(notesAskId: string): boolean {
  return Boolean(notesAskId)
}

/** When a Meeting is stopped with the mic NOT live (capture='paused'), the
 * server listener is still attached and must be released — otherwise capture
 * stays 'paused' and shouldGenerateAutoReport returns 'wait' forever, so Notes
 * never auto-generate. When capture is already 'off' there is nothing to
 * release. ('listening'/'recording' are handled by the primary-stop path.) */
export function stopShouldReleaseListener(capture: string): boolean {
  return capture === 'paused'
}
