/** Native cold start paints from the token already on the device.
 *  `/api/me` must not hold the brand mask — a slow or hanging request is why
 *  opening the app sat on the launch image for seconds. */
export type NativeColdStartSurface = 'workspace' | 'signin'

export function nativeColdStartSurface(token: string): NativeColdStartSurface {
  return token ? 'workspace' : 'signin'
}
