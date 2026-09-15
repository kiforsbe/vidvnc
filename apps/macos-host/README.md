# Native macOS server host

Status: ownership scaffold only; no runnable Xcode project yet.

Own the native Apple server-management UI and server process lifecycle here, using
Swift/SwiftUI/AppKit as appropriate. This is not a viewer client or web wrapper.
Use native Xcode/SwiftPM conventions; keep its unit/UI tests with this app.

The host must support Debug launch in Xcode, private packaged runtimes in installed
mode and explicit development runtime paths. Host, Node server and media worker are
separate debugger targets. See `../../tools/debug/README.md`.
