# PR #179 final replay corrections

Implementation baseline: `7bf258bf633722516fd2a9e8dc01cd3cfaa6e6df`.

## Corrected behavior

- A healthy End sends its <50ms tail without waiting for another input. Normal
  and final sending share one raw in-flight frame; failure restores only that
  unsent frame ahead of the suffix. Padding is excluded from original-byte counts.
- A refused old hold cannot be overtaken by a newer small frame. New bytes are
  kept behind the hold within its existing budget, otherwise retained in the
  archive with incomplete state latched. This is explicit failure, not a promise
  of successful replay after budget exhaustion. Listener budget includes its
  in-flight frame (4 MiB); Session hold remains bounded at 2 MiB.
- Rejections are retained and replayed on control reattach/audio reconnect.
  Completion rechecks the request, current listener and incomplete state.
- Watch validates rejection identity before applying the payload's sessionId.
  iOS checks the bound native stream and stops ingest/pumping on terminal
  rejection, retaining the Watch original and avoiding fallback to JS.
- End after rejection does not restart drain. A failure page has an explicit Done
  exit which preserves/retire-marks the capture and makes Start/storage usable.
- System and local outstanding transfers protect old files from deletion. File
  callbacks use the main queue. Disk-full stops recorder and visible recording
  state, with an explicit warning; deletion refusal/failure is visible.

## Executed verification

- Full server suite: **450 passed, 1 skipped** (33.94s). After the final small
  control-error replay addition, the 12 replay/rejection tests passed again.
- Targeted pcm_drain/stt_audio/listen_idle/uplink/stt_terminate/budget/fast-fail/
  rejection/regression suite: **120 passed**.
- `web`: `npx tsc --noEmit` and `npm test` passed.
- `bash scripts/test-watch-replay.sh` passed. It compiles the production
  WatchPhoneSession, WatchPcmStore, WatchCopy, WatchBridge, AudioUplink and
  WatchPcmIngest. External WatchConnectivity/recorder/audio SDK doubles replace
  devices; temporary real files exercise storage. It is not a duplicate TS model
  or an on-device UI test. Assertions cover stale identity, terminal exit,
  in-flight deletion, disk budget/failure, late callbacks, coalesced final ack,
  and AudioUplink → WatchBridge → actual Watch consumption. A macOS CI job now
  runs this script.
- Full **Debug iOS Simulator** and **Debug watchOS Simulator** builds succeeded
  with SDK 26.5 and code signing disabled. Commands:

```sh
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/nod165-build CODE_SIGNING_ALLOWED=NO
xcodebuild -workspace ios/App/App.xcworkspace -scheme WatchApp \
  -configuration Debug -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath /tmp/nod165-build CODE_SIGNING_ALLOWED=NO
```

The Watch scheme includes its companion App, so it must build through the
workspace containing Pods; a project-only attempt failed to resolve Capacitor
and was corrected to the workspace command above.

`node scripts/iosWorktreePods.mjs assert-roots` passed. SwiftFileList entries for
NodMic/NodWatch and WatchApp point into `/tmp/wt-165-replay` (the same directory as
`/private/tmp/wt-165-replay`), not the dirty main checkout.

## Still a separate device batch

No merge, cap:sync, bundle bump, device installation or physical-device acceptance
was performed. Simulator compilation does not prove lock-screen behavior or the
actual Watch transport/UI. #165's phone+Watch installation and six-minute /
one-minute-disconnection / End / Pause-Resume device scenarios remain required.
