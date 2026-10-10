#!/bin/sh
# MG8 prototype only: notarize, staple and assess build/VidVNC MG8.app. Needs a Developer ID
# build and the keychain profile from `xcrun notarytool store-credentials vidvnc-notary ...`.
set -eu
unset CDPATH
here=$(cd "$(dirname "$0")" && pwd)
app="$here/build/VidVNC MG8.app"
zip="$here/build/VidVNC-MG8.zip"
profile=${NOTARY_PROFILE:-vidvnc-notary}
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
xcrun notarytool submit "$zip" --keychain-profile "$profile" --wait --output-format json | tee "$here/build/notary-submit.json"
id=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$here/build/notary-submit.json")
xcrun notarytool log "$id" --keychain-profile "$profile" "$here/build/notary-log.json" || true
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"
# The artefact for the clean Mac: the stapled app, zipped again.
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
echo "notarized and stapled: $zip"
