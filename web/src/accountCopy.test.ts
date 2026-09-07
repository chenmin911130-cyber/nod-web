import { accountInitials, listeningLeftLine, signInLine, signOutGate } from './accountCopy'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

eq(accountInitials('Min Chen', 'min@example.com'), 'MC', 'two-word name')
eq(accountInitials('', 'min@example.com'), 'M', 'email fallback')
eq(accountInitials('', ''), '?', 'empty fallback')

eq(signInLine('google'), 'Signed in with Google', 'google')
eq(signInLine(undefined), 'Signed in with email', 'missing sign-in')
eq(signInLine('email'), 'Signed in with email', 'email')

eq(
  listeningLeftLine({ daily_stt_seconds: 1800, daily_stt_limit: 7200 }),
  'Listening left today · 1.5h',
  'remaining',
)
eq(
  listeningLeftLine({ daily_stt_seconds: 7300, daily_stt_limit: 7200 }),
  'Daily listening limit reached · resets at midnight UTC',
  'cap',
)
eq(
  listeningLeftLine({ daily_stt_seconds: 600, daily_stt_limit: 0, quota_disabled: true }),
  'Listened today · 0.2h · no daily cap',
  'no cap',
)

eq(signOutGate({ listening: true, paused: false, disposition: 'undecided', hasContent: true, workspaceMode: 'meeting' }), 'blocked-listening', 'listening')
eq(signOutGate({ listening: false, paused: true, disposition: 'undecided', hasContent: true, workspaceMode: 'meeting' }), 'blocked-listening', 'paused')
eq(signOutGate({ listening: false, paused: false, disposition: 'saving', hasContent: true, workspaceMode: 'meeting' }), 'wait-saving', 'saving')
eq(signOutGate({ listening: false, paused: false, disposition: 'undecided', hasContent: true, workspaceMode: 'meeting' }), 'prompt', 'meeting content')
eq(signOutGate({ listening: false, paused: false, disposition: 'undecided', hasContent: true, workspaceMode: 'translate' }), 'go', 'translate')
eq(signOutGate({ listening: false, paused: false, disposition: 'undecided', hasContent: false, workspaceMode: 'meeting' }), 'go', 'empty')
