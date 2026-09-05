// Maps a quota reason to a user-facing "limit reached" line. The values
// (session_limit, daily_stt_limit, …) come from the /api/me usage snapshot the
// client already holds, so the copy can name the exact cap.
export type QuotaFields = Record<string, number | undefined>

export function fmtHours(seconds?: number): string {
  if (!seconds) return '0h'
  const h = seconds / 3600
  return `${(Math.round(h * 10) / 10).toString().replace(/\.0$/, '')}h`
}

export function quotaLimitText(reason: string | undefined, q: QuotaFields = {}): string {
  switch (reason) {
    case 'sessions':
      return `Monthly session limit reached (${q.session_limit ?? 60}). Resets on the 1st.`
    case 'daily_stt':
      return `Daily listening limit reached (${fmtHours(q.daily_stt_limit)}). Resets at midnight UTC.`
    case 'llm':
      return `Monthly token limit reached (${(q.llm_limit ?? 100000).toLocaleString()}). Resets on the 1st.`
    case 'daily':
      return 'Daily spending limit reached. Resets at midnight UTC.'
    case 'global':
      return 'Daily platform budget reached. Try again later.'
    case 'stt':
      return `Monthly listening limit reached (${fmtHours(q.stt_limit)}). Resets on the 1st.`
    default:
      return 'Usage limit reached — open Account'
  }
}
