/** Meeting rail is paused only after the user taps Pause, not after Start. */
export function meetingRailIsPaused(input: {
  workspaceMode: string
  listening: boolean
  userPaused: boolean
  started: boolean
  ended: boolean
}): boolean {
  return (
    input.workspaceMode === 'meeting'
    && input.userPaused
    && input.started
    && !input.ended
    && !input.listening
  )
}
