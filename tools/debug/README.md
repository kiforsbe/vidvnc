# Debug launching

`targets.json` inventories the targets; Visual Studio consumes the Windows host's
`Properties/launchSettings.json`. Other native apps remain scaffolds.

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

| Process | Windows debugger | macOS debugger |
| --- | --- | --- |
| Native host/viewer | Visual Studio managed/native as appropriate | Xcode/LLDB |
| Node server | Node inspector, loopback only, explicit opt-in | Same |
| Native media worker/libraries | Visual Studio C++ | Xcode/LLDB |

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
