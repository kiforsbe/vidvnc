// The "provided" certificate-provisioning strategy: an operator brings their own
// certificate (from a real CA, an internal PKI, or anything else) and points TLS
// settings at it, either as a PEM certificate+key pair or a single PFX/PKCS12 file.
//
// This module also defines the strategy shape shared by all three provisioning
// strategies (Task 4 is first; `mkcert.mjs` and `self-signed.mjs` implement the same
// shape): a `name`, an `isAvailable(settings, deps)` check, and a `provision(settings,
// deps)` operation that returns either a usable credential plus the anchor a device must
// trust, or a reason it could not. Every strategy reports failure through that same
// `{ ok: false, reason }` shape rather than throwing — TLS is an improvement, never a
// precondition, so a caller (Task 7) can walk the strategy list, log each reason it
// skips, and fall through to plaintext if all of them fail.
//
// `isAvailable`'s second argument, `deps`, is optional and ignorable: this strategy's own
// availability is a pure settings check, so its `isAvailable` below only declares
// `settings` and never looks at `deps`. A strategy whose availability depends on probing
// the environment (`mkcert.mjs` checks whether the mkcert binary resolves; the Windows
// self-signed strategy checks the platform) takes the same `deps` object `provision`
// does — e.g. an injectable `spawnSync` — so its check stays testable without requiring
// the real tool. Task 7 calls every strategy's `isAvailable(settings, deps)` uniformly;
// a strategy that does not need `deps` simply has a parameter it never reads.
//
// `credential` is deliberately shaped as whatever `node:tls` needs directly:
// `{ cert, key }` for a PEM pair, `{ pfx, passphrase }` for a PFX. Both are valid
// `tls.SecureContextOptions` on their own, so a caller can pass `credential` straight
// into `tls.createServer`/`tls.createSecureContext` without inspecting which case it is
// or converting anything (a PFX is never turned into PEM).
//
// `anchor` is the `X509Certificate` a device must trust to stop warning about this
// server. For this strategy it is always the same object used to build the credential
// (the operator's own leaf) — this strategy has no separate CA to hand back. That is
// exactly what lets the shape serve Task 6 (self-signed) unmodified, where the anchor is
// also the leaf; Task 5 (mkcert) uses the same field to carry a *different* certificate
// (the mkcert local root), since `anchor` only ever means "what a device must trust," not
// "the certificate this strategy issued."
import { readFileSync } from 'node:fs';
import { createSecureContext as nodeCreateSecureContext } from 'node:tls';
import { loadCertificate, checkCoverage, renewalStatus } from '../certificate-facts.mjs';
import { localAddresses as discoverLocalAddresses } from '../local-addresses.mjs';
import { loadPfxCredential } from '../pfx-credential.mjs';

export const name = 'provided';

// True only when TLS settings are actually configured for this strategy. Never throws —
// callers (including `provision` itself, below) can call this on any settings object,
// including ones for `auto` or `off` mode, without guarding first.
export function isAvailable(settings) {
  return settings?.mode === 'provided';
}

// Reads the PEM certificate+key pair named by `certificatePath`/`keyPath`. Delegates
// certificate parsing to `loadCertificate` (Task 2) rather than reimplementing it, then
// separately reads the certificate's raw bytes for the credential — `loadCertificate`
// only hands back a parsed `X509Certificate`, not the original bytes `node:tls` needs
// verbatim for `cert`, so the file is read twice on the happy path. Both reads go through
// the same injectable `readFile`, so tests can still control every byte with one fake.
function loadPemCredential(certificatePath, keyPath, { readFile, createSecureContext }) {
  const certResult = loadCertificate(certificatePath, { readFile });
  if (!certResult.ok) return { ok: false, reason: certResult.reason };

  let certBytes;
  try {
    certBytes = readFile(certificatePath);
  } catch (error) {
    return {
      ok: false,
      reason: `could not read certificate file "${certificatePath}": ${error.message}`,
    };
  }

  let keyBytes;
  try {
    keyBytes = readFile(keyPath);
  } catch (error) {
    return { ok: false, reason: `could not read key file "${keyPath}": ${error.message}` };
  }

  // Prove the pair is actually usable together, exactly as the PFX path does. Reading two
  // files that each exist says nothing about whether the key belongs to the certificate;
  // without this a mismatched pair is only discovered when the TLS listener is built, which
  // is later and reports a bare OpenSSL "key values mismatch".
  const credential = { cert: certBytes, key: keyBytes };
  try {
    createSecureContext(credential);
  } catch (error) {
    return {
      ok: false,
      reason: `certificate "${certificatePath}" and key "${keyPath}" cannot be used together (${error.message})`,
    };
  }

  return {
    ok: true,
    certificate: certResult.certificate,
    credential,
    path: certificatePath,
  };
}

// PFX/PKCS12 loading (`loadPfxCredential`) now lives in `../pfx-credential.mjs`, shared
// with `windows-self-signed.mjs` (Task 6), which needs the identical leaf-extraction
// logic for its own freshly exported PFX. See that module for the full provenance
// comment on the undocumented internal Node API it depends on
// (`context.context.getCertificate()`). This extraction changed nothing about this
// strategy's own behavior — same shape, same wording, same defaults resolved the same
// way — only where the code lives.

// Loads the operator's configured certificate and reports whether it is usable.
//
// Returns `{ ok: true, credential, anchor, warnings }` on success (`warnings` is always
// an array, empty when there is nothing to report) or `{ ok: false, reason }` when the
// strategy is not configured, the file(s) could not be read or parsed, the passphrase was
// wrong, or the certificate has expired. Never throws: every failure mode a caller needs
// to show in the host UI or log is folded into `reason` instead.
//
// A certificate that does not cover every one of the machine's current addresses is
// *not* a failure here — `warnings` gets an entry and the certificate still loads,
// because the operator configuring their own certificate may know something the address
// discovery does not (a public hostname behind a reverse proxy, a VPN address, etc.).
// Expiry is the one condition that is always fatal: an expired certificate is never
// silently served.
export function provision(
  settings,
  {
    readFile = readFileSync,
    createSecureContext = nodeCreateSecureContext,
    localAddresses = discoverLocalAddresses,
    now,
  } = {},
) {
  if (!isAvailable(settings)) {
    return {
      ok: false,
      reason: `the provided strategy is not available: TLS mode is "${settings?.mode}", not "provided"`,
    };
  }

  const loaded =
    settings.pfxPath !== null
      ? loadPfxCredential(settings.pfxPath, settings.pfxPassphrase, {
          readFile,
          createSecureContext,
        })
      : loadPemCredential(settings.certificatePath, settings.keyPath, {
          readFile,
          createSecureContext,
        });

  if (!loaded.ok) return loaded;
  const { certificate, credential, path } = loaded;

  // IMPORTANT: check `expired` alone (not `needsRenewal`) — see certificate-facts.mjs's
  // doc comment on `renewalStatus` for why the two are mutually exclusive by design.
  const status = renewalStatus(certificate, now ? { now } : undefined);
  if (status.expired) {
    return {
      ok: false,
      reason: `certificate "${path}" has expired (valid until ${status.validTo.toISOString()})`,
    };
  }

  const coverage = checkCoverage(certificate, localAddresses());
  const warnings = coverage.covered
    ? []
    : [
        `certificate "${path}" does not cover this machine's current address(es): ` +
          `${coverage.missing.join(', ')}`,
      ];

  return { ok: true, credential, anchor: certificate, warnings };
}

// The stable strategy object Task 7 selects between. `mkcert.mjs` (Task 5) and
// `self-signed.mjs` (Task 6) each export the same three members under their own name.
export const providedStrategy = { name, isAvailable, provision };
