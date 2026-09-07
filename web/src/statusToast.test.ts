import { statusIsAmbient } from './statusToast'

function eq(got: boolean, want: boolean, label: string) {
  if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`)
}

eq(statusIsAmbient(''), true, 'empty status is ambient')
eq(statusIsAmbient('Ready to listen'), true, 'Ready is ambient')
eq(statusIsAmbient('Listening'), true, 'Listening is ambient')
eq(statusIsAmbient('Speech recognition · Auto · follows the language you speak'), true, 'speech recognition chip is ambient')
eq(statusIsAmbient('Speech recognition · English only'), true, 'locked speech language is ambient')
eq(statusIsAmbient('Mode · Translate'), true, 'workspace switch is ambient')
eq(statusIsAmbient('Mode · AI Listening Assistant'), true, 'Listen mode toast is ambient')
eq(statusIsAmbient('Opened meeting session'), true, 'history restore status is ambient')
eq(statusIsAmbient('Microphone is silent'), false, 'mic failure still toasts')
eq(statusIsAmbient('Settings are locked while recording'), false, 'locked settings still toasts')
eq(statusIsAmbient("Couldn't save. Try again."), false, 'save failure still toasts')
eq(statusIsAmbient('Stop listening first'), false, 'blocked mode switch still toasts')

console.log('statusToast.test.ts ok')
