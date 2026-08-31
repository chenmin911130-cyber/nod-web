/** After a Record session stops, wait until listen is idle and Ask is not busy. */
export function shouldGenerateAutoReport(input: {
  flagged: boolean
  heardListen: boolean
  run: string
  workspaceMode: string
  busy: boolean
  lineCount: number
  paused?: boolean
}): 'wait' | 'skip' | 'generate' {
  if (!input.flagged) return 'skip'
  if (input.paused) return 'wait'
  if (input.run === 'listen' || input.run === 'record' || input.run === 'think') return 'wait'
  if (!input.heardListen) return 'wait'
  if (input.workspaceMode === 'translate') return 'skip'
  if (input.busy) return 'wait'
  if (input.lineCount === 0) return 'skip'
  return 'generate'
}
