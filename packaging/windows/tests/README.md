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
An optional previous MSI allows direct identity/folder comparison. Shared build-time
inspection performs read-only costing of fresh synthetic copies in both contexts.
Actual per-user/no-UAC and all-users/elevated installation, same-context upgrades,
cross-scope removal policy and ICE105 remain disposable-host release gates.

The CLI check retains and narrowly accepts GIO access-denied diagnostics while
enumerating unrelated protected WindowsApps manifests. Other unexpected startup
diagnostics still fail, including media/plugin load failures.
