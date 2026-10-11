#!/bin/sh
# Builds the prototype and saves light and dark images of every section to
# docs/design/macos-host-previz/. The app draws its own window, so no Screen Recording
# permission is needed. Usage: apps/macos-host/Prototype/screenshots.sh [scenario]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out="$root/docs/design/macos-host-previz"
derived="${TMPDIR:-/tmp}/vidvnc-prototype-derived"
scenario="${1:-Local network}"

xcodebuild -project "$here/VidVNCPrototype.xcodeproj" -scheme VidVNCPrototype \
  -configuration Debug -derivedDataPath "$derived" -quiet build
app="$derived/Build/Products/Debug/VidVNCPrototype.app"

mkdir -p "$out"
"$app/Contents/MacOS/VidVNCPrototype" -snapshotDir "$out" -scenario "$scenario" \
  -ApplePersistenceIgnoreState YES
echo "Saved screenshots to $out"
