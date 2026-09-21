import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { anchorReport } from '../../src/tls/anchor.mjs';
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

test('no credential at all (TLS off, or total provisioning failure) reports inactive, with nothing to enrol', () => {
  for (const result of [
    { ok: false, attempted: false, strategy: null, anchor: null },
    { ok: false, attempted: true, strategy: null, anchor: null },
    undefined,
    null,
  ]) {
    const report = anchorReport(result);
    assert.equal(report.active, false);
    assert.equal(report.needsEnrolment, false);
    assert.equal(report.strategy, null);
    assert.equal(report.anchor, null);
    assert.equal(report.fingerprint, null);
  }
});

test('a self-signed anchor (mkcert root or windows-self-signed leaf) is active and needs enrolment', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'windows-self-signed', anchor });

  assert.equal(report.active, true);
  assert.equal(report.needsEnrolment, true);
  assert.equal(report.strategy, 'windows-self-signed');
  assert.equal(report.anchor, anchor);
  assert.equal(report.fingerprint, certificateFingerprint(anchor));
});

test('an mkcert CA root anchor is also active and needs enrolment (a root is self-signed by definition)', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'mkcert', anchor });

  assert.equal(report.active, true);
  assert.equal(report.needsEnrolment, true);
});

test('a "provided" certificate chained to something else reports active, with nothing to enrol', () => {
  const anchor = chainedAnchor();
  const report = anchorReport({ ok: true, strategy: 'provided', anchor });

  assert.equal(report.active, true);
  assert.equal(report.needsEnrolment, false);
  assert.equal(report.strategy, 'provided');
  assert.equal(report.anchor, anchor);
  assert.equal(report.fingerprint, 'DE:AD:BE:EF:00:11:22:33');
});

test('a self-issued "provided" certificate (operator rolled their own) still needs enrolment', () => {
  const anchor = selfSignedAnchor();
  const report = anchorReport({ ok: true, strategy: 'provided', anchor });

  assert.equal(report.active, true);
  assert.equal(report.needsEnrolment, true);
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
