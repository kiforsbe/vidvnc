// Shared PFX/PKCS12 credential loading. Extracted from `strategies/provided.mjs` (Task
// 4) so the two strategies that both need to turn PFX bytes into a `node:tls`-ready
// credential plus a parsed leaf `X509Certificate` — `provided.mjs` (an operator's own
// PFX) and `strategies/windows-self-signed.mjs` (a freshly issued and exported leaf) —
// share one call site's worth of risk against the undocumented internal Node API this
// depends on, not two. Moving this did not change its behavior: every caller still gets
// exactly the same `{ ok, certificate, credential, path }` / `{ ok: false, reason }`
// shape, with the same wording, that `provided.mjs` produced before the extraction.
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createSecureContext as nodeCreateSecureContext } from 'node:tls';

// Reads the PFX/PKCS12 file named by `pfxPath` and extracts its leaf certificate.
//
// There is no public Node API that turns a PFX into an `X509Certificate` directly (only
// `node:crypto`'s `X509Certificate` constructor exists, and it parses PEM/DER, not
// PKCS12). Rather than adding a PEM-conversion step — which the design explicitly rules
// out — this builds a real `tls` secure context from the PFX (the same call `node:tls`
// itself would make to actually serve it) and reads the leaf back off the context's
// native handle via `.context.getCertificate()`, which returns the leaf's DER bytes.
// Creating the context this way also proves the credential is genuinely usable: a wrong
// or missing passphrase fails right here, synchronously, as a decrypt/MAC error — exactly
// the "wrong passphrase reported as a configuration error" case callers must catch.
//
// Provenance of `.context.getCertificate()`, since it is not part of the documented
// `tls.SecureContext` surface: it is Node's native `SecureContext::GetCertificate`,
// registered in `src/crypto/crypto_context.cc` via
// `SetProtoMethodNoSideEffect(isolate, tmpl, "getCertificate", GetCertificate<true>)`.
// Confirmed present and registered identically at both `v20.6.0` (this repo's floor) and
// `v22.0.0` in Node's own source — an old, stable binding behind Node's multi-cert/SNI
// support, not something that appeared later in the 20-26 range. It is unrelated to
// nodejs/node#26724, an attempt at a *documented* JS-level wrapper of the same name that
// was never merged (closed 2020) — this code calls the already-shipped native method
// directly, not that abandoned wrapper. Both ways this can go wrong — the method being
// absent, or it returning something `X509Certificate` rejects (e.g. `null`) — are inside
// the `try` below and come back as `{ ok: false, reason }` before a broken anchor could
// ever reach `renewalStatus`/`checkCoverage` (see provided.test.mjs's "internal API"
// tests, which pin exactly this with a fake `createSecureContext`).
export function loadPfxCredential(
  pfxPath,
  passphrase,
  { readFile = readFileSync, createSecureContext = nodeCreateSecureContext } = {},
) {
  let pfxBytes;
  try {
    pfxBytes = readFile(pfxPath);
  } catch (error) {
    return { ok: false, reason: `could not read PFX file "${pfxPath}": ${error.message}` };
  }

  const normalizedPassphrase = passphrase ?? undefined;
  const credential = { pfx: pfxBytes, passphrase: normalizedPassphrase };

  let context;
  try {
    context = createSecureContext(credential);
  } catch (error) {
    return {
      ok: false,
      reason: `could not load PFX file "${pfxPath}" (check the passphrase): ${error.message}`,
    };
  }

  let certificate;
  try {
    certificate = new X509Certificate(context.context.getCertificate());
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the certificate inside PFX file "${pfxPath}": ${error.message}`,
    };
  }

  return { ok: true, certificate, credential, path: pfxPath };
}
