# Native macOS server host

Status: ownership scaffold and a UI prototype; no server-backed Xcode project yet.

Own the native Apple server-management UI and server process lifecycle here, using
Swift/SwiftUI/AppKit as appropriate. This is not a viewer client or web wrapper.
Use native Xcode/SwiftPM conventions; keep its unit/UI tests with this app.

The host must support Debug launch in Xcode, private packaged runtimes in installed
mode and explicit development runtime paths. Host, Node server and media worker are
separate debugger targets. See `../../tools/debug/README.md`.

## UI prototype

[Prototype/](Prototype/) holds `VidVNCPrototype.xcodeproj`, a SwiftUI app that shows the
planned host window, menu bar extra, sheets and Settings running on fake data. It starts
no server, opens no ports and never asks macOS for a privacy permission; "Open System
Settings" only opens the Privacy & Security pane. It is a design aid, not the product.

- Swift 6, macOS 27 deployment target, Xcode 27. Signed to run locally (ad-hoc), no
  entitlements, bundle ID `io.github.kiforsbe.vidvnc.prototype` so it never shares privacy
  grants with the real app.
- Views read only the `HostModel` protocol
  ([Model/HostModel.swift](Prototype/VidVNCPrototype/Model/HostModel.swift)).
  `FakeHostModel` supplies the sample data; the real app will supply a server-backed model
  without changing the views.
- The **Scenario** menu switches the fake model between the states in the design (sharing
  off, starting, remote access, someone controlling, HTTPS not ready, missing permissions,
  new network, server stopped, approval request). Overview, the sidebar footer and the
  menu bar symbol all follow it. Command-1 to Command-7 switch sections.
- Every section, sheet, Settings and the menu bar content have light and dark `#Preview`s.

Open `Prototype/VidVNCPrototype.xcodeproj` in Xcode and run, or build from the command
line:

```sh
xcodebuild -project apps/macos-host/Prototype/VidVNCPrototype.xcodeproj \
  -scheme VidVNCPrototype -configuration Debug build
```

Pass `-scenario "Remote access"` (any Scenario menu title) as a launch argument to start
in that state. [Prototype/screenshots.sh](Prototype/screenshots.sh) builds the app and
saves light and dark images of every section to
[docs/design/macos-host-previz/](../../docs/design/macos-host-previz/README.md).
