# Native macOS server host

Status: the VidVNC app for Mac runs from source and drives the real server, and
[packaging/macos](../../packaging/macos/README.md) builds it into a signed, notarized DMG.

The host owns the Mac's server-management UI and the server process's lifetime: Swift 6,
SwiftUI with AppKit where SwiftUI falls short (the Identify overlays), macOS 27 on Apple
Silicon. It speaks the [owner protocol](../../docs/ARCHITECTURE.md#owner-protocol) unchanged,
as the Windows host does. The design is
[2026-10-11-macos-host-design.md](../../docs/superpowers/specs/2026-10-11-macos-host-design.md);
the screens are in [docs/design/macos-host-previz/](../../docs/design/macos-host-previz/README.md).

## Layout

| Path                                                | What it holds                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VidVNC.xcodeproj`                                  | The app, its unit tests and its UI tests; the shared `VidVNC` scheme                                                                                                                |
| `VidVNC/Model/`                                     | `HostModel`, the protocol every view reads, and `FakeHostModel`, its sample-data stand-in for previews, screenshots and `-scenario`                                                 |
| `VidVNC/Server/`                                    | `ServerHostModel` (the real model), `ServerProcess` (`posix_spawn` with pipes), `RuntimeManifest`, the owner-protocol messages, and `OfflineSettings` (`main.mjs config`)           |
| `VidVNC/System/`                                    | Privacy checks, the Local Network probe, display ids, network interfaces, the login item, Install Command-Line Tool                                                                 |
| `VidVNC/Views/`, `Sheets/`, `Settings/`, `MenuBar/` | The window's eight sections, its sheets, the Settings window and the menu bar item                                                                                                  |
| `VidVNCTests/`                                      | Swift Testing unit tests: every owner-protocol example decodes, the manifest's path rules, `ServerProcess`                                                                          |
| `VidVNCUITests/`                                    | XCUITest navigation against the stand-in server                                                                                                                                     |
| `tests/`                                            | The stand-in server, its contract check (part of `npm test`) and the process-tree check                                                                                             |
| `Config/`                                           | `Info.plist` additions and the signing settings                                                                                                                                     |
| `screenshots.sh`                                    | Saves light and dark images of each section to `docs/design/macos-host-previz/`                                                                                                     |
| `docs-screenshots.sh`                               | Saves the whole window of each section, Connect a Device's QR code and each Settings tab, light and dark, to `docs/images/macos-host/` ([Screenshots](../../docs/images/README.md)) |

## Run it

From the repository root, on a Mac with the tools `npm run deps` asks for:

```sh
npm run prepare:host -- Debug
npm run start:host -- Debug
```

`prepare:host` builds and tests the Debug media worker, builds the app into
`out/macos-host/DerivedData`, and writes the development runtime manifest to
`out/macos-host/Debug/runtime.json`. `start:host` does the same when something is stale, then
opens the app through Launch Services, so macOS asks for and records permissions for VidVNC
rather than for Terminal. To debug in Xcode, open `VidVNC.xcodeproj` and run the `VidVNC`
scheme: its Run action points `VIDVNC_RUNTIME_MANIFEST` at the same manifest. Enable the
scheme's `VIDVNC_INSPECT` variable for the Node inspector on `127.0.0.1:9229`.

**Signing.** The project signs ad-hoc unless told otherwise, which works but loses the Screen
Recording and Device Control grants on every rebuild. Set `VIDVNC_SIGN_IDENTITY` (for example
`Developer ID Application`) for `prepare:host` and `start:host`; the team comes from the
matching identity in your keychain at build time, or from `VIDVNC_DEVELOPMENT_TEAM`. Or copy
`Config/Signing.local.xcconfig.example` to `Config/Signing.local.xcconfig` for Xcode. Both
stay out of the repository.

The app's bundle ID is `io.github.kiforsbe.vidvnc` (spec Q14). Settings and logs are the
server's, in `~/Library/Application Support/VidVNC`; the app keeps only its own preferences
(keep sharing when the window closes, whether the permissions introduction was shown) in
its user defaults.

## How it works

- The server starts with `--desktop --await-owner --confirm-networks` and gets one approval
  line, `{"type":"start","sharing":"local"}` or `"remote"`. After `ready`, every change is
  an owner command; while sharing is off, Access and Remote Access settings go through the
  offline `config` command, and the stream policy can be changed only while sharing.
- The server runs in its own process group with only stdin, stdout and stderr inherited.
  The host alone holds the write end of the server's stdin, so if the host exits or is
  killed the server stops (owner pipe and parent watch). Stop sends `{"type":"stop"}` and
  ends the process group after five seconds; Quit waits for that.
- Closing the window leaves VidVNC in the menu bar with no Dock icon, and sharing carries
  on unless **Keep sharing when the window closes** is off in Settings, General.
- Permissions (spec D5): nothing is asked at launch. Turning sharing on the first time shows
  an introduction, then macOS asks for Screen & System Audio Recording and Local Network,
  and the first stream with sound asks for System Audio Recording. Device Control & Data
  Access is explained the first time the owner gives a viewer control or picks
  **Allow when available**; until it is allowed, the worker posts no input and the server
  reports why on that stream. The Permissions section reads each setting every two seconds.
  Local Network has no API; it is inferred by browsing for `_vidvnc._tcp`.
- Streaming edits the profiles, codecs and encoder while sharing. A profile's size follows
  the display, as with the command line's `--height`, `--width`, `--scale` and
  `--size … --aspect`; **Restore Defaults** puts the five standard profiles back as shipped
  and keeps the owner's own.
- Once the introduction has been shown, sharing starts when the app opens, as on Windows,
  if Screen Recording is already allowed; otherwise the app opens with sharing off and asks
  nothing. `-startSharing NO` turns that off (the UI tests pass it), and the unit tests'
  host app never shares.
- The app icon is the Windows host's monitor glyph on a macOS tile, drawn by
  `Icon/draw-app-icon.swift` into `VidVNC/Assets.xcassets`.
- A network the server has not been allowed on shows a sheet, **Share on This Network?**,
  and the server listens there only after **Allow** (`network-confirm`, Q2).
- **Open at login** in Settings, General registers the app as a login item with
  `SMAppService`; it is off until the owner turns it on.
- **Install Command-Line Tool…** (the VidVNC menu, or **Command-line tool** in Settings,
  General) links `/usr/local/bin/vidvnc` to the packaged app's `Contents/Helpers/vidvnc`
  after the owner confirms, directly when that folder is writable and otherwise through
  `do shell script … with administrator privileges`, which shows macOS's password prompt.
  It can replace another `vidvnc` there after saying so, and **Remove** deletes the link
  only while it leads to this app. A development build has no launcher, so the item is
  unavailable there.
- A packaged app reads `Contents/Resources/runtime.json`, whose `root` is `..`, and never a
  `VIDVNC_RUNTIME_MANIFEST` it inherits.
- In Debug builds, `-scenario "Remote access"` (any Scenario menu title) runs the app on
  sample data with no server, with a Scenario menu to switch states.

## Tests

```sh
xcodebuild -project apps/macos-host/VidVNC.xcodeproj -scheme VidVNC \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath out/macos-host/DerivedData test
node apps/macos-host/tests/process-tree.mjs
node apps/macos-host/tests/process-tree.mjs --real
```

The Xcode tests run the unit tests and the UI tests; the UI tests need
`npm run prepare:host -- Debug` first (for the manifest's Node.js path) and Xcode's
permission to control the Mac. They start sharing against the stand-in server, so nothing is
captured. `process-tree.mjs` starts sharing, kills VidVNC with `SIGKILL` and fails if any
server process is still running ten seconds later; `--real` uses the real server and its
media relay. Both use a Debug-only switch (`VIDVNC_TEST_ASSUME_SCREEN_RECORDING=1`) in place
of the Screen Recording permission, because no viewer connects and nothing is captured.

## Not done yet

- The server reports only networks waiting for an answer, so the app cannot list or forget
  networks already allowed; `known-networks.json` in the settings folder holds them.
