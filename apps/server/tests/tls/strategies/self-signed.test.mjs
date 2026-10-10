import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:tls';
import { connect } from 'node:tls';
import {
  ipBytes,
  isAvailable,
  issueCertificate,
  name,
  provision,
  selfSignedStrategy,
  VALIDITY_DAYS,
} from '../../../src/tls/strategies/self-signed.mjs';
import { defaultTlsSettings } from '../../../src/tls/tls-settings.mjs';

const settings = { ...defaultTlsSettings(), mode: 'auto' };
const addresses = {
  hostnames: ['localhost', 'Kims-MBP'],
  ips: ['127.0.0.1', '::1', '192.168.1.23', 'fd5e:2a1c:9b30:1::23'],
  errors: [],
};
const posix = process.platform !== 'win32';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'vidvnc-self-signed-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'VidVNC');
  return {
    data,
    state: join(data, 'tls', 'self-signed'),
    deps: (extra = {}) => ({
      platform: 'darwin',
      localAddresses: () => addresses,
      certificateDirectory: () => join(data, 'tls', 'self-signed'),
      dataRoot: () => data,
      ...extra,
    }),
  };
}

test('the module has the shared strategy shape and is never used on Windows', () => {
  assert.equal(name, 'self-signed');
  assert.deepEqual(selfSignedStrategy, { name, isAvailable, provision });
  assert.equal(isAvailable(settings, { platform: 'darwin' }), true);
  assert.equal(isAvailable(settings, { platform: 'linux' }), true);
  assert.equal(isAvailable(settings, { platform: 'win32' }), false);
  const refused = provision(settings, { platform: 'win32' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /not used on this platform/);
});

test('IP addresses become 4 or 16 bytes', () => {
  assert.equal(ipBytes('192.168.1.23').toString('hex'), 'c0a80117');
  assert.equal(ipBytes('::1').toString('hex'), '0'.repeat(31) + '1');
  assert.equal(ipBytes('fd5e:2a1c:9b30:1::23').toString('hex'), 'fd5e2a1c9b3000010000000000000023');
  assert.equal(ipBytes('::ffff:10.1.2.3').toString('hex'), '00000000000000000000ffff0a010203');
  assert.throws(() => ipBytes('not-an-ip'), /Not an IP address/);
});

test('the certificate is a P-256, self-signed, two-year server certificate for every address', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const { certificate, keyPem } = issueCertificate(addresses, { now });
  assert.equal(certificate.subject, 'CN=VidVNC');
  assert.equal(certificate.issuer, 'CN=VidVNC');
  assert.equal(certificate.ca, false);
  assert.ok(certificate.verify(certificate.publicKey), 'signed by its own key');
  assert.equal(certificate.publicKey.asymmetricKeyType, 'ec');
  assert.equal(certificate.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(
    certificate.validToDate.getTime() - now.getTime(),
    VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  );
  assert.ok(certificate.validFromDate < now);
  for (const host of addresses.hostnames) assert.ok(certificate.checkHost(host), host);
  for (const ip of addresses.ips) assert.ok(certificate.checkIP(ip), ip);
  // IPs are IP entries, never DNS names that look like them.
  assert.doesNotMatch(certificate.subjectAltName, /DNS:192\.168/);
  assert.match(keyPem, /BEGIN PRIVATE KEY/);
  // Two certificates never share a serial number.
  assert.notEqual(issueCertificate(addresses).certificate.serialNumber, certificate.serialNumber);
});

test('a TLS client that trusts the anchor completes a handshake by IP and by name', async (t) => {
  const s = scratch(t);
  const result = provision(settings, s.deps());
  assert.equal(result.ok, true);
  const server = createServer(result.credential, (socket) => socket.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const ca = result.anchor.toString();
  for (const servername of [undefined, 'localhost']) {
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(
        { host: '127.0.0.1', port: server.address().port, ca, servername },
        () => socket.once('data', (data) => resolve(data.toString())),
      );
      socket.once('error', reject);
    });
    assert.equal(reply, 'ok');
  }
});

test('the key is the user’s alone and is reused until it must change', async (t) => {
  const s = scratch(t);
  const first = provision(settings, s.deps());
  assert.equal(first.ok, true);
  const keyPath = join(s.state, 'key.pem');
  const certPath = join(s.state, 'cert.pem');
  assert.equal(readFileSync(certPath, 'utf8'), first.credential.cert.toString());
  if (posix) {
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    for (const directory of [s.data, join(s.data, 'tls'), s.state])
      assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  }

  // A restart reuses the same certificate, so devices keep trusting it.
  const second = provision(settings, s.deps());
  assert.equal(second.anchor.fingerprint256, first.anchor.fingerprint256);
  // A loosened key file is restricted again.
  if (posix) {
    chmodSync(keyPath, 0o644);
    provision(settings, s.deps());
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  }

  // A new address, the renewal window, `force` and a mismatched key each issue a new one.
  const moved = provision(
    settings,
    s.deps({ localAddresses: () => ({ ...addresses, ips: [...addresses.ips, '10.0.0.5'] }) }),
  );
  assert.notEqual(moved.anchor.fingerprint256, second.anchor.fingerprint256);
  assert.ok(moved.anchor.checkIP('10.0.0.5'));
  const later = () => new Date(Date.now() + (VALIDITY_DAYS - 10) * 24 * 60 * 60 * 1000);
  const renewed = provision(settings, s.deps({ now: later }));
  assert.notEqual(renewed.anchor.fingerprint256, moved.anchor.fingerprint256);
  const forced = provision(settings, s.deps({ force: true }));
  assert.notEqual(forced.anchor.fingerprint256, renewed.anchor.fingerprint256);
  writeFileSync(keyPath, issueCertificate(addresses).keyPem);
  const mismatched = provision(settings, s.deps());
  assert.notEqual(mismatched.anchor.fingerprint256, forced.anchor.fingerprint256);
  assert.ok(
    new X509Certificate(readFileSync(certPath)).checkPrivateKey(
      (await import('node:crypto')).createPrivateKey(readFileSync(keyPath)),
    ),
  );
});

test('damaged files are replaced, and a failure to save is a reason, never a throw', (t) => {
  const s = scratch(t);
  assert.equal(provision(settings, s.deps()).ok, true);
  writeFileSync(join(s.state, 'cert.pem'), 'not a certificate');
  assert.equal(provision(settings, s.deps()).ok, true);
  assert.match(readFileSync(join(s.state, 'cert.pem'), 'utf8'), /BEGIN CERTIFICATE/);
  const failed = provision(
    settings,
    s.deps({
      force: true,
      rename: () => {
        throw new Error('disk full');
      },
    }),
  );
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /could not save the certificate: disk full/);
  const noDirectory = provision(
    settings,
    s.deps({
      mkdir: () => {
        throw new Error('read-only');
      },
    }),
  );
  assert.match(noDirectory.reason, /could not create TLS state directory/);
});
