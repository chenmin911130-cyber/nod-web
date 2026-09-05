import { fmtHours, quotaLimitText } from './quotaCopy'

function eq(got: string, want: string, label: string) {
  if (got !== want) throw new Error(`${label}: expected "${want}", got "${got}"`)
}

eq(quotaLimitText('sessions', { session_limit: 60 }), 'Monthly session limit reached (60). Resets on the 1st.', 'sessions')
eq(quotaLimitText('daily_stt', { daily_stt_limit: 7200 }), 'Daily listening limit reached (2h). Resets at midnight UTC.', 'daily_stt')
eq(quotaLimitText('llm', { llm_limit: 100000 }), 'Monthly token limit reached (100,000). Resets on the 1st.', 'llm')
eq(quotaLimitText('daily', {}), 'Daily spending limit reached. Resets at midnight UTC.', 'daily')
eq(quotaLimitText('global', {}), 'Daily platform budget reached. Try again later.', 'global')
eq(quotaLimitText('stt', { stt_limit: 2 * 3600 * 31 }), 'Monthly listening limit reached (62h). Resets on the 1st.', 'stt')
eq(quotaLimitText('', {}), 'Usage limit reached — open Account', 'default')
eq(quotaLimitText(undefined, {}), 'Usage limit reached — open Account', 'no reason')
eq(fmtHours(7200), '2h', 'hours')
eq(fmtHours(3600), '1h', 'one hour')
