import { keepShouldWaitForNotes, shouldGenerateAutoReport, stopShouldReleaseListener } from './recordReport'
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
