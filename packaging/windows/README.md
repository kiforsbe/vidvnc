# Windows packaging

`npm run package` builds the unsigned host MSI and CLI ZIP, each with Node.js bundled.
`package:app` and `package:cli` build them individually. `package:msix` explicitly builds
an unsigned MSIX outside those defaults. No optional Node or runtime-installer variants
remain. The native viewer (`windows-client` in `../targets.json`) is still planned.

The submodule pins the published non-beta
[winbuildtools v0.5.0 release](https://github.com/kiforsbe/winbuildtools/releases/tag/v0.5.0).
It owns MSI/MSIX packing/inspection, native diagnostics and final metadata. Published
VidVNC v0.12.2 remains on its original tag and artifacts. The
[correction design](../../docs/superpowers/specs/2026-10-24-msi-wizard-corrections.md)
records the installed feedback; the
[launch-default release design](../../docs/superpowers/specs/2026-10-25-msi-launch-default-release.md)
records the subsequent default and release requirements.

Ordinary published checkouts initialize with `git submodule update --init --recursive`.
PowerShell 7.4+ (`pwsh`) is required; optional MSIX additionally needs Windows SDK
10.0.26100.0+ MakeAppx. The tooling update has no added package dependency, license change,
platform binary redistribution, signing action or install-time executable custom action.
Builds never download tooling, create keys, sign or import certificate trust.
`prepare.mjs` downloads only the pinned Node archive and verifies its SHA-256.

VidVNC owns the approved payload, required files, PE dependency allowlists, notices,
prerequisites, branding and product identity. `build.mjs` builds Release CMake/WinUI
outputs, then stages runtime.json, files.json, server/viewer assets, worker/media
libraries and Node.js. `build-tools.mjs` exchanges JSON with `build-tools.ps1`, which
delegates shared mechanisms. ZIP creation uses Windows tar through the shared runner.
The WinUI publish keeps its current obj/resource layout through that runner; the shared
locked .NET helper needs a separately validated lock/artifacts-layout migration.

## MSI identity and installation

`msi.json` is a product-owned schema-v2 template with a permanent identity namespace,
required files and minimum OS build 26200 (Windows 11 25H2). `msi.mjs` resolves literal
upgrade/product/component GUIDs and the complete approved file list before passing it
to the shared packer. The namespace, normalization and GUID byte ordering reproduce
the old v1 engine's identities. New install and Start-menu folders are named `VidVNC`,
without an architecture suffix. Previously installed development MSIs can retain their
remembered destination during maintenance/upgrades; uninstall the old test build first
to apply the new default path. Keep permanent identities stable after release.

One MSI offers the native **Just me / All users** scope chooser in full UI. Just me is
the default: files go under LOCALAPPDATA/Programs/VidVNC, with a shortcut in the
current user's Start menu. All users uses Program Files/VidVNC and the shared
Start menu and requires administrator approval. The host always runs as its launching
user, with that user's settings; All users makes the application available to other
users, without starting sharing in their sessions. Node.js is private to the product,
not installed on PATH. Visual C++, .NET and Windows App Runtime remain prerequisites;
CLI needs VC++.

The chooser runs before related-product discovery and costing and is skipped during
maintenance. Choose the existing scope for upgrades. Switching scope requires explicit
uninstall first: Just me does not migrate/remove an All users registration. Basic,
reduced and silent deployment use standard explicit context properties instead of the
full-UI chooser:

```powershell
# Just me (also the default for an unattended fresh install):
msiexec.exe /i VidVNC.msi /qn ALLUSERS=2 MSIINSTALLPERUSER=1 /norestart
# All users, from an appropriately elevated deployment:
msiexec.exe /i VidVNC.msi /qn ALLUSERS=2 MSIINSTALLPERUSER="" /norestart
```

Upgrades replace older MSI versions and reject downgrades. Uninstall removes owned
files/shortcuts, preserving settings in LOCALAPPDATA/VidVNC. Graceful Restart Manager
servicing requests shutdown without forced termination or automatic relaunch. The host
consents to WM_QUERYENDSESSION without stopping, remains usable after cancellation,
and synchronously requests server cleanup on committed WM_ENDSESSION, including tray
mode. The existing job object remains the child-process cleanup backstop.

Older MSIX installations are not migrated automatically: uninstall them before installing
the MSI to avoid duplicate applications. Installer UI/UAC in both scopes, ICE/ICE105 validation, actual repair,
upgrade and uninstall must still pass on a disposable Windows host before shipping.
Byte/table inspection and relocated execution do not establish installed lifecycle.

## Native setup and maintenance

The shared engine provides its native Windows Installer welcome/destination/Ready wizard,
upgrade confirmation, progress and completion/error pages. Repair/Remove is offered
for an installed product. VidVNC does not opt into destination editing or a license
agreement page. Scope selection is enabled through the shared schema-v2 chooser. Full UI supports interactive cancellation; reduced /qr progress has
Cancel disabled, so use /qb or /qf for interactive cancellation.

New MSIs include ARP location/icon and Start-shortcut native uninstall metadata.
The owner reproduced missing Start right-click Uninstall despite this metadata being
present. It appeared after reinstalling, unpinning and restarting Explorer, with a delay
after the restart; both the owner and the read-only installed checker confirmed it.
The exact cause and which steps were necessary remain unproven.
The engine also
owns an InstallLocation registry value under the installation context's
Software/winbuildtools/Installations/{UpgradeCode}, tied to the executable component.
It remembers the destination for subsequent same-context upgrades. Packages built with
older tools lack this record and need their known INSTALLFOLDER explicitly when
upgrading a non-default installation. This is unrelated to VidVNC user settings.

Shared inspection checks the exact three declarative type-51 property setters,
registration rows and secured UI-to-server properties; no executable/script custom
actions are permitted. Preflight randomizes its synthetic product identities and
registry paths and disables Restart Manager before costing. Building/inspecting does
not create those installation records on the build machine.

## Optional wizard configuration

VidVNC uses compact headers with the canonical app logo's 256-pixel frame selected
first in the embedded wizard resource. The installed ICO remains unchanged. Destination
editing/Browse and completion Details are disabled. Fixed-folder setup skips the duplicate
Options page and shows the read-only destination on the final Install review. Progress
appears immediately after consent, before native discovery/costing, and is retained
across later confirmation/error dialogs. Failure/cancellation retain log information.
After successful full-UI install/update, an initially checked Launch VidVNC checkbox
launches the installed host when left selected and the user clicks Finish.
Clear the checkbox to finish without opening the app.
It is absent for repair/removal, basic/reduced/silent UI and a transaction that replaced
files in use. A pre-existing machine-wide pending reboot neither overrides normal success
nor suppresses Run. Genuine transaction restart state displays a direct restart-required
message; the engine does not infer the result by parsing logs. Its bounded action policy
excludes general reboot actions and executable custom actions.
Actual identity/privileges after elevated setup remain unvalidated; no unelevated-launch
guarantee is made. External links and the agreement page remain disabled.

The [selected design](../../docs/superpowers/specs/2026-10-24-winbuildtools-selected-presentation.md)
records the owner's choices and supersedes the earlier
[presentation proposal](../../docs/superpowers/specs/2026-10-24-winbuildtools-presentation-design.md).

The [upstream contract](../../external/winbuildtools/msi/README.md#native-setup-and-maintenance)
owns exact fields, defaults and image/URL limits. Additional Start-menu shortcuts,
AppUserModelID and agreement text remain available but are not selected.


## Outputs and verification

Staging stays under `out/packages/<target>/Release`; distributables under
`out/installers/<target>/<version>`. Fresh per-run work, shared inspection output and
failure diagnostics stay under ignored `out/packaging/windows`. Each distributable has
a JSON sidecar measuring final bytes/signature state, commit and dirty state, including
submodule changes. Sidecars are not signed attestations. Default reporting excludes
any separately built MSIX.

The MSIX template is `msix/AppxManifest.xml`. Generate its resolved manifest outside
the payload; the shared packer compares manifest semantics, identity and payload bytes.
It remains unsigned: proper signing and direct installation are future work.

Portable command/launcher and adapter tests live in `../tests/windows-package.test.mjs`;
`../tests/msi.test.mjs` checks scope defaults and stable compatibility GUIDs.
`pwsh -File packaging/windows/tests/msi-package-check.ps1` reads the produced MSI and
independently checks scope properties, both radio options/events, least-privilege
metadata and every component's legacy identity. `-PreviousArtifact <old.msi>` also
compares the previous actual package's upgrade family and surviving components.
It does not install or elevate. Shared packaging inspection additionally costs fresh
synthetic copies in both contexts before comparing cabinet bytes.
`tests/cli-bundle-check.mjs` runs the relocated ZIP without PATH Node on real GPU
hardware. After `package:msix`, `tests/server-package-check.mjs` verifies against the
current staged host payload and independently generated manifest, then runs the host
and tests shutdown. Rebuild the matching MSIX before that check if staging changed.
The optional `--register` test modifies the machine and requires explicit consent.

Executable-specific Private/LAN firewall onboarding remains in the app, not the MSI.
It covers HTTP and HTTPS regardless of port. Building or inspecting does not change
firewall settings, install products or mutate trust.

`development-certificate.ps1 uninstall -Thumbprint <reviewed-thumbprint>` is solely
legacy trust removal, including expired certificates. It never imports trust or removes
private signing keys. No certificate helper or CER is included in new outputs.
