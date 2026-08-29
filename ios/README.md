# Nod iOS (Capacitor)

The iPhone app is the existing web workspace in a WKWebView, plus a native microphone session so listening continues after the screen locks. There is no Apple Watch target.

Xcode only runs on a Mac. This repo prepares the project; you compile, run on a device, and upload TestFlight from that Mac.

## One-time Mac setup

1. Install Xcode, CocoaPods (`sudo gem install cocoapods`), and Node 20+.
2. Open an Apple Developer account and create an iOS App ID: `com.nodpilot.app`.
3. From the repo root:

```bash
cd web && npm ci && cd ..
npm ci
npm run cap:sync
npx cap open ios
```

`cap:sync` builds `web/dist`, points the app at `app.html` (not the marketing site), and copies assets into `ios/`.

## Run on a phone

1. In Xcode, select the **App** target → **Signing & Capabilities**.
2. Choose your Team. Xcode will create a development profile for `com.nodpilot.app`.
3. Plug in an iPhone, pick it as the run destination, press Run.
4. The first listen prompt must stay on screen until the user confirms. That is the same consent copy as the website.
5. iOS will also ask for **Microphone**. The usage string says Nod transcribes meetings, lectures, and interviews.

Safari / Google sign-in returns through `nodpilot://auth?token=…`. Confirm that URL scheme is listed under **Info → URL Types** (`nodpilot`). Email sign-in stays inside the app.

## Background / lock-screen listening

- **Signing & Capabilities → Background Modes → Audio, AirPlay, and Picture in Picture** must stay checked (`UIBackgroundModes: audio`).
- Start listening in the app, then lock the phone. The orange mic indicator should stay on. A “Listening — tap to return” notification opens the app.
- Do not start capture from the lock screen. The user has to tap Start in the app first.

If lock-screen audio dies, the usual cause is a missing Background Mode or the session category not being `playAndRecord`. Re-run `npm run cap:sync` and confirm `ios/App/App/Info.plist` still has `UIBackgroundModes` / `NSMicrophoneUsageDescription`.

## TestFlight

1. In Xcode: **Product → Archive**.
2. **Distribute App → App Store Connect → Upload**.
3. In App Store Connect, add the build to a TestFlight group.
4. Review notes should say: microphone is used only after in-app consent; lock-screen recording is an explicit listen session, not silent capture.

API and WebSocket traffic always go to `https://nodpilot.com` / `wss://nodpilot.com`. Do not point a store build at localhost.

## Out of scope

Watch, Android, Zoom/Teams system-audio capture, and desktop stealth are not in this target.
