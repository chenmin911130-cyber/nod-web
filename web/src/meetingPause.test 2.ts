import { meetingRailIsPaused } from './meetingPause'

function yes(got: boolean, label: string) {
  if (!got) throw new Error(label)
}

yes(
  !meetingRailIsPaused({
    workspaceMode: 'meeting',
    listening: false,
    userPaused: false,
    started: true,
    ended: false,
  }),
  'Start / listen_new must not paint the yellow paused ring',
)

yes(
  meetingRailIsPaused({
    workspaceMode: 'meeting',
    listening: false,
    userPaused: true,
    started: true,
    ended: false,
  }),
  'Pause must show the paused ring',
)

yes(
  !meetingRailIsPaused({
    workspaceMode: 'meeting',
    listening: true,
    userPaused: false,
    started: true,
    ended: false,
  }),
  'live Start / Stop must stay cyan',
)

yes(
  !meetingRailIsPaused({
    workspaceMode: 'meeting',
    listening: false,
    userPaused: true,
    started: true,
    ended: true,
  }),
  'Stop / ended must not stay paused',
)
