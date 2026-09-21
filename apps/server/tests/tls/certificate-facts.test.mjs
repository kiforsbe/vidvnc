import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import {
  loadCertificate,
  checkCoverage,
  renewalStatus,
  fingerprint,
} from '../../src/tls/certificate-facts.mjs';

const validCertPath = fileURLToPath(new URL('../fixtures/tls/valid/cert.pem', import.meta.url));
const expiredCertPath = fileURLToPath(new URL('../fixtures/tls/expired/cert.pem', import.meta.url));

function loadValidCertificate() {
  const result = loadCertificate(validCertPath);
  assert.equal(result.ok, true);
  return result.certificate;
}

test('a valid certificate file loads successfully', () => {
  const result = loadCertificate(validCertPath);
  assert.equal(result.ok, true);
  assert.ok(result.certificate instanceof X509Certificate);
});

test('the fixture actually carries genuine IP SAN entries, not DNS-smuggled text', () => {
  // Proof required by the task: checkIP only matches a real IP-typed SAN entry, so a
  // match here proves the fixture (and this assertion) aren't fooled by SAN text that
  // merely looks like an IP address inside a DNS entry.
  const certificate = loadValidCertificate();
  assert.equal(certificate.checkIP('203.0.113.25'), '203.0.113.25');
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
});

test('a certificate covering every required address passes', () => {
  const certificate = loadValidCertificate();
  const result = checkCoverage(certificate, {
    hostnames: ['vidvnc-test.invalid'],
    ips: ['127.0.0.1', '203.0.113.25'],
  });
  assert.deepEqual(result, { covered: true, missing: [] });
});

test('a certificate missing a required hostname fails and names it', () => {
  const certificate = loadValidCertificate();
  const result = checkCoverage(certificate, {
    hostnames: ['vidvnc-test.invalid', 'other-host.invalid'],
    ips: ['127.0.0.1'],
  });
  assert.equal(result.covered, false);
  assert.deepEqual(result.missing, ['other-host.invalid']);
});

test('a certificate missing a required IP fails and names it', () => {
  const certificate = loadValidCertificate();
  const result = checkCoverage(certificate, {
    hostnames: ['vidvnc-test.invalid'],
    ips: ['127.0.0.1', '10.0.0.99'],
  });
  assert.equal(result.covered, false);
  assert.deepEqual(result.missing, ['10.0.0.99']);
});

test('coverage is checked through checkHost/checkIP rather than SAN string matching', () => {
  // A naive implementation that regex-matches the raw subjectAltName string would be
  // fooled by, e.g., a DNS entry whose text merely contains an IP-looking substring.
  // Spy on the certificate to prove checkHost/checkIP are the mechanism actually used.
  const certificate = loadValidCertificate();
  let hostCalls = 0;
  let ipCalls = 0;
  const spy = {
    checkHost: (...args) => {
      hostCalls += 1;
      return certificate.checkHost(...args);
    },
    checkIP: (...args) => {
      ipCalls += 1;
      return certificate.checkIP(...args);
    },
  };
  const result = checkCoverage(spy, { hostnames: ['vidvnc-test.invalid'], ips: ['127.0.0.1'] });
  assert.deepEqual(result, { covered: true, missing: [] });
  assert.equal(hostCalls, 1);
  assert.equal(ipCalls, 1);
});

test('an unreadable file is reported as a reason rather than thrown', () => {
  const missingPath = fileURLToPath(new URL('../fixtures/tls/does-not-exist.pem', import.meta.url));
  const result = loadCertificate(missingPath);
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('a corrupt certificate file is reported as a reason rather than thrown', () => {
  const result = loadCertificate('ignored-path', {
    readFile: () => Buffer.from('this is not a certificate'),
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('an expired certificate is reported expired', () => {
  const loaded = loadCertificate(expiredCertPath);
  assert.equal(loaded.ok, true);
  const status = renewalStatus(loaded.certificate);
  assert.equal(status.expired, true);
  assert.equal(status.needsRenewal, false);
});

test('a certificate far from expiry does not need renewal', () => {
  const certificate = loadValidCertificate();
  const status = renewalStatus(certificate, {
    now: () => new Date('2026-09-21T00:00:00Z'),
    renewalWindowDays: 30,
  });
  assert.equal(status.expired, false);
  assert.equal(status.needsRenewal, false);
});

test('a certificate inside the renewal window is reported as needing renewal while still valid', () => {
  const certificate = loadValidCertificate();
  // validTo is 2036-09-21T13:29:38Z; inject a clock 10 days before that, well inside a
  // 30-day renewal window, so no time-bombed fixture is needed for this case.
  const status = renewalStatus(certificate, {
    now: () => new Date('2036-09-11T00:00:00Z'),
    renewalWindowDays: 30,
  });
  assert.equal(status.expired, false);
  assert.equal(status.needsRenewal, true);
});

test('renewalStatus reports validTo alongside the expired/needsRenewal facts', () => {
  const certificate = loadValidCertificate();
  const status = renewalStatus(certificate, { now: () => new Date('2026-09-21T00:00:00Z') });
  assert.ok(status.validTo instanceof Date);
  assert.equal(status.validTo.toISOString(), certificate.validToDate.toISOString());
});

test('the fingerprint is stable and formatted for a human to compare', () => {
  const certificate = loadValidCertificate();
  const first = fingerprint(certificate);
  const second = fingerprint(certificate);
  assert.equal(first, second);
  assert.match(first, /^[0-9A-F]{2}(:[0-9A-F]{2})*$/);
});
