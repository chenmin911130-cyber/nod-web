import { fmtHours } from './quotaCopy'
import type { SaveStatus } from './sessionSave'

export type SignOutGate = 'blocked-listening' | 'wait-saving' | 'prompt' | 'go'

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
  return signIn === 'google' ? 'Signed in with Google' : 'Signed in with email'
}

export function listeningLeftLine(usage: {
  daily_stt_seconds?: number
  daily_stt_limit?: number
  quota_disabled?: boolean
}): string {
  const used = usage.daily_stt_seconds || 0
  const limit = usage.daily_stt_limit || 0
  if (usage.quota_disabled || limit <= 0) {
    return `Listened today · ${fmtHours(used)} · no daily cap`
  }
  const left = limit - used
  if (left > 0) return `Listening left today · ${fmtHours(left)}`
  return 'Daily listening limit reached · resets at midnight UTC'
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
