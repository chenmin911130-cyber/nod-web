# Nod iOS (Capacitor)

The iPhone app is the existing web workspace in a WKWebView, plus a native microphone session so listening continues after the screen locks. The Watch app records from the **Watch microphone** (Summary AI–style), then sends 16 kHz PCM to the iPhone for the existing live transcript and notes.

Xcode only runs on a Mac. This repo prepares the project; you compile, run on a device, and upload TestFlight from that Mac.

## One-time Mac setup

1. Install Xcode, CocoaPods (`sudo gem install cocoapods`), and Node 20+.
2. Open an Apple Developer account. Create an iOS App ID `com.nodpilot.app` and a Watch App ID `com.nodpilot.app.watchkitapp` (Xcode can create both when you pick a Team).
3. From the repo root:

```bash
cd web && npm ci && cd ..
npm ci
npm run cap:sync
npx cap open ios
```

`cap:sync` builds `web/dist`, points the app at `app.html` (not the marketing site), and copies assets into `ios/`.

## Run on a phone + Watch

1. In Xcode, select the **App** target → **Signing & Capabilities**. Choose your Team. Do the same for **WatchApp**.
2. Plug in an iPhone that is paired with an Apple Watch (watchOS 9+). Run the **App** scheme — the Watch app is embedded and installs with it.
3. Open Nod on the iPhone once and sign in. Confirm the first microphone consent on the phone (same copy as the website).
4. On the Watch, allow **Microphone**, then tap **Listen**. The Watch captures audio. If the iPhone is nearby, PCM streams over and live captions appear in the phone app. If the phone is out of range, the Watch keeps recording and flushes the leftover audio when you tap Stop.
5. iPhone lock-screen listening (phone mic) still works from the phone UI.

Safari / Google sign-in returns through `nodpilot://auth?token=…`. Confirm that URL scheme is listed under **Info → URL Types** (`nodpilot`). Email sign-in stays inside the app.

## Background / lock-screen listening

- iPhone: **Signing & Capabilities → Background Modes → Audio** (`UIBackgroundModes: audio`).
- Watch: the Watch target also has `UIBackgroundModes: audio` so lowering the wrist does not kill the Watch mic.
- Start listening first (phone or Watch). Do not treat this as silent capture.

If lock-screen audio dies, the usual cause is a missing Background Mode. Re-run `npm run cap:sync` and confirm `ios/App/App/Info.plist` and `ios/App/WatchApp/Info.plist` still have `UIBackgroundModes` / `NSMicrophoneUsageDescription`.

## TestFlight

1. In Xcode: **Product → Archive** the **App** scheme (Watch is included).
2. **Distribute App → App Store Connect → Upload**.
3. In App Store Connect, add the build to a TestFlight group.
4. Review notes should say: microphone is used only after in-app consent; Watch and lock-screen recording are explicit listen sessions, not silent capture.

API and WebSocket traffic always go to `https://nodpilot.com` / `wss://nodpilot.com`. Do not point a store build at localhost.

## Out of scope

Android, Zoom/Teams system-audio capture, and desktop stealth are not in this target.
