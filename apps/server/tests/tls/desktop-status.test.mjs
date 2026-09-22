// The `tls` field carried on the desktop host's periodic `status` message.
//
// Two properties matter more than the field-by-field mapping and are asserted directly:
// the raw `failureReason` never escapes into the payload (it can embed the operator's
// certificate paths), and `expired`/`needsRenewal` are reported as two independent facts
// so the host UI can apply `expired || needsRenewal` rather than being handed a single
// boolean that has already collapsed them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { tlsDesktopStatus } from '../../src/tls/desktop-status.mjs';
import { anchorReport, ENROLMENT_REQUIRED } from '../../src/tls/anchor.mjs';
import { fingerprint } from '../../src/tls/certificate-facts.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../fixtures/tls/${relativePath}`, import.meta.url));

const validAnchor = () => new X509Certificate(readFileSync(fixture('valid/cert.pem')));
const expiredAnchor = () => new X509Certificate(readFileSync(fixture('expired/cert.pem')));

// Exactly what `createTlsListener().report()` returns: `anchorReport`'s output plus the
// listener's own latest failure text. Built through the real `anchorReport` so this test
// cannot drift from the shape the host actually receives.
const report = (anchor, failureReason = null) => ({
  ...anchorReport(anchor ? { ok: true, strategy: 'windows-self-signed', anchor } : null),
  failureReason,
});

const settings = (changes = {}) => ({ mode: 'auto', port: 4383, ...changes });

test('a serving listener reports every field the host section shows', () => {
  const anchor = validAnchor();
  const field = tlsDesktopStatus({
    settings: settings(),
    status: { active: true, port: 4383 },
    report: report(anchor),
  });
  assert.equal(field.mode, 'auto');
  assert.equal(field.active, true);
  assert.equal(field.port, 4383);
  assert.equal(field.strategy, 'windows-self-signed');
  assert.equal(field.enrolmentStatus, ENROLMENT_REQUIRED);
  assert.equal(field.fingerprint, fingerprint(anchor));
  assert.equal(field.expiry, anchor.validToDate.toISOString());
  assert.equal(field.expired, false);
  assert.equal(field.reason, null);
});

test('the field is JSON-serialisable and carries no certificate object', () => {
  const field = tlsDesktopStatus({
    settings: settings(),
    status: { active: true, port: 4383 },
    report: report(validAnchor()),
  });
  const round = JSON.parse(JSON.stringify(field));
  assert.deepEqual(Object.keys(round).sort(), [
    'active',
    'enrolmentStatus',
    'expired',
    'expiry',
    'fingerprint',
    'mode',
    'needsRenewal',
    'port',
    'reason',
    'strategy',
  ]);
  assert.equal(round.anchor, undefined);
});

test('expired and needsRenewal are reported as two separate facts', () => {
  const expired = tlsDesktopStatus({
    settings: settings(),
    status: { active: true, port: 4383 },
    report: report(expiredAnchor()),
  });
  // The pair an `expired || needsRenewal` reader needs: an already-dead certificate is
  // `expired: true, needsRenewal: false`, so a host UI testing only the second would show
  // nothing at all for it.
  assert.equal(expired.expired, true);
  assert.equal(expired.needsRenewal, false);

  const anchor = validAnchor();
  const insideWindow = tlsDesktopStatus({
    settings: settings(),
    status: { active: true, port: 4383 },
    report: report(anchor),
    now: () => new Date(anchor.validToDate.getTime() - 24 * 60 * 60 * 1000),
  });
  assert.equal(insideWindow.expired, false);
  assert.equal(insideWindow.needsRenewal, true);
});

test('a raw failureReason never reaches the payload, and provided mode says so plainly', () => {
  const leaky =
    'provided: could not read certificate file "C:\\Users\\operator\\secrets\\wildcard.pem": ENOENT';
  const field = tlsDesktopStatus({
    settings: settings({ mode: 'provided' }),
    status: { active: false, port: null },
    report: report(null, leaky),
  });
  assert.equal(field.active, false);
  assert.equal(field.strategy, null);
  assert.equal(field.fingerprint, null);
  assert.equal(field.expiry, null);
  assert.ok(field.reason, 'a failure must never be silent');
  for (const secret of ['operator', 'wildcard.pem', 'ENOENT', 'C:\\'])
    assert.ok(!field.reason.includes(secret), `reason leaked "${secret}": ${field.reason}`);
  assert.match(field.reason, /Nothing was generated in its place/);
  assert.match(field.reason, /4383/);
});

test('a failure in auto mode names the port and stays generic', () => {
  const field = tlsDesktopStatus({
    settings: settings({ port: 4499 }),
    status: { active: false, port: null },
    report: report(null, 'port 4499 is already in use'),
  });
  assert.match(field.reason, /HTTPS could not be started on port 4499/);
});

test('a failed re-check while still serving is reported without claiming TLS is down', () => {
  const field = tlsDesktopStatus({
    settings: settings(),
    status: { active: true, port: 4383 },
    report: report(validAnchor(), 'certificate rotation failed (bad key)'),
  });
  assert.equal(field.active, true);
  assert.match(field.reason, /still running on the certificate it already had/);
  assert.ok(!field.reason.includes('bad key'));
});

test('before the first attempt finishes the host is told HTTPS is pending, not broken', () => {
  const field = tlsDesktopStatus({
    settings: settings(),
    status: { active: false, port: null },
    report: report(null),
  });
  assert.equal(field.reason, 'HTTPS has not started yet.');
});

test('mode off is a configuration, not a failure', () => {
  const field = tlsDesktopStatus({
    settings: settings({ mode: 'off' }),
    status: { active: false, port: null },
    report: report(null),
  });
  assert.equal(field.mode, 'off');
  assert.equal(field.active, false);
  assert.equal(field.reason, null);
});
