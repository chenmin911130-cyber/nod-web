export function formatDetectedAgo(ms: number): string {
  if (ms < 1500) return 'just now'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  if (ms < 3600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  return `${Math.max(1, Math.round(ms / 3600_000))}h ago`
}

export function qaDetectedLine(input: { listening?: boolean; generating?: boolean; msAgo: number }): string {
  if (input.listening) return 'Question detected · listening'
  if (input.generating) return 'Question detected · answering'
  return `Question detected · ${formatDetectedAgo(input.msAgo)}`
}

/** Split an answer for the card. Numbers stay as written — no rounding or invented stats. */
export function qaAnswerParts(answer: string): { hero: string | null; summary: string; more: string } {
  const normalized = answer.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return { hero: null, summary: '', more: '' }
  // Trim only leading/trailing blank lines and trailing horizontal whitespace
  // so multi-line lists and indented code keep their line breaks and indent.
  const text = normalized
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '')
    .replace(/[ \t]+$/, '')
  let summary = text
  let more = ''
  if (!text.includes('\n')) {
    const split = /(?<=[.!?])[ \t]+/.exec(text)
    if (split) {
      summary = text.slice(0, split.index)
      more = text.slice(split.index + split[0].length)
    }
  }
  const firstLine = summary.split('\n', 1)[0].trimStart()
  const lead = firstLine.match(/^(?:about|approximately|around|≈|~)?\s*(\d[\d.,]*)\s*(million|billion|thousand|m|k|%)\b/i)
  if (!lead) return { hero: null, summary, more }
  const n = lead[1]
  const unit = lead[2].toLowerCase()
  let hero = n
  if (unit === 'million' || unit === 'm') hero = `${n}M`
  else if (unit === 'billion') hero = `${n}B`
  else if (unit === 'thousand' || unit === 'k') hero = `${n}K`
  else if (unit === '%') hero = `${n}%`
  return { hero, summary, more }
}
