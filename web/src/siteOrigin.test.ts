import { SITE_ORIGIN, siteUrl } from './siteOrigin'

function eq<T>(got: T, want: T) {
  if (got !== want) {
    throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

eq(SITE_ORIGIN, 'https://nodpilot.com')
eq(siteUrl('/'), 'https://nodpilot.com/')
eq(siteUrl('/zh'), 'https://nodpilot.com/zh')
eq(siteUrl('privacy'), 'https://nodpilot.com/privacy')
eq(siteUrl('/login'), 'https://nodpilot.com/login')
