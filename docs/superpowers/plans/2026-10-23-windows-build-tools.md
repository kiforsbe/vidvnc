# Windows build tools implementation plan

> **For agentic workers:** Use superpowers:executing-plans in the current session.

**Goal:** Default unsigned MSI and bundled-Node CLI ZIP, optional unsigned MSIX.

**Architecture:** Product-owned Node staging feeds a PowerShell adapter to pinned
winbuildtools. Shared tools own installer creation/inspection, process diagnostics
and final artifact measurement. Keep WinUI/CMake resource and dependency policy local.

**Tech stack:** Node.js, PowerShell 7.4+, Windows Installer, Windows SDK, CMake, .NET.

**Spec:** ../specs/2026-10-23-winbuildtools-msi-design.md and its overriding
../specs/2026-10-23-winbuildtools-tag-amendment.md.

## Global constraints

- Pin v0.3.0 commit 9a3bf8cf1d79d05946abbd020fe57ccec3d0ceb5.
- Work on main as requested; leave changes uncommitted and do not push.
- MSI schema v1, machine scope, minimum Windows build 26200.
- Every product bundles Node.js; no build changes keys or trust.
- Preserve current documentation in the implementation change.

## Review focus

- A missing/changed tools checkout must produce an actionable failure.
- A PATH Node must never override the bundled runtime.
- A failed packer must not publish partial output or report old output as new.
- Installer shutdown must respect canceled session ending and stop child processes.
- Unsigned MSIX must remain explicit and preserve identity/manifest/payload integrity.

## Task 1: Pin tools and add adapter contracts

Files: .gitmodules, external/winbuildtools, packaging/windows/build-tools.ps1,
packaging/windows/build-tools.mjs, packaging/tests/build-tools.test.mjs.

Interfaces: invokeBuildTools(request) invokes pwsh with a request file and returns
structured response data. Operations: preflight, run, msi, msix, metadata.

- [ ] Add failing tests for missing checkout, unsigned operation selection and
      failure propagation; run node --test packaging/tests/build-tools.test.mjs.
- [ ] Pin submodule, implement adapter using tagged shared scripts and test.
- [ ] Check live Node.js/upstream dependency/license/advisory guidance; record review.

## Task 2: Single bundled payload and installer paths

Files: packaging/windows/build.mjs, package-all.mjs, prepare.mjs, inputs.json,
package.json, packaging/windows/msi.json, packaging/windows/launcher.mjs.

Interfaces: windows-server defaults to MSI; --msix explicitly selects MSIX.
launcher() produces a cmd launcher for runtime/node/node.exe.

- [ ] Test command selection, removed flags, bundled runtime selection and forwarding.
- [ ] Replace optional variants, automatic key creation and direct signing with
      adapter calls; place generated MSIX manifest outside payload.
- [ ] Build ZIP/MSI/explicit MSIX; compare approved payload and final metadata.

## Task 3: Lifecycle and package acceptance

Files: apps/windows-host/HostWindow.Tray.cs, host tests,
packaging/windows/tests/_, packaging/tests/_.

- [ ] Test session-ending cancellation versus committed shutdown and implement
      orderly host/server/worker termination for Restart Manager maintenance.
- [ ] Adapt acceptance checks for bundled Node, MSI extraction, unsigned MSIX and
      independently expected manifest/inventory; no install or trust mutation.
- [ ] Run host runtime-contract checks and applicable upstream checks.

## Task 4: Documentation and verification

Files: README, CONTRIBUTING, CHANGELOG, LICENSING, docs/ARCHITECTURE,
docs/PACKAGING, docs/ROADMAP, docs/security/internet-exposure, directory READMEs,
affected site claims and checkout workflows.

- [ ] Update current claims/commands/platform prerequisites and security record;
      document machine installation, legacy MSIX transition and deferred signing.
- [ ] Run npm run format:check, npm test, npm run test:host, package builds and
      non-installing inspection/runtime checks. Report ICE/disposable lifecycle gaps.
- [ ] Review final diff and fix correctness gaps before reporting completion.
