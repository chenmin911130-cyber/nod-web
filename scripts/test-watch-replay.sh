#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
replay_test_dir=$(mktemp -d)
trap 'rm -rf "$replay_test_dir"' EXIT
xcrun swiftc -D PCM_REPLAY_TESTING -o "$replay_test_dir/watch-replay-tests" \
 tests/native/PlatformStubs.swift ios/App/WatchApp/WatchCopy.swift \
 ios/App/WatchApp/WatchAod.swift \
 ios/App/WatchApp/WatchQASummary.swift ios/App/WatchApp/WatchQAPage.swift \
 ios/App/WatchApp/WatchPcmStore.swift ios/App/WatchApp/WatchSendBuffer.swift \
 ios/App/WatchApp/WatchPhoneSession.swift \
 plugins/nod-watch/ios/Sources/NodWatchPlugin/WatchBridge.swift \
 plugins/nod-mic/ios/Sources/NodMicPlugin/PhonePcmStore.swift \
 plugins/nod-mic/ios/Sources/NodMicPlugin/AudioUplink.swift \
 plugins/nod-mic/ios/Sources/NodMicPlugin/WatchPcmIngest.swift \
 tests/native/WatchReplayTests.swift \
 tests/native/WatchQASummaryTests.swift
"$replay_test_dir/watch-replay-tests"

# The #227 startup gate: the slow-vs-dead rule and the recovery/retry transitions. Its
# source file is Foundation-only, so it compiles for the host like the replay tests do.
xcrun swiftc -o "$replay_test_dir/startup-recovery-tests" \
 ios/App/App/StartupRecoveryGate.swift tests/native/StartupRecoveryTests.swift
"$replay_test_dir/startup-recovery-tests"
