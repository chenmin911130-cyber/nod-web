export const CLERK_JS_URL = '/clerk.browser.js'

export const CLERK_SIGN_IN_URL = '/login'

export const CLERK_SIGN_UP_URL = '/signup'

/** Clerk bot protection looks up this exact id on OAuth sign-up transfer. */
export const CLERK_CAPTCHA_ELEMENT_ID = 'clerk-captcha'

export const CLERK_LOAD_TIMEOUT_MS = 20_000

export const GOOGLE_LOAD_ERROR = "Google sign-in didn't load. Refresh the page, or use an email code."

export type GoogleButtonState = {
  isLoaded: boolean
  busy: boolean
  isSignedIn: boolean
  loadFailed: boolean
}

export function googleButtonLabel(state: GoogleButtonState): string {
  if (state.busy) return 'Opening workspace…'
  if (!state.isLoaded && !state.loadFailed) return 'Connecting Google…'
  if (state.isSignedIn) return 'Open workspace'
  return 'Continue with Google'
}

export function googleButtonDisabled(state: GoogleButtonState): boolean {
  return state.busy || !state.isLoaded || state.loadFailed
}

export function googleLoadError(loadFailed: boolean): string {
  return loadFailed ? GOOGLE_LOAD_ERROR : ''
}
