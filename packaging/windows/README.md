# Windows packaging ownership

Targets: `windows-server`, `windows-client`, `windows-cli` in `../targets.json`.
Status: `build.mjs` builds `windows-cli` (unsigned development ZIPs) and `windows-server`
(MSIX signed with the self-signed development certificate from `prepare.mjs`), with
inputs in `inputs.json`. The MSIX manifest template is `msix/AppxManifest.xml`. Hardware
checks: `tests/cli-bundle-check.mjs` and `tests/server-package-check.mjs`. No
`windows-client` recipe yet.

Reuse MSBuild output for WinUI applications and CMake output for the media worker.
Keep Debug symbols separate from Release distribution content.

This layer owns executable-path-specific Private/LAN firewall onboarding, install
locations, process shutdown, upgrade/uninstall policy and Windows signing. None of
those machine settings should be changed by merely building a package.

CLI bundles use a launcher that checks the declared Node.js and Visual C++ runtime
prerequisites, then runs the installed Node.js with the bundled native libraries.
Host packages add the WinUI management UI to the same server payload; the host checks
the same prerequisites and uses a bundled Node.js when the package has one. Client-only
packages exclude the Node server and desktop capture worker.
