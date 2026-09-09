#!/usr/bin/env bash
# Prepare the Capacitor iOS app on a Mac, then open Xcode or archive.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="open"
TEAM_ID="${TEAM_ID:-${DEVELOPMENT_TEAM:-}}"

usage() {
  cat <<'EOF'
Package Nod for iPhone + Apple Watch. Run this on a Mac with Xcode.

  npm run cap:ios
      Build the web app, sync Capacitor, install pods, open Xcode.

  TEAM_ID=XXXXXXXXXX npm run cap:ios -- --archive
      Also create ios/dist/Nod.xcarchive (pick Team in Xcode first, or pass TEAM_ID).

  TEAM_ID=XXXXXXXXXX npm run cap:ios -- --ipa
      Archive and export a development IPA to ios/dist/Nod.ipa.

TEAM_ID is the 10-character Apple Team ID (Xcode → Settings → Accounts).
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --archive) MODE="archive" ;;
    --ipa) MODE="ipa" ;;
    --open) MODE="open" ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  cat <<EOF >&2
iOS packaging needs Xcode, which only runs on a Mac. This machine is $(uname -s).

On the Mac, in this repo:

  git pull
  npm ci
  (cd web && npm ci)
  npm run cap:ios

Then in Xcode: App target and WatchApp target → Signing & Capabilities → your Team.
Plug in the iPhone and press Run. Watch installs with the phone app.
EOF
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1. $2" >&2
    exit 1
  fi
}

need node "Install Node 20+ from https://nodejs.org"
need xcodebuild "Install Xcode from the App Store, then open it once and accept the license."

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode command-line tools are not selected. Run: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

if [[ -L node_modules ]]; then
  echo "package-ios: node_modules is a symlink; replacing it so native plugins compile from this worktree."
  rm node_modules
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
if [[ ! -d web/node_modules ]]; then
  (cd web && npm ci)
fi
node scripts/iosWorktreePods.mjs assert-roots

npm run cap:sync

if [[ ! -d ios/App/Pods ]]; then
  echo "CocoaPods did not produce ios/App/Pods." >&2
  echo "Install with: sudo gem install cocoapods   or   brew install cocoapods" >&2
  exit 1
fi

WORKSPACE="$ROOT/ios/App/App.xcworkspace"
if [[ ! -f "$WORKSPACE/contents.xcworkspacedata" ]]; then
  echo "Missing $WORKSPACE — cap sync did not produce the Xcode workspace." >&2
  exit 1
fi

if [[ "$MODE" == "open" ]]; then
  echo "Opening Xcode. Select Team on App and WatchApp, then Run on a device."
  if command -v npx >/dev/null 2>&1; then
    npx cap open ios
  else
    open "$WORKSPACE"
  fi
  exit 0
fi

if [[ -z "$TEAM_ID" ]]; then
  echo "Set TEAM_ID to your 10-character Apple Team ID before --archive / --ipa." >&2
  echo "Example: TEAM_ID=ABCD123456 npm run cap:ios -- --archive" >&2
  exit 1
fi

mkdir -p ios/dist
ARCHIVE="$ROOT/ios/dist/Nod.xcarchive"
rm -rf "$ARCHIVE"

echo "Archiving Nod (App + WatchApp) with TEAM_ID=$TEAM_ID …"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  archive

echo "Archive ready: $ARCHIVE"

if [[ "$MODE" != "ipa" ]]; then
  echo "In Xcode: Window → Organizer → Distribute App → TestFlight / App Store Connect."
  open "$ARCHIVE"
  exit 0
fi

EXPORT_PLIST="$ROOT/ios/dist/ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>development</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>${TEAM_ID}</string>
	<key>compileBitcode</key>
	<false/>
	<key>destination</key>
	<string>export</string>
</dict>
</plist>
EOF

EXPORT_DIR="$ROOT/ios/dist/ipa"
rm -rf "$EXPORT_DIR"
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST"

shopt -s nullglob
ipas=("$EXPORT_DIR"/*.ipa)
if [[ ${#ipas[@]} -eq 0 ]]; then
  echo "Export finished but no IPA was produced in $EXPORT_DIR" >&2
  exit 1
fi
cp "${ipas[0]}" "$ROOT/ios/dist/Nod.ipa"
echo "IPA ready: $ROOT/ios/dist/Nod.ipa"
