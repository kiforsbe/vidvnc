# Windows distribution tests

Own clean-machine install/run, upgrade/uninstall, prerequisite checks, independence
from developer SDKs/paths, firewall scope and process-cleanup checks here.
`cli-bundle-check.mjs` is the opt-in hardware check for the CLI ZIP; it changes no
machine settings. `server-package-check.mjs` checks the MSIX files and signature and
runs the unpacked app without installing it. Its `--register` option installs the
package on the current machine (Developer Mode), uses the real `%LOCALAPPDATA%\VidVNC`
and port 4382, then removes the package; run it only with explicit consent. Run other
machine-changing installer tests in disposable Windows environments.
These are separate from source-module tests and full-stream tests in `tests/system`.
