#!/bin/sh
# MG8 prototype only: builds build/VidVNC MG8.app, signed inside out with hardened runtime.
#   IDENTITY="Developer ID Application: …" ./build.sh   (default "-": ad-hoc, for structure only)
#   NODE=<official Node 24 darwin-arm64 binary>          (required)
# Layout: Contents/MacOS/{VidVNC MG8, node, node-relay, media-worker, sandbox-launcher},
#         Contents/Frameworks/*.dylib (GStreamer and its libraries, flat: codesign accepts no
#         plain folders there), Contents/Library/GStreamer/*.dylib (plugins),
#         Contents/Resources/{mg8-check.mjs, relay-bundle.js}.
set -eu
unset CDPATH
here=$(cd "$(dirname "$0")" && pwd)
proto="$here/.."
repo="$proto/../../.."
identity=${IDENTITY:--}
node=${NODE:?set NODE to the official Node 24 binary}
unset CDPATH
for candidate in /Library/Frameworks/GStreamer.framework/Versions/1.0/lib "$HOME/Library/Frameworks/GStreamer.framework/Versions/1.0/lib"; do
  [ -d "$candidate" ] && gst=$(cd "$candidate" && pwd -P)
done
: "${gst:?GStreamer.framework not found}"
app="$here/build/VidVNC MG8.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks" "$app/Contents/Library/GStreamer"
cp "$here/Info.plist" "$app/Contents/Info.plist"
# VERSION=<n>: the bundle version, for the update re-check (same bundle ID, new build).
version=${VERSION:-1}
plutil -replace CFBundleShortVersionString -string "0.0.$version" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version" "$app/Contents/Info.plist"

xcrun swiftc -O -target arm64-apple-macos27.0 -o "$app/Contents/MacOS/VidVNC MG8" "$here/main.swift"
cp "$node" "$app/Contents/MacOS/node"
cp "$node" "$app/Contents/MacOS/node-relay"
cp "$proto/build-xcode/Release/media-worker" "$app/Contents/MacOS/media-worker"
cp "$proto/build-xcode/Release/mg4-probe" "$app/Contents/MacOS/sandbox-launcher"
cp "$here/mg8-check.mjs" "$app/Contents/Resources/"
"$node" --input-type=module -e "import { relayBundle } from '$repo/apps/server/src/media-relay/bundle.mjs'; process.stdout.write(relayBundle());" > "$app/Contents/Resources/relay-bundle.js"

# GStreamer: only what the worker and media-net reach (gst-closure.py), symlinks resolved.
python3 "$here/gst-closure.py" "$gst" "$app/Contents/MacOS/media-worker" "$app/Contents/MacOS/sandbox-launcher" |
while read -r kind path; do
  if [ "$kind" = plugin ]; then
    cp -L "$path" "$app/Contents/Library/GStreamer/"
  else
    cp -L "$path" "$app/Contents/Frameworks/"
  fi
done
chmod u+w "$app/Contents/Frameworks/"*.dylib "$app/Contents/Library/GStreamer/"*.dylib
# Plugins and libraries find each other in the bundle (they only carry relative rpaths that
# assume GStreamer's own lib/ and lib/gstreamer-1.0/ layout).
for plugin in "$app/Contents/Library/GStreamer/"*.dylib; do
  install_name_tool -add_rpath "@loader_path/../../Frameworks" "$plugin" 2>/dev/null
done
for dylib in "$app/Contents/Frameworks/"*.dylib; do
  install_name_tool -add_rpath "@loader_path" "$dylib" 2>/dev/null
done
# The executables find GStreamer in the bundle, not in the developer's home.
for exe in media-worker sandbox-launcher; do
  for old in $(otool -l "$app/Contents/MacOS/$exe" | awk '/LC_RPATH/{getline;getline;print $2}'); do
    install_name_tool -delete_rpath "$old" "$app/Contents/MacOS/$exe" 2>/dev/null
  done
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$app/Contents/MacOS/$exe" 2>/dev/null
done

# Sign inside out: libraries, then helpers, then the app.
if [ "$identity" = "-" ]; then timestamp=""; library_entitlements="--entitlements $here/adhoc-library.entitlements"; else timestamp="--timestamp"; library_entitlements=""; fi
sign() { codesign --force --sign "$identity" --options runtime $timestamp "$@"; }
for dylib in "$app/Contents/Frameworks/"*.dylib "$app/Contents/Library/GStreamer/"*.dylib; do
  sign "$dylib"
done
sign --entitlements "$here/node.entitlements" "$app/Contents/MacOS/node"
sign "$app/Contents/MacOS/node-relay"
sign $library_entitlements "$app/Contents/MacOS/media-worker"
sign $library_entitlements "$app/Contents/MacOS/sandbox-launcher"
sign "$app"
codesign --verify --deep --strict --verbose=1 "$app"
du -sh "$app"
echo "built $app (identity $identity, version 0.0.$version)"
