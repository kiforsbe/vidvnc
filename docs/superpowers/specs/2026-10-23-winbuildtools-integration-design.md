# Windows build-tools integration and single bundled-Node packages

Date: 2026-10-23. Status: proposed for owner review; implementation has not started.

## Intent and scope

Replace as much of VidVNC's Windows packaging machinery as the published
[winbuildtools](https://github.com/kiforsbe/winbuildtools) supports, using ProcSight's
integration as the reference. Simplify distribution to one Windows host MSIX and one
Windows CLI ZIP, each containing Node.js. The owner requested a written design before
implementation and subsequently requested removal of the package variants.

The migration covers Windows only. macOS packages already bundle Node.js and keep their
existing build, signing and notarization flow. It does not introduce an MSI, native
viewer package, Windows ARM64 support, Store submission or production signing service.
There will be no version bump, release, tag, push or package installation as part of
implementation. Changes remain reviewable in the working tree.

## Current implementation and reference

- `packaging/windows/build.mjs` builds the worker and publishes the WinUI host, approves
  dependencies and licenses, stages files, locates NuGet SDK tools, packs/signs the
  MSIX directly, and writes ZIPs. It supports optional Node.js and runtime installers.
- `packaging/windows/package-all.mjs` runs preparation and four combinations that
  produce two CLI ZIPs, two host MSIX files and two host installer ZIPs.
- `packaging/windows/prepare.mjs`, also called by `tools/deps.mjs`, downloads pinned
  inputs and creates or migrates development signing keys automatically.
- `packaging/windows/development-certificate.ps1` locally implements public-certificate
  trust and removal. Copies ship beside the MSIX and inside installer ZIPs.
- ProcSight's `scripts/packaging/ProcSight.ps1` checks the pinned submodule, delegates
  packaging/signing/metadata to shared scripts, and keeps product identity, payload
  validation and release policy local. Its SDK-generated MSIX needs shared inspection;
  VidVNC can use shared packing directly because it already prepares its own payload.

## Approaches

1. Replace only MakeAppx calls. This is a smaller edit but retains duplicated signing,
   certificates, SDK discovery and artifact measurement, contrary to the requested
   extent of replacement and upstream's integration guidance. Not recommended.
2. Delegate all applicable mechanisms through a thin product adapter, retaining VidVNC
   staging and validation. This matches ProcSight and upstream ownership boundaries.
   **Recommended; approval of this document selects this approach.**
3. Move the entire build to a new PowerShell pipeline or add MSI distribution. This
   rewrites working product logic or adds a deliverable the owner has not requested.
   Not recommended.

## Distribution contract

For the existing Windows x64 target, a successful `npm run package` produces exactly
two application distributables under the existing target/version output layout:

- `VidVNC-<version>-windows-x64-selfsigned.msix`: WinUI host, server, viewer assets,
  worker/media libraries and the pinned Node.js runtime.
- `VidVNC-Server-<version>-windows-x64-unsigned.zip`: CLI server, viewer assets,
  worker/media libraries and the same pinned Node.js runtime, without the WinUI host.

Public certificate, certificate-management support files, diagnostic logs and JSON
artifact metadata are supporting outputs, not additional package variants. There is
no host wrapper ZIP and no runtime-installer ZIP. Remove `--include-node` and
`--include-runtime-installers`; unknown/removed flags fail with updated usage rather
than silently selecting a different artifact. Keep `package`, `package:app`,
`package:cli` and `package:prepare` as npm entry points.

Both products use `runtime/node/node.exe` in `runtime.json`. The CLI launcher runs
that exact bundled executable, retaining argument forwarding, `NODE_OPTIONS` clearing,
runtime-manifest setup and Visual C++ prerequisite checks. It must not search PATH for
Node.js or use a globally installed Node.js when the bundle is damaged. A missing
bundled runtime produces an actionable damaged-package error.

Keep the Visual C++ runtime prerequisite for both products, and .NET/Windows App
Runtime prerequisites for the host. Remove Node.js as an installed prerequisite and
remove obsolete installer-download/hash entries and associated bundle handling when
no remaining consumer needs them. Keep prerequisites' official installation links.
Node.js is pinned and hash verified, not installed on the build or target machine.
Payload policy, notices and `files.json` must include Node.js and its license in both
products. Review any claims in the website that Windows CLI requires installed Node.

Old generated variants must not appear as current outputs after this migration.
Remove only explicitly recognized obsolete VidVNC variant filenames for the current
version, after new artifacts pass verification; preserve other versions and unrelated
files. Failed builds must not announce old artifacts as newly built output.

## Checkout, dependency and license policy

Add a Git submodule at `external/winbuildtools` with the published HTTPS URL. The
proposed exact pin is `9949d5cd95f426611ec137522d1ee76b4889677c`, which matches
ProcSight and the live origin HEAD checked on 2026-10-23. Latest listed stable tag
`v0.3.0` resolves to `9a3bf8cf1d79d05946abbd020fe57ccec3d0ceb5`; the proposed pin
is two commits later and includes consumer integration improvements. It is an explicit
post-tag compatibility choice, not a claim that HEAD is a tagged release. Review those
changes before pinning. No GitHub Releases are currently published.

The reviewed upstream source is MIT licensed. It adds no npm, NuGet or PowerShell
module dependencies or redistributed binary tools; its runtime package transitive
tree is empty. Keep upstream license/notice material with any support scripts copied
into distribution. Record provenance and redistribution obligations in `LICENSING.md`.
Installed PowerShell, Windows SDK, Git and .NET remain host tools with their own terms.
PowerShell 7.4+ and Windows SDK 10.0.26100.0+ are API floors, not currency claims.

Before implementation selects or changes any application dependency, check live
authoritative registries, upstream support/deprecation guidance, public advisories,
and actual licenses for its direct and transitive packages. Review the bundled Node
pin against current supported stable releases and official security notices. If any
existing dependency examined during integration is deprecated/vulnerable/prerelease,
record and resolve it or explicitly explain the compatibility exception; do not
silently retain it. Do not claim a complete security audit from a public advisory scan.

Checkout is explicit (`git submodule update --init --recursive`), never a packaging
download or sibling-folder fallback. Missing/incomplete tools fail before expensive
builds with that repair command. Update applicable CI checkout to recurse submodules;
do not add or run hosted workflows without a separate owner request.

## Adapter and delegation

Keep the existing Node.js entry points as coordinators. Add a small PowerShell adapter
under `packaging/windows/` and a narrow Node bridge invoking `pwsh -NoProfile -File`
with argument arrays or an explicit JSON request file. Avoid interpolated PowerShell
source and secret-bearing logs. Validate tool availability and signing before building.

Delegate these operations to the pinned checkout:

- SDK discovery and native-command logging: `Get-WbtSdkTool` and `Invoke-WbtTool`.
- MSIX construction and byte/manifest inspection: `msix/package.ps1`.
- Signing preflight, existing-store certificate selection and publisher validation:
  shared signing/certificate functions; dispose certificate objects.
- Signing plus expected-signer/integrity verification: `signing/sign.ps1`.
- Explicit development-key creation and public CER validation/trust: shared scripts
  and certificate functions.
- Final artifact SHA-256/signature measurement: `common/write-artifact-manifest.ps1`,
  for both the signed MSIX and unsigned CLI ZIP.

Keep product builds, prerequisite rules, PE dependency allowlists, license attribution,
required-file checks, logos, MSIX XML identity/capabilities, `runtime.json`, `files.json`,
and ZIP layout in VidVNC. The Windows tar ZIP operation remains local because
winbuildtools has no ZIP authoring API. Payload-file hashes remain local inventory
data; final artifact hash/signature measurement comes from upstream.

Generate the authoritative `AppxManifest.xml` outside the MSIX payload, as the shared
packer requires. Adjust inventory tests accordingly: compare the embedded manifest
against the independently generated expectation, and check every payload file against
the payload inventory. Never derive expected content from the artifact being checked.

Use fresh per-run intermediate/output directories outside the payload. Preserve failed
tool diagnostics. Publish only after packaging, inspection and signing succeed. Write
metadata for the final filename and final bytes, keeping JSON sidecars outside payloads.
Preserve upstream fields and add target, architecture and source dirty state without
recomputing hashes/signatures. Capture Git status with `--ignore-submodules=none`.
No failed run should promote partially signed bytes or leave mismatched new metadata.

The shared .NET helper requires committed project locks and a compatible artifacts
layout. VidVNC currently publishes WinUI with its own resource/obj assumptions and no
committed host package lock. Retain those publish settings through the shared native
runner in this migration, documenting this compatibility exception. Do not add an
unrelated NuGet/layout migration merely to call `dotnet/invoke.ps1`.

## Development certificates and trust

`package:prepare` and `npm run deps` download verified inputs only; neither creates,
imports, migrates or trusts signing keys. Add `npm run package:certificate` as a
separate explicit development-key setup command wrapping upstream creation. It creates
a non-exportable, one-year code-signing key and exports the public CER at the configured
path. Existing valid CER/store-key pairs remain usable; setup never overwrites them or
replaces a missing key automatically. Old PFX migration becomes manual documented
recovery rather than an automatic build operation.

MSIX builds remain signed development packages using the existing configured public
CER to identify the matching CurrentUser/My key. Validate public-only CER, validity,
code-signing EKU, private-key availability and publisher before building. Missing or
invalid signing material fails with setup/recovery guidance. Packaging never changes
certificate trust. Do not add unsigned/production package variants in this task.

Preserve the public `development-certificate.ps1 install|uninstall` commands and
published-thumbprint review. Use shared public-certificate validation and object-based
TrustedPeople import for install; retain consumer-owned exact-thumbprint removal for
uninstall, including expired certificate removal. Never import into Root. Support files
shipped beside the MSIX must include the minimal upstream helper closure and MIT
license, using only relative paths within that support directory. They must work
without the repository or submodule. Document PowerShell 7 as their prerequisite.

No real key creation/signing, trust changes, package registration or install/uninstall
is performed by ordinary tests. Live signing verification uses only an explicitly
authorized identity/environment. Existing developer keys are never silently exercised.

## Validation and documentation

Add meaningful adapter/launcher tests for missing checkout, removed flags, bundled-node
selection with a conflicting PATH Node, missing bundled runtime, certificate failure
before build, expected-signer mismatch, pack/sign failures preventing publication,
fresh output directories and accurate final metadata. Use temporary synthetic fixtures;
no private-key or trust mutation in the default suite.

Run `npm run format:check`, `npm test`, `npm run test:host`, and the applicable upstream
non-installing checks. Build the actual CLI ZIP and inspect/run it from a path containing
spaces/non-ASCII characters without PATH Node. Build and inspect the host MSIX when
signing is authorized, otherwise report that validation gap explicitly. Retain existing
host startup/shutdown and worker runtime checks; registration and hardware tests need
their appropriate environment and explicit consent where existing tests require it.
The upstream committed-clone check tests committed HEAD; do not report it as validation
of an uncommitted consumer integration.

Update affected current docs in the implementation change: README, CONTRIBUTING,
CHANGELOG under Unreleased, architecture/security architecture and diagrams,
security verification record, packaging docs/READMEs, test READMEs, roadmap validation
status, LICENSING and website claims. Update remote-access guidance only if setup
instructions there are affected; SECURITY only if its support/reporting policy changes.
Historical specs/plans remain unchanged.

Implementation file organization, bridge request shape, fixture mechanics and helper
support-directory naming are left to the builder within these contracts.
