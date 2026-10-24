# winbuildtools latest-tag upgrade review — 2026-10-23

The owner requested the newest published winbuildtools tag after the v0.3.0
integration. Live origin tags and the
[upstream release](https://github.com/kiforsbe/winbuildtools/releases/tag/v0.4.0-beta.1)
identify **v0.4.0-beta.1**, resolving to
`23aaea448133df02d182a8e5702d8c7680a99496`. Its annotated tag object is
`1224174fa5d4b25d0a6973fca3ab2af4ac81798a`.

This is an explicit prerelease selection to satisfy that request. The latest stable
tag is still v0.3.0 (`9a3bf8cf1d79d05946abbd020fe57ccec3d0ceb5`). Do not describe
the selected beta as stable or silently follow upstream main during builds.

## Reviewed changes and boundaries

Compared the complete published v0.3.0-to-beta delta, upstream changelog, interfaces,
security guidance, dependency policy and actual LICENSE. MIT terms are unchanged.
The delta adds PowerShell/source/configuration/documentation and tests, with no new
registry package dependency, bundled transitive package tree or redistributed platform
binary. Platform prerequisites retain their separate licensing/support terms. No
additional npm/NuGet/PowerShell module versions are selected by this update.

The release adds a native MSI setup/maintenance wizard, uninstall/ARP registration and
same-context destination memory, plus stricter inspection of exact MSI semantics.
It also adds opt-in schema v2 and public certificate helpers. VidVNC keeps schema v1,
its existing permanent identity inputs, machine-wide scope, non-editable destination
UI and unsigned default MSI/CLI ZIP plus explicit unsigned MSIX. No signing/trust
commands or schema-v2 product identities are introduced.

The new install-location registry value belongs to the executable component and is
created by installation, not packaging. Only three exact declarative type-51 property
setters are authored; no executable/script actions are allowed. Inspector checks cover
the action/registry/shortcut metadata and secure property transfer before isolated
costing. Preflight randomizes installation-memory paths and disables Restart Manager.
See [Windows packaging](../../packaging/windows/README.md#native-setup-and-maintenance)
for behavior, upgrade compatibility and reduced-UI cancellation details.

Upstream identifies a certificate-substitution fix: trust uses the validated in-memory
object rather than reopening a path. VidVNC's unsigned build path does not invoke that
helper or import trust. Public-source checks cannot rule out private advisories or
establish complete security. Earlier Node/npm review exceptions remain recorded in
[their dated review](node-dependency-review-2026-10-23.md).

## Acceptance limits

Upstream explicitly marks the release as beta because actual installed lifecycle,
Start right-click Uninstall, UAC/managed elevation, ICE/ICE105, accessibility/scaling
and native ARM64 execution still need disposable-host acceptance. VidVNC's portable
tests, non-installing shared verification and package-byte inspection do not close
those gaps. No installer is run or trusted on the developer's machine in this update.

Consumer verification results are recorded in the
[security verification record](internet-exposure.md#verification-record).
