# macOS package checks

```sh
node packaging/macos/tests/package-check.mjs macos-server [dmg]
node packaging/macos/tests/package-check.mjs macos-cli [zip]
```

Without a file it checks this version's package in `out/installers/<target>/<version>/`,
notarized or, failing that, not notarized. It needs no Screen Recording or Device Control
permission: no viewer connects and nothing is captured. In order:

1. **Unpacking.** The DMG's stapled ticket and Gatekeeper's answer (notarized builds), its
   signature, then the app copied out of it; or the ZIP extracted. Either goes into a
   folder whose path has spaces and non-ASCII characters.
2. **Signatures.** Every program verifies with `--deep --strict`, is signed by a Developer
   ID Application identity with the hardened runtime and a secure timestamp, and has only
   its own entitlements (managed ones from a provisioning profile aside). For a notarized
   build, `spctl` reports `Notarized Developer ID` for the app, which also has a stapled
   ticket, or for the CLI's capture helper, since Gatekeeper assesses only bundles and a
   bare program cannot carry a ticket.
3. **Libraries.** Every Mach-O in the package is arm64 only, loads only `/usr/lib`,
   `/System/Library` and `@rpath` libraries, and has rpaths inside the package.
4. **Running.** From an unrelated folder, with a fresh home, `NODE_OPTIONS` and
   `NODE_PATH` set to break an unclean launch: `vidvnc config help` succeeds and a usage
   error keeps exit code 2; the server starts with `--desktop` on loopback and a free
   media port, serves the web client, and every process under it runs and maps libraries
   from the package or the system only; a stop line exits 0; and after `SIGKILL` of the
   server, every process it started exits within ten seconds.

Not covered here: a clean Mac without developer tools, a quarantined download, App
Translocation, permissions and streaming to a viewer. Those are the clean-Mac acceptance
in plan phase 7, on a disposable virtual machine.
