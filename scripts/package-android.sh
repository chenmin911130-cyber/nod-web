#!/usr/bin/env bash
# Build a sideloadable Android debug APK from this checkout. See docs/android.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export ANDROID_HOME="${ANDROID_HOME:-${HOME}/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# Gradle 8.11 cannot load on Studio JBR 25 (class file 69). Prefer a JDK 21.
JBR21="${HOME}/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home"
STUDIO_JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
BREW_21="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
if [[ -x "$JBR21/bin/java" ]]; then
  export JAVA_HOME="$JBR21"
elif JAVA21="$(/usr/libexec/java_home -v 21 2>/dev/null)" && [[ -x "$JAVA21/bin/java" ]]; then
  export JAVA_HOME="$JAVA21"
elif [[ -x "$BREW_21/bin/java" ]]; then
  export JAVA_HOME="$BREW_21"
elif [[ -x "$STUDIO_JBR/bin/java" ]]; then
  export JAVA_HOME="$STUDIO_JBR"
elif [[ -z "${JAVA_HOME:-}" && -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
fi
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

usage() {
  cat <<'EOF'
Package Nodpilot for Android (phone features, no Watch).

  npm run cap:android
      Sync web assets and write android/app/build/outputs/apk/debug/app-debug.apk

  npm run cap:android -- --open
      Also open the project in Android Studio.

  npm run cap:android -- --install
      adb install -r on the first connected device.

This does not bump the iOS bundle. Apple Watch / Wear OS are not in this build.
EOF
}

OPEN=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --open) OPEN=1 ;;
    --install) INSTALL=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1. $2" >&2
    exit 1
  fi
}

need node "Install Node 20+"
if [[ ! -d "$ANDROID_HOME" ]]; then
  echo "Android SDK not found at $ANDROID_HOME. Open Android Studio once and install the SDK." >&2
  exit 1
fi

if [[ -L node_modules ]]; then
  echo "package-android: node_modules is a symlink; replacing it."
  rm node_modules
fi
if [[ -L web/node_modules ]]; then
  echo "package-android: web/node_modules is a symlink; replacing it."
  rm web/node_modules
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
if [[ ! -d web/node_modules ]]; then
  (cd web && npm ci)
fi

if [[ ! -d android ]]; then
  npx cap add android
fi

npm run cap:sync:android

if [[ ! -f android/gradlew ]]; then
  echo "android/gradlew missing after cap add" >&2
  exit 1
fi

chmod +x android/gradlew
(
  cd android
  ./gradlew assembleDebug
)

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
  echo "Gradle finished but $APK was not produced" >&2
  exit 1
fi

DEST="${HOME}/Desktop/Nodpilot-debug.apk"
cp "$APK" "$DEST"
echo "APK ready: $APK"
echo "Copied to: $DEST"

if [[ "$INSTALL" -eq 1 ]]; then
  need adb "Install platform-tools from Android Studio SDK Manager"
  if ! adb devices | awk 'NR>1 && $2=="device"{found=1} END{exit found?0:1}'; then
    echo "No adb device in 'device' state. Plug in a phone, enable USB debugging, then rerun with --install." >&2
    exit 1
  fi
  adb install -r "$APK"
  echo "Installed on the connected device. Allow microphone when Listen starts. Watch is not in this build."
fi

if [[ "$OPEN" -eq 1 ]]; then
  npx cap open android
fi
