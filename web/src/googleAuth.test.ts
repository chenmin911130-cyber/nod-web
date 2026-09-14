import {
  CLERK_JS_URL,
  CLERK_LOAD_TIMEOUT_MS,
  GOOGLE_LOAD_ERROR,
  googleButtonDisabled,
  googleButtonLabel,
  googleLoadError,
} from './googleAuth'

function eq<T>(got: T, want: T, label: string) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const idle = { isLoaded: true, busy: false, isSignedIn: false, loadFailed: false }

eq(googleButtonLabel({ ...idle, isLoaded: false }), 'Connecting Google…', 'loading label')
eq(googleButtonDisabled({ ...idle, isLoaded: false }), true, 'loading disabled')
eq(googleLoadError(false), '', 'no load error while waiting')

eq(googleButtonLabel(idle), 'Continue with Google', 'ready label')
eq(googleButtonDisabled(idle), false, 'ready enabled')

eq(googleButtonLabel({ ...idle, isSignedIn: true }), 'Open workspace', 'signed-in label')
eq(googleButtonDisabled({ ...idle, isSignedIn: true }), false, 'signed-in enabled')

eq(googleButtonLabel({ ...idle, busy: true }), 'Opening workspace…', 'busy label')
eq(googleButtonDisabled({ ...idle, busy: true }), true, 'busy disabled')

eq(googleButtonLabel({ ...idle, isLoaded: false, loadFailed: true }), 'Continue with Google', 'failed label')
eq(googleButtonDisabled({ ...idle, isLoaded: false, loadFailed: true }), true, 'failed disabled')
eq(googleLoadError(true), GOOGLE_LOAD_ERROR, 'failed error copy')
eq(CLERK_JS_URL, '/clerk.browser.js', 'same-origin clerk-js')
eq(CLERK_LOAD_TIMEOUT_MS, 20_000, 'load timeout')

console.log('googleAuth.test.ts ok')
