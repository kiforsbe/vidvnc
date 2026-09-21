import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

const DEFAULT_RENEWAL_WINDOW_DAYS = 30;

// Reads and parses a certificate file into an X509Certificate, without throwing.
// A missing/unreadable file and a corrupt/non-certificate file are both reported as
// `{ ok: false, reason }` rather than propagating fs's or crypto's opaque errors, since
// callers (settings validation, strategy loading) need a reason they can show a user
// or log, not a stack trace from a module two layers away.
export function loadCertificate(path, { readFile = readFileSync } = {}) {
  let raw;
  try {
    raw = readFile(path);
  } catch (error) {
    return { ok: false, reason: `could not read certificate file "${path}": ${error.message}` };
  }

  try {
    return { ok: true, certificate: new X509Certificate(raw) };
  } catch (error) {
    return { ok: false, reason: `could not parse certificate file "${path}": ${error.message}` };
  }
}

// Checks whether `certificate` covers every hostname and IP address supplied. Takes the
// exact `{ hostnames, ips }` shape `localAddresses()` (Task 1) produces, so a caller can
// pass that result straight through without reshaping it; any other keys on the input
// (e.g. `errors`) are ignored.
//
// Coverage is decided through `certificate.checkHost`/`checkIP` — never by reading or
// pattern-matching `subjectAltName` text — because those are the only APIs that
// distinguish a genuine IP-typed SAN entry from a DNS entry whose text merely looks like
// one, and they apply the same hostname-matching rules (wildcards, case-insensitivity)
// Node's own TLS stack uses.
export function checkCoverage(certificate, { hostnames = [], ips = [] } = {}) {
  const missing = [];
  for (const hostname of hostnames) {
    if (!certificate.checkHost(hostname)) missing.push(hostname);
  }
  for (const ip of ips) {
    if (!certificate.checkIP(ip)) missing.push(ip);
  }
  return { covered: missing.length === 0, missing };
}

// Reports expiry and renewal-window facts for `certificate` as of `now`. `now` and
// `renewalWindowDays` are both injectable so callers (and tests) can evaluate "does this
// need renewal" at an arbitrary point in time without depending on a fixture that is only
// "inside the window" for a limited real-world period.
//
// `needsRenewal` is true only while the certificate is still valid but within the window
// — an already-expired certificate is `expired: true, needsRenewal: false`, since at that
// point it needs replacing outright, not "renewing soon".
//
// IMPORTANT for callers deciding whether to reissue/replace a credential: check
// `expired || needsRenewal`, never `needsRenewal` alone. `needsRenewal` is deliberately
// false once `expired` is true (the two are mutually exclusive by design, see above), so
// a reissue predicate that only tests `needsRenewal` will silently skip reissuing a
// credential that has already expired.
export function renewalStatus(
  certificate,
  { now = () => new Date(), renewalWindowDays = DEFAULT_RENEWAL_WINDOW_DAYS } = {},
) {
  const validTo = certificate.validToDate;
  const current = now();
  const expired = current >= validTo;
  const windowMs = renewalWindowDays * 24 * 60 * 60 * 1000;
  const needsRenewal = !expired && validTo.getTime() - current.getTime() <= windowMs;
  return { validTo, expired, needsRenewal };
}

// The certificate's SHA-256 fingerprint, already formatted by Node as uppercase
// colon-separated hex pairs (e.g. "AA:BB:CC:...") — stable across calls and suitable for
// a human to compare against a value shown on another device during enrolment.
export function fingerprint(certificate) {
  return certificate.fingerprint256;
}
