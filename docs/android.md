# Android (Capacitor)

The Android app is the existing web workspace in a WebView. Listen uses the browser microphone (`getUserMedia`). This is a **foreground** build: lock-screen / pocket recording and Apple Watch are not included.

## Package a debug APK

Android Studio and the SDK must already be installed.

```bash
npm ci
(cd web && npm ci)
npm run cap:android
```

That writes:

- `android/app/build/outputs/apk/debug/app-debug.apk`
- `~/Desktop/Nodpilot-debug.apk`

Install:

```bash
npm run cap:android -- --install
```

or open the project:

```bash
npm run cap:android -- --open
```

In Android Studio: select a device or emulator, press Run. The first Listen tap must grant **Microphone**.

Sign in with email OTP. Google sheet is iOS-only in this build.

API traffic goes to `https://nodpilot.com` / `wss://nodpilot.com`.

## Out of scope

Wear OS, native lock-screen uplink (`nod-mic` AudioUplink), and the iOS Google sign-in sheet.
