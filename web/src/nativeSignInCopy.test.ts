import {
  NATIVE_APPLE_SIGN_IN_LABEL,
  NATIVE_SIGNIN_PRIVACY_URL,
  NATIVE_SIGNIN_TERMS_URL,
  appleSignInError,
  nativeSignInCopy,
} from './nativeSignInCopy'

const copy = nativeSignInCopy('en-US')
if (!copy.termsLabel.includes('Terms')) throw new Error('native sign-in copy must include Terms label')
if (!copy.privacyLabel.includes('Privacy')) throw new Error('native sign-in copy must include Privacy label')
if (NATIVE_SIGNIN_TERMS_URL !== 'https://nodpilot.com/terms') {
  throw new Error('native sign-in Terms URL must point at nodpilot.com/terms')
}
if (NATIVE_SIGNIN_PRIVACY_URL !== 'https://nodpilot.com/privacy') {
  throw new Error('native sign-in Privacy URL must point at nodpilot.com/privacy')
}

if (NATIVE_APPLE_SIGN_IN_LABEL !== 'Sign in with Apple') {
  throw new Error('Apple sign-in label must stay Sign in with Apple')
}
if (appleSignInError({ message: 'canceled' }) !== 'Apple sign-in was canceled') {
  throw new Error('Apple canceled mapping')
}
if (appleSignInError({ message: 'boom' }) !== 'boom') {
  throw new Error('Apple error passthrough')
}
if (appleSignInError({}) !== 'Apple sign-in failed') {
  throw new Error('Apple default error')
}

console.log('nativeSignInCopy.test.ts ok')
