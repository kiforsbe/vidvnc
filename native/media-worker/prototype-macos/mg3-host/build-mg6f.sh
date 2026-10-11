#!/bin/sh
# MG6 re-check, prototype only: "VidVNC MG6F Host.app", a fresh bundle ID signed with the
# Developer ID and hardened runtime, for Local Network behaviour under real signing. Bundles the
# official Node (NODE=..., allow-jit only); runs mg6-lan.mjs through host-chain.mjs.
#   IDENTITY="Developer ID Application: …" NODE=<official node> ./build-mg6f.sh
set -eu
unset CDPATH
here=$(cd "$(dirname "$0")" && pwd)
identity=${IDENTITY:?set IDENTITY to a Developer ID Application identity}
node=${NODE:?set NODE to the official Node 24 binary}
app="$here/build/VidVNC MG6F Host.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/Info-mg6f.plist" "$app/Contents/Info.plist"
xcrun swiftc -O -target arm64-apple-macos27.0 -o "$app/Contents/MacOS/VidVNC MG6F Host" "$here/main.swift"
cp "$node" "$app/Contents/MacOS/node"
cp "$here/mg3-chain.mjs" "$app/Contents/Resources/"
# main.swift expects a bundled worker; this test never runs it.
cp "$here/../build-xcode/Release/media-worker" "$app/Contents/MacOS/media-worker"
codesign --force --sign "$identity" --options runtime --timestamp "$app/Contents/MacOS/media-worker"
codesign --force --sign "$identity" --options runtime --timestamp \
  --entitlements "$here/../mg8/node.entitlements" "$app/Contents/MacOS/node"
codesign --force --sign "$identity" --options runtime --timestamp "$app"
codesign --verify --deep --strict "$app" && echo "built $app"
