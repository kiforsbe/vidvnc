# Windows packaging design amendment: latest tagged winbuildtools

Date: 2026-10-23. Status: proposed design, awaiting implementation approval.

The owner requires the latest winbuildtools tag. This amendment overrides the pin,
MSI schema, installation scope and identity derivation in
[the MSI design](2026-10-23-winbuildtools-msi-design.md). All other requirements remain:
default unsigned MSI plus CLI ZIP, explicit optional unsigned MSIX, and Node.js bundled
in every format. Signing remains deferred.

## Verified upstream selection

Live `git ls-remote --tags origin` on 2026-10-23 identifies **v0.3.0** as the newest
published tag. Its annotated tag object is
`a25d3542f08959f6e72ee2fd0b359d4ad91ce6fb`, resolving to source commit
`9a3bf8cf1d79d05946abbd020fe57ccec3d0ceb5`. Pin the submodule to that commit, not
post-tag HEAD. Future tool updates remain deliberate reviewed operations.

Inspect license, dependency policy and interfaces at this exact tag during integration;
do not assume later ProcSight helpers or upstream main APIs exist in v0.3.0.

## MSI compatibility consequence

The tagged MSI engine supports schema v1 and **machine-wide installation only**.
Use that supported contract rather than copying unreleased schema-v2 functionality
into VidVNC. Installation therefore requires administrator approval and uses native
Program Files, with an advertised Start-menu shortcut. The application still runs
as the interactive user and retains its current per-user settings location.

VidVNC supplies its own permanent upgrade namespace GUID, product data, approved file
list and required-file policy. The tagged engine derives architecture-specific upgrade
families, component identities and version-specific ProductCodes; VidVNC must not
supply the schema-v2 resolved GUID map. Use the tagged engine's architecture suffix
for application/menu folders and preserve these inputs across releases.

Keep the tagged engine's graceful Restart Manager servicing and validate the host's
shutdown/cleanup behavior as described in the main design. Lifecycle acceptance must
cover elevated installation, standard-user application launch, upgrade, repair and
uninstall/settings preservation on an authorized disposable Windows host. Replace
the earlier per-user MSI scope assertions/tests with machine-scope expectations.

Retain historical designs unchanged. Read this amendment together with the MSI design
when preparing the implementation plan.
