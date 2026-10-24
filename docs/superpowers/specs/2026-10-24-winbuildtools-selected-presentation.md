# Windows setup: selected presentation options

Date: 2026-10-24. Status: approved by the owner for implementation and release 0.12.2.
This records the owner's choices after the
[presentation proposal](2026-10-24-winbuildtools-presentation-design.md), which remains
unchanged as dated history. The selected tool pin remains v0.5.0-beta.1.

## Approved behavior

- Keep compact headers and show the existing approved `Assets/VidVnc.ico` logo.
- Explicitly disable destination editing and Browse. The Options page remains visible
  with a read-only destination; hiding it is not supported by the tagged engine.
- Disable completion Details and omit its dialog/buttons. Failure/cancellation still
  show setup-log information through the engine's existing result behavior.
- Offer Run VidVNC after successful full-UI installation/update. The checkbox starts
  unchecked. Only selecting it and finishing requests the installed host executable.
  No arguments, shell commands or download are configurable. Repair/removal, cancellation,
  failure, reduced/basic/silent UI and detected restart states do not offer launch.
- No help/release-note links, sidebar artwork or agreement page are enabled.
- Preserve Just me default, optional All users, unsuffixed VidVNC folders, bundled Node,
  persistent identities, graceful shutdown and default MSI/CLI ZIP outputs.

The user's explicit launch selection supersedes the proposal's recommendation to defer
that feature. It does not establish an unelevated-launch guarantee. Actual identity and
privileges following elevated/all-users setup require disposable-host validation.
Do not describe the host as guaranteed unelevated when started by this checkbox.

## Implementation and verification

`packaging/windows/msi.json` owns these settings; the existing resolver forwards them.
No image/dependency is added: the logo already belongs to the approved payload. Shared
inspection checks its exact Binary bytes against that icon and rejects unexpected
resources/actions. The consumer MSI checker verifies logo controls, no Details/Browse,
read-only destination, an initially unchecked launch property, exact installed File-key
launch without arguments and every full-UI/success/restart gate. It retains scope/folder/
legacy identity assertions. Inactive actual-MSI previews cover logo, options and completion.

Run portable/format, host/build and actual-package checks before release. No app is
launched, URL followed, installer transaction performed or certificate trust imported
by preview/inspection. Installed launch/UAC/servicing, accessibility/DPI/high contrast
and ICE remain explicitly unvalidated; they require a disposable Windows host.
