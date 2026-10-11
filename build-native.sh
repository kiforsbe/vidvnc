#!/bin/sh
# Builds the macOS media worker and runs its unit tests: the counterpart of build-native.cmd.
# Uses Xcode's toolchain through CMake's Xcode generator (CMakePresets.json, macos-arm64).
set -eu
case "${1:-Release}" in
  Release | release) preset=macos-arm64-release ;;
  Debug | debug) preset=macos-arm64-debug ;;
  *)
    echo "Usage: build-native.sh [Debug|Release]" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  echo "Usage: build-native.sh [Debug|Release]" >&2
  exit 2
fi
cd "$(dirname "$0")"
node tools/format.mjs native
if ! command -v cmake >/dev/null 2>&1; then
  echo "CMake was not found; npm run deps says how to install it." >&2
  exit 1
fi
cmake --preset macos-arm64
cmake --build --preset "$preset"
ctest --preset "$preset"
