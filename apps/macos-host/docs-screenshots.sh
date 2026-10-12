#!/bin/sh
# Builds VidVNC and saves the documentation screenshots to docs/images/macos-host/: the whole
# window for every section, Connect a Device's QR code, and each Settings tab, using the
# sample data of a Debug build (-scenario), so no server starts and no real names show.
# screencapture takes each window as macOS draws it, so the app this runs from (Terminal)
# needs Screen & System Audio Recording; without it the images come out blank.
# Usage: apps/macos-host/docs-screenshots.sh [light|dark] [scenario]
set -eu
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/docs/images/macos-host"
derived="$root/out/macos-host/DerivedData"
appearance="${1:-light}"
scenario="${2:-Local network}"

xcodebuild -project "$here/VidVNC.xcodeproj" -scheme VidVNC -configuration Debug \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath "$derived" -quiet build
app="$derived/Build/Products/Debug/VidVNC.app"

mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkfifo "$work/answers"
# VidVNC asks on standard output and waits for each answer on standard input.
"$app/Contents/MacOS/VidVNC" -snapshotDir "$out" -snapshotStyle window \
  -snapshotAppearance "$appearance" -scenario "$scenario" -ApplePersistenceIgnoreState YES \
  <"$work/answers" | while read -r request rest; do
  case "$request" in
  activate)
    open "$app"
    echo ok >&3
    ;;
  capture)
    # The window number, then the file. -x silent, -o without the shadow.
    if screencapture -x -o -l "${rest%% *}" "${rest#* }"; then echo ok >&3; else echo failed >&3; fi
    ;;
  esac
done 3>"$work/answers"
echo "Saved screenshots to $out"
