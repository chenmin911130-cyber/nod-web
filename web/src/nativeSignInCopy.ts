export const NATIVE_SIGNIN_TERMS_URL = 'https://nodpilot.com/terms'
export const NATIVE_SIGNIN_PRIVACY_URL = 'https://nodpilot.com/privacy'

export const NATIVE_APPLE_SIGN_IN_LABEL = 'Sign in with Apple'

export function appleSignInError(ex: unknown): string {
  const err = ex as { message?: string }
  const message = err?.message || ''
  if (/canceled/i.test(message)) return 'Apple sign-in was canceled'
  return message || 'Apple sign-in failed'
}

export type NativeSignInCopy = {
  signupLegalLead: string
  termsLabel: string
  privacyLabel: string
  signupLegalJoin: string
}

const EN: NativeSignInCopy = {
  signupLegalLead: 'By creating an account you agree to the',
  termsLabel: 'Terms',
  privacyLabel: 'Privacy Policy',
  signupLegalJoin: 'and',
}

export function nativeSignInCopy(_locale?: string): NativeSignInCopy {
  return EN
}
