# TLS test fixtures

Test-only certificate/key pairs for the HTTPS/TLS test suite. Generated once, by hand,
on Windows (`New-SelfSignedCertificate` in `Cert:\CurrentUser\My`, exported to PEM via
.NET's `RSACertificateExtensions.GetRSAPrivateKey` + `ExportPkcs8PrivateKey`, then the
certificate removed from the certificate store) and committed here so the portable test
suite (macOS, Linux, Windows) only ever *reads* these files — it never generates a
certificate at runtime.

**These private keys are intentionally public.** They exist solely to exercise TLS
loading/listener code under test. Never load them outside this test suite, never reuse
them for anything real, and never treat anything in this directory as secret.

## `valid/`

- Subject: `CN=vidvnc-test.invalid`
- SANs: `DNS:vidvnc-test.invalid`, `IP:127.0.0.1`, `IP:203.0.113.25`
  (`.invalid` is the RFC 2606 reserved TLD for names that must never resolve;
  `203.0.113.0/24` is the RFC 5737 TEST-NET-3 documentation range — both are
  guaranteed non-routable and safe to bake into a fixture.)
- Validity: 2026-09-20 to **2036-09-21** (10 years, so this fixture does not need
  regenerating for a long time).
- Purpose: gives coverage tests both a hit (the hostname/IPs above) and a miss (any
  other hostname or IP) without needing a second "valid" fixture.

## `expired/`

- Subject: `CN=vidvnc-test-expired.invalid`
- SANs: `DNS:vidvnc-test-expired.invalid`, `IP:127.0.0.1`
- Validity: 2024-09-21 to **2025-09-21** — already in the past as of this writing, so
  the "certificate is reported expired" test needs no clock injection.

There is no separate "inside the renewal window" fixture. That case is exercised by
injecting a fake clock next to `valid/`'s real expiry date rather than committing a
certificate that is only "inside the window" for a limited time (which would make the
suite go red on some future date for no reason).

## `pfx/`

Generated the same way as `valid/`/`expired/` above (`New-SelfSignedCertificate` in
`Cert:\CurrentUser\My`, certificate removed from the store afterward), then exported to
PFX with `Export-PfxCertificate` and a passphrase, since PFX loading needs a passphrase
to have something real to fail against. Node's `node:tls` consumes this PFX directly —
there is no PEM conversion step anywhere in the loading path that reads it.

- Subject: `CN=vidvnc-test-pfx.invalid`
- SANs: `DNS:vidvnc-test-pfx.invalid`, `IP:127.0.0.1`, `IP:203.0.113.25` (same
  reserved/non-routable ranges as `valid/`, for the same reason)
- Validity: 2026-09-21 to **2036-09-21** (10 years, so this fixture does not need
  regenerating for a long time)
- File: `pfx/cert.pfx`
- **Passphrase: `vidvnc-test-pfx-passphrase`** — recorded here deliberately; this is a
  test fixture and the secret is intentionally public, same as the private keys above.
- Thumbprint at creation (removed from `Cert:\CurrentUser\My`, including its key
  container, with `-DeleteKey`; `Cert:\CurrentUser\My` was the store confirmed clear
  of this thumbprint afterward, and is the only one that claim covers):
  `1ECA22ADF0387AA3C99EDF4FD83F2F692C6DE3C8`

Never load this PFX outside the test suite, never reuse the passphrase for anything
real, and never treat anything in this directory as secret — the same rule as the PEM
fixtures above.
