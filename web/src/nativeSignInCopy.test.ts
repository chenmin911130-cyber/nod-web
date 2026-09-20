import {
  NATIVE_SIGNIN_PRIVACY_URL,
  NATIVE_SIGNIN_TERMS_URL,
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

console.log('nativeSignInCopy.test.ts ok')
