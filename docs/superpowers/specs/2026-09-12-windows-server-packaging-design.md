# Windows server distribution and debugging design

Date: 2026-09-12. Scope approved in conversation: Windows native host+server
installer and Windows CLI server bundle; current-user installation by default.
The packaging/debug scaffolding was committed first as `d508077`. Revised
2026-09-15 by the user: MSIX replaces Inno Setup, signed with a self-signed
development certificate for now.

## Deliverables and boundaries

1. `windows-server`: MSIX package (installed per user) containing the WinUI host
   and the Windows server payload.
2. `windows-cli`: portable ZIP containing the same server payload plus a console
   launcher, without WinUI/.NET host files.
3. Development Debug/Release launch support for the Windows host and worker,
   including separate attachment to Node and native child processes.

Windows 11 25H2/build 26200+, x64, NVIDIA H.264 hardware encoding remain required.
No native clients, macOS implementation, unattended Windows service, login startup,
codec changes, remote hub or authentication redesign in this slice.

**Dependency policy (revised 2026-09-15 by the user; supersedes "self-contained").**
Packages include what is built or prepared specifically for the project: server and
web-client files, the native worker, allowlisted GStreamer plugins with their SDK
dependencies, and whatever the native app packager requires inside the installer.
Packaging never copies DLLs or other files from outside the project (Visual Studio
redist folders, System32, global installs). General-purpose runtimes are declared
prerequisites the user installs: Microsoft Visual C++ Redistributable (x64) and
Node.js for both products, plus .NET 10 Runtime and Windows App Runtime for the host.
A packaging option adds pinned, hash-verified runtime installers beside the package.
The host package may optionally bundle Node.js as plain files used only by the native
host (not an installer); it then no longer declares Node.js. The OS and NVIDIA driver
remain prerequisites. Where later sections say "self-contained", read this policy.

## Approach selection

Package the framework-dependent WinUI host as MSIX, and ship a portable CLI ZIP. Both
products consume the same staged server payload. The host build is unpackaged
(`WindowsPackageType=None`, bootstrapper initialisation that is a no-op under package
identity), so the same binaries run from a development folder and inside the MSIX.
The MSIX is assembled from a hand-written manifest template with the Windows SDK
`makeappx`/`signtool` restored through NuGet, not a Visual Studio packaging project.
Nothing downloads runtimes on the user's machine at install time.

Development builds are signed with a self-signed certificate created locally by
`npm run package:prepare` (files in `.deps/signing` only; no certificate store is
changed) and labelled `selfsigned`. Its subject is the manifest publisher, so a later
real certificate changes the package identity: development installs must be
uninstalled before installing a release build. MSIX installs per user without
elevation; trusting the development certificate once per PC needs an administrator.

## Package layout and runtime contract

```text
<package root>/
  runtime.json
  runtime/node/node.exe              optional Node.js bundle, host package only
  runtime/media/bin/media-worker.exe
  runtime/media/bin/<project SDK DLLs; never VC++ runtime DLLs>
  runtime/media/lib/gstreamer-1.0/<allowed plugins>
  runtime/media/libexec/gstreamer-1.0/<plugin scanner if required; not shipped now>
  app/node_modules/@vidvnc/server/<production files>
  app/node_modules/@vidvnc/web-client/<production files>
  app/node_modules/@vidvnc/media-worker/<runtime adapter>
  notices/<third-party notices and license texts>
  prerequisites/<runtime installers>  CLI ZIP only, with the include-installers option
  files.json                         file hashes, components, declared prerequisites
  VidVNC.Server.cmd                  CLI only
  VidVnc.Host.exe and host files     full host product only
  AppxManifest.xml, Assets/          full host product only (MSIX)
```

The host product writes the development certificate and a script that trusts or
removes it (`VidVNC-Development-Certificate.ps1`, from
`packaging/windows/development-certificate.ps1`) beside the MSIX. With the
include-installers option it also writes a separate ZIP holding the MSIX, the
certificate, the script, `prerequisites/` and `INSTALL.txt`, so the installers are not
installed into the application folder.

The exact case of host executable names follows MSBuild output. All generated
manifests use the emitted filename rather than assuming another spelling.

`runtime.json` is versioned and records mode (`packaged` or `development`), build
configuration, architecture and explicit locations for server entry point, worker,
media DLL directory, plugin directory, optional scanner and optional Node. An absent
`node` means the launcher runs the installed Node.js prerequisite. Packaged paths
must be relative to its own directory, resolve inside that directory, and exist.
Unknown schema versions, invalid architecture/configuration and missing files fail
with actionable messages. Do not search parent directories for a source checkout.

Both the C# host and JS worker adapter implement this same contract, with shared
test fixtures exercising valid, missing, escaping and non-ASCII/space-containing
paths. An explicit development manifest may reference absolute tool/build paths;
packaged manifests may not. Packaged launches do not honor developer executable/SDK
overrides. Both resolvers accept a packaged manifest without `node`. The manifest also
lists declared prerequisites (name, minimum version, download) so the host can name
what to install.

The host uses the existing `--desktop` process protocol with its bundled Node when the
package includes one, otherwise the first `node.exe` on fully-qualified PATH entries
that meets the declared minimum. Before starting the server it checks the declared
VC++ runtime minimum and shows what is missing in its window. The CLI launcher
finds `node.exe` on PATH only (never the current directory), checks the declared
Node.js and VC++ runtime minimums and prints what to install (or the bundled
installer to run), clears `NODE_OPTIONS`, quotes paths safely, passes arguments
without string evaluation and propagates the server exit code. It does not require
PowerShell execution-policy changes or run npm/formatting at startup.

Worker launches explicitly isolate GStreamer plugin discovery from global SDKs,
set the bundled plugin/scanner paths, and keep the plugin registry cache in the
user-data area with a versioned name. Clear inherited GStreamer discovery overrides
in packaged mode. Keep required Windows system DLL discovery intact.

## Runtime payload assembly

Use explicit build inputs (`packaging/windows/inputs.json`): target, version,
configuration, the project GStreamer SDK in `.deps/gstreamer`, declared prerequisites
and optional runtime installers. Pin and record the SDK version/hash and each
installer's URL/hash; verify downloads before use. Network acquisition is an explicit
dependency-preparation step (`npm run package:prepare`), not an implicit build/start
behavior.

Copy actual production package files, not workspace symlinks pointing back to the
checkout. Exclude tests, formatters, SDK headers/import libraries, development tools,
source maps containing private paths and debug-only inspector options from Release.

Start with an explicit GStreamer plugin allowlist for DXGI/D3D11, NVIDIA encoding,
H.264 parsing/RTP, WebRTC/ICE/DTLS/SRTP/SCTP, WASAPI, audio conversion/resampling,
Opus and core elements. Resolve ordinary and delay-loaded PE dependencies
recursively from approved input directories, and separately account for plugins,
scanner helpers and runtime-loaded libraries. Missing or ambiguous dependencies
must fail assembly, not silently fall back to installed SDK files.

Do not copy every SDK plugin: the installed development SDK contains unrelated
codecs/plugins with different licensing obligations. Record each shipped component's
origin, version and license; include relevant license/notice material. A generated
inventory/SBOM and file hashes support review but are not themselves a legal approval.
Public release remains gated on redistribution/license compliance review.

Dependency resolution searches only project directories. Visual C++ runtime DLLs
are reported against the declared redistributable prerequisite and never bundled;
an undeclared runtime DLL fails assembly. The build also fails if the worker's MSVC
toolset is newer than the declared runtime minimum. The worker preflight checks the
elements webrtcbin creates internally, so a plugin allowlist gap fails at startup.
The plugin scanner is not shipped; packaged workers scan in-process
(`GST_REGISTRY_FORK=no`).

Publish the host framework-dependent: .NET 10 Runtime (the host needs only
Microsoft.NETCore.App) and Windows App Runtime 2.2 are declared prerequisites, with
optional bundled installers. Reference only the Windows App SDK component packages the
host uses. The build fails if the publish carries the Windows App Runtime or a bundled
.NET, lacks the host's `.pri` resource index, or contains a file it cannot attribute
to the project or a NuGet package; package licences come from each `.nuspec`. The
MSIX adds only its manifest, logos and the package dependency on the Windows App
Runtime framework package, whose identity is read from the restored SDK.

Stage under `out/packages/<target>/<configuration>/`, and emit versioned ZIP/installer
artifacts under `out/installers/<target>/<version>/`. Validate resolved output paths
before cleaning a staging tree; never recursively delete a caller-supplied arbitrary
directory. Reject missing inputs before replacing a previous successful artifact.

## Installer and lifecycle

Windows' package deployment provides the Start-menu entry, the Settings uninstall
entry, the minimum OS check (`MinVersion` 10.0.26200.0) and the Windows App Runtime
dependency check. The manifest declares `runFullTrust` and no startup task, service,
extension or PATH change. The installed files live in the versioned, read-only
`WindowsApps` folder managed by Windows.

Mutable logs/cache/settings remain under `%LOCALAPPDATA%/VidVNC`, outside the signed
application payload. The manifest disables file-system write virtualization
(`desktop6:FileSystemWriteVirtualization` with the `unvirtualizedResources`
capability), so the app shares that folder with the CLI server and Windows keeps it
when the package is uninstalled. Do not invent persisted passwords: the existing
session password remains generated at run.

Upgrade/uninstall must not replace running files silently; MSIX deployment handles
files in use. Never terminate all Node processes or other VidVNC copies by
executable name. The normal host stop path asks its server to
shut down, waits with a bounded timeout, then terminates only its owned process tree.
Host-close and debugger-stop tests must check for orphan workers and released input.
If forced owner termination bypasses graceful shutdown, use a Windows ownership
mechanism with kill-on-owner-exit semantics rather than relying only on UI callbacks.

The portable CLI bundle is removed by deleting its extracted files after stopping
it; it does not register an uninstaller or alter system PATH.

Firewall permission is a separate consent boundary. Installation/building does not
disable the firewall or silently add global rules. Show the need for Private/LAN
permission for the bundled Node listener and worker. Any optional rule-creation step
requires explicit consent/elevation, limits scope to the exact executables, Private
profile and LocalSubnet, and records only its own rules for later removal. Initial
packaging can use the Windows permission prompt without claiming automatic setup.
Executables inside the MSIX (the worker, a bundled Node.js) have the package version
in their path, so the Windows prompt can reappear after each upgrade.

## Debugging

Add named CMake Debug build/test presets alongside existing Release presets. Debug
worker builds emit symbols; their runtime DLL ABI must match the distributed SDK.
Select the worker configuration explicitly; missing Debug output is an error, not
permission to use the Release binary.

Use a generated development runtime manifest with explicit Node/SDK/worker paths.
Commit shared Visual Studio project launch settings, not private absolute paths.
F5 launches the native host under the debugger; it does not automatically attach to
Node or the worker. Document attachment to the worker using Visual Studio C++ and
optional loopback-only Node inspector attachment. Wait-for-debugger is opt-in and
must not be enabled in distributed Release manifests or shortcuts.

Provide a repeatable development preparation command that builds matching host and
worker configurations and generates the development manifest before host launch.
Keep installation permissions separate from development debugging permissions.

## Test ownership and acceptance

- Runtime contract fixtures/tests live with the owning modules. Shared packaging
  staging/manifest/dependency tests live under `packaging/tests`.
- Windows installer/portable runtime checks live under `packaging/windows/tests`.
- Host/server/worker shutdown and real-stream checks remain under `tests/system`.
- Existing 33 portable tests, seven hardware/lifecycle tests, CTest suites and
  toolbar behavior must remain passing after integration changes.
- Verify CLI and host staging from a directory outside the checkout, including
  spaces/non-ASCII characters and an unrelated current working directory.
- Verify bundled plugin discovery with developer SDK/environment paths absent and
  a fresh GStreamer registry cache; test real video, Opus and input on approved hardware.
- Verify Debug host launch and breakpoints/attachment in the native worker, with no
  Release fallback and no orphan processes after stopping the session.
- Test install/upgrade/uninstall in a clean disposable Windows environment with only
  the declared prerequisites installed, and the missing-prerequisite messages without them. Never uninstall the user's system runtimes
  merely to simulate a clean machine. Report any unperformed clean-machine/device
  acceptance gates explicitly rather than claiming release readiness.

Unsigned (CLI ZIP) and self-signed (MSIX) development artifacts may be produced and
must be labeled as such; the self-signed development certificate was approved by the
user on 2026-09-15. Signed release builds require externally supplied signing
credentials, verified signatures and timestamping; never present the development
certificate as a release signature or silently downgrade signing failures. Actual
publication is not authorized by this implementation task.

## Implementation order

1. Runtime manifest resolution and module-owned tests; preserve existing development
   behavior through an explicit development mode during the transition.
2. Debug configuration propagation, host launch preparation and lifecycle checks.
3. Shared Windows server payload assembly, dependency/license inventory and CLI ZIP.
4. Framework-dependent host publishing and the self-signed MSIX consuming it.
5. Relocation, clean-machine and device acceptance evidence; signing remains an
   external-credential gate when credentials are unavailable.

## Primary references

- [Create an MSIX package manually with MakeAppx](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
- [Create a certificate for package signing](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing)
- [Windows App SDK framework-dependent deployment](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/deploy-packaged-apps)
- [Unpackaged WinUI distribution](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/unpackage-winui-app)
