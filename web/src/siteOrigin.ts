export const SITE_ORIGIN = 'https://nodpilot.com'

export function siteUrl(path: string): string {
  const trimmed = (path || '/').trim() || '/'
  if (trimmed === '/') return `${SITE_ORIGIN}/`
  return `${SITE_ORIGIN}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
}
