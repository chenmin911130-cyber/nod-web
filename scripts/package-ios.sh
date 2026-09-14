#!/usr/bin/env bash
# DEPRECATED — kept only as a forwarding shim.
#
# The single supported iOS delivery entry point is scripts/ios-deliver.mjs
# (`npm run cap:ios -- …`). It pins a commit, checks the dependency realpaths,
# produces a delivery manifest and gates installs on it. This file forwards to
# it so an old command cannot quietly use a second, unguarded pipeline.
#
#   npm run cap:ios -- build --sha <40-hex> --version <1.0> --build <n> [--ipa]
#   npm run cap:ios -- open            # development: opens Xcode
#
# Legacy flags still parse: --open, --archive, --ipa.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "package-ios.sh is deprecated; forwarding to scripts/ios-deliver.mjs (npm run cap:ios)." >&2
exec node "$ROOT/scripts/ios-deliver.mjs" "$@"
