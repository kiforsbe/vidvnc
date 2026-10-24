# Windows setup: latest winbuildtools integration and presentation proposal

Date: 2026-10-24. Status: latest-tag integration authorized; optional product UI
changes below are proposals for owner review, not enabled by this integration.

This amendment supersedes the tag, scope, folder and UI descriptions in the
[2026-10-23 tag amendment](2026-10-23-winbuildtools-tag-amendment.md) and
[MSI design](2026-10-23-winbuildtools-msi-design.md). Historical files remain unchanged.
The existing request to release 0.12.2 remains; proposals do not implicitly add new
features to that release.

## Integration decision and alternatives

Live origin tags on 2026-10-24 identify **v0.5.0-beta.1** as newest, resolving to
`d9ec7c72cdabfc65b85c61e4cf2f055b75a444a9`. Stable remains **v0.4.0**.
Use the exact beta gitlink because the owner explicitly requests the latest tag.
The compatibility exception is deliberate, visible in packaging docs and the changelog.
Do not follow moving main or copy the new presentation engine into VidVNC.

Three approaches were considered:

1. **Integrate latest; propose optional UI separately (selected).** Adopt compatible
   engine defaults, preserve product policy and identify attractive opt-ins for review.
2. **Enable every new UI option immediately.** More visible change, but Browse and
   launching introduce new acceptance obligations and branding needs visual decisions.
3. **Remain on v0.4.0.** Avoids prerelease code but does not satisfy the latest-tag request.

## Product contract preserved

- Default outputs: one unsigned x64 host MSI and one bundled-Node CLI ZIP.
  Explicit `npm run package:msix` still builds an unsigned MSIX outside defaults.
- One MSI offers Just me and All users; **Just me remains default**.
  Fresh folders remain `%LOCALAPPDATA%\Programs\VidVNC` and `Program Files\VidVNC`;
  Start-menu folder is VidVNC. No architecture suffix. Scope changes require uninstall.
- Preserve permanent upgrade/component identities and version-derived ProductCodes.
  Keep graceful Restart Manager shutdown and per-user data preservation.
- No certificate creation, trust import, downloads, automatic launch or browser opening
  occurs during package building or inspection. Signing remains deferred.
- The tag's default compact presentation now provides operation-specific result pages
  and an Installation details dialog with selectable folder/log fields. These are
  inherited engine changes, not optional features awaiting selection.

## Recommended optional features

| Feature                                            | Recommendation                         | Reason and acceptance                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing app logo (`ui.logo`)                      | Adopt first, after preview             | Reuse approved `Assets/VidVnc.ico`; avoids new artwork, package variants or dependencies. Check logo rendering, DPI and high contrast.                                                                                         |
| Compact header vs branded sidebar (`ui.layout`)    | Keep compact header initially          | Fits the current small wizard. Sidebar can follow a visual review; its welcome/result layout changes do not improve install semantics.                                                                                         |
| Installation details (`ui.completion.showDetails`) | Keep enabled                           | New default gives selectable location/log, version, architecture and scope. Useful for support without exposing a log editor or adding a separate diagnostics tool.                                                            |
| Release notes and help links                       | Adopt after link/navigation acceptance | Use literal HTTPS GitHub release notes and the existing getting-started documentation. Links open only when clicked after successful install/update. No automatic browsing.                                                    |
| Editable destination + Browse                      | Optional follow-up                     | Enable `allowDirectoryChange` with `showBrowseButton` only if custom folders are wanted. Preserve Just me default and scope-aware reset. Test invalid paths, Cancel/Back, scope changes, same-context upgrade memory and ACLs. |
| Run VidVNC after setup                             | Defer                                  | The native checkbox is initially unchecked and install/update-only, but unelevated launch is not guaranteed. Prove all-users/elevated installation starts the host as the intended interactive user before enabling.           |
| Custom completion messages                         | Usually keep engine defaults           | Existing text distinguishes install/update/repair/remove/failure/cancel/restart. Override only for a concrete VidVNC support need; do not promise a restart is unnecessary.                                                    |
| Full sidebar artwork (`ui.sidebarImage`)           | Defer                                  | Adds an asset and DPI/high-contrast review. A logo alone is sufficient initially.                                                                                                                                              |
| License acceptance page                            | Leave disabled                         | Notices already ship. Do not add a mandatory agreement without an actual product/legal requirement; it also affects unattended deployments.                                                                                    |

The suggested first opt-in configuration, **not applied**, is:

```json
{
  "ui": {
    "layout": "compactHeader",
    "logo": "Assets/VidVnc.ico",
    "allowDirectoryChange": false,
    "completion": {
      "showDetails": true,
      "launchApplication": false,
      "releaseNotesUrl": "https://github.com/kiforsbe/vidvnc/releases",
      "helpUrl": "https://github.com/kiforsbe/vidvnc#install-and-run"
    }
  }
}
```

For version-specific notes, the consumer resolver can supply an exact tag URL once
that behavior is approved. No new generic runtime setting or product dependency is
needed. The [upstream UI contract](../../../external/winbuildtools/msi/README.md#native-setup-and-maintenance)
owns accepted fields and limits. Referenced images must be approved payload/component
entries and pass byte/format checks; URLs must be literal HTTPS without credentials.

## What the tag does not provide

Disabling folder editing does not hide the Options page. There is no schema field
for an editable log destination; Details displays it read-only and deployments use
`msiexec /L*v`. It adds no trusted signing, prerequisite bootstrapper, service install,
automatic updates, guaranteed unelevated launch or installed-lifecycle certification.
Additional shortcuts and AppUserModelID already existed; neither is required here.

## Source, dependency and security review

Compared with v0.4.0, the tag adds source-only Branding/Presentation helpers and
schema/test/documentation changes. MIT terms and attribution are unchanged. No new
npm/NuGet/PowerShell module dependency, binary tool or copied external artwork is
introduced. System.Drawing comes from installed Windows PowerShell runtime components;
its platform servicing and terms remain the host's responsibility.

Review confirms bounded image decoding (8 MiB, at most 2048x2048), payload-relative
asset checks, exact Binary resource hashing before costing, HTTPS-only literal URLs,
plain-text message escaping, native Browse validation and installed-File-only launch
without arguments or executable custom actions. These controls constrain inputs;
they do not establish full platform security. The consumer's read-only MSI checker
loads Branding and Presentation in the new upstream dependency order.

Optional links add an external navigation boundary; approval must name exact trusted
URLs. Optional launch adds a process/privilege boundary; it must not elevate the host
or expose its server with installer privileges. Those features remain disabled now.

## Verification and release criteria

Run the exact tag's non-installing `verify.ps1`, including presentation tests. Rebuild
both defaults and explicit unsigned MSIX. Inspect actual MSI scope/default/folder/GUID
and new Details/result tables, compare cabinet bytes, and verify final sidecar hashes.
Run format/portable/host/hardware/build checks and relocated bundled-Node package checks.
No test may install, register or import trust on this machine implicitly.

Before enabling proposed features, render actual VidVNC pages in inactive preview
and test in a disposable host: Browse navigation/Cancel/Back, links, elevated versus
standard-user launch, restart handling, UAC, repair/remove/upgrade/rollback, ICE/ICE105,
keyboard/accessibility/DPI/high contrast. Upstream explicitly leaves these installed
acceptance checks open. A beta tag and read-only preview do not close those gaps.

Current verification results belong in the
[security verification record](../../security/internet-exposure.md), not in this dated
proposal. Release 0.12.2 notes must identify unsigned development artifacts, the beta
build-tool pin and remaining lifecycle/ICE limitations.
