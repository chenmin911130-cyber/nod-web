import { applyListenFlushEvent, beginListenFlushWait, idleListenFlushWait, keepShouldWaitForNotes, listenFlushEventMatchesWait, shouldGenerateAutoReport, stopShouldReleaseListener } from './recordReport'
import type { ListenFlush } from './recordReport'

function eq(got: string, want: string) {
  if (got !== want) throw new Error(`expected ${want}, got ${got}`)
}

function report(input: { capture: string; engine: string; workspaceMode: string; busy: boolean; lineCount: number; heardListen?: boolean; flagged?: boolean; listenFlush?: ListenFlush }): string {
  return shouldGenerateAutoReport({
    flagged: input.flagged ?? true,
    heardListen: input.heardListen ?? true,
    capture: input.capture,
    engine: input.engine,
    workspaceMode: input.workspaceMode,
    busy: input.busy,
    lineCount: input.lineCount,
    listenFlush: input.listenFlush,
  })
}

eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3, flagged: false }), 'skip')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3, heardListen: false, listenFlush: 'complete' }), 'wait')
eq(report({ capture: 'listening', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3, listenFlush: 'complete' }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: true, lineCount: 3, listenFlush: 'complete' }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'translate', busy: false, lineCount: 3 }), 'skip')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 0, listenFlush: 'complete' }), 'skip')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2, listenFlush: 'complete' }), 'generate')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'interview', busy: false, lineCount: 2 }), 'generate')
eq(report({ capture: 'paused', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2, listenFlush: 'complete' }), 'wait')
eq(report({ capture: 'off', engine: 'generating', workspaceMode: 'meeting', busy: false, lineCount: 2, listenFlush: 'complete' }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2, listenFlush: 'pending' }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2, listenFlush: 'idle' }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2, listenFlush: 'timeout' }), 'generate')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2 }), 'wait')

// A Save while Notes are still streaming must wait for them.
if (keepShouldWaitForNotes('ask-1') !== true) throw new Error('streaming notes => save waits')
if (keepShouldWaitForNotes('__pending__') !== true) throw new Error('pending notes => save waits')
if (keepShouldWaitForNotes('') !== false) throw new Error('no notes in flight => save now')

// A Meeting stopped while paused must release the server listener, or capture
// stays 'paused' and auto-notes never fire.
if (stopShouldReleaseListener('paused') !== true) throw new Error('paused => release the listener')
if (stopShouldReleaseListener('off') !== false) throw new Error('off => no listener to release')

const idle = idleListenFlushWait()
const waiting = beginListenFlushWait(idle, 'f2', 'sess-b')
if (waiting.status !== 'pending') throw new Error('expect arms pending')
if (waiting.waitId !== 'f2') throw new Error('expect keeps this End nonce')
if (waiting.lastId !== '') throw new Error('expect must not invent a last id')

const latePrev = applyListenFlushEvent(waiting, { id: '1', flushId: 'f1', sessionId: 'sess-a', ok: true })
if (latePrev.status !== 'pending') throw new Error('previous End receipt must not complete this wait')
if (listenFlushEventMatchesWait(waiting, { id: '1', flushId: 'f1', sessionId: 'sess-a', ok: true })) {
  throw new Error('stale flush_id must not match')
}
if (listenFlushEventMatchesWait(waiting, { id: '9', sessionId: 'sess-b', ok: true })) {
  throw new Error('flush without this End nonce must not match')
}

const matched = applyListenFlushEvent(waiting, { id: '2', flushId: 'f2', sessionId: 'sess-b', ok: true })
if (matched.status !== 'complete') throw new Error('matching nonce completes this End')
if (matched.lastId !== '2') throw new Error('accepted seq is remembered')

const nextWait = beginListenFlushWait(matched, 'f3', 'sess-b')
if (nextWait.lastId !== '2') throw new Error('next wait must keep the last accepted seq')
const replay = applyListenFlushEvent(nextWait, { id: '2', flushId: 'f2', sessionId: 'sess-b', ok: true })
if (replay.status !== 'pending') throw new Error('replay of the previous nonce must not complete the new wait')

const heldFirst = applyListenFlushEvent(idleListenFlushWait(), { id: '4', flushId: 'f9', sessionId: 's', ok: true })
if (heldFirst.status !== 'idle') throw new Error('flush before expect is held, not completed')
const lateExpect = beginListenFlushWait(heldFirst, 'f9', 's')
if (lateExpect.status !== 'complete') throw new Error('expect after matching held flush completes immediately')

