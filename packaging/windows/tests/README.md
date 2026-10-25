# Windows distribution tests

Own clean-machine install/run, upgrade/uninstall, prerequisite checks, independence
from developer SDKs/paths, firewall scope and process-cleanup checks here.
`cli-bundle-check.mjs` is the opt-in hardware check for the CLI ZIP; it changes no
machine settings. `server-package-check.mjs` checks the unsigned MSIX against staged bytes and an independently generated manifest, then
runs the unpacked app on bundled Node without installing it. It also checks canceled
and committed session shutdown. Run after package:msix so the current staging matches. Its `--register` option installs the
package on the current machine (Developer Mode), uses the real `%LOCALAPPDATA%\VidVNC`
and port 4382, then removes the package; run it only with explicit consent. Run other
machine-changing installer tests in disposable Windows environments.
These are separate from source-module tests and full-stream tests in `tests/system`.

MSI creation itself checks the authored tables and embedded cabinet against approved
staging through winbuildtools. This is not installed lifecycle validation: ICE, elevated
installation, standard-user launch, repair, running-app upgrade and uninstall preserving
settings still need an authorized disposable Windows host before shipping.

msi-package-check.ps1 reads the actual built MSI without installing: both scope radio
options/events, per-user defaults, least-privilege summary and legacy persistent GUIDs.
It also checks the logo, read-only destination, disabled Details/Browse, and an initially
checked Run option targeting the installed host File key with every launch gate.
Actual launch identity/privileges remain unverified.
`msi-installed-check.ps1 -Artifact <msi>` checks the exact installed PackageCode and
the real Windows app catalog's Uninstall verb, without installing, repairing, launching
or removing anything. It binds catalog identity to the registered executable or the
verified MSI shortcut's advertised descriptor or exact authored AppUserModel.ID;
a same-name MSIX cannot satisfy the check.
Use `-UninstallLabel` for the localized Windows menu label.
Run this after installation in a disposable Windows environment; table checks alone
cannot establish that Start exposes Uninstall. This check reproduced the owner's
missing-Uninstall report and now passes against the exact installed corrective candidate.
An owner-authorized clean per-user uninstall/reinstall preserved all 33 existing
application data files, but did not restore Uninstall; removing the Start pin also
failed. Nine fresh isolated test installations, including two complete payload clones,
exposed Uninstall. After Explorer was restarted, the immediate check still failed;
later the owner saw Uninstall and the same read-only check passed. These results
establish recovery on this PC, without proving the cause or which steps were necessary.
An optional previous MSI allows direct identity/folder comparison. Shared build-time
inspection performs read-only costing of fresh synthetic copies in both contexts.
Actual per-user/no-UAC and all-users/elevated installation, same-context upgrades,
cross-scope removal policy and ICE105 remain disposable-host release gates.

The CLI check retains and narrowly accepts GIO access-denied diagnostics while
enumerating unrelated protected WindowsApps manifests. Other unexpected startup
diagnostics still fail, including media/plugin load failures.

The wizard-state regression opens a synthetic unregistered MSI copy and evaluates
native conditions without performing actions. An unrelated machine-wide pending
reboot must leave normal success and Run visible; an actual in-use-file replacement
must show the transaction restart state and block launch. Synthetic inputs remain
under ignored `out/packaging/windows/wizard-state-*` for diagnosis.
