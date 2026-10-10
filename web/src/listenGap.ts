export type ListenGap = { id: string; fromMs: number; toMs: number }

export function formatGapTs(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function gapFromEvent(ev: {
  type?: string
  id?: string
  from_ms?: number
  to_ms?: number
}): ListenGap | null {
  if (ev.type !== 'listen_gap') return null
  const id = (ev.id || '').trim()
  const fromMs = ev.from_ms
  const toMs = ev.to_ms
  if (!id || typeof fromMs !== 'number' || typeof toMs !== 'number') return null
  if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || toMs <= fromMs) return null
  return { id, fromMs, toMs }
}

export function gapFromHistoryItem(item: { kind: string; qid: string; text: string }): ListenGap | null {
  if (item.kind !== 'gap') return null
  const id = (item.qid || '').trim()
  const m = (item.text || '').trim().match(/^(\d+)-(\d+)$/)
  if (!id || !m) return null
  const fromMs = Number(m[1])
  const toMs = Number(m[2])
  if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || toMs <= fromMs) return null
  return { id, fromMs, toMs }
}

export function insertGap(gaps: ListenGap[], gap: ListenGap): ListenGap[] {
  if (gaps.some((g) => g.id === gap.id)) return gaps
  return [...gaps, gap].sort((a, b) => a.fromMs - b.fromMs || a.id.localeCompare(b.id))
}

export function gapLabel(
  gap: ListenGap,
  copy: { listenGapLine: string },
): string {
  const from = formatGapTs(gap.fromMs)
  const to = formatGapTs(gap.toMs)
  const secs = Math.max(1, Math.round((gap.toMs - gap.fromMs) / 1000))
  return copy.listenGapLine
    .replace('{from}', from)
    .replace('{to}', to)
    .replace('{secs}', String(secs))
}

export function tsToMs(ts: string): number {
  const t = (ts || '').trim()
  if (!t) return 0
  const parts = t.split(':').map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000
  }
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
  }
  return 0
}

export function interleaveGaps<T extends { ts: string }>(
  lines: T[],
  gaps: ListenGap[],
): Array<{ line: T } | { gap: ListenGap }> {
  if (!gaps.length) return lines.map((line) => ({ line }))
  const sorted = [...gaps].sort((a, b) => a.fromMs - b.fromMs)
  const out: Array<{ line: T } | { gap: ListenGap }> = []
  let gi = 0
  for (const line of lines) {
    while (gi < sorted.length && tsToMs(line.ts) >= sorted[gi].fromMs) {
      out.push({ gap: sorted[gi] })
      gi += 1
    }
    out.push({ line })
  }
  while (gi < sorted.length) {
    out.push({ gap: sorted[gi] })
    gi += 1
  }
  return out
}
