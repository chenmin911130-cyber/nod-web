import { buildListenPdfDoc, sectionChunks } from './pdfTemplates'

function eq<T>(got: T, want: T, label?: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label || 'assert'}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// Same-language passthrough: a transcript line whose translation equals its
// source must NOT paint a second row in the exported PDF (the observed bug:
// each English line followed by the identical English). A genuinely different
// translation still gets its own `.tr` row.
{
  const doc = buildListenPdfDoc({
    theme: 'meeting',
    summary: '',
    transcript: [
      { ts: '0:01', speaker: 'Host', text: 'The host introduces the tutorial.', translation: 'The host introduces the tutorial.' },
      { ts: '0:06', speaker: 'Host', text: 'We ship Friday.', translation: '我们周五发。' },
    ],
  })
  const html = sectionChunks(doc).join('\n')
  const trRows = html.split('<span class="tr">').length - 1
  eq(trRows, 1, 'only the genuinely-different translation renders a second row')
  const sourceCount = html.split('The host introduces the tutorial.').length - 1
  eq(sourceCount, 1, 'same-language passthrough prints the source once in the PDF')
}

// A translation that differs only by whitespace normalizes to one copy.
{
  const doc = buildListenPdfDoc({
    theme: 'meeting',
    summary: '',
    transcript: [{ ts: '0:01', speaker: 'Host', text: 'We ship Friday.', translation: 'We ship   Friday.' }],
  })
  const html = sectionChunks(doc).join('\n')
  eq(html.split('<span class="tr">').length - 1, 0, 'whitespace-only difference dedupes to one row')
}

// No translation: the transcript line renders once, never an empty `.tr` row.
{
  const doc = buildListenPdfDoc({
    theme: 'meeting',
    summary: '',
    transcript: [{ ts: '0:01', speaker: 'Host', text: 'We ship Friday.' }],
  })
  const html = sectionChunks(doc).join('\n')
  eq(html.split('<span class="tr">').length - 1, 0, 'a line with no translation stays source-only')
}
