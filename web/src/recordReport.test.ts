import { keepShouldWaitForNotes, shouldGenerateAutoReport, stopShouldReleaseListener } from './recordReport'

function eq(got: string, want: string) {
  if (got !== want) throw new Error(`expected ${want}, got ${got}`)
}

function report(input: { capture: string; engine: string; workspaceMode: string; busy: boolean; lineCount: number; heardListen?: boolean; flagged?: boolean }): string {
  return shouldGenerateAutoReport({
    flagged: input.flagged ?? true,
    heardListen: input.heardListen ?? true,
    capture: input.capture,
    engine: input.engine,
    workspaceMode: input.workspaceMode,
    busy: input.busy,
    lineCount: input.lineCount,
  })
}

eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3, flagged: false }), 'skip')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3, heardListen: false }), 'wait')
eq(report({ capture: 'listening', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3 }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: true, lineCount: 3 }), 'wait')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'translate', busy: false, lineCount: 3 }), 'skip')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 0 }), 'skip')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2 }), 'generate')
eq(report({ capture: 'off', engine: 'idle', workspaceMode: 'interview', busy: false, lineCount: 2 }), 'generate')
eq(report({ capture: 'paused', engine: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2 }), 'wait')
eq(report({ capture: 'off', engine: 'generating', workspaceMode: 'meeting', busy: false, lineCount: 2 }), 'wait')

// Wait for Notes only when leaving this session after Save — not Watch, not a stay-put phone Save.
if (keepShouldWaitForNotes({ notesAskId: 'ask-1', pendingAfterSave: 'new', fromWatch: true }) !== false) {
  throw new Error('notesAskId set + fromWatch => keep now')
}
if (keepShouldWaitForNotes({ notesAskId: 'ask-1', pendingAfterSave: null, fromWatch: false }) !== false) {
  throw new Error('notes + phone + pendingAfterSave null => keep now')
}
if (keepShouldWaitForNotes({ notesAskId: 'ask-1', pendingAfterSave: 'new', fromWatch: false }) !== true) {
  throw new Error('notes + phone + pendingAfterSave new => wait')
}
if (keepShouldWaitForNotes({ notesAskId: '', pendingAfterSave: 'new', fromWatch: false }) !== false) {
  throw new Error('empty notesAskId => keep now')
}

// A Meeting stopped while paused must release the server listener, or capture
// stays 'paused' and auto-notes never fire.
if (stopShouldReleaseListener('paused') !== true) throw new Error('paused => release the listener')
if (stopShouldReleaseListener('off') !== false) throw new Error('off => no listener to release')
