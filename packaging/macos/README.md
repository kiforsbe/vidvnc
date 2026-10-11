# macOS packaging ownership

Targets: `macos-server`, `macos-client`, `macos-cli` in `../targets.json`.
Status: the media worker and the [server host app](../../apps/macos-host/README.md) build
and run from source; the native viewer and the packaging recipes are not implemented
(macOS plan phase 6).

Use native Apple application bundles and Xcode/SwiftPM build outputs. This layer
owns bundle layout, embedded runtime/library paths, signing order, entitlements,
notarization/stapling and distribution wrapping. CLI bundles omit the management UI.

Screen-recording/accessibility consent must be tested for the actual signed process
identity that performs capture/input. Do not silently grant permissions or assume a
developer build's permission transfers to a packaged app.

Initial target: Apple Silicon. A universal client is a future target decision;
do not conflate a multi-architecture macOS binary with an iOS application.
