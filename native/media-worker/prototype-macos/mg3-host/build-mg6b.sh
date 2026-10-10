#!/bin/sh
# MG3 prototype only: builds "VidVNC MG6B Host.app" next to this script, ad-hoc signed (no
# Developer ID yet). Bundles Homebrew's node and the prototype worker.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$here/build/VidVNC MG6B Host.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/${INFO_PLIST:-Info.plist}" "$app/Contents/Info.plist"
xcrun swiftc -O -target arm64-apple-macos27.0 -o "$app/Contents/MacOS/VidVNC MG6B Host" "$here/main.swift"
node_bin=$(node -p process.execPath)
cp "$node_bin" "$app/Contents/MacOS/node"
# Homebrew's node loads libnode through @rpath; its other libraries keep absolute
# /opt/homebrew paths, which is fine for this machine only.
cp "$(dirname "$node_bin")/../lib/"libnode.*.dylib "$app/Contents/MacOS/"
cp "$here/../build-xcode/Release/media-worker" "$app/Contents/MacOS/media-worker"
cp "$here/mg3-chain.mjs" "$app/Contents/Resources/"
codesign --force --sign - "$app/Contents/MacOS/node" "$app/Contents/MacOS/media-worker" "$app/Contents/MacOS/"libnode.*.dylib
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app" && echo "built $app"
