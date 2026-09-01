export type ListenPdfTheme = 'meeting' | 'lecture'

export type ListenPdfDoc = {
  theme: ListenPdfTheme
  title: string
  date: string
  exported: string
  duration: string
  speakers: string[]
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: Array<{ text: string; owner?: string }>
  importantDetails: string[]
  followUps: string[]
  revisionNotes: string[]
  catchNotes: Array<{ title: string; text: string }>
  transcript: Array<{ ts: string; speaker: string; text: string; translation?: string }>
}

export function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function textHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br />')
}

export function titleFromSummary(summary: string, fallback: string): string {
  const raw = (summary || '').trim()
  if (!raw) return fallback
  const sentence = raw.split(/[.。!?？]/)[0].trim() || raw
  if (sentence.length <= 72) return sentence
  return `${sentence.slice(0, 69).trim()}…`
}

export function buildListenPdfDoc(input: {
  theme: ListenPdfTheme
  summary: string
  date?: string
  exported?: string
  duration?: string
  speakers?: string[]
  keyPoints?: string[]
  decisions?: string[]
  actionItems?: Array<{ text: string; owner?: string }>
  importantDetails?: string[]
  followUps?: string[]
  revisionNotes?: string[]
  catchNotes?: Array<{ title: string; text: string }>
  transcript?: ListenPdfDoc['transcript']
}): ListenPdfDoc {
  const fallback = input.theme === 'lecture' ? 'Study notes' : 'Meeting notes'
  return {
    theme: input.theme,
    title: titleFromSummary(input.summary, fallback),
    date: input.date || new Date().toLocaleDateString(),
    exported: input.exported || new Date().toLocaleString(),
    duration: input.duration || '',
    speakers: input.speakers || [],
    summary: input.summary || '',
    keyPoints: input.keyPoints || [],
    decisions: input.decisions || [],
    actionItems: input.actionItems || [],
    importantDetails: input.importantDetails || [],
    followUps: input.followUps || [],
    revisionNotes: input.revisionNotes || [],
    catchNotes: (input.catchNotes || []).filter((n) => n.text.trim()),
    transcript: input.transcript || [],
  }
}

const SHARED = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: 794px; }
  .sheet {
    width: 794px;
    height: 1123px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    page-break-after: always;
  }
  .body { flex: 1; min-height: 0; padding: 16px 28px 10px; }
  .foot {
    display: flex;
    justify-content: space-between;
    padding: 0 28px 14px;
    font-size: 10px;
    letter-spacing: 0.08em;
  }
`

export const MEETING_CSS = `
  ${SHARED}
  :root {
    --ink: #102033;
    --muted: #5d6d82;
    --line: #d5deea;
    --paper: #f4f7fb;
    --card: #ffffff;
    --navy: #0b1424;
    --cyan: #0891b2;
    --cyan-soft: #e8f7fb;
    --ok: #0f766e;
  }
  .sheet { background: var(--paper); color: var(--ink); font-family: "IBM Plex Sans", "Segoe UI", "Microsoft YaHei UI", sans-serif; }
  .mast {
    background: var(--navy);
    color: #eef5ff;
    padding: 20px 22px 18px 28px;
    display: grid;
    grid-template-columns: 10px 1fr auto;
    gap: 16px;
    align-items: start;
    flex-shrink: 0;
  }
  .mast.slim { padding: 12px 28px; grid-template-columns: 1fr auto; align-items: center; }
  .rail { width: 4px; min-height: 78px; background: #22d3ee; border-radius: 99px; margin-top: 4px; }
  .brand { font-size: 11px; letter-spacing: 0.18em; color: #67e8f9; font-weight: 700; }
  .kind { display: inline-block; margin: 8px 0 6px; font-size: 10px; letter-spacing: 0.16em; font-weight: 700; color: #9ab0c9; }
  h1 { margin: 0; font-family: Newsreader, Georgia, "Songti SC", serif; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
  .mast.slim h1 { font-size: 16px; }
  .when { text-align: right; font-size: 12px; color: #9ab0c9; line-height: 1.5; }
  .when strong { display: block; color: #eef5ff; font-size: 13px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 28px 0; flex-shrink: 0; }
  .chip { background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; font-size: 11px; color: var(--muted); font-weight: 600; }
  .summary { background: var(--card); border: 1px solid var(--line); border-left: 3px solid #22d3ee; padding: 12px 14px; margin-bottom: 14px; }
  .label { font-size: 10px; letter-spacing: 0.16em; font-weight: 700; color: var(--cyan); margin: 0 0 8px; }
  .summary p { margin: 0; font-family: Newsreader, Georgia, "Songti SC", serif; font-size: 15px; line-height: 1.45; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
  .box { background: var(--card); border: 1px solid var(--line); padding: 12px 14px 10px; }
  h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cyan); }
  .dec { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 8px; font-size: 12.5px; line-height: 1.4; }
  .dec i { flex: 0 0 12px; height: 12px; margin-top: 3px; border: 1.5px solid var(--cyan); transform: rotate(45deg); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; padding: 0 0 6px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 8px 7px 0; font-size: 12.5px; vertical-align: top; border-bottom: 1px solid #eef2f6; }
  .who { display: inline-block; background: var(--cyan-soft); color: var(--ok); font-weight: 700; font-size: 11px; padding: 2px 7px; border-radius: 999px; }
  .points { margin: 0 0 12px; }
  .points ul { margin: 0; padding: 0; list-style: none; }
  .points li { position: relative; padding: 0 0 6px 14px; font-size: 13px; line-height: 1.4; }
  .points li::before { content: ""; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; background: #22d3ee; }
  .follow { display: flex; gap: 10px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
  .follow b { color: var(--cyan); font-size: 11px; width: 22px; }
  .tx { margin-top: 4px; }
  .line { display: grid; grid-template-columns: 52px 72px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid #e8eef5; font-size: 12px; line-height: 1.4; }
  .ts { color: var(--muted); font-variant-numeric: tabular-nums; }
  .spk { font-weight: 700; color: #0e7490; }
  .tr { color: var(--muted); }
  .foot { color: var(--muted); }
  .catch { background: var(--card); border: 1px solid var(--line); padding: 10px 12px; margin-bottom: 12px; }
  .catch .q { margin: 0 0 6px; font-size: 12px; color: var(--muted); }
`

export const LECTURE_CSS = `
  ${SHARED}
  :root {
    --ink: #1c1712;
    --muted: #6b5e4e;
    --line: #e4d8c4;
    --paper: #f6f1e6;
    --card: #fffdf8;
    --forest: #161410;
    --teal: #0f766e;
    --amber: #b45309;
    --cream: #fff7ed;
  }
  .sheet { background: var(--paper); color: var(--ink); font-family: "IBM Plex Sans", "Segoe UI", "Microsoft YaHei UI", sans-serif; }
  .mast { background: var(--forest); color: #f6efe2; padding: 22px 28px 18px; flex-shrink: 0; }
  .mast.slim { padding: 12px 28px; }
  .top { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; letter-spacing: 0.16em; color: #f5d38a; font-weight: 700; }
  .course { color: #c4b59a; letter-spacing: 0.08em; font-weight: 600; }
  h1 { margin: 10px 0 6px; font-family: Literata, Georgia, "Songti SC", serif; font-size: 28px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.12; }
  .mast.slim h1 { margin: 4px 0 0; font-size: 16px; }
  .meta { color: #c4b59a; font-size: 12px; }
  .rule { height: 3px; margin-top: 14px; background: linear-gradient(90deg, #f5d38a 0 28%, #0f766e 28% 62%, #e8d5b0 62% 100%); }
  .overview { font-family: Literata, Georgia, "Songti SC", serif; font-size: 16px; line-height: 1.45; margin: 0 0 14px; }
  .sec { font-size: 10px; letter-spacing: 0.16em; font-weight: 700; color: var(--teal); margin: 0 0 8px; }
  .concepts { margin: 0 0 12px; padding: 0; list-style: none; }
  .concepts li { display: grid; grid-template-columns: 36px 1fr; gap: 10px; align-items: start; padding: 7px 0; border-top: 1px solid var(--line); }
  .concepts b { font-family: Georgia, "Songti SC", serif; font-size: 20px; color: var(--teal); line-height: 1; }
  .concepts span { font-size: 13px; line-height: 1.4; padding-top: 3px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 12px; }
  .flash { background: var(--cream); border: 1px solid #f0d3a8; padding: 11px 12px; min-height: 78px; }
  .flash small { display: block; color: var(--amber); font-size: 10px; letter-spacing: 0.12em; font-weight: 700; margin-bottom: 6px; }
  .flash p { margin: 0; font-size: 13px; line-height: 1.4; }
  .formula { font-family: Georgia, "Songti SC", serif; background: var(--card); border: 1px dashed #d2c4a8; padding: 10px 12px; margin: 0 0 12px; font-size: 14px; }
  .formula span { display: block; font-size: 10px; letter-spacing: 0.12em; color: var(--muted); font-family: "IBM Plex Sans", "Segoe UI", sans-serif; font-weight: 700; margin-bottom: 4px; }
  .details { margin: 0 0 12px; padding: 0; list-style: none; }
  .details li { padding: 4px 0 4px 14px; position: relative; font-size: 13px; line-height: 1.4; }
  .details li::before { content: ""; position: absolute; left: 0; top: 10px; width: 6px; height: 6px; background: #f5d38a; }
  .hw { background: #ecf6f3; border: 1px solid #b7d9d2; padding: 12px 14px; margin-bottom: 12px; }
  .hw ol { margin: 0; padding-left: 18px; font-size: 13px; }
  .hw li { margin: 4px 0; }
  .line { display: grid; grid-template-columns: 52px 78px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid #eadfcb; font-size: 12px; line-height: 1.4; }
  .ts { color: var(--muted); font-variant-numeric: tabular-nums; }
  .spk { font-weight: 700; color: var(--teal); }
  .spk.aud { color: var(--amber); }
  .tr { color: var(--muted); }
  .foot { color: var(--muted); }
  .catch { background: var(--card); border: 1px solid var(--line); padding: 10px 12px; margin-bottom: 12px; }
  .catch .q { margin: 0 0 6px; font-size: 12px; color: var(--muted); }
`

export function templateCss(theme: ListenPdfTheme): string {
  return theme === 'lecture' ? LECTURE_CSS : MEETING_CSS
}

export function templateFonts(theme: ListenPdfTheme): string {
  if (theme === 'lecture') {
    return 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Literata:opsz,wght@7..72,500;7..72,650&display=swap'
  }
  return 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Newsreader:opsz,wght@16..72,500;16..72,600&display=swap'
}

export function mastHtml(doc: ListenPdfDoc, slim: boolean): string {
  const speakers = doc.speakers.length ? `${doc.speakers.length} speaker${doc.speakers.length === 1 ? '' : 's'}` : ''
  if (doc.theme === 'lecture') {
    const meta = [doc.date, doc.duration, doc.speakers.join(' + ')].filter(Boolean).join(' · ')
    if (slim) {
      return `<header class="mast slim"><div class="top"><span>Nodpilot · STUDY NOTES</span><span class="course">${escapeHtml(doc.date)}</span></div><h1>${escapeHtml(doc.title)}</h1></header>`
    }
    return `<header class="mast"><div class="top"><span>Nodpilot · STUDY NOTES</span><span class="course">${escapeHtml(doc.exported)}</span></div><h1>${escapeHtml(doc.title)}</h1><div class="meta">${escapeHtml(meta)}</div><div class="rule"></div></header>`
  }
  if (slim) {
    return `<header class="mast slim"><div><div class="brand">Nodpilot</div><h1>${escapeHtml(doc.title)}</h1></div><div class="when"><strong>${escapeHtml(doc.date)}</strong></div></header>`
  }
  return `<header class="mast"><div class="rail"></div><div><div class="brand">Nodpilot</div><div class="kind">MEETING NOTES</div><h1>${escapeHtml(doc.title)}</h1></div><div class="when"><strong>${escapeHtml(doc.date)}</strong>${doc.duration ? `${escapeHtml(doc.duration)}<br />` : ''}${escapeHtml(speakers)}</div></header>`
}

export function chipsHtml(doc: ListenPdfDoc): string {
  if (doc.theme === 'lecture') return ''
  const chips = [
    ...doc.speakers.map((name) => `<span class="chip">${escapeHtml(name)}</span>`),
    `<span class="chip">Exported ${escapeHtml(doc.exported)}</span>`,
  ]
  return `<div class="chips">${chips.join('')}</div>`
}

export function footerHtml(doc: ListenPdfDoc, page: number, total: number): string {
  const mid = doc.theme === 'lecture' ? 'CONCEPTS · REVISION · HOMEWORK' : 'DECISIONS · ACTIONS · FOLLOW-UPS'
  const kind = doc.theme === 'lecture' ? 'LECTURE' : 'MEETING'
  return `<footer class="foot"><span>Nodpilot · ${kind}</span><span>${mid}</span><span>${page} / ${total}</span></footer>`
}

export function sectionChunks(doc: ListenPdfDoc): string[] {
  const chunks: string[] = []
  if (doc.theme === 'lecture') {
    if (doc.summary.trim()) chunks.push(`<p class="overview">${textHtml(doc.summary)}</p>`)
    if (doc.keyPoints.length) {
      chunks.push(`<p class="sec">CONCEPTS</p><ol class="concepts">${doc.keyPoints.map((item, i) => `<li><b>${String(i + 1).padStart(2, '0')}</b><span>${textHtml(item)}</span></li>`).join('')}</ol>`)
    }
    if (doc.revisionNotes.length) {
      chunks.push(`<p class="sec">REVISE · EXAM / FORMULAS</p><div class="cards">${doc.revisionNotes.map((item) => `<div class="flash"><small>REVISE</small><p>${textHtml(item)}</p></div>`).join('')}</div>`)
    }
    if (doc.importantDetails.length) {
      const [first, ...rest] = doc.importantDetails
      chunks.push(`<div class="formula"><span>EXAMPLES &amp; DETAILS</span>${textHtml(first)}</div>`)
      if (rest.length) chunks.push(`<ul class="details">${rest.map((item) => `<li>${textHtml(item)}</li>`).join('')}</ul>`)
    }
    if (doc.followUps.length) {
      chunks.push(`<section class="hw"><p class="sec">HOMEWORK &amp; READING</p><ol>${doc.followUps.map((item) => `<li>${textHtml(item)}</li>`).join('')}</ol></section>`)
    }
  } else {
    if (doc.summary.trim()) {
      chunks.push(`<section class="summary"><p class="label">SUMMARY</p><p>${textHtml(doc.summary)}</p></section>`)
    }
    if (doc.decisions.length || doc.actionItems.length) {
      const dec = doc.decisions.length
        ? `<section class="box"><h2>Decisions</h2>${doc.decisions.map((item) => `<div class="dec"><i></i><span>${textHtml(item)}</span></div>`).join('')}</section>`
        : ''
      const act = doc.actionItems.length
        ? `<section class="box"><h2>Action items</h2><table><thead><tr><th>Owner</th><th>Item</th></tr></thead><tbody>${doc.actionItems.map((row) => `<tr><td>${row.owner ? `<span class="who">${escapeHtml(row.owner)}</span>` : '—'}</td><td>${textHtml(row.text)}</td></tr>`).join('')}</tbody></table></section>`
        : ''
      chunks.push(`<div class="split">${dec}${act}</div>`)
    }
    if (doc.keyPoints.length) {
      chunks.push(`<section class="points"><h2>Key points</h2><ul>${doc.keyPoints.map((item) => `<li>${textHtml(item)}</li>`).join('')}</ul></section>`)
    }
    if (doc.importantDetails.length) {
      chunks.push(`<section class="points"><h2>Important details</h2><ul>${doc.importantDetails.map((item) => `<li>${textHtml(item)}</li>`).join('')}</ul></section>`)
    }
    if (doc.followUps.length) {
      chunks.push(`<section>${doc.followUps.map((item, i) => `<div class="follow"><b>${String(i + 1).padStart(2, '0')}</b> ${textHtml(item)}</div>`).join('')}</section>`)
    }
  }
  for (const note of doc.catchNotes) {
    chunks.push(`<section class="catch"><h2>${escapeHtml(note.title || 'Ask')}</h2><p>${textHtml(note.text)}</p></section>`)
  }
  const heading = doc.theme === 'lecture' ? '<p class="sec">CLASSROOM STREAM</p>' : '<h2>Transcript</h2>'
  if (!doc.transcript.length) {
    chunks.push(`${heading}<div class="line"><span class="ts"></span><span class="spk"></span><span>No transcript lines.</span></div>`)
  } else {
    chunks.push(heading)
    for (const line of doc.transcript) {
      const aud = /audience/i.test(line.speaker) ? ' aud' : ''
      chunks.push(`<div class="line"><span class="ts">${escapeHtml(line.ts)}</span><span class="spk${aud}">${escapeHtml(line.speaker)}</span><span>${textHtml(line.text)}${line.translation ? `<span class="tr"><br />${textHtml(line.translation)}</span>` : ''}</span></div>`)
    }
  }
  return chunks
}
