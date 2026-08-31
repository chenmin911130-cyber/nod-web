import { shouldGenerateAutoReport } from './recordReport'

function eq(got: string, want: string) {
  if (got !== want) throw new Error(`expected ${want}, got ${got}`)
}

eq(shouldGenerateAutoReport({
  flagged: false, heardListen: false, run: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3,
}), 'skip')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: false, run: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 3,
}), 'wait')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'listen', workspaceMode: 'meeting', busy: false, lineCount: 3,
}), 'wait')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'idle', workspaceMode: 'meeting', busy: true, lineCount: 3,
}), 'wait')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'idle', workspaceMode: 'translate', busy: false, lineCount: 3,
}), 'skip')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 0,
}), 'skip')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2,
}), 'generate')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'idle', workspaceMode: 'interview', busy: false, lineCount: 2,
}), 'generate')

eq(shouldGenerateAutoReport({
  flagged: true, heardListen: true, run: 'idle', workspaceMode: 'meeting', busy: false, lineCount: 2, paused: true,
}), 'wait')
