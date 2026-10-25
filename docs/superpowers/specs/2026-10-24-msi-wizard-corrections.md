# MSI wizard corrections after installed feedback

Date: 2026-10-24. Status: local wizard and launch fixes verified; Start Uninstall unresolved.
This supersedes the affected behavior in the
[selected presentation](2026-10-24-winbuildtools-selected-presentation.md), without
editing that dated decision. Published v0.12.2 and its tag remain unchanged.

## Observed failures and causes

The owner installed the actual MSI and reported unconditional close-app guidance,
duplicate destination/Ready pages, a disappearing window before progress, a vague
restart message after successful installation, missing Run and a blurred logo.

Read-only inspection of successful VidVNC installation logs found native engine exit
code 0, no ReplacedInUseFiles flag and MsiSystemRebootPending=1. The latter describes
pre-existing machine state. It is not evidence that VidVNC installation requires a
reboot. The current engine incorrectly uses it both to replace the success message
and to hide the Run choice. The new consumer regression reproduces that false
positive using only native condition evaluation on a synthetic MSI copy.

The existing ICO contains 16 through 256-pixel frames. MSI's Icon control, without
size-selection attributes, loads the first image: the 16-pixel frame is stretched.
The high-resolution source is present; the wizard's resource selection is wrong.
No replacement artwork or downloaded image dependency is needed.

## Required behavior

- Use concise, conventional MSI wording and familiar labels. Avoid unnecessary
  narration or treating routine actions as something the user needs explained.
  No third-party string collection, runtime dependency or license change is needed.
- Use neutral welcome guidance. Only actual files-in-use detection should request
  closing applications; do not claim an application is running without detection.
- Collect scope and show the read-only destination once, with a clear Install action.
  Omit the redundant Options page for VidVNC's fixed-destination/no-license flow;
  keep Ready as the single review/Install step. Do not remove the last explicit
  consent before beginning installation.
- Keep a visible wizard surface while moving into native preparation/progress.
  Preserve real engine progress, cancellation and rollback; do not fabricate a timer
  or percentage or hide the gap behind a splash screen.
- Show normal success when this transaction succeeded without requiring reboot.
  Pre-existing machine reboot state must neither imply that VidVNC needs restarting
  Windows nor hide Run. Preserve correct handling of genuine transaction restart
  requirements and native result codes. Do not parse a log to guess the UI outcome.
- Offer the initially unchecked Run choice after successful interactive install/update,
  retaining the installed-host-only target and repair/remove/failure restrictions.
- Display the high-resolution icon frame sharply. Keep the canonical app artwork and
  approve/inspect any normalized installer resource against that source.
- Keep Just me default, All users support, unsuffixed folders, disabled Details and
  destination editing, bundled Node, identities and servicing policy unchanged.

## Ownership and verification

Installed acceptance of the first corrective candidate found two further failures:
selecting Launch VidVNC and Finish did not launch the host, and Windows Start omitted
Uninstall. Exact PackageCode inspection rules out an older cached MSI. Require actual
native launch-event execution with a harmless fixture, not only condition evaluation,
and check the installed app catalog's Uninstall verb. A shortcut property in the MSI
or even in the installed link is insufficient evidence that Start exposes Uninstall.

Generic behavior is fixed in winbuildtools candidate
`634ec1a85e814b71746bfd5ebbe78878aaca93c5`, consumed locally by VidVNC.
Its maintained native regression proves the raw MsiLaunchApp file-key token launches
the harmless fixture, including a path with spaces; adding quotes silently fails.
Start-menu Uninstall remains a separate installed acceptance failure.
Do not fork engine helpers into the consumer. No new release, published tag replacement,
installation, reboot, trust mutation or implicit hosted workflow is authorized by this fix.

Reproduce the old failure before changing the engine, then run native condition checks
with machine-pending state both on and off and a genuine in-use-file restart state.
Verify success text, restart text and Run visibility/action independently. Inspect the
actual resource frame, page/event sequence and final install consent in the built MSI.
Render the actual pages without executing an installation. Run shared tests and the
consumer's format, portable and package checks. Record actual results and remaining
installed transition/launch/UAC/ICE limitations in the security verification record.
