# Windows packaging: default MSI and CLI ZIP, optional unsigned MSIX

Date: 2026-10-23. Status: proposed for owner review; implementation has not started.

This proposal supersedes
[the earlier MSIX-first proposal](2026-10-23-winbuildtools-integration-design.md).
The owner requested MSI as the default host installer, a single bundled-Node CLI ZIP,
and the ability to build an unsigned MSIX explicitly. Proper MSIX signing is deferred.

## Deliverables and commands

| Command                   | Application distributables                                         |
| ------------------------- | ------------------------------------------------------------------ |
| `npm run package`         | One unsigned Windows x64 host MSI and one CLI ZIP                  |
| `npm run package:app`     | The same host MSI only                                             |
| `npm run package:cli`     | The same CLI ZIP only                                              |
| `npm run package:msix`    | An unsigned Windows x64 host MSIX, explicitly requested            |
| `npm run package:prepare` | Hash-verified package inputs, without credentials or trust changes |

Proposed filenames are `VidVNC-<version>-windows-x64-unsigned.msi`,
`VidVNC-Server-<version>-windows-x64-unsigned.zip`, and
`VidVNC-<version>-windows-x64-unsigned.msix`. Keep the current target/version output
directories; MSI and optional MSIX belong to `windows-server`. Diagnostic reports and
artifact metadata are supporting files, not additional package variants.

Every format bundles the same pinned Windows Node.js executable and its license.
Remove the Node-optional and prerequisite-installer variants and their flags. There
is no host wrapper ZIP. No signing key, CER or certificate trust is needed to build
any format. The unsigned MSIX is a packaging/inspection output; ordinary direct MSIX
installation still needs suitable signing/trust. Documentation must distinguish these.

## Scope and approaches

Use the requested published winbuildtools repository and ProcSight's integration
pattern. Delegate applicable mechanisms through a thin adapter while retaining product
payload and policy in VidVNC. This is the recommended approach for approval.

A packer-only replacement retains duplicated SDK discovery, diagnostics and final
artifact measurement. Rewriting the entire product build adds unnecessary risk to
working native/resource staging. Neither alternative fits as well as the thin adapter.

macOS packaging stays unchanged. No viewer installer, new architecture, version bump,
release, tag or push is included. Production signing and installed MSIX validation
remain future work. Implementation changes remain in the working tree for review.

## Source integration and dependency review

Add `external/winbuildtools` as a Git submodule with URL
`https://github.com/kiforsbe/winbuildtools.git`. Proposed pin:
`9949d5cd95f426611ec137522d1ee76b4889677c`, matching ProcSight and live origin HEAD
checked on 2026-10-23. The newest listed stable tag, v0.3.0, resolves to
`9a3bf8cf1d79d05946abbd020fe57ccec3d0ceb5`. The proposed pin deliberately includes
two published post-tag commits for consumer-owned MSI identity/scope support and its
verification record. Review that delta before pinning; do not call it a tagged release.

Upstream is MIT licensed and introduces no npm, NuGet or PowerShell module packages,
binary tool redistribution or package transitive dependency tree. Record its license,
provenance and installed-platform boundaries in LICENSING and contributor docs.
PowerShell 7.4+ is required by the tools; optional MSIX additionally needs Windows SDK
10.0.26100.0+ MakeAppx. These are API floors, not latest-version assertions. MSI uses
Windows-provided Installer Automation, MakeCab and Expand and must not need MakeAppx,
SignTool or a signing certificate merely to package an already prepared payload.

For any selected/changed application dependency, check live authoritative registries,
upstream guidance, deprecation/replacement information, known advisories and actual
license/redistribution terms, including transitives. In particular review the bundled
Node.js pin and its included third-party notices against current supported stable
releases and security guidance. Record any compatibility exceptions explicitly. No
advisory scan alone supports a claim of complete security.

Submodule initialization is an explicit checkout step, never a build download or
sibling-folder fallback. Missing/incomplete tooling fails early with
`git submodule update --init --recursive`. Update relevant CI checkout and formatting
traversal for the submodule without starting hosted workflows.

## Product payload and shared mechanisms

Keep Node entry points as coordinators, with a small PowerShell adapter invoked through
argument arrays or a structured request file. Use shared `Invoke-WbtTool` for native
tool diagnostics, `msi/package.ps1` for MSI authoring/inspection,
`msix/package.ps1` for optional MSIX packing/inspection, and
`common/write-artifact-manifest.ps1` for final artifact hash/signature metadata.
Use shared SDK discovery only for operations requiring SDK tools. Remove local
MakeAppx/SignTool discovery, direct signing and duplicated final hash measurement.
ZIP creation stays local because upstream has no ZIP authoring API.

VidVNC retains CMake/WinUI build settings, PE dependency allowlists, prerequisite and
license policy, branding, required-file checks, runtime.json and files.json. Preserve
WinUI resource-index output and framework-dependent publishing. Retain current .NET
publish layout through the shared native runner: the generic .NET helper requires
committed locks and demonstrated artifacts-layout compatibility that this host does
not currently have. Document that exception instead of coupling this migration to an
unrelated NuGet/build-layout rewrite.

Both launchers use `runtime/node/node.exe`; the CLI must never select PATH Node.js.
Preserve argument forwarding, NODE_OPTIONS clearing and runtime-manifest setup. A
missing bundled Node is a damaged-package error. Remove Node.js from installed
prerequisites. Keep Visual C++ for both products, and .NET/Windows App Runtime for the
host, with official installation links. Neither MSI nor ZIP installs those runtimes.
Remove obsolete prerequisite-installer downloads where no remaining consumer needs
them. Include Node.js licenses/notices and provenance in both product inventories.

Prepare a shared host payload for MSI/MSIX that contains no AppxManifest.xml or MSIX
container metadata. Generate the authoritative MSIX manifest separately, preserving
the existing product identity, capabilities, dependencies and OS requirement. Optional
MSIX inspection compares that manifest and approved payload against unpacked bytes.
Do not build expected content from the resulting package.

Use fresh per-run intermediate and packer output directories outside payloads, preserve
failure diagnostics, and publish only after successful inspection. Sidecars describe
final filenames/bytes, preserve upstream metadata fields, and add product fields without
rehashing. Capture source dirty state with `--ignore-submodules=none`. Remove only known
obsolete variant filenames for the current version after successful replacement;
preserve other versions, unrelated files and an explicitly built unsigned MSIX.
Default output reporting lists only the MSI and ZIP actually built by that run.

## MSI product and servicing policy

Use upstream schema v2 with application-owned permanent identities and an exact
approved file list. Proposed policy: one per-user installation, with no install-scope
choice, and a VidVNC Start-menu shortcut. Per-user installation matches the host's
existing user-session operation and avoids an unnecessary administrator requirement.
This is a proposed design choice, not an existing owner requirement. Keep user settings
in the existing LOCALAPPDATA VidVNC location, outside installer-owned files.

Generate one new permanent upgrade GUID for VidVNC Windows x64 and commit it. Derive
stable component GUIDs from that namespace and normalized relative paths, and distinct
ProductCodes per application version. Do not reuse upstream example GUIDs. Set the
minimum Windows build to the current product requirement, 26200 (Windows 11 25H2).
Preserve installation directories and identity derivation across future releases.
Upgrades replace older MSI versions transactionally; downgrades are blocked. No
automatic conversion/removal of existing MSIX installations is promised: document
manual uninstall of an older MSIX before installing the MSI to avoid duplicate apps.

Use graceful Restart Manager servicing, with no forced process termination or automatic
relaunch. VidVNC's close-to-tray behavior must not defeat committed Windows session
shutdown: inspect/add WM_QUERYENDSESSION/WM_ENDSESSION handling so an accepted servicing
shutdown closes the host and its server/worker with orderly cleanup, including tray
mode. A canceled shutdown must leave the app usable. This is part of MSI readiness,
not an unrelated UI change. Installer uninstall removes its own payload/shortcut,
preserves user settings, and never changes certificate trust or firewall settings.

## Certificates and deferred signing

Remove automatic signing-key creation and legacy PFX import from package:prepare and
npm run deps. Do not add a replacement certificate setup command for these unsigned
deliverables. Existing keys/CER files in a developer's store or .deps remain untouched.
Do not copy certificate trust scripts or CER files into the new outputs.

If the old certificate-management entry point remains for removing trust granted to
historical MSIX packages, clearly document it as legacy maintenance. Preserve
exact-thumbprint confirmation/removal, including expired certificates. Any retained
certificate validation/import must delegate to shared helpers; do not preserve a
second active local trust implementation. No build invokes it. Production signing,
certificate selection/timestamp policy and signed MSIX distribution will receive a
separate design when the owner has appropriate signing.

## Verification and documentation

Test default command selection and explicit unsigned MSIX, removed flags, missing
checkout, bundled Node selection despite conflicting PATH, missing runtime errors,
exact MSI payload/identity/scope/shortcut/upgrade tables, rejected payloads, failure
preventing publication, and final artifact metadata. Add meaningful host shutdown
checks for servicing and cancellation. Default checks do not create keys, import
trust, install products or register packages.

Run npm run format:check, npm test, npm run test:host, and relevant upstream
non-installing checks. Build the actual MSI, CLI ZIP and explicitly requested unsigned
MSIX; inspect package contents and manifests and run extracted payload checks from
paths containing spaces/non-ASCII characters without installed Node. Retain worker
and host startup/cleanup checks. Tests requiring hardware use the appropriate Windows
desktop environment. The upstream committed-clone check validates committed HEAD;
do not report it as verification of an uncommitted consumer change.

Before shipping the MSI, run ICE validation and real standard-user install, Start-menu
launch, repair, running-app upgrade, canceled shutdown, downgrade rejection and
uninstall/settings-preservation checks on an authorized disposable Windows host.
Read-only table/cabinet inspection does not prove that lifecycle. If no such host is
available, record the gap and retain it as a release acceptance requirement. Do not
install/uninstall on the developer's machine as an ordinary packaging test.

Update current README, CONTRIBUTING, Unreleased changelog, packaging docs/READMEs,
architecture and relevant diagrams/security boundaries, security verification record,
roadmap validation status, LICENSING, tests' READMEs and affected website claims in the
implementation change. Adjust remote-access guidance only where setup changes;
SECURITY only if support/reporting policy changes. Historical specs stay unchanged.

Bridge details, fixture mechanics and file organization are left to the builder within
these contracts. The MSI per-user scope and manual transition from old MSIX installs
are the principal proposed product choices for the owner to review.
