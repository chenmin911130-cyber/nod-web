# Nod iOS (Capacitor)

The iPhone app is the existing web workspace in a WKWebView, plus a native microphone session so listening continues after the screen locks. The Watch app records from the **Watch microphone** (Summary AI–style), then sends 16 kHz PCM to the iPhone for the existing live transcript and notes.

Xcode only runs on a Mac. This Linux/cloud checkout prepares the project; you compile the IPA on that Mac.

## Package on a Mac (this is the iOS build)

1. Install **Xcode** from the App Store. Open it once and accept the license.
2. Install **Node 20+** and CocoaPods (`sudo gem install cocoapods` or `brew install cocoapods`).
3. Sign in to an Apple Developer account in Xcode → Settings → Accounts. Xcode can create App IDs `com.nodpilot.app` and `com.nodpilot.app.watchkitapp` when you pick a Team.
4. In this repo on the Mac:

```bash
git fetch origin
npm ci
(cd web && npm ci)
```

5. Open the project for development (no manifest, no install):

```bash
npm run cap:ios -- open
```

Select **Team** on both the **App** and **WatchApp** targets, plug in an iPhone, press Run.

## Delivery: one pinned entry point

Builds and installs go through `scripts/ios-deliver.mjs`; `npm run cap:ios` is only an
alias for it (legacy `--open` / `--archive` / `--ipa` flags still parse). Pick the full
SHA of the reviewed, merged commit and build into a fresh output directory:

```bash
SHA=$(git rev-parse HEAD)   # must be the reviewed commit and present on origin
TEAM_ID=XXXXXXXXXX npm run cap:ios -- build --sha "$SHA" --version 1.0 --build 92 --ipa
```

`--build` is the bundle this run will carry: HEAD's `CURRENT_PROJECT_VERSION` + 1, because
the guarded `cap:sync` bumps it once. A wrong value refuses before `cap:sync` runs, so the
checkout is not mutated.

The run refuses to continue unless the worktree HEAD is exactly that SHA, origin really
has it, the tree is clean outside the generated set, and `node_modules` / `Pods` / the
local plugins resolve inside this checkout. It then runs the guarded `cap:sync`,
archives, and writes `<out>/delivery-manifest.json`: target/actual SHA, realpath,
allowed diff, tool versions, lockfile digests, plugin/Pods paths, web-asset digest,
archive/App path + digest, embedded framework identifiers, phone/watch versions, and an
explicit `unverified` list. No key material, tokens, or signing private keys — ever.

Verify a manifest against the exact artifact path (never "the newest file"):

```bash
npm run cap:ios -- verify --manifest ios/dist/delivery/<sha12>-<build>/delivery-manifest.json
```

Install only with explicit authorisation, then read the phone and Watch versions back
from the device into the manifest:

```bash
npm run cap:ios -- install --manifest <path> --device <udid> --authorize
```

A locked or unreadable device is recorded as `unverified`, never as success. Add
`--dry-run` to run every preflight check and stop before touching a device.

`cap:sync` (also run by `cap:ios build`) builds `web/dist`, points the app at
`app.html` (not the marketing site), and copies assets into `ios/`.

## Run on a phone + Watch

1. In Xcode, select the **App** target → **Signing & Capabilities**. Choose your Team. Do the same for **WatchApp**.
2. Plug in an iPhone that is paired with an Apple Watch (watchOS 9+). Run the **App** scheme — the Watch app is embedded and installs with it.
3. Open Nod on the iPhone once and sign in. Confirm the first microphone consent on the phone (same copy as the website).
4. On the Watch, allow **Microphone**, then tap **Listen**. The Watch captures audio. If the iPhone is nearby, PCM streams over and live captions appear in the phone app. If the phone is out of range, the Watch keeps recording and flushes the leftover audio when you tap Stop. After **Stop**, the session is saved to History and Nod writes the meeting or lecture report on the iPhone. Unlock the phone and open Nod — the Notes tab is already showing the report, including after the app was killed. This is not email or iMessage.
5. iPhone lock-screen listening (phone mic) still works from the phone UI.

Safari / Google sign-in returns through `nodpilot://auth?token=…`. Confirm that URL scheme is listed under **Info → URL Types** (`nodpilot`). Email sign-in stays inside the app.

## Background / lock-screen listening

- iPhone: **Signing & Capabilities → Background Modes → Audio** (`UIBackgroundModes: audio`).
- Watch: the Watch target also has `UIBackgroundModes: audio` so lowering the wrist does not kill the Watch mic.
- Start listening first (phone or Watch). Do not treat this as silent capture.

If lock-screen audio dies, the usual cause is a missing Background Mode. Re-run `npm run cap:sync` and confirm `ios/App/App/Info.plist` and `ios/App/WatchApp/Info.plist` still have `UIBackgroundModes` / `NSMicrophoneUsageDescription`.

## TestFlight

Use the pinned delivery entry point above (`npm run cap:ios -- build --ipa`) to produce
and verify the archive, then in Xcode **Window → Organizer → Distribute App → App Store
Connect → Upload** (or use the exported IPA). The Watch app is embedded in the phone
archive.

1. In App Store Connect, add the build to a TestFlight group.
2. Review notes should say: microphone is used only after in-app consent; Watch and lock-screen recording are explicit listen sessions, not silent capture.

API and WebSocket traffic always go to `https://nodpilot.com` / `wss://nodpilot.com`. Do not point a store build at localhost.

## Out of scope

Android, Zoom/Teams system-audio capture, and desktop stealth are not in this target.
