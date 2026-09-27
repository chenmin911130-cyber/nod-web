# Native apps

The iOS app wraps the web workspace in Capacitor with native mic uplink and lock-screen recording. The Apple Watch app records with the watch mic and mirrors phone state. The Android debug APK matches the phone features without a Watch.

## Sub-features

- `native-apps` is a placeholder that always reports NOT VERIFIABLE on Linux.

## How to get to it (user POV)

- TestFlight build on an iPhone, the paired Watch app, or the Android debug APK.

## Driving it with control-nod

Preconditions:

- macOS with Xcode for iOS and Watch; Android SDK and a device or emulator for Android.

- **iOS compile.** Run `npm run check:ios` on macOS. It compiles the real `App` scheme (App, WatchApp, and the local pods).
- **iOS delivery.** Follow `docs/ios-deliver.md` (`npm run cap:ios -- build …`). Do not hand-assemble `cap sync` / `xcodebuild`.
- **Android.** Run `npm run cap:android` per `docs/android.md`.
- **Here.** Run `control-nod drive native-apps` to record the skip with its reason.

## Gotchas

- Read `.cursor/skills/self-improve/errors.md` before any Watch or phone-sync verification; most past misses were there.
- Installing the phone app does not update the Watch app. Check both bundle versions on device.
