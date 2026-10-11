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
