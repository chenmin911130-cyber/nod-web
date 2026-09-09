import { IPHONE_COPY } from './iphoneCopy'
import { nextStatusText, statusIsAmbient, statusIsStickyUplink, statusShouldOverlayToast } from './statusToast'

function eq<T>(got: T, want: T, label: string) {
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
eq(statusIsAmbient(IPHONE_COPY.uplinkUnavailable), false, 'uplink capability is not ambient')
eq(statusShouldOverlayToast('Microphone is silent'), true, 'mic failure still overlays')
eq(statusShouldOverlayToast(IPHONE_COPY.uplinkUnavailable), false, 'uplink failure stays in the status band')
eq(statusShouldOverlayToast(IPHONE_COPY.uplinkFailed), false, 'uplink connect failure stays in the status band')
eq(statusIsStickyUplink(IPHONE_COPY.uplinkUnavailable), true, 'unimplemented maps to sticky uplink copy')
eq(nextStatusText(IPHONE_COPY.uplinkUnavailable, IPHONE_COPY.uplinkUnavailable), IPHONE_COPY.uplinkUnavailable, 'same uplink error does not stack a second line')
eq(nextStatusText(IPHONE_COPY.uplinkUnavailable, 'Listening'), IPHONE_COPY.uplinkUnavailable, 'Listening does not 2s-dismiss the uplink banner')
eq(nextStatusText(IPHONE_COPY.uplinkUnavailable, ''), '', 'successful uplink clears the banner')
eq(nextStatusText(IPHONE_COPY.uplinkUnavailable, 'Microphone is silent'), 'Microphone is silent', 'a later non-ambient status replaces the uplink banner')

console.log('statusToast.test.ts ok')
