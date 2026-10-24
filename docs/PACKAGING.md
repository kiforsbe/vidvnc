# Distribution requirements

User requirements recorded 2026-09-12. These are product deliverables, not a claim
that installers exist today. Initially there are **six OS/product combinations**:

| Deliverable | Windows | macOS | Contents |
| --- | --- | --- | --- |
| Complete server/host installer | One installer | One installer | Native server-management UI, server, web client assets, native capture/encode/input worker and its project-specific libraries; general runtimes are declared prerequisites |
| Native viewer/client installer | One installer | One installer | Native viewer UI, media decoding/playback/input transport and its project-specific libraries; no server or capture worker |
| CLI server bundle | One bundle | One bundle | CLI server, web client assets, native worker and its project-specific libraries; no native management UI |

The complete server installer's UI is WinUI 3 on Windows and native Apple UI on
macOS. It must look and behave as a first-party-quality native application. Native
viewer clients have the same platform-native design requirement. The browser client
continues to be served by the server, including in CLI-only distributions.

The complete server/host deliverable is interpreted as the listed server-side
components, not an implicit requirement to include the separately distributed native
viewer. Bundling the viewer there later can be a packaging choice without changing
source ownership.

The macOS client may later become a universal binary/bundle. Keep architecture
selection in the build/package layer. Do not assume "universal" means iOS support;
the precise additional CPU/platform targets remain a future decision.

## Bundled files and prerequisites

User requirement revised 2026-09-15 (replaces the earlier "self-contained" rule):

- Packages include what is built or prepared specifically for the project: VidVNC
  code and assets, native workers, required media libraries/plugins (for example the
  allowlisted GStreamer plugins and their SDK dependencies), and whatever the native
  app packager requires inside its installer.
- Packaging never copies DLLs or other files from outside the project, such as
  Visual Studio redistributable folders, System32 or global installations.
- The encoder plugins are staged for every supported vendor, not only the one the
  build machine has: `gstnvcodec.dll` (NVENC), `gstqsv.dll` (Quick Sync),
  `gstamfcodec.dll` (AMF) and `gstmediafoundation.dll`, which together add roughly
  2 MB. Media Foundation also pulls in `gstwinrt-1.0-0.dll`. Which plugins load is a
  runtime decision on the user's PC, so a package built on an NVIDIA machine must
  still carry the Intel and AMD plugins or it will not encode there.
- Both platforms bundle Node.js as private plain files in every server product.
  Windows still requires Microsoft Visual C++ Redistributable (x64), plus .NET 10
  Runtime and Windows App Runtime for the host. No Windows package bundles prerequisite
  installers or depends on a separately installed Node.js.
- Users never install GStreamer SDKs, npm packages, compilers or development tools.
- Resolve bundled binaries/assets/libraries relative to the installed bundle, never
  a source checkout, developer PATH or global npm installation.
  Windows CLI always runs its bundled runtime/node/node.exe, without PATH lookup.
- Include required native libraries/plugins and their transitive dependencies; do
  not ship the entire development SDK as a substitute for a verified runtime bundle.
- Install/run with smart defaults and existing onboarding: connection addresses,
  access setup, and platform permission prompts. No developer-facing configuration
  steps as the normal user experience.
- Store mutable configuration/logs in platform user/application-data locations,
  separate from signed/read-only application files. Uninstall and upgrade must have
  explicit policies for preserving user settings and cleaning up processes/services.
- Packages do not include the OS or GPU driver and cannot bypass macOS
  screen-recording/accessibility permissions or Windows security prompts. Supported
  OS/hardware remains an explicit prerequisite.

## Ports and firewall

The server listens on two ports: a plaintext one for enrolment and redirect (default
`4382`, set by `VIDVNC_PORT`) and a TLS one for everything else (default `4383`,
independently configurable through TLS settings or the CLI's `tls-port` command) — see
[ARCHITECTURE.md](ARCHITECTURE.md#tls-and-trust-provisioning) for the listener and
provisioning detail. This needs no change to firewall onboarding: it is keyed to the
executable, not to a port, so the existing Private/LAN onboarding already covers both
ports the same way it covered the one plaintext port before TLS existed (verified and
documented in `packaging/windows/README.md`).

## How this fits the repository

Source modules remain independent of distribution products. The complete server
and CLI bundle reuse the **same server/runtime payload**, with the complete server
adding the native management host. Client-only packages do not pull in server-side
capture dependencies. There should not be six copied source trees or separate forks
of shared protocol logic.

Structural preparation now lives under `packaging/windows`, `packaging/macos` and
`packaging/shared`. `packaging/targets.json` records all six products and reusable
payload membership. The Windows CLI bundle (`npm run package:cli`, unsigned ZIP) and
the Windows server/host package (`npm run package:app`, unsigned MSI) have working
builders. `npm run package` builds exactly these two bundled-Node products;
`npm run package:msix` explicitly creates an unsigned MSIX outside the defaults. On macOS, `npm run package:macos` builds the VidVNC app as a DMG and the CLI
bundle as a ZIP, both with Node.js bundled, signed with the owner's Developer ID and
notarized ([packaging/macos](../packaging/macos/README.md)). The native viewers are still
definitions and ownership guides, not working installer recipes.
Stage generated payloads and installers under ignored `out/packages` and
`out/installers`, organized by product, OS, architecture and version.

Keep native build tools authoritative: MSBuild/WinUI and CMake on Windows;
Xcode/SwiftPM and native Apple build tooling on macOS. Root scripts may coordinate
these builds and assemble artifacts, but must not replace them with source duplication.

## Release acceptance gates (future implementation)

1. Clean-machine install/run with only the declared prerequisites installed and no
   developer SDKs or checkout present; check the missing-prerequisite messages too.
2. Smoke-test each of the six products and each supported architecture. Verify the
   server installer and CLI bundle use equivalent streaming/authentication behavior.
3. Verify permission onboarding, paths containing spaces/non-ASCII characters,
   startup/shutdown, disconnect cleanup, upgrades and uninstall behavior.
4. Verify relocatable CLI bundles without assuming current working directory.
5. Sign Windows deliverables and sign/notarize/staple Apple deliverables as appropriate;
   verify integrity and provenance of every bundled third-party component.
6. Inventory dependencies, include required licenses/notices and produce an SBOM.
   Review redistribution/plugin/codec licensing before choosing the final payload.
7. Confirm client-only packages contain no unintended server/capture services.

The Windows host defaults to one MSI from pinned winbuildtools v0.5.0-beta.1, offering
Just me (default) or All users in its native scope chooser. Scope changes require
uninstalling the existing copy first.
An explicitly requested unsigned MSIX remains available for preparation/inspection;
proper signing and direct installation are deferred. See
[Windows packaging](../packaging/windows/README.md) for permanent identities, servicing,
legacy MSIX transition, inspection and installed-lifecycle acceptance requirements.
