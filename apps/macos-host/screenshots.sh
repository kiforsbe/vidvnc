#!/bin/sh
# Builds VidVNC and saves light and dark images of every section to
# docs/design/macos-host-previz/, using the sample data of a Debug build (-scenario). The app
# draws its own window, so no Screen Recording permission is needed and no server starts.
# Usage: apps/macos-host/screenshots.sh [scenario]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/docs/design/macos-host-previz"
derived="$root/out/macos-host/DerivedData"
scenario="${1:-Local network}"

xcodebuild -project "$here/VidVNC.xcodeproj" -scheme VidVNC -configuration Debug \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath "$derived" -quiet build
app="$derived/Build/Products/Debug/VidVNC.app"

mkdir -p "$out"
"$app/Contents/MacOS/VidVNC" -snapshotDir "$out" -scenario "$scenario" \
  -ApplePersistenceIgnoreState YES
echo "Saved screenshots to $out"
