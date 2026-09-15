# macOS packaging ownership

Targets: `macos-server`, `macos-client`, `macos-cli` in `../targets.json`.
Status: native apps/media worker and packaging recipes are not implemented.

Use native Apple application bundles and Xcode/SwiftPM build outputs. This layer
owns bundle layout, embedded runtime/library paths, signing order, entitlements,
notarization/stapling and distribution wrapping. CLI bundles omit the management UI.

Screen-recording/accessibility consent must be tested for the actual signed process
identity that performs capture/input. Do not silently grant permissions or assume a
developer build's permission transfers to a packaged app.

Initial target: Apple Silicon. A universal client is a future target decision;
do not conflate a multi-architecture macOS binary with an iOS application.
