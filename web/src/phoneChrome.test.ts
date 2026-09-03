import { phoneChrome } from './phoneChrome'

function eq(got: boolean, want: boolean, label: string) {
  if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`)
}

eq(phoneChrome({ native: true, width: 1440, height: 900 }), true, 'native is always phone chrome')
eq(phoneChrome({ native: false, width: 390, height: 844 }), true, 'iPhone portrait uses phone chrome')
eq(phoneChrome({ native: false, width: 1440, height: 900 }), false, 'desktop stays on the web layout')
eq(phoneChrome({ native: false, width: 844, height: 390 }), true, 'iPhone landscape uses phone chrome')
eq(phoneChrome({ native: false, width: 760, height: 800 }), true, '760px is the last phone width')
eq(phoneChrome({ native: false, width: 761, height: 800 }), false, '761px keeps the web layout')
eq(phoneChrome({ native: false, width: 900, height: 500 }), true, 'short landscape height uses phone chrome')
eq(phoneChrome({ native: false, width: 900, height: 501 }), false, '501px height on a wide window stays web')

console.log('phoneChrome.test.ts ok')
