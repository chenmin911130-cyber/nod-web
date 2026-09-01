export type TrackEvent =
  | 'cta_hero_start'
  | 'cta_google'
  | 'cta_signup_email'
  | 'cta_pricing'
  | 'scroll_pricing'
  | 'open_privacy'
  | 'signup_success'
  | 'watch_demo'

type TrackProps = Record<string, string | number | boolean | undefined>

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>
  }
}

export function track(name: TrackEvent, props: TrackProps = {}) {
  const payload = {
    event: name,
    name,
    path: typeof location !== 'undefined' ? location.pathname : '',
    ...props,
    t: Date.now(),
  }
  try {
    window.dataLayer = window.dataLayer || []
    window.dataLayer.push(payload)
  } catch {
    /* ignore */
  }
  const body = JSON.stringify({ name, path: payload.path, extra: props })
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))
      return
    }
  } catch {
    /* fall through */
  }
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined)
}

export function applySeo(opts: {
  title: string
  description: string
  url: string
  lang: string
  image: string
  ogTitle?: string
}) {
  document.title = opts.title
  document.documentElement.lang = opts.lang
  setMeta('name', 'description', opts.description)
  setMeta('property', 'og:title', opts.ogTitle || opts.title)
  setMeta('property', 'og:description', opts.description)
  setMeta('property', 'og:url', opts.url)
  setMeta('property', 'og:image', opts.image)
  setMeta('property', 'og:type', 'website')
  setMeta('property', 'og:locale', opts.lang === 'zh-Hans' ? 'zh_CN' : 'en_US')
  setMeta('name', 'twitter:card', 'summary_large_image')
  setMeta('name', 'twitter:title', opts.ogTitle || opts.title)
  setMeta('name', 'twitter:description', opts.description)
  setMeta('name', 'twitter:image', opts.image)
  setLink('canonical', opts.url)
  setLink('alternate', `${origin()}/`, 'en')
  setLink('alternate', `${origin()}/`, 'x-default')
  let jsonld = document.getElementById('nod-jsonld') as HTMLScriptElement | null
  if (!jsonld) {
    jsonld = document.createElement('script')
    jsonld.id = 'nod-jsonld'
    jsonld.type = 'application/ld+json'
    document.head.appendChild(jsonld)
  }
  jsonld.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Nodpilot',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: opts.description,
    url: opts.url,
    image: opts.image,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      category: 'free',
      description: 'Free public testing',
    },
  })
}

function origin() {
  return window.location.origin.replace(/\/+$/, '')
}

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function setLink(rel: string, href: string, hreflang?: string) {
  const sel = hreflang
    ? `link[rel="${rel}"][hreflang="${hreflang}"]`
    : `link[rel="${rel}"]:not([hreflang])`
  let el = document.head.querySelector(sel) as HTMLLinkElement | null
  if (!el) {
    el = document.createElement('link')
    el.rel = rel
    if (hreflang) el.hreflang = hreflang
    document.head.appendChild(el)
  }
  el.href = href
}
