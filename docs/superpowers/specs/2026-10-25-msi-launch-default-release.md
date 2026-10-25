# MSI launch default and 0.12.3 release

The owner requested Launch VidVNC selected by default, followed by VidVNC 0.12.3.
The owner also requires winbuildtools to commit, push, tag and publish its changes
before VidVNC integrates them. Work remains on main.

## Behavior and ownership

Use the shared `ui.completion.launchApplicationChecked` setting with
`launchApplication: true`. The user can clear the checkbox. Preserve native
full-UI/success/restart gates and the installed-host-only raw File key; repair,
removal and silent installation must not launch the application.

Keep the existing per-user default and all-users choice, fixed unsuffixed folder,
disabled Details and destination editing, bundled Node, and MSI plus CLI ZIP defaults.
MSIX remains an explicit unsigned build. Launch privilege limitations still apply;
no launch de-elevation guarantee is introduced.

Implement the option in winbuildtools and consume its published release, rather than
patching the consumer's generated MSI or carrying an unpublished submodule commit.
This also carries the previous wizard, logo, false-reboot and native launch fixes.

## Evidence and release boundaries

The previous missing Start Uninstall report has recovered: the owner saw the action
and the exact-package read-only installed checker passed. Recovery followed reinstall,
unpinning and an Explorer restart with a delay; no individual cause is established.
This supersedes the unresolved status in the dated October 24 correction design.

Verify the checked default and user opt-out against the actual MSI, retain native
launch-event regressions, and run the repository's Windows release checks. Publish
only packages rebuilt from the clean 0.12.3 tagged commit, with unsigned status stated.
Do not replace the published 0.12.2 tag or artifacts or run hosted Actions implicitly.
