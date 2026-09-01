export const PDF_BRAND = 'Nodpilot'

export function pdfBrandMark(kind?: string): string {
  const label = (kind || '').trim()
  return label ? `${PDF_BRAND} · ${label}` : PDF_BRAND
}

export function pdfDefaultTitle(title?: string): string {
  const clean = (title || '').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return clean || PDF_BRAND
}

export function pdfDownloadName(base: string, ext = 'pdf'): string {
  const suffix = ext.replace(/^\./, '')
  const raw = (base || PDF_BRAND).replace(/[\\/:*?"<>|]+/g, ' ').trim() || PDF_BRAND
  const named = raw.toLowerCase().endsWith(`.${suffix}`) ? raw.slice(0, -(suffix.length + 1)) : raw
  if (named.toLowerCase().startsWith('nodpilot')) return `${named}.${suffix}`
  return `${PDF_BRAND}-${named}.${suffix}`
}
