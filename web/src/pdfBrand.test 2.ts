import { PDF_BRAND, pdfBrandMark, pdfDefaultTitle, pdfDownloadName } from './pdfBrand'

function eq(got: string, want: string, label: string) {
  if (got !== want) throw new Error(`${label}: expected "${want}", got "${got}"`)
}

eq(PDF_BRAND, 'Nodpilot', 'brand')
eq(pdfBrandMark(), 'Nodpilot', 'mark only')
eq(pdfBrandMark('MEETING'), 'Nodpilot · MEETING', 'mark with kind')
eq(pdfDefaultTitle(''), 'Nodpilot', 'empty title')
eq(pdfDefaultTitle('NOD'), 'NOD', 'keep session title')
eq(pdfDownloadName('Lecture-2026-08-28'), 'Nodpilot-Lecture-2026-08-28.pdf', 'prefix pdf')
eq(pdfDownloadName('Nodpilot-Lecture-2026-08-28.pdf'), 'Nodpilot-Lecture-2026-08-28.pdf', 'do not double prefix')
eq(pdfDownloadName('Lecture-2026-08-28', 'wav'), 'Nodpilot-Lecture-2026-08-28.wav', 'audio name')
