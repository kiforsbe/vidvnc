# Repository conventions

See [distribution requirements](PACKAGING.md) for the six self-contained products:
server/host, native viewer, and CLI server, each on Windows and macOS. Build modules
are reusable inputs to those products, not one duplicated source tree per installer.

## Layout and ownership

```text
apps/
  server/          Node signaling, authentication, worker lifecycle; src/ + tests/
  web-client/      Browser UI and receiver logic; src/ + tests/
  windows-host/    WinUI 3/.NET host, conventional XAML/MSBuild layout
  macos-host/      Planned native Apple server host (ownership guide only)
  windows-client/ Planned WinUI 3 viewer (ownership guide only)
  macos-client/   Planned native Apple viewer (ownership guide only)
native/
  media-worker/   C++ capture/encode/input; src/ + tests/ + CMakeLists.txt
tests/system/     Cross-application lifecycle and real media smoke checks
tools/            Root orchestration and formatting; tools/tests/ owns its tests
  debug/          Cross-process debug target definitions and implementation contract
packaging/        Six-product catalog; shared and OS-specific packaging ownership
docs/             Architecture, mockups, research history
out/              Ignored CMake outputs and preserved legacy artifacts
.deps/            Ignored local SDKs/tools/download cache
```

Tests follow **ownership**, not one mandatory naming convention. JS unit/module
integration tests are inside their app's `tests/`; C++ tests are inside their native
module. App-specific browser tests also belong to that app. Root `tests/system`
is only for checks that exercise the assembled product. A root runner aggregates
tests without taking ownership away from modules.

## Dependency boundaries

- The Node server depends on the web client's exported assets and password helper,
  and the native worker's small exported JS runtime-path adapter.
- Native C++ does not depend on Node. CMake owns its targets, SDK linkage and CTest
  registration. Its private npm manifest only exposes launch configuration and
  its existing Node-driven hardware tests; npm does not compile C++ itself.
- Browser production code does not import the server. Its dev-only server dependency
  supplies a local HTTP fixture for UI smoke tests.
- WinUI owns its MSBuild/XAML project and launches Node through the existing process
  protocol. It does not depend on npm to compile its UI.
- Future Apple apps should use Swift/SwiftUI/AppKit and native Xcode/SPM targets,
  with their own tests. Future Windows viewers should use WinUI 3. The explicitly
  requested ownership scaffolds are not runnable projects; do not invent a shared
  native abstraction before it has users.
- Extract genuinely shared protocol/validation code into a package when needed;
  do not duplicate it or introduce a generic `shared` dumping ground now.

The cross-process JSON/stdin/stdout and WebRTC contracts remain unchanged in this
migration. Stream profiles, H.264/Opus settings, input and session ownership remain
unchanged. Modules resolve resources relative to their own location, not launch CWD.

## Build, dependencies, and tests

One root npm workspace lockfile pins JS dependencies. Use `npm ci` from the root;
no separate nested npm lockfiles. CMake presets coordinate native configurations;
MSBuild remains authoritative for WinUI. Keep generated files out of source control.
GStreamer development headers and runtime DLLs must come from the same SDK install.
Using a custom CMake SDK path requires the matching runtime `GSTREAMER_ROOT` too.

`npm test` is portable and uses stubbed hardware. `npm run test:hardware` explicitly
requires Windows 25H2+, NVIDIA and an interactive desktop. CTest registers the two
existing native unit suites; assert-based checks remain enabled in Release.
Portable CI checks formatting/tests across Windows, macOS and Linux; it does not
claim native capture support on those other OSes or replace device acceptance tests.

Existing opt-in browser checks require an installed Playwright module path:

```powershell
node apps/web-client/tests/toolbar-browser-check.mjs C:\path\to\playwright
node tests/system/browser-media-check.mjs C:\path\to\playwright iphone-720p-test
```

The second captures the real desktop and requires Windows/NVIDIA. Chromium with an
iPhone user-agent tests routing, not Safari or iPhone hardware decoding.

## Platform target

Windows SDK 26100 is the compilation target; runtime preflight enforces Windows build
26200 (25H2).
