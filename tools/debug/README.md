# Debug launching

`targets.json` inventories the targets; Visual Studio consumes the Windows host's
`Properties/launchSettings.json`, and Xcode the macOS host's shared `VidVNC` scheme. The
native viewers remain scaffolds.

## Windows host and worker

Run `npm.cmd run prepare:host -- Debug` from the repository. This builds and tests
the Debug worker, builds the Debug WinUI host, and writes a validated `runtime.json`
beside the host output. Use `Release` explicitly for matching Release outputs.
Missing Debug binaries fail preparation rather than selecting Release.

Open `apps/windows-host/VidVnc.Host.csproj` in Visual Studio, select the matching
configuration and the **VidVNC Host** launch profile, then press F5. Run preparation
again after moving the checkout or changing tool/SDK locations. Generated manifests
contain local absolute paths and remain in ignored build output.

The **VidVNC Host + Node inspector** profile opts into `127.0.0.1:9229`; attach a Node
debugger separately. The native worker needs a separate Visual Studio C++ attachment
to its `media-worker.exe` process after connecting a browser. Debug PDBs are emitted
alongside the worker. F5 does not automatically attach to these child processes.

The host uses a Windows kill-on-close job for its server tree. Startup approval is
sent only after job assignment. Graceful stop still uses the desktop stdin protocol;
forced host/debugger termination closes the job and terminates owned descendants.
No firewall rules are created by preparation or launch tooling.

Verified locally: Debug host/worker builds, worker symbols, both CTest cases,
host startup from an unrelated CWD, loopback HTTP readiness, forced-owner cleanup,
and the existing hardware/lifecycle suite. Interactive F5 breakpoint attachment and
clean-machine deployment acceptance have not been performed.

## macOS host and worker

Run `npm run prepare:host -- Debug`. This builds and tests the Debug worker
(`build-native.sh`), builds the app with `xcodebuild` into `out/macos-host/DerivedData`, and
writes a validated `os: macos` manifest to `out/macos-host/Debug/runtime.json`, the path the
`VidVNC` scheme's Run action gives the app in `VIDVNC_RUNTIME_MANIFEST`. Then open
`apps/macos-host/VidVNC.xcodeproj` and run the `VidVNC` scheme under LLDB, or run
`npm run start:host -- Debug`, which opens the app through Launch Services so that macOS
treats VidVNC, not Terminal, as the app asking for permissions.

The scheme's disabled `VIDVNC_INSPECT` variable opts into the Node inspector on
`127.0.0.1:9229`. Attach to the `media-worker` process from Xcode (Debug, Attach to
Process) after a viewer connects. Set `VIDVNC_SIGN_IDENTITY` (for example
`Developer ID Application`) so rebuilds keep their privacy grants; the team is read from the
matching keychain identity unless `VIDVNC_DEVELOPMENT_TEAM` is set. Without it the app is
signed ad hoc ([apps/macos-host](../../apps/macos-host/README.md#run-it)).

The macOS host has no job object: it spawns the server with `posix_spawn` in its own process
group and is the only holder of its owner pipe.
[process-tree.mjs](../../apps/macos-host/tests/process-tree.mjs) kills the host with
`SIGKILL` and checks that no server process survives, with the stand-in server or
(`--real`) the real one and its relay; both pass on macOS 27.

| Process                       | Windows debugger                               | macOS debugger |
| ----------------------------- | ---------------------------------------------- | -------------- |
| Native host/viewer            | Visual Studio managed/native as appropriate    | Xcode/LLDB     |
| Node server                   | Node inspector, loopback only, explicit opt-in | Same           |
| Native media worker/libraries | Visual Studio C++                              | Xcode/LLDB     |

## Latency probe

[latency-probe.html](latency-probe.html) and the viewer's probe module
([latency-probe.js](../../apps/web-client/src/viewer/latency-probe.js)) measure two
latencies on a real session, on the stream the viewer is showing:

- **Hand-to-glass**: the viewer sends input, the probe page changes a patch, and the
  viewer times it from sending to the first decoded frame that shows the change
  (`requestVideoFrameCallback`'s `expectedDisplayTime`), on its own clock. Pointer moves
  (between the page's left and right halves) and key presses (L) are timed separately,
  because they will travel differently.
- **Glass-to-glass**: the page draws a barcode of the host's clock every frame, and the viewer
  compares it with its own clock as each frame is shown. This is exact only when the viewer runs
  on the host itself; on another device it includes the difference between the two clocks.

A measurement is started from the host, never from the viewer:

1. On the host, open `tools/debug/latency-probe.html` in a browser on the shared display
   and click **Full screen**. The layout is in fractions of the screen, so the page must
   fill it.
2. On the viewer, turn on keyboard & mouse, and keep your hands off the screen.
3. On the host, open Diagnostics (the host's Diagnostics action, or `diagnostics open` in the
   CLI), pick the viewer's stream, and click **Measure latency** in the **Latency** section.

The viewer learns of the request in the reply to its next stream-telemetry post (every 2
seconds), loads the probe module, which a normal session never fetches and the server serves
only while that session has a measurement, and shows "Measuring latency for the host. Keep
your hands off the screen." with **Cancel**. It then runs 40 moves and 40 key presses with
random pauses of 150 to 400 ms, and posts the results. Diagnostics shows the median, p95,
range and count of each, the glass-to-glass figures, the receiver's decode rate,
jitter-buffer delay, decode time, round trip and losses over the run, and the run's own
overhead: the time each frame read took, and the frames the probe missed. The last five runs
are listed with **Copy as JSON**. The viewer shows no results.

A measurement fails, with the reason shown in Diagnostics, when the viewer doesn't hold
keyboard and mouse control, can't read the probe page within 2 seconds, has no
`requestVideoFrameCallback`, isn't showing that stream, loses control or switches stream
during the run, or is cancelled. One that no viewer picks up within 15 seconds, or that
sends no result within 120 seconds, expires. The viewer starts no new trial after 100 seconds and
reports what it has, and it stops before sending anything if the server has already ended the
measurement. One measurement runs at a time.

The probe sends input only while the device holds control, through the normal input path and
its checks, and stops if the first key press doesn't flip the patch, or if the probe page
leaves the screen for 2 seconds during the run, so it doesn't keep typing into another window. Frames are read only during a run, on a GPU-backed canvas, so only
a 128 × 72 scaled copy is read back. Hand-to-glass includes the probe page's own
input-to-paint time, as any app would, but not the viewer's mouse or display hardware.
**To last packet** is the same timing up to the arrival of the frame's last packet (Chrome
only), so the rest is the viewer's jitter buffer, decode and render.

Verified: the page's barcode decodes back to its own clock in a browser, and the shared
layout and encoder, the run's checks, cancel and lost control are checked by
[latency-probe.test.mjs](../../apps/web-client/tests/latency-probe.test.mjs); the request,
banner and cancel in a real browser by
[stream-browser-check.mjs](../../apps/web-client/tests/stream-browser-check.mjs). Not yet run
against a live session or on an iPhone.

## Implementation contract

- Separate Debug and Release outputs. Propagate selected configuration to the worker
  path; do not silently substitute a Release worker when Debug is requested.
- Native host F5 launches the host under its debugger. Child Node/worker processes
  require separate debugger attachment or explicitly configured child debugging;
  they do not automatically inherit the host debugger.
- Development manifests specify runtime/executable paths. Installed manifests point
  only inside the bundled payload; neither mode relies on current working directory.
- Node inspector and wait-for-debugger behavior are opt-in and loopback-only. Never
  expose a debugger through a release installer or default LAN server startup.
- Keep symbols available for native code. Missing builds/runtime inputs must produce
  actionable errors, not trigger implicit downloads or fallback configurations.
- Stop/disconnect/debugger-detach paths must release input and clean up child processes.
- Keep generated IDE/user settings and private machine paths out of version control.

Add tested shared Visual Studio launch settings and Xcode schemes with the owning
apps as they become runnable. Cross-process helper scripts belong here; their tests
belong in `tools/tests`. Full-host lifecycle scenarios remain in `tests/system`.
