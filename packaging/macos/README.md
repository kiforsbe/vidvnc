# macOS packaging

Targets: `macos-server` (the VidVNC app in a DMG) and `macos-cli` (the command-line server
ZIP) in [`../targets.json`](../targets.json); `macos-client` is planned. Both are built by
[build.mjs](build.mjs), signed with the owner's Developer ID, and notarized
([design D9 and Channel A](../../docs/superpowers/specs/2026-10-09-macos-support-design.md#d9-bundle-layout-and-runtime)).
How to run it is in the [README](../../README.md#mac-packages).

| File                      | What it holds                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `inputs.json`             | GStreamer version, plugin allow-list and license mapping; pinned Node.js; bundle ids; env names |
| `build.mjs`               | Builds, assembles, signs, notarizes and staples one target                                      |
| `prepare.mjs`             | Downloads the pinned Node.js archive into `.deps/downloads` and checks its SHA-256              |
| `package-all.mjs`         | `npm run package:macos`: both targets                                                           |
| `capture-helper/`         | The capture helper's `Info.plist` (`io.github.kiforsbe.vidvnc.capture`, spec Q14)               |
| `launcher/vidvnc.c`       | The `vidvnc` launcher, compiled per layout                                                      |
| `entitlements/`           | One entitlement file per signed program                                                         |
| `tests/package-check.mjs` | Checks a built DMG or ZIP: signatures, notarization, libraries, and running it                  |

## Layout

```text
VidVNC.app/Contents/
  MacOS/VidVNC                    the Swift host (Release, from Xcode)
  MacOS/VidVNC Server             Node.js, renamed
  Helpers/vidvnc                  the command-line server launcher
  Helpers/VidVNC Capture.app/     the capture helper
    Contents/MacOS/media-worker     worker, media-net and the sandbox launcher
    Contents/Frameworks/            the allow-listed GStreamer libraries, flat
    Contents/Library/GStreamer/     the allow-listed plugins
  Resources/runtime.json          root "..": its paths are relative to Contents
  Resources/server/node_modules/  @vidvnc/server, @vidvnc/web-client, @vidvnc/media-worker
  Resources/notices/              THIRD-PARTY-NOTICES.txt and every license text

VidVNC-Server-<version>-macos-arm64/
  vidvnc  runtime.json  runtime/VidVNC Server  runtime/VidVNC Capture.app/  app/  notices/
```

- **The capture helper carries its own libraries.** The GStreamer libraries and plugins sit
  inside the helper rather than in the app's `Frameworks`, so the same signed helper serves
  the app and the CLI, and only the program that uses them carries them. `codesign`
  rejects plain folders under `Frameworks`, so the libraries sit flat there and the plugins
  under `Library/GStreamer` (gate MG8).
- **Libraries.** [macho-dependencies.mjs](../shared/macho-dependencies.mjs) walks the
  worker and the plugins and fails on anything that is neither in the system nor an
  `@rpath` library of the framework; `gstreamer.components` must name exactly the files
  shipped. Each library is thinned to arm64, loads every other one as `@rpath/<name>`,
  and has one rpath inside the helper; the worker's development rpath is removed.
- **One Node.js.** The server and the relay run the same `VidVNC Server`, which has only
  `allow-jit`; the relay runs it with `--jitless` under its sandbox profile
  ([media-relay.mjs](../../apps/server/src/media-relay.mjs)), as gate MG5 required. The gate
  ran the relay on a second copy without the entitlement; one copy keeps the package
  half the size.
- **The launcher** runs the bundled Node.js on the bundled server with the package's
  manifest, clearing every inherited `NODE_` variable, and works through a symbolic link,
  so the app's **Install Command-Line Tool** can link it into `/usr/local/bin`.
- `files.json` beside the bundle in `out/packages/<target>/Release` lists every file with
  its size, SHA-256 and component.

## Signing and notarization

The identity and the notary profile come from `VIDVNC_SIGN_IDENTITY` and
`VIDVNC_NOTARY_PROFILE`; the build fails with instructions when either is missing, and the
team is read from the keychain identity at build time, never stored. Signing is inside out
with `--options runtime --timestamp`: the helper's libraries and plugins, the helper, the
server's Node.js, the launcher, then the app.

| Program        | Entitlements ([entitlements/](entitlements/))                               |
| -------------- | --------------------------------------------------------------------------- |
| VidVNC (host)  | none                                                                        |
| VidVNC Server  | `com.apple.security.cs.allow-jit` (V8)                                      |
| VidVNC Capture | none; library validation stays on, every library is signed by the same team |
| `vidvnc`       | none                                                                        |

`VIDVNC_APP_PROFILE` and `VIDVNC_CAPTURE_PROFILE` may name Developer ID provisioning
profiles. A profile must be for this team and bundle id; it is embedded, and its
application identifier and persistent-content-capture entitlement (spec Q7) are added to
that program's signature. Without them nothing is embedded, which is right until Apple
approves the entitlement.

The app is zipped and notarized, then stapled; the DMG (with an Applications link) is
then signed, notarized and stapled. The CLI ZIP is notarized as a whole, but a ticket
cannot be stapled to a bare program, so its first run checks with Apple online.
`--no-notarize` stops after signing.

Notarization reads the profile from the keychain, which macOS keeps closed while the Mac
is locked: run the build while you are logged in and the screen is unlocked.

### Choosing the identity

Use a **Developer ID Application** certificate: it is the one Apple requires for apps
distributed outside the App Store, and the only kind notarization accepts. Apple
Development and Apple Distribution certificates cannot be used, and Developer ID Installer
is only for `.pkg` installers, which these packages are not.

`VIDVNC_SIGN_IDENTITY` is a prefix of the identity's name, not necessarily the whole name.
[build.mjs](build.mjs) lists the identities from
`security find-identity -v -p codesigning` and keeps the ones whose names start with it.
The build fails unless exactly one matches and it is a `Developer ID Application:`
identity. It then reads the team from that name and passes the full name, such as
`Developer ID Application: Your Name (TEAMID)`, to every `codesign` call. A short value
therefore signs exactly as the full name would.

`VIDVNC_SIGN_IDENTITY="Developer ID Application"` is enough when the keychain holds one
Developer ID Application identity. With more than one, for example for several teams, or
an old and a renewed certificate that are both still valid, that prefix matches all of
them and the build stops. Set the full name as `find-identity` prints it instead:

```sh
VIDVNC_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" npm run package:macos
```

The repository's examples use the short form so that no name or team is written into
them.

### Creating the notary profile

`VIDVNC_NOTARY_PROFILE` is the name of a `notarytool` keychain profile, which you choose
when you create it. The build passes it to `xcrun notarytool submit --keychain-profile`
and `notarytool log`; `notarytool` reads the credentials from the keychain, so the build
never sees them. Create the profile once per Mac, for example as `vidvnc-notary`:

```sh
xcrun notarytool store-credentials vidvnc-notary --apple-id you@example.com --team-id TEAMID
```

It asks for an app-specific password, not the Apple Account password; create one at
[account.apple.com](https://account.apple.com) under Sign-In and Security. The team ID is
the code in brackets at the end of the Developer ID Application identity. `notarytool`
checks the credentials with Apple before it saves them in the login keychain. On a build
machine, an App Store Connect API key can be used instead of an Apple Account:

```sh
xcrun notarytool store-credentials vidvnc-notary --key AuthKey_KEYID.p8 --key-id KEYID --issuer ISSUER
```

Then name the profile when you build:

```sh
VIDVNC_SIGN_IDENTITY="Developer ID Application" VIDVNC_NOTARY_PROFILE=vidvnc-notary npm run package:macos
```

## Checks

[tests/package-check.mjs](tests/package-check.mjs) is run by hand after a build (it is not
part of `npm test`); see [tests/README.md](tests/README.md). Clean-Mac acceptance with no
developer tools is plan phase 7.
