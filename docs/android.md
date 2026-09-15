# Android (Capacitor)

The Android app is the same phone workspace as iPhone: bundled `web/dist` in a WebView, API/WS to `https://nodpilot.com` / `wss://nodpilot.com`. Native plugins cover Google sign-in, lock-screen listen (foreground service + PCM uplink), share/save, and on-phone speech playback. **Wear OS / Apple Watch are not included.**

## Package a debug APK

Android Studio and the SDK must already be installed. Packaging uses a JDK 21 (not Android Studio’s bundled JBR 25 — Gradle 8.11 cannot load it).

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

In Android Studio: select a device or emulator, press Run. The first Listen tap must grant **Microphone**. Android 13+ may also ask to show the listening notification.

Sign in with Google (Chrome Custom Tab → `nodpilot://auth`) or email OTP.

This does not bump the iOS bundle.

## Phone parity

| iPhone | Android |
|---|---|
| `NodAuth.google` in-app login sheet | Chrome Custom Tab of the same login URL (Google blocks embedded WebView OAuth) |
| `NodMic` 16 kHz PCM + native `wss` uplink + lock-screen keep-alive | `AudioRecord` + OkHttp uplink + microphone foreground service |
| `NodWatch` save/share/play/account on the phone | same methods; Watch commands no-op |
| Apple Watch | not in this build |

## Out of scope

Wear OS and WatchConnectivity. Do not bump `CURRENT_PROJECT_VERSION`.
