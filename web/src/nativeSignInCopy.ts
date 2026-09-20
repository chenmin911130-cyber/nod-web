export const NATIVE_SIGNIN_TERMS_URL = 'https://nodpilot.com/terms'
export const NATIVE_SIGNIN_PRIVACY_URL = 'https://nodpilot.com/privacy'

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
