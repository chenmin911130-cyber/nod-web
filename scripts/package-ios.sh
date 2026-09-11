#!/usr/bin/env bash
# Locked iOS delivery: SHA, worktree deps, unique artifacts, optional install.
# See docs/ios-deliver.md. Do not pack from an unlocked checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE=""
SHA=""
BUNDLE=""
OUT=""
MANIFEST=""
INSTALL_OK=0
IPHONE_UDID=""
WATCH_UDID=""
RAILWAY_SHA="${RAILWAY_SHA:-}"
TEAM_ID="${TEAM_ID:-${DEVELOPMENT_TEAM:-}}"
ALLOW_DIFF=()

usage() {
  cat <<'EOF'
Deliver Nod for iPhone + Apple Watch from a locked commit. See docs/ios-deliver.md.

  npm run cap:ios -- --sha <40-char> --bundle <n> --out <dir> --archive
  npm run cap:ios -- --sha <40-char> --bundle <n> --out <dir> --ipa
  npm run cap:ios -- --sha <40-char> --bundle <n> --open
  npm run cap:ios -- --install <manifest.json> --install-ok

Required for build: full commit SHA, expected bundle, and (for archive/ipa) a unique --out.
Install requires --install-ok. Without it, stop after writing the delivery manifest.
Do not pick artifacts by mtime or glob. Do not pack from Desktop shortcuts or a dirty main checkout.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --archive) MODE="archive"; shift ;;
    --ipa) MODE="ipa"; shift ;;
    --open) MODE="open"; shift ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --install) MODE="install"; MANIFEST="${2:-}"; shift 2 ;;
    --install-ok) INSTALL_OK=1; shift ;;
    --iphone-udid) IPHONE_UDID="${2:-}"; shift 2 ;;
    --watch-udid) WATCH_UDID="${2:-}"; shift 2 ;;
    --railway-sha) RAILWAY_SHA="${2:-}"; shift 2 ;;
    --allow-diff) ALLOW_DIFF+=("${2:-}"); shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "ios deliver: choose --archive, --ipa, --open, or --install. Unlocked npm run cap:ios is not a delivery path." >&2
  usage >&2
  exit 2
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1. $2" >&2
    exit 1
  fi
}

need node "Install Node 20+ from https://nodejs.org"

if [[ "$MODE" == "install" ]]; then
  if [[ -z "$MANIFEST" ]]; then
    echo "ios deliver: --install requires a manifest path" >&2
    exit 2
  fi
  INSTALL_ARGS=(install --manifest "$MANIFEST")
  if [[ "$INSTALL_OK" -eq 1 ]]; then
    INSTALL_ARGS+=(--install-ok)
  fi
  node scripts/iosDeliver.mjs "${INSTALL_ARGS[@]}"
  if [[ "$INSTALL_OK" -ne 1 ]]; then
    echo "ios deliver: manifest checked; install not authorized" >&2
    exit 1
  fi
  APP_PATH="$(node --input-type=module -e 'import { loadManifest } from "./scripts/iosDeliver.mjs"; const m=loadManifest(process.argv[1]); process.stdout.write(m.artifacts?.app?.path||"")' "$MANIFEST")"
  if [[ -z "$APP_PATH" ]]; then
    echo "ios deliver: manifest has no exact App.app path; cannot install" >&2
    exit 1
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "ios deliver: install authorized, but this machine cannot talk to devices ($(uname -s))." >&2
    exit 1
  fi
  if [[ -z "$IPHONE_UDID" && -z "$WATCH_UDID" ]]; then
    echo "ios deliver: set --iphone-udid and --watch-udid to install the exact App.app from the manifest." >&2
    exit 1
  fi
  if [[ -n "$IPHONE_UDID" ]]; then
    xcrun devicectl device install app --device "$IPHONE_UDID" "$APP_PATH"
    echo "ios deliver: phone install issued for $APP_PATH"
    xcrun devicectl device info apps --device "$IPHONE_UDID" || true
  fi
  WATCH_APP="$APP_PATH/Watch/Nod.app"
  if [[ -n "$WATCH_UDID" ]]; then
    if [[ ! -d "$WATCH_APP" ]]; then
      echo "ios deliver: missing watch app at $WATCH_APP" >&2
      exit 1
    fi
    xcrun devicectl device install app --device "$WATCH_UDID" "$WATCH_APP"
    echo "ios deliver: watch install issued for $WATCH_APP"
    xcrun devicectl device info apps --device "$WATCH_UDID" || true
  fi
  echo "ios deliver: installed exact artifact $APP_PATH"
  echo "ios deliver: read device versions with devicectl; phone success does not prove watch updated."
  exit 0
fi

if [[ -z "$SHA" || -z "$BUNDLE" ]]; then
  echo "ios deliver: --sha and --bundle are required. Do not pack an unlocked checkout." >&2
  usage >&2
  exit 2
fi

if [[ "$MODE" == "archive" || "$MODE" == "ipa" ]]; then
  if [[ -z "$OUT" ]]; then
    echo "ios deliver: --out is required so artifacts are not picked from ios/dist by mtime." >&2
    exit 2
  fi
fi

CHECKOUT_ARGS=(checkout --root "$ROOT" --sha "$SHA")
if [[ ${#ALLOW_DIFF[@]} -gt 0 ]]; then
  for d in "${ALLOW_DIFF[@]}"; do
    CHECKOUT_ARGS+=(--allow-diff "$d")
  done
fi
node scripts/iosDeliver.mjs "${CHECKOUT_ARGS[@]}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  cat <<EOF >&2
iOS packaging needs Xcode, which only runs on a Mac. This machine is $(uname -s).

On the Mac, in an isolated worktree of the approved SHA:

  npm run cap:ios -- --sha <40-char-sha> --bundle <n> --out /tmp/nod-deliver-<id> --archive

See docs/ios-deliver.md.
EOF
  exit 1
fi

need xcodebuild "Install Xcode from the App Store, then open it once and accept the license."

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode command-line tools are not selected. Run: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

if [[ -L node_modules ]]; then
  echo "package-ios: node_modules is a symlink; replacing it so native plugins compile from this worktree."
  rm node_modules
fi
if [[ -L web/node_modules ]]; then
  echo "package-ios: web/node_modules is a symlink; replacing it so this worktree owns web deps."
  rm web/node_modules
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
if [[ ! -d web/node_modules ]]; then
  (cd web && npm ci)
fi

node scripts/iosWorktreePods.mjs assert-roots
node scripts/iosDeliver.mjs preflight --root "$ROOT" --sha "$SHA"

export NOD_IOS_BUNDLE="$BUNDLE"
npm run cap:sync

node scripts/iosWorktreePods.mjs assert-roots
node scripts/iosDeliver.mjs preflight --root "$ROOT" --sha "$SHA" --bundle "$BUNDLE" \
  --allow-diff ios/App/App.xcodeproj/project.pbxproj \
  --allow-diff ios/App/App/public/ \
  --allow-diff ios/App/App/capacitor.config.json \
  --allow-diff ios/App/App/config.xml \
  --allow-diff ios/App/Podfile \
  --allow-diff ios/App/Podfile.lock \
  --allow-diff ios/App/Pods/

if [[ ! -d ios/App/Pods ]]; then
  echo "CocoaPods did not produce ios/App/Pods." >&2
  exit 1
fi

WORKSPACE="$ROOT/ios/App/App.xcworkspace"
if [[ ! -f "$WORKSPACE/contents.xcworkspacedata" ]]; then
  echo "Missing $WORKSPACE — cap sync did not produce the Xcode workspace." >&2
  exit 1
fi

if [[ "$MODE" == "open" ]]; then
  echo "Opening Xcode for SHA $SHA bundle $BUNDLE. This is not an install."
  if command -v npx >/dev/null 2>&1; then
    npx cap open ios
  else
    open "$WORKSPACE"
  fi
  exit 0
fi

if [[ -z "$TEAM_ID" ]]; then
  echo "Set TEAM_ID to your 10-character Apple Team ID before --archive / --ipa." >&2
  echo "Example: TEAM_ID=ABCD123456 npm run cap:ios -- --sha <sha> --bundle <n> --out /tmp/nod-deliver --archive" >&2
  exit 1
fi

OUT_ABS="$(node --input-type=module -e 'import { assertOutputDir } from "./scripts/iosDeliver.mjs"; process.stdout.write(assertOutputDir(process.argv[1], process.argv[2]))' "$OUT" "$SHA")"
DERIVED="$OUT_ABS/DerivedData"
ARCHIVE="$OUT_ABS/Nod.xcarchive"
mkdir -p "$DERIVED"
rm -rf "$ARCHIVE"

echo "Archiving Nod (App + WatchApp) SHA=$SHA bundle=$BUNDLE TEAM_ID=$TEAM_ID → $ARCHIVE"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  archive

echo "Archive ready: $ARCHIVE"
APP_PATH="$ARCHIVE/Products/Applications/App.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "ios deliver: archive did not contain $APP_PATH" >&2
  exit 1
fi

MANIFEST_CMD=(manifest --root "$ROOT" --sha "$SHA" --bundle "$BUNDLE" --out "$OUT_ABS" --archive "$ARCHIVE" --app "$APP_PATH")
if [[ -n "$RAILWAY_SHA" ]]; then
  MANIFEST_CMD+=(--railway-sha "$RAILWAY_SHA")
fi

if [[ "$MODE" != "ipa" ]]; then
  node scripts/iosDeliver.mjs "${MANIFEST_CMD[@]}"
  echo "ios deliver: build recorded. Install needs --install $OUT_ABS/manifest.json --install-ok"
  exit 0
fi

EXPORT_PLIST="$OUT_ABS/ExportOptions.plist"
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

EXPORT_DIR="$OUT_ABS/ipa"
rm -rf "$EXPORT_DIR"
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST"

IPA="$EXPORT_DIR/Nod.ipa"
if [[ ! -f "$IPA" ]]; then
  shopt -s nullglob
  ipas=("$EXPORT_DIR"/*.ipa)
  if [[ ${#ipas[@]} -ne 1 ]]; then
    echo "ios deliver: expected exactly one IPA in $EXPORT_DIR, not a glob pick." >&2
    exit 1
  fi
  IPA="${ipas[0]}"
fi

MANIFEST_CMD+=(--ipa "$IPA")
node scripts/iosDeliver.mjs "${MANIFEST_CMD[@]}"
echo "IPA ready: $IPA"
echo "ios deliver: build recorded. Install needs --install $OUT_ABS/manifest.json --install-ok"
