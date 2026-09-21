import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import {
  anchorReport,
  ENROLMENT_REQUIRED,
  ENROLMENT_UNKNOWN,
  ENROLMENT_NOT_REQUIRED,
} from '../../src/tls/anchor.mjs';
import { fingerprint as certificateFingerprint } from '../../src/tls/certificate-facts.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../fixtures/tls/${relativePath}`, import.meta.url));

// A real, self-signed fixture certificate (issuer === subject), standing in for both a
// `windows-self-signed` leaf and an mkcert CA root — both are self-signed by
// construction, per anchor.mjs's doc comment.
const selfSignedAnchor = () => new X509Certificate(readFileSync(fixture('valid/cert.pem')));

// A fake certificate object, not self-signed, standing in for a `provided`-mode
// certificate issued by something else (a real CA, or an internal one already deployed
// to the operator's devices). `anchorReport` only ever reads `.issuer`/`.subject` and
// hands the object to `certificate-facts.mjs`'s `fingerprint()`, which reads only
// `.fingerprint256` — a plain object with those three properties is indistinguishable
// from a real `X509Certificate` as far as this module is concerned.
const chainedAnchor = () => ({
  issuer: 'CN=Example Root CA',
  subject: 'CN=vidvnc.example.com',
  fingerprint256: 'DE:AD:BE:EF:00:11:22:33',
});

// `ENROLMENT_NOT_REQUIRED` exists as a named export/value but this test file never
// expects `anchorReport` to actually return it — see the comment on that constant in
// anchor.mjs: with the three strategies that exist today, only self-issued (REQUIRED) or
// provided-and-chained (UNKNOWN) are reachable. This import is exercised anyway (below)
// so a typo in the constant's own definition would still be caught.
test('ENROLMENT_NOT_REQUIRED is exported and distinct from the other two values', () => {
  assert.equal(typeof ENROLMENT_NOT_REQUIRED, 'string');
  assert.notEqual(ENROLMENT_NOT_REQUIRED, ENROLMENT_REQUIRED);
  assert.notEqual(ENROLMENT_NOT_REQUIRED, ENROLMENT_UNKNOWN);
});

test('no credential at all (TLS off, or total provisioning failure) reports inactive, with a null enrolment status', () => {
  for (const result of [
    { ok: false, attempted: false, strategy: null, anchor: null },
    { ok: false, attempted: true, strategy: null, anchor: null },
    undefined,
    null,
  ]) {
    const report = anchorReport(result);
    assert.equal(report.active, false);
    // Deliberately `null`, not `ENROLMENT_NOT_REQUIRED`: "is there anything to install"
    // does not apply when nothing is running over HTTPS at all. A consumer must not be
    // able to mistake this for a real "nothing to enrol" answer.
    assert.equal(report.enrolmentStatus, null);
    assert.equal(report.strategy, null);
    assert.equal(report.anchor, null);
    assert.equal(report.fingerprint, null);
  }
});

test('a self-signed anchor (mkcert root or windows-self-signed leaf) is active and enrolment is required', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'windows-self-signed', anchor });

  assert.equal(report.active, true);
  assert.equal(report.enrolmentStatus, ENROLMENT_REQUIRED);
  assert.equal(report.strategy, 'windows-self-signed');
  assert.equal(report.anchor, anchor);
  assert.equal(report.fingerprint, certificateFingerprint(anchor));
});

test('an mkcert CA root anchor is also active and required (a root is self-signed by definition)', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'mkcert', anchor });

  assert.equal(report.active, true);
  assert.equal(report.enrolmentStatus, ENROLMENT_REQUIRED);
});

test('a "provided" certificate chained to something else reports active, with an UNKNOWN enrolment status (never collapsed to a boolean default)', () => {
  const anchor = chainedAnchor();
  const report = anchorReport({ ok: true, strategy: 'provided', anchor });

  assert.equal(report.active, true);
  assert.equal(report.enrolmentStatus, ENROLMENT_UNKNOWN);
  // Guard against exactly the failure mode the review caught: naive boolean coercion of
  // an UNKNOWN status must not silently read as "nothing needed" (falsy) or be
  // indistinguishable from REQUIRED (truthy in the same way any non-empty string is).
  assert.notEqual(report.enrolmentStatus, ENROLMENT_NOT_REQUIRED);
  assert.notEqual(report.enrolmentStatus, ENROLMENT_REQUIRED);
  assert.equal(Boolean(report.enrolmentStatus), true); // never falsy — never silently skipped
  assert.equal(report.strategy, 'provided');
  assert.equal(report.anchor, anchor);
  assert.equal(report.fingerprint, 'DE:AD:BE:EF:00:11:22:33');
});

test('a self-issued "provided" certificate (operator rolled their own) is required, not unknown', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'provided', anchor });

  assert.equal(report.active, true);
  assert.equal(report.enrolmentStatus, ENROLMENT_REQUIRED);
});

test('a non-self-issued anchor from a strategy other than "provided" defaults to the safe REQUIRED outcome', () => {
  // Not reachable by any real strategy today (only `provided` can produce a
  // non-self-issued anchor), but `anchorReport` must still fail toward showing the user
  // what to trust rather than toward silence if that ever changes.
  const anchor = chainedAnchor();
  const report = anchorReport({ ok: true, strategy: 'some-future-strategy', anchor });

  assert.equal(report.enrolmentStatus, ENROLMENT_REQUIRED);
});

test('fingerprint is computed via certificate-facts.mjs, never reimplemented', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'mkcert', anchor });
  assert.equal(report.fingerprint, anchor.fingerprint256);
});

test('never throws on a malformed or partial result', () => {
  assert.doesNotThrow(() => anchorReport({}));
  assert.doesNotThrow(() => anchorReport({ ok: true }));
  assert.doesNotThrow(() => anchorReport({ ok: true, anchor: null }));
});
