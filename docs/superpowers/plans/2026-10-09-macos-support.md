# macOS Host, Server and Distribution Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Phase 0 runs on
> the owner's Mac and Apple Developer account. Phase 1 needs no Mac and can start at once.
> Do not start a phase that depends on a gate until that gate has a recorded result in the
> spec's gate table.

**Goal:** VidVNC hosts on macOS 27 on Apple Silicon, with the same packages as Windows: the
VidVNC app (native host, server and worker, with the command-line server inside), and a
standalone command-line server ZIP. Both are signed with the owner's Developer ID and
notarized.

**Architecture:** The Node server and web client are shared. The media worker keeps its
platform-neutral core (owner protocol, broker, policy, records, rate control, telemetry) and
gains a macOS platform layer: ScreenCaptureKit capture, VideoToolbox encoding, ScreenCaptureKit
audio into the existing Opus branch, and `CGEventPost` input. media-net and the relay run under
a macOS sandbox applied by the worker's launcher. The host is a Swift app that speaks the
existing owner protocol.

**Tech stack:** Swift 6, SwiftUI and AppKit (Xcode, macOS 27 SDK); C++17 and Objective-C++ with
Clang; GStreamer 1.28.6 macOS framework; Node.js 24 (bundled); `codesign`, `notarytool`,
`stapler`, `hdiutil`. No new npm runtime dependency.

**Spec:** [macos-support-design.md](../specs/2026-10-09-macos-support-design.md) (revision 2,
accepted). Decisions are referred to by their register IDs (`Q1`–`Q14`, `D1`–`D10`) and gates
by `MG1`–`MG8`.

## Global constraints

- macOS 27 and Apple Silicon only (Q6). No `#available` branches for older releases.
- Windows behaviour does not change. Every commit that touches shared worker or server code
  passes `npm test` here, and the owner runs `npm run test:hardware` and `npm run test:host`
  on Windows before it merges, because cloud sessions cannot.
- Every new component fails closed. There is no runtime fallback to a weaker sandbox, an
  unsandboxed relay, a software encoder or an unconfirmed network.
- Protocol additions are limited to those listed in the spec: the `videotoolbox` backend id,
  the worker's `input-unavailable` report and `--adapters` mode, the network-confirmation
  owner command and status field (Q2), and `os` in the runtime manifest.
- No secrets in the repository: signing identities, provisioning profile paths and the
  `notarytool` keychain profile come from environment variables (Q11), and the scripts fail
  with instructions when they are missing.
- Documentation lands with each change, per [AGENTS.md](../../../AGENTS.md). User-visible
  changes get `## [Unreleased]` changelog entries. The first release with macOS support is a
  minor version (Q13).

## File structure

| File                                                                               | Role                                                                                  | Phase |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----- |
| `docs/ARCHITECTURE.md` (owner protocol section)                                    | The owner protocol as a written contract                                              | 1     |
| `apps/server/tests/fixtures/owner-protocol/` (new)                                 | Example commands, replies and status lines both hosts are checked against             | 1     |
| `native/media-worker/runtime.mjs`, `runtime-manifest.mjs`                          | Per-platform defaults, `os` and `arm64` in the manifest                               | 1     |
| `apps/server/src/encoder-backends.mjs`, CLI settings                               | `videotoolbox` backend                                                                | 1     |
| `apps/server/src/lan-adapters.mjs` (new), `macos-lan-adapters.mjs` (new)           | Platform choice of LAN provider; macOS rows from the worker                           | 1     |
| `apps/server/src/network-confirmation.mjs` (new)                                   | Known networks and the owner's confirmation (Q2)                                      | 1     |
| `apps/server/src/tls/strategies/self-signed.mjs` (new), `der.mjs` (new)            | Portable self-signed certificate (D7)                                                 | 1     |
| `apps/server/src/media-relay.mjs`                                                  | Sandboxed relay launch on macOS                                                       | 1     |
| `native/media-worker/CMakeLists.txt`, `CMakePresets.json`, `build-native.sh` (new) | Apple build                                                                           | 2     |
| `native/media-worker/src/platform/windows/` (new)                                  | Code moved out of `media-worker.cpp`: DXGI, D3D11 pipeline, `SendInput`, `check-port` | 2     |
| `native/media-worker/src/platform/macos/` (new)                                    | Display inventory, capture, encode, audio, input, adapters, `check-port`, sandbox     | 2–4   |
| `native/media-worker/src/net-pipes.hpp`                                            | POSIX implementation                                                                  | 2     |
| `native/media-worker/src/input-policy.hpp`                                         | One allow-list, Windows and macOS key tables                                          | 2     |
| `native/media-worker/tests/` (macOS checks)                                        | Hardware, relay and sandbox checks on macOS                                           | 3–4   |
| `apps/macos-host/` (Xcode project)                                                 | The Swift host and its tests                                                          | 5     |
| `docs/design/macos-host-previz/` (new)                                             | Design preview before the host UI is built                                            | 5     |
| `tools/debug/`                                                                     | `prepare:host` and launch for the macOS host                                          | 5     |
| `packaging/shared/macho-dependencies.mjs` (new)                                    | Dependency walk for Mach-O, the counterpart of `pe-dependencies.mjs`                  | 6     |
| `packaging/macos/` (`inputs.json`, `build.mjs`, `entitlements/`, `tests/`)         | App, DMG and CLI ZIP builders and checks                                              | 6     |
| `tools/version.mjs`                                                                | Also sets the macOS app and helper versions                                           | 6     |

## Phase 0: Apple account, Mac setup and prototype gates

Owner tasks. Record each gate's result in the spec's gate table, and security results in the
security analysis's verification record.

### Task 0.1: Apple Developer account

- [ ] Register the App IDs `io.github.kiforsbe.vidvnc` and `io.github.kiforsbe.vidvnc.capture`
      (Q14).
- [ ] Submit the persistent content capture request for both App IDs (Q7; steps in the spec,
      [Applying for persistent content capture](../specs/2026-10-09-macos-support-design.md#applying-for-persistent-content-capture)).
      Record the date; follow up after four weeks.
- [ ] Create a **Developer ID Application** certificate in the login keychain.
- [ ] Create a `notarytool` keychain profile:
      `xcrun notarytool store-credentials vidvnc-notary --apple-id <id> --team-id <team>` with
      an app-specific password. The password stays in the keychain, never in the repository.
- [ ] When the entitlement is approved: enable it on both App IDs and download a Developer ID
      provisioning profile for each, kept outside the repository.

### Task 0.2: Mac development environment

- [ ] macOS 27 on Apple Silicon, Xcode 27 with command-line tools, CMake, Node.js 24.
- [ ] Install the GStreamer 1.28.6 macOS development and runtime framework, the version
      `packaging/windows/inputs.json` pins. Read its minimum macOS from the binaries
      (`otool -l` on `GStreamer.framework/GStreamer`, `LC_BUILD_VERSION`) and record it.
- [ ] Clone the repository, `npm ci`, `npm test`.

### Task 0.3: Gates

Prototypes are throwaway code on a `prototype/macos-*` branch; only results and lessons move
into the phases.

- [ ] **MG1:** build media-net alone with Clang against the framework; run
      `native/media-worker/tests/relay-check.mjs` against Chromium on loopback (P1, P2).
- [ ] **MG2:** a prototype ScreenCaptureKit → VideoToolbox → frames → media-net → Chromium and
      iPhone Safari, H.264 and HEVC at 1080p60 and 4K30. Measure latency and CPU against the
      Windows NVENC baseline. If it disappoints, measure `vtenc_h264_hw` too (D1 alternative).
- [ ] **MG3:** host-like app → Node → worker spawning chain posting mouse and key events with
      `CGEventPost`. Record which app the Screen Recording and Accessibility prompts name.
- [ ] **MG4:** port `sandbox-probe` and run it under each D3 candidate; the probe tries to
      capture, post events, read `~/Documents`, open a non-loopback socket, fork and exec, then
      runs `webrtcbin`.
- [ ] **MG5:** the minimal hardened-runtime entitlements for the bundled Node.js running the
      server and the relay bundle under Node's permission model.
- [ ] **MG6:** on macOS 27: what triggers the Remote Desktop privacy category; whether relay
      replies to LAN peers need Local Network approval; how often capture is re-approved; and,
      once approved, whether the entitlement stops it and on which process.
- [ ] **MG7:** only to keep Q1 honest: a sandboxed (inherit) build end to end, and App Review's
      answer on a host that posts input events. Q1 stays "no App Store edition" unless this
      changes the picture.
- [ ] **MG8:** a bundle with a Swift stub, Node.js, the worker and the GStreamer dylibs passes
      notarization, stapling and `spctl --assess` on a clean Mac with no developer tools.

## Phase 1: Portable server work (no Mac needed)

Runs and is tested with `npm test` on any OS. Starts now, in parallel with phase 0.

### Task 1.1: Owner protocol contract

- [ ] Write the owner protocol into ARCHITECTURE: the start line, every command the Windows host
      sends, every `*-result` reply and every `status` field, from `main.mjs`,
      `owner-security-commands.mjs`, `host-status.mjs` and the C# that uses them.
- [ ] Add fixtures under `apps/server/tests/fixtures/owner-protocol/` and a test that the server's
      real replies and status lines match them.
- [ ] Point `apps/windows-host/tests/Navigation/owner-fixture.mjs` at the same fixtures, so both
      hosts are held to one contract. No protocol change.

### Task 1.2: Runtime paths and manifest

- [ ] `runtime.mjs`: per-platform user data and log directory (reuse `dataDirectory()`), default
      worker path `out/native/macos-arm64/<config>/…`, and a GStreamer root that defaults to the
      framework on macOS. Tests for both platforms with injected `platform` and `env`.
- [ ] `runtime-manifest.mjs`: `os` (`windows`, `macos`) and `architecture` `arm64` for macOS;
      reject mismatches. Windows manifests without `os` keep working.

### Task 1.3: `videotoolbox` encoder backend

- [ ] Add it to `ENCODER_BACKENDS` and the labels, the CLI's `encoder-backend` usage and
      completion, and validation tests. The Windows host reads backends from status, so it needs
      no change; confirm.

### Task 1.4: LAN adapter provider

- [ ] `lan-adapters.mjs` chooses the provider by platform; `main.mjs` stops importing the
      Windows one directly.
- [ ] `macos-lan-adapters.mjs` runs the worker's `--adapters` mode (task 2.6) with a fixed
      argument list and a timeout, and maps its JSON to the rows `normalizeWindowsLanRows`
      produces. Eligible: physical Ethernet or Wi-Fi, up, private, unique-local or link-local
      address. Tests with recorded fixtures, including VPN, bridge and Thunderbolt rows.

### Task 1.5: Network confirmation (Q2)

- [ ] `network-confirmation.mjs`: a network identity from subnet and router hardware address;
      known networks persisted in the data directory; a new network is ineligible until the
      owner confirms it.
- [ ] Owner command `network-confirm {id, allow}` and a `status.networks` field with pending
      networks. On only when the host passes `--confirm-networks`; the CLI does not.
- [ ] Settings file and migration tests. Changelog under Added.

### Task 1.6: Portable self-signed TLS (D7)

- [ ] `der.mjs`: a minimal DER writer for the certificate fields VidVNC needs, with tests against
      `node:crypto`'s `X509Certificate` parsing.
- [ ] `strategies/self-signed.mjs`: P-256 key, the same subject alternative names, validity and
      renewal rules as `windows-self-signed`, key file mode `0600`, data directory `0700`.
- [ ] Strategy order on macOS: `provided`, `mkcert`, `self-signed`. Windows unchanged.

### Task 1.7: Relay launch and parent exit

- [ ] `media-relay.mjs`: on macOS, launch through `media-worker --sandbox -- <node> …` as on
      Windows. In packaged mode on macOS, refuse to start the relay without the launcher.
- [ ] Server: stop when `process.ppid` changes (the owner died), as defence in depth next to the
      existing stop on owner-pipe close.

## Phase 2: Worker portability (needs a Mac to build; Windows unchanged)

### Task 2.1: Apple build

- [ ] `CMakeLists.txt`: an Apple branch (Clang, `OBJCXX`, `-fobjc-arc`, frameworks, the
      GStreamer framework under `GSTREAMER_ROOT`), keeping the MSVC branch as is.
- [ ] `CMakePresets.json`: `macos-arm64-debug` and `macos-arm64-release`; `build-native.sh`.
- [ ] The portable unit tests (`net-records`, `input-policy`, `rate-control`, …) build and pass
      under CTest on macOS. Add them to the `Portable checks` workflow's macOS job.

### Task 2.2: Split the worker

- [ ] Move Windows-only code out of `media-worker.cpp` into `src/platform/windows/` behind small
      interfaces: display inventory, video source, audio source, input sink, port attestation,
      sandbox launch. Behaviour unchanged; owner runs the Windows hardware suite.
- [ ] `src/platform/macos/` stubs that fail the probe by name until phase 3.

### Task 2.3: POSIX pipes and portable media-net

- [ ] `net-pipes.hpp`: POSIX implementation with `pipe(2)`, `FD_CLOEXEC` on all but the four
      child ends, the same threads, queue limit and overflow behaviour.
- [ ] media-net: Winsock start, `RevertToSelf` and Arbitrary Code Guard behind the Windows
      platform layer. MG1's relay check passes from the real worker.

### Task 2.4: Key tables

- [ ] `input-policy.hpp`: one allow-list of `code` values with Windows and macOS (`kVK_*`)
      tables; a test that both cover exactly the same set.

### Task 2.5: Port attestation

- [ ] `check-port` with `proc_pidinfo` and `proc_pidfdinfo` on media-net's pid; tests for a port
      owned by media-net, by another process and by nobody.

### Task 2.6: `--adapters` mode

- [ ] SystemConfiguration and `getifaddrs`: BSD name, kind, physical, up, addresses, router
      hardware address; JSON on stdout; no network traffic.

## Phase 3: macOS capture, encode, audio and input (needs MG1–MG3)

### Task 3.1: Displays

- [ ] Inventory from `CGGetActiveDisplayList`, a stable id from
      `CGDisplayCreateUUIDFromDisplayID`, bounds in points, pixel size, scale, rotation, primary.
- [ ] Hotplug with `CGDisplayRegisterReconfigurationCallback`; the existing stale-inventory and
      unplug rules apply.

### Task 3.2: Capture

- [ ] One `SCStream` per source: NV12 at the profile's output size, frame interval from the
      profile, cursor shown, started on the first answered viewer as on Windows.
- [ ] A display change underneath a session releases held input and fails the session, as on
      Windows.

### Task 3.3: Encode (D1)

- [ ] `VTCompressionSession` with low-latency rate control, real time, no reordering, key-frame
      interval from the GOP; `vt-rate-control.mm` maps `RateControl` and is tested with the
      same intents as `encoder-properties.hpp`.
- [ ] Forced key frames through the existing limiter; Annex B access units into frame records.
- [ ] Probe: list encoders, encode 10 real frames per codec, report `backends` with
      `videotoolbox` and minimums; AV1 only if a hardware encoder exists and passes.

### Task 3.4: Audio

- [ ] ScreenCaptureKit audio, VidVNC's own audio excluded, into `appsrc` and the existing
      Opus branch; same profiles and record format.

### Task 3.5: Input (D4)

- [ ] `CGEventPost` for move, buttons with drag events, keys and wheel; mapping onto
      `CGDisplayBounds`; release held keys and buttons on lease loss.
- [ ] `CGPreflightPostEventAccess` at `start`; `input-unavailable` to the server, shown in host
      status and the CLI.

### Task 3.6: Hardware checks on macOS

- [ ] Make `native-worker.test.mjs`, `multi-stream-check.mjs`, `shared-stream-check.mjs`,
      `audio-only-check.mjs` and `control-permission-check.mjs` run on macOS, and
      `npm run test:hardware` choose them. Record what ran on which Mac.

## Phase 4: Sandbox for media-net and the relay (needs MG4)

- [ ] Implement the mechanism MG4 chose in `src/platform/macos/sandbox`, used by `--sandbox`
      and by the media-net launch.
- [ ] `kqueue` `EVFILT_PROC` `NOTE_EXIT` watch on the parent in the worker and the launcher.
- [ ] `sandbox-check.mjs` and `relay-sandbox-check.mjs` on macOS; results in the verification
      record; threat model rows from the spec's security analysis in ARCHITECTURE.
- [ ] If no mechanism passes, stop and ask the owner (spec D3); do not ship without the split
      by default.

## Phase 5: Host app

### Task 5.1: Design preview

- [ ] `docs/design/macos-host-previz/`: the pages, Permissions and network confirmation, the
      menu bar item, light and dark. Owner review before task 5.4.

### Task 5.2: Project and runtime

- [ ] Xcode project in `apps/macos-host`, Swift 6, macOS 27, app and capture-helper targets with
      the Q14 identifiers.
- [ ] Runtime manifest loading with the packaged-path rules of `RuntimeManifest.cs`.
- [ ] `npm run prepare:host` and `start:host` on macOS (`tools/debug`), Debug and Release kept
      apart as on Windows.

### Task 5.3: Server supervision

- [ ] `posix_spawn` with pipes, the start line, `Codable` status decoding tested against the
      phase 1 fixtures, graceful stop.
- [ ] Process-tree test: `SIGKILL` the host and no VidVNC process survives.

### Task 5.4: Pages

- [ ] One task per page, at parity with Windows: Overview, Sharing, Displays with Identify
      overlays, Profiles, Allowed options, Codecs, Access, Clients, Sessions, TLS, Versions;
      then the menu bar item.

### Task 5.5: Permissions and onboarding

- [ ] Permissions page with live state and buttons to the System Settings panes; prompts only
      after an owner action (D5).
- [ ] Network confirmation UI (Q2), with `--confirm-networks` passed to the server.

### Task 5.6: Bundled command-line server (Q10)

- [ ] `Helpers/vidvnc` launcher using the bundled Node.js and server; "Install command-line
      tool" links it into a `PATH` folder after asking.

### Task 5.7: Tests and login item

- [ ] Swift Testing unit tests; an XCUITest navigation test against the owner fixture, like
      `apps/windows-host/tests/Navigation`.
- [ ] Login at startup as an opt-in through `SMAppService`.

## Phase 6: Packaging (needs MG5 and MG8)

- [ ] `packaging/macos/inputs.json`: Node.js 24 `darwin-arm64` archive with SHA-256, the
      GStreamer framework version, and the dylib and plugin allow-list.
- [ ] `packaging/shared/macho-dependencies.mjs` with fixture tests: follow `otool -L` from the
      worker and plugins, fail on anything outside the allow-list or the system.
- [ ] `build.mjs macos-server`: assemble the app (layout in spec D9), rewrite install names to
      `@rpath`, write `runtime.json` and notices, embed provisioning profiles, sign inside out
      with the per-executable entitlement files, build and sign the DMG, notarize and staple.
- [ ] `build.mjs macos-cli`: the ZIP with launcher, Node.js, server, capture helper and
      libraries, signed and notarized.
- [ ] Package checks: `codesign --verify --deep --strict`, `spctl --assess`,
      `stapler validate`, running from a path with spaces and non-ASCII characters, server
      ready, cleanup after kill.
- [ ] `tools/version.mjs` also sets the app and helper versions; `npm run package:macos`.
- [ ] `targets.json` statuses and `packaging/macos/README.md`.

## Phase 7: Acceptance and documentation

- [ ] Clean-Mac acceptance (MG8 environment): install from the DMG, onboarding, sharing to a
      browser and an iPhone, control, audio, two displays if available, hotplug, the bundled
      and standalone CLI with shared settings, uninstall by deleting the app.
- [ ] Documentation per the spec's
      [Documentation changes](../specs/2026-10-09-macos-support-design.md#documentation-changes),
      including README (install, permissions, data and logs, the first-run online notarization
      check for the CLI), CONTRIBUTING (building on a Mac) and the roadmap.
- [ ] Release only when the owner asks, with the version the owner chooses (Q13).

## Not scheduled

- A Mac App Store edition (Q1, MG7).
- A Control-to-Command mapping for viewers (Q3).
- Bundling Node.js in the Windows CLI (Q5); the owner will do it separately.
- The native macOS viewer.
