import { keepShouldWaitForNotes, shouldGenerateAutoReport } from './recordReport'

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

// A Save while Notes are still streaming must wait for them.
if (keepShouldWaitForNotes('ask-1') !== true) throw new Error('streaming notes => save waits')
if (keepShouldWaitForNotes('__pending__') !== true) throw new Error('pending notes => save waits')
if (keepShouldWaitForNotes('') !== false) throw new Error('no notes in flight => save now')
