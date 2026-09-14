export interface NodSplashPlugin {
  /** Tell the native brand mask that the first real page is on screen. */
  splashReady(): Promise<void>
}
