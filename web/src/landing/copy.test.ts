import { COPY, type Locale } from './copy'

function publicText(): string {
  return JSON.stringify(COPY)
}

const leaked = publicText().match(/stealth|pin-on-top|隐身/gi)
if (leaked) {
  throw new Error(`public landing copy must not advertise desktop stealth: ${leaked.join(', ')}`)
}

const crossWeek = publicText().match(/pricing last week|上周我们怎么决定定价|ask about them later|再继续问/gi)
if (crossWeek) {
  throw new Error(`landing must not claim cross-session Ask: ${crossWeek.join(', ')}`)
}

if ('sitPresentation' in COPY.en || 'sitPresentation' in COPY.zh) {
  throw new Error('Presentation is not a product scene; map talks onto Lecture copy')
}

for (const loc of ['en', 'zh'] as Locale[]) {
  const mem = COPY[loc].memP
  if (!/30/.test(mem)) {
    throw new Error(`${loc} Memory copy must say History is 30 days: ${mem}`)
  }
  if (/Interviewer|面试官/.test(COPY[loc].demoInterviewer)) {
    throw new Error(`${loc} Live Q&A demo must not frame an interviewer`)
  }
}

if (COPY.en.proof5.toLowerCase().includes('memory') && !COPY.en.proof5.toLowerCase().includes('30')) {
  throw new Error(`proof chip must not advertise searchable Memory: ${COPY.en.proof5}`)
}
