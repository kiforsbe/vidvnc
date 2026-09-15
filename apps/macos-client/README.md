# Native macOS viewer

Status: ownership scaffold only; no runnable Xcode project yet.

Own the native Apple viewer, decoding/playback integration and remote-input UI here.
Use Swift/SwiftUI/AppKit and native Xcode/SwiftPM conventions with app-owned tests.
The viewer-only package must not include the server/capture worker.

Provide Xcode Debug launch and LLDB support for native libraries. Initially target
Apple Silicon; preserve room for a universal macOS client without duplicating source.
