# macOS prototype gates (phase 0)

Results of the prototype gates MG1–MG8 from the
[macOS design](../superpowers/specs/2026-10-09-macos-support-design.md#prototype-gates), run
before phase 1 of the [macOS plan](../superpowers/plans/2026-10-09-macos-support.md). The
design asks for the results in its gate table, but dated specs are not edited (see
[docs/superpowers](../superpowers/README.md)), so they are recorded here.

## Summary (2026-10-10)

All gates ran on the owner's Apple Silicon MacBook on macOS 27.0, with a clean macOS 27.0.1
virtual machine for MG8. The prototype code was throwaway and is not in the repository.

| Gate | Result                                              | Decision it settles                                          |
| ---- | --------------------------------------------------- | ------------------------------------------------------------ |
| MG1  | Pass                                                | D2: POSIX pipes, record formats unchanged                    |
| MG2  | Pass (Mac and iPhone); Windows baseline not run     | D1: ScreenCaptureKit into VideoToolbox stands                |
| MG3  | Pass                                                | D4: `CGEventPost`; prompts name the host app                 |
| MG4  | Option 1 pass, option 2 fail; one residual accepted | D3: launcher-applied sandbox profile                         |
| MG5  | Pass, also re-checked with Developer ID             | D9: server Node.js needs only `allow-jit`                    |
| MG6  | Pass, except the re-approval interval               | D5: Local Network prompt only for connections the Mac starts |
| MG7  | Not run                                             | Q1 stays: no App Store edition                               |
| MG8  | Pass on a clean Mac                                 | D9: bundle notarizes, and grants survive updates             |

What phase 1 onwards must take from this:

- **Accessibility is renamed on macOS 27.** System Settings → Privacy & Security lists it as
  **Device Control & Data Access**. Onboarding and the "input unavailable" message (plan
  task 3.5) must use that name on macOS 27. The
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` link still
  opens it.
- **Posted input fails silently without the grant.** `CGEventPost` returns no error and
  the event never arrives, so the worker must check `CGPreflightPostEventAccess` at start
  and report input unavailable. A check that moves the cursor also fails if someone moves
  the mouse at the same time; it must tolerate that.
- **media-net can listen on the LAN under its sandbox, but never send there.** The owner
  accepted this residual with a fail-closed socket audit by the worker (phase 4); it goes in
  the security analysis.
- **Local Network approval is needed only for connections the Mac starts** toward a LAN
  device other than the router. Viewers contact the Mac first, so normal use needs none;
  discovery or LAN probing would trigger the prompt (plan task 5.5).
- **Signing.** GStreamer must be re-signed with the team ID (the worker then needs no
  entitlements). Grants follow the team and bundle ID, so updates keep them; ad-hoc
  rebuilds do not.

## Environment

| Item      | Version                                                           |
| --------- | ----------------------------------------------------------------- |
| macOS     | 27.0 (26A428), arm64; clean VM 27.0.1 (26A434)                    |
| Xcode     | 27.0 (27A266a), Apple clang 21.0.0, Swift 6.4                     |
| CMake     | 4.4.4, building with `cmake -G Xcode` and `xcodebuild`            |
| Node.js   | v25.5.0 for development; official v24.21.0 bundled in MG5 and MG8 |
| GStreamer | 1.28.6 framework, `LC_BUILD_VERSION` minos 11.0, sdk 26.5         |
| Browsers  | Chrome 155 on the Mac; Safari on iOS 18.7                         |

`npm test` passed 923 of 925 on the Mac. The two failures in
[runtime-manifest.test.mjs](../../native/media-worker/tests/runtime-manifest.test.mjs)
compared a resolved temp path (`/private/var/…`) with `os.tmpdir()` (`/var/…`); the test
now resolves its temp folder first.

## MG1: media-net and the relay check

media-net and the shared headers compile unmodified with Apple clang against the
GStreamer framework, with a small POSIX shim for the Win32 calls it uses (pipes,
`ReadFile`/`WriteFile`, `Sleep`, `ExitProcess`). The repository's `CMakeLists.txt` is
Windows-only, so phase 2 needs an Apple path. `relay-check.mjs`, with `lsof` and `pgrep`
in place of `netstat` and `tasklist`, passed P1 and P2 against Chrome with a stand-in
worker sending Opus:

- P1: the worker offered only 127.0.0.1, ICE and DTLS completed through the relay, every
  worker socket was on loopback, and 2 or 4 peers shared the relay port with no loss.
- P2 (20 s runs): ICE RTT 0.45 ms direct, 5.95 ms relayed with 2 peers and 8.0 ms with 4,
  against 6.58 ms recorded on Windows. One Xcode-built rerun measured 11.2 ms, so single
  runs are noisy.

## MG2: capture and encode

ScreenCaptureKit (NV12) into a hardware `VTCompressionSession` (low-latency, real time, no
reordering, CBR, a keyframe every second), then `h264parse` or `h265parse` and the real
media-net and relay. Glass to glass is a clock drawn on screen and read back from the
received video. Every run had no loss, freezes or dropped frames.

| Viewer, run                         | Glass to glass p50 / p95 | Bitrate     | Worker CPU |
| ----------------------------------- | ------------------------ | ----------- | ---------- |
| Chrome on the Mac, H.264 1080p60    | 63 / 68 ms               | 8.9 Mbit/s  | 4.1%       |
| Chrome on the Mac, HEVC 1080p60     | 64 / 75 ms               | 5.3 Mbit/s  | 4.1%       |
| Chrome on the Mac, H.264 4K30       | 93 / 125 ms              | 14.2 Mbit/s | 1.0%       |
| Chrome on the Mac, HEVC 4K30        | 100 / 125 ms             | 6.9 Mbit/s  | 0.9%       |
| iPhone Safari, Wi-Fi, H.264 1080p60 | 70–74 / 92–98 ms         | 8.6 Mbit/s  |            |
| iPhone Safari, Wi-Fi, HEVC 1080p60  | 73 / 80 ms               | 5.3 Mbit/s  |            |
| iPhone Safari, Wi-Fi, H.264 4K30    | 111 / 121 ms             | 15.6 Mbit/s |            |
| iPhone Safari, Wi-Fi, HEVC 4K30     | 107 / 130 ms             | 7.2 Mbit/s  |            |

- CPU is a percentage of one core; scaling and encoding run on the GPU and media engine.
- The relay adds about 4 ms, within the noise. At 4K30 most of the latency is the 33 ms
  frame interval plus about 18 ms of encoding.
- Safari decodes both codecs in hardware at full rate; HEVC needs 40–55% less bandwidth.
- VideoToolbox CBR undershoots its target on this synthetic content (9 of 20 Mbit/s at
  1080p60).
- "4K" was the built-in panel scaled to 3840×2160; a true 4K source needs an external
  display.
- Not run: the Windows NVENC comparison. The repository has no Windows glass-to-glass
  baseline, and the owner postponed it. The GStreamer `vtenc` fallback was not needed.

## MG3: input and privacy attribution

A Swift host app launched its bundled Node.js, which spawned the worker, as in the product.
TCC attributes requests to the responsible process, so the Screen Recording and
Accessibility prompts and Settings entries name the **host app**, never Node.js or the
worker, and the grants carry down the chain. Nothing in that chain may disclaim
responsibility. Started from a terminal, the terminal app gets the attribution instead, so
development runs need their own grants. With both grants, capture worked and a posted
mouse move and Shift key landed.

## MG4: sandbox for media-net

A probe ran under the host app with live grants, against each D3 candidate:

| Check                     | Option 1: launcher profile (SBPL) | Option 2: App Sandbox helper   |
| ------------------------- | --------------------------------- | ------------------------------ |
| Screen capture            | blocked                           | captured with the host's grant |
| Posted events             | did not land                      | landed with the host's grant   |
| Home files, `~/Documents` | denied                            | `~/Documents` listed           |
| Sending to the LAN        | denied                            | allowed                        |
| fork and exec             | denied                            | allowed                        |
| Loopback WebRTC           | works                             | works                          |

Option 2 is out: an App Sandbox child still uses the app's grants and cannot be limited to
loopback. Option 1's profile denies by default and allows no `mach-lookup`, which alone
blocks capture and event posting. Applied before exec it also needs `file-map-executable`
for the system libraries, GStreamer and the program, and read access to `/` and
`/private/preboot`, or dyld aborts. `sandbox_init` still works on macOS 27 but is
deprecated (risk R1).

**Residual.** SBPL network filters only take `*` or `localhost`, and `localhost` on the
local side matches every local address, so media-net can bind a LAN address and receive
on it, though it can never send there. The owner accepted this as a receive-only residual
on 2026-10-09, with a fail-closed audit: the worker checks media-net's sockets every
second (`proc_pidfdinfo`) and ends the source if any is bound to a non-loopback address. A
prototype of the audit ended a fault-injected source within a second. The real media-net
passed the relay check under the profile. XPC services (option 3) were not tested.

## MG5: entitlements for the bundled Node.js

| Component | Entitlements                                                     |
| --------- | ---------------------------------------------------------------- |
| Server    | `allow-jit` only (without any, V8 cannot reserve its code range) |
| Relay     | none, on its own Node.js copy run with `--jitless`               |
| Worker    | none, once GStreamer is signed with the team ID                  |

- The relay ran under Node's `--permission` and its own SBPL profile (UDP only, no
  `mach-lookup`, no fork or exec, reads limited to the system and Node.js). Node.js needs
  its working directory to be `/` there, because it calls `getcwd` at start-up. The full
  sandboxed stack connected with no loss. Video load on a jitless relay is not measured.
- The server does not start on macOS yet: it looks for the Windows worker at start-up
  (phases 1 and 2).
- Re-checked with Developer ID under MG8: library validation accepts team-signed GStreamer
  with no exception, notarization accepts these entitlements, the launcher works in a
  notarized app, and grants survive an update.

## MG6: macOS 27 privacy

- **Remote Desktop category.** It exists in TCC with Screen Recording's prompt text, but
  only `replayd` uses it, next to the persistent-content-capture entitlement check. Without
  that entitlement capture stays under Screen Recording, as observed. This is inferred
  from the system binaries; observing it needs the entitlement, which is not requested
  yet.
- **Local Network.** Connections the Mac starts toward a LAN device are blocked with
  `EHOSTUNREACH` until the owner allows the app; the router is exempt. The prompt names the
  host app, appears about 1.5 minutes after the first blocked attempt, and one approval
  covers the app's Node.js and native children. Replies to a LAN viewer that contacts the
  Mac first go through without approval. A Developer ID-signed, hardened-runtime app with
  a new bundle ID behaved the same as the ad-hoc signed ones, before and after approval.
- **Capture re-approval.** `replayd` still has a day-based re-approval policy, but the
  interval is compiled in and was not measured. It can be observed on a real install.

## MG7: Mac App Store

Not run. It needs App Store Connect and an App Review answer, and the owner postponed it
until the Developer ID app works. Q1 (no App Store edition) stands.

## MG8: signed, notarized bundle on a clean Mac

The prototype bundle (about 290 MB) held a Swift host stub, two copies of the official
Node.js 24.21 (server and relay, about 115 MB each), the worker and launcher, and only the
GStreamer it needs: 14 plugins and 29 libraries, 59 MB instead of 3.6 GB.

- **Layout.** `codesign` rejects plain folders under `Contents/Frameworks`, so the
  libraries sit flat there and the plugins in `Contents/Library/GStreamer`, with rpaths
  rewritten into the bundle.
- **Signing.** Signed inside out with Developer ID and hardened runtime, timestamped.
  Signing many files prompts for keychain access per file unless the key's partition list
  allows `codesign` (`security set-key-partition-list -S apple-tool:,apple:,codesign:`).
- **Notarization.** Accepted on the first submission with no issues, then stapled.
  `spctl` reports "accepted, source=Notarized Developer ID".
- **Clean Mac.** In a fresh macOS 27.0.1 VM with no developer tools, the zip downloaded
  with Safari carried the quarantine flag, Gatekeeper let it open, and the self-check
  passed three times from App Translocation paths: the server's JIT and WebAssembly, the
  sandboxed relay, the worker with the bundled GStreamer and hardware H.264 and HEVC, and
  the sandboxed media-net. Privacy stayed denied, attributed to the app.
- **Updates keep grants.** A notarized 0.0.2 with the same bundle ID and team replaced
  0.0.1 in place, and Screen Recording and Accessibility were still granted, with posted
  input landing on target. An ad-hoc signed rebuild had lost the Accessibility grant in
  MG3.
- Not recorded: the exact wording of the first-launch Gatekeeper dialog.
