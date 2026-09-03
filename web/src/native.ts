import { Capacitor } from '@capacitor/core'

export const NATIVE_API_ORIGIN = 'https://nodpilot.com'
export const NATIVE_AUTH_SCHEME = 'nodpilot'

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const prefix = isNativeApp() ? NATIVE_API_ORIGIN : ''
  return `${prefix}${path.startsWith('/') ? path : `/${path}`}`
}

export function wsUrl(): string {
  if (isNativeApp()) return `${NATIVE_API_ORIGIN.replace(/^http/, 'ws')}/ws`
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

/** Map a site path (`/login?next=/app`) onto the bundled HTML files. */
export function appHref(path: string): string {
  if (!isNativeApp()) return path
  let url: URL
  try {
    url = new URL(path, 'https://nodpilot.com')
  } catch {
    return './app.html'
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    return `./app.html${url.search}${url.hash}`
  }
  const view = pathname === '/' ? '' : pathname.replace(/^\//, '')
  const query = new URLSearchParams(url.search)
  if (view) query.set('view', view)
  const qs = query.toString()
  return `./index.html${qs ? `?${qs}` : ''}${url.hash}`
}

export function nativeGo(path: string, replace = false): void {
  const href = appHref(path)
  if (replace) location.replace(href)
  else location.assign(href)
}

export function sitePathFromLocation(): string {
  const queryView = new URLSearchParams(location.search).get('view')
  if (queryView) {
    const clean = queryView.replace(/^\/+/, '')
    return clean ? `/${clean}` : '/'
  }
  const path = location.pathname.replace(/\/+$/, '') || '/'
  if (path.endsWith('/index.html') || path.endsWith('/app.html')) return '/'
  return path
}

export function tokenFromAppUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const scheme = parsed.protocol.replace(/:$/, '')
    if (scheme !== NATIVE_AUTH_SCHEME) return ''
    const host = (parsed.hostname || parsed.host || '').replace(/\/+$/, '')
    const path = parsed.pathname.replace(/^\/+/, '')
    if (host !== 'auth' && path !== 'auth') return ''
    return parsed.searchParams.get('token') || ''
  } catch {
    return ''
  }
}

const NATIVE_RETURN_KEY = 'nod_native_return'

export function rememberNativeReturn(): void {
  try {
    if (new URLSearchParams(location.search).get('native_return') === '1') {
      sessionStorage.setItem(NATIVE_RETURN_KEY, '1')
    }
  } catch {
    /* private mode */
  }
}

export function wantsNativeReturn(): boolean {
  rememberNativeReturn()
  try {
    if (new URLSearchParams(location.search).get('native_return') === '1') return true
    return sessionStorage.getItem(NATIVE_RETURN_KEY) === '1'
  } catch {
    return false
  }
}

export function maybeReturnToNativeApp(token: string): boolean {
  if (!token || !wantsNativeReturn()) return false
  try {
    sessionStorage.removeItem(NATIVE_RETURN_KEY)
  } catch {
    /* ignore */
  }
  location.replace(`${NATIVE_AUTH_SCHEME}://auth?token=${encodeURIComponent(token)}`)
  return true
}

function onNativeLinkClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest('a')
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) return
  event.preventDefault()
  nativeGo(href)
}

async function listenForAuthReturn(): Promise<void> {
  const { App } = await import('@capacitor/app')
  const apply = async (url: string) => {
    const token = tokenFromAppUrl(url)
    if (!token) return
    const { setToken } = await import('./auth')
    setToken(token)
    try {
      const { Browser } = await import('@capacitor/browser')
      await Browser.close()
    } catch {
      /* browser sheet may already be gone */
    }
    nativeGo('/app', true)
  }
  App.addListener('appUrlOpen', ({ url }) => apply(url))
  const launch = await App.getLaunchUrl()
  if (launch?.url) apply(launch.url)
}

export function installNativeShell(): void {
  if (!isNativeApp()) return
  document.documentElement.classList.add('nod-native')
  document.addEventListener('click', onNativeLinkClick)
  void listenForAuthReturn()
  void import('./keyboardInset').then(({ installKeyboardInset }) => {
    installKeyboardInset()
  })
  void import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
    void StatusBar.setStyle({ style: Style.Dark })
  }).catch(() => undefined)
  void import('@capacitor/keyboard').then(async ({ Keyboard, KeyboardResize }) => {
    await Keyboard.setAccessoryBarVisible({ isVisible: false })
    await Keyboard.setScroll({ isDisabled: true })
    await Keyboard.setResizeMode({ mode: KeyboardResize.Native })
  }).catch(() => undefined)
}
