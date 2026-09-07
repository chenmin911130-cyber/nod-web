import { accountDeletedNotice, accountInitials, deleteAccountCopy, listeningLeftLine, signInLine, signOutGate } from './accountCopy'

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

eq(deleteAccountCopy.body.length, 5, 'delete body has five lines')
eq(
  deleteAccountCopy.body.includes('Provider copies already processed cannot be recalled from here.'),
  true,
  'keeps provider-copy line',
)
{
  const joined = deleteAccountCopy.body.join('\n')
  if (joined.includes('稍后') || joined.includes('24 小时')) {
    throw new Error('delete body must not promise later or 24 hours')
  }
}
eq(accountDeletedNotice('?deleted=1'), deleteAccountCopy.notice, 'deleted query shows notice')
eq(accountDeletedNotice('?signout=1'), '', 'signout alone has no delete notice')
