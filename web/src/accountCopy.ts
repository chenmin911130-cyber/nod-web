import { IPHONE_COPY } from './iphoneCopy'
import { fmtHours } from './quotaCopy'
import type { SaveStatus } from './sessionSave'

export type SignOutGate = 'blocked-listening' | 'wait-saving' | 'prompt' | 'go'

export const deleteAccountCopy = {
  row: 'Delete account',
  title: 'Delete your Nodpilot account',
  body: [
    'This deletes your saved sessions, notes, exported PDFs, and kept audio.',
    'Usage records are deleted too.',
    'This takes effect immediately and cannot be undone.',
    'Your Google account and email are not deleted.',
    'Provider copies already processed cannot be recalled from here.',
  ],
  cancel: 'Cancel',
  confirm: 'Delete my Nodpilot account',
  deleting: 'Deleting…',
  error: "Couldn't delete your account. Try again.",
  errorSignIn: "Couldn't delete your account. Sign in again.",
  retry: 'Retry',
  notice: 'Your account was deleted.',
} as const

export function accountDeletedNotice(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search
  return new URLSearchParams(query).get('deleted') === '1' ? deleteAccountCopy.notice : ''
}

export function accountInitials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const first = parts[0]?.[0]
    const last = parts[parts.length - 1]?.[0]
    if (first && last) return `${first}${last}`.toUpperCase()
  }
  if (parts[0]?.[0]) return parts[0][0].toUpperCase()
  const local = email.trim().split('@')[0] || ''
  if (local[0]) return local[0].toUpperCase()
  return '?'
}

export function signInLine(signIn: string | undefined): string {
  if (signIn === 'apple') return IPHONE_COPY.accountSignedInApple
  if (signIn === 'google') return IPHONE_COPY.accountSignedInGoogle
  return IPHONE_COPY.accountSignedInEmail
}

export function listeningLeftLine(usage: {
  daily_stt_seconds?: number
  daily_stt_limit?: number
  quota_disabled?: boolean
}): string {
  const used = usage.daily_stt_seconds || 0
  const limit = usage.daily_stt_limit || 0
  if (usage.quota_disabled || limit <= 0) {
    return IPHONE_COPY.listenedTodayNoCap.replace('{hours}', fmtHours(used))
  }
  const left = limit - used
  if (left > 0) return IPHONE_COPY.listeningLeftToday.replace('{hours}', fmtHours(left))
  return IPHONE_COPY.dailyListeningLimit
}

export function signOutGate(input: {
  listening: boolean
  paused: boolean
  disposition: SaveStatus | string
  hasContent: boolean
  workspaceMode: string
}): SignOutGate {
  if (input.listening || input.paused) return 'blocked-listening'
  if (input.disposition === 'saving') return 'wait-saving'
  if (input.workspaceMode === 'meeting' && input.hasContent && input.disposition === 'undecided') {
    return 'prompt'
  }
  return 'go'
}
