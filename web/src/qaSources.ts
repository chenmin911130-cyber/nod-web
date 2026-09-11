import type { AnswerSource, AnswerSources, Turn } from './types'

/**
 * #182 Think: what the client does with a `sources` event.
 *
 * Kept pure and separate from the reducer so the two rules that matter can be
 * tested without a browser: a late event must never attach to a turn it does not
 * belong to, and only safe `http(s)` links are ever rendered.
 */

/** The only schemes allowed to become a clickable citation. */
export function safeLink(url: unknown): string | null {
  const value = typeof url === 'string' ? url.trim() : ''
  if (!value) return null
  const lower = value.toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://') ? value : null
}

/** The links a card may render: safe, deduped, with a usable label. */
export function renderableSources(sources: AnswerSources | undefined): AnswerSource[] {
  if (!sources || !Array.isArray(sources.results)) return []
  const out: AnswerSource[] = []
  const seen = new Set<string>()
  for (const item of sources.results) {
    const url = safeLink(item?.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const title = typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : url
    const published = typeof item?.published_at === 'string' && item.published_at.trim() ? item.published_at.trim() : null
    out.push({ title, url, published_at: published })
  }
  return out
}

/**
 * Attach a `sources` event to the answer it belongs to.
 *
 * The event carries the generation id of the answer it was produced for. An
 * event with no id, or one whose id is not in the current session, is dropped:
 * a lookup that finished after a New / reconnect must not decorate the next
 * session's answer (and a plain answer must never grow an empty source block).
 */
export function applySources(turns: Turn[], ev: AnswerSources & { id?: string }): Turn[] {
  const id = typeof ev?.id === 'string' ? ev.id : ''
  if (!id) return turns
  const index = turns.findIndex((t) => t.id === id)
  if (index < 0) return turns
  const sources: AnswerSources = {
    status: ev.status,
    retrieved_at: ev.retrieved_at,
    retrieved_at_text: ev.retrieved_at_text,
    results: renderableSources(ev),
    note: typeof ev.note === 'string' ? ev.note : '',
  }
  const turns2 = turns.slice()
  turns2[index] = { ...turns2[index], sources }
  return turns2
}

/** True when there is something worth rendering under the answer. */
export function hasSourceBlock(sources: AnswerSources | undefined): boolean {
  if (!sources) return false
  if (sources.note) return true
  return renderableSources(sources).length > 0
}

/**
 * The plain-text sources block used by copy / export so a saved answer keeps the
 *出处 it was based on. Old records (no sources) produce nothing.
 */
export function sourcesAsText(sources: AnswerSources | undefined): string {
  if (!hasSourceBlock(sources)) return ''
  const lines: string[] = []
  const links = renderableSources(sources)
  links.forEach((s, i) => {
    const date = s.published_at ? `（发布时间 ${s.published_at}）` : ''
    lines.push(`[${i + 1}] ${s.title}${date}\n    ${s.url}`)
  })
  if (sources?.retrieved_at_text) lines.push(`检索时间：${sources.retrieved_at_text}`)
  if (sources?.note) lines.push(sources.note)
  return lines.join('\n')
}
