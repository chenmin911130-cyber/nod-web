import { useEffect, useState } from 'react'
import { isNativeApp } from './native'

/** Matches the existing phone media query in App.css. */
export const PHONE_CHROME_MAX_WIDTH = 760
export const PHONE_CHROME_MAX_HEIGHT = 500
export const PHONE_CHROME_QUERY = `(max-width: ${PHONE_CHROME_MAX_WIDTH}px), (max-height: ${PHONE_CHROME_MAX_HEIGHT}px)`

/** Layout only. Capacitor APIs stay behind isNativeApp(). */
export function phoneChrome(opts: { native: boolean; width: number; height: number }): boolean {
  if (opts.native) return true
  return opts.width <= PHONE_CHROME_MAX_WIDTH || opts.height <= PHONE_CHROME_MAX_HEIGHT
}

export function syncPhoneChromeClass(on: boolean): void {
  document.documentElement.classList.toggle('nod-phone', on)
}

export function usePhoneChrome(): boolean {
  const native = isNativeApp()
  const [narrow, setNarrow] = useState(() => {
    if (native) return true
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(PHONE_CHROME_QUERY).matches
  })

  useEffect(() => {
    if (native) {
      syncPhoneChromeClass(true)
      return
    }
    const mq = window.matchMedia(PHONE_CHROME_QUERY)
    const apply = () => {
      setNarrow(mq.matches)
      syncPhoneChromeClass(mq.matches)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [native])

  return native || narrow
}
