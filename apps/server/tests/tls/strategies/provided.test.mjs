import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import {
  isAvailable,
  provision,
  providedStrategy,
  name,
} from '../../../src/tls/strategies/provided.mjs';
import { defaultTlsSettings } from '../../../src/tls/tls-settings.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../../fixtures/tls/${relativePath}`, import.meta.url));

const validCertPath = fixture('valid/cert.pem');
const validKeyPath = fixture('valid/key.pem');
const expiredCertPath = fixture('expired/cert.pem');
const expiredKeyPath = fixture('expired/key.pem');
const validPfxPath = fixture('pfx/cert.pfx');
const VALID_PFX_PASSPHRASE = 'vidvnc-test-pfx-passphrase';

// Matches `valid/cert.pem`'s SAN set exactly, so coverage passes cleanly regardless of
// whatever addresses this machine actually has.
const addressesCoveredByValidPem = () => ({
  hostnames: ['vidvnc-test.invalid'],
  ips: ['127.0.0.1', '203.0.113.25'],
  errors: [],
});

// Matches `pfx/cert.pfx`'s SAN set exactly.
const addressesCoveredByValidPfx = () => ({
  hostnames: ['vidvnc-test-pfx.invalid'],
  ips: ['127.0.0.1', '203.0.113.25'],
  errors: [],
});

const addressesNotCoveredByEither = () => ({
  hostnames: ['totally-different-host.invalid'],
  ips: ['10.0.0.1'],
  errors: [],
});

function providedSettings(overrides) {
  return { ...defaultTlsSettings(), mode: 'provided', ...overrides };
}

test('the module exposes the shared strategy shape: name, isAvailable, provision', () => {
  assert.equal(name, 'provided');
  assert.equal(providedStrategy.name, 'provided');
  assert.equal(providedStrategy.isAvailable, isAvailable);
  assert.equal(providedStrategy.provision, provision);
  assert.equal(typeof providedStrategy.isAvailable, 'function');
  assert.equal(typeof providedStrategy.provision, 'function');
});

test('isAvailable is true only when mode is "provided"', () => {
  assert.equal(isAvailable(providedSettings()), true);
  assert.equal(isAvailable(defaultTlsSettings()), false); // mode: 'auto'
  assert.equal(isAvailable({ ...defaultTlsSettings(), mode: 'off' }), false);
  assert.equal(isAvailable(undefined), false);
  assert.equal(isAvailable(null), false);
});

test('the strategy reports unavailable rather than throwing when the mode is not provided', () => {
  assert.doesNotThrow(() => provision(defaultTlsSettings()));
  const result = provision(defaultTlsSettings());
  assert.equal(result.ok, false);
  assert.match(result.reason, /not available/i);
  assert.match(result.reason, /"auto"/);

  assert.doesNotThrow(() => provision(null));
  assert.doesNotThrow(() => provision(undefined));
  assert.equal(provision(null).ok, false);
});

test('a valid PEM pair loads', () => {
  const settings = providedSettings({ certificatePath: validCertPath, keyPath: validKeyPath });
  const result = provision(settings, { localAddresses: addressesCoveredByValidPem });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.anchor instanceof X509Certificate);
  assert.equal(result.anchor.subject, 'CN=vidvnc-test.invalid');

  // The credential must carry what node:tls needs directly, as a PEM pair.
  assert.ok(Buffer.isBuffer(result.credential.cert));
  assert.ok(Buffer.isBuffer(result.credential.key));
  assert.equal(result.credential.pfx, undefined);
  // Proves node:tls actually accepts this credential as-is, not just that it looks right.
  assert.doesNotThrow(() => createSecureContext(result.credential));
});

test('a valid PFX loads', () => {
  const settings = providedSettings({ pfxPath: validPfxPath, pfxPassphrase: VALID_PFX_PASSPHRASE });
  const result = provision(settings, { localAddresses: addressesCoveredByValidPfx });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.anchor instanceof X509Certificate);
  assert.equal(result.anchor.subject, 'CN=vidvnc-test-pfx.invalid');

  // The credential must carry the PFX through as a PFX, never converted to PEM.
  assert.ok(Buffer.isBuffer(result.credential.pfx));
  assert.equal(result.credential.cert, undefined);
  assert.equal(result.credential.key, undefined);
  assert.equal(result.credential.passphrase, VALID_PFX_PASSPHRASE);
  assert.doesNotThrow(() => createSecureContext(result.credential));
});

test('a passphrase-protected PFX loaded with no passphrase fails cleanly, not with a crash', () => {
  // tls-settings.mjs's default is `null`; node:tls expects `string | undefined` for
  // `passphrase`, so this strategy must normalize `null` -> `undefined` rather than pass
  // `null` straight through and risk a TypeError instead of a reported reason.
  const settings = providedSettings({ pfxPath: validPfxPath, pfxPassphrase: null });
  assert.doesNotThrow(() => provision(settings, { localAddresses: addressesCoveredByValidPfx }));
  const result = provision(settings, { localAddresses: addressesCoveredByValidPfx });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes(validPfxPath));
});

test('a wrong passphrase is reported as a configuration error naming the file', () => {
  const settings = providedSettings({
    pfxPath: validPfxPath,
    pfxPassphrase: 'not-the-right-passphrase',
  });
  const result = provision(settings, { localAddresses: addressesCoveredByValidPfx });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.includes(validPfxPath));
  // Names the actual problem too, not just the file — a regression that kept the path
  // but dropped the "check the passphrase" wording would otherwise still pass this test.
  assert.match(result.reason, /passphrase/i);
});

test('a broken internal getCertificate binding fails cleanly rather than throwing or producing a broken anchor', () => {
  // Pins this module's top named risk: extracting the PFX's leaf certificate goes
  // through an internal, undocumented Node handle (`context.context.getCertificate()`),
  // not a public API. Both ways that handle could misbehave — the method being absent,
  // or returning something `X509Certificate` rejects — must come back as a clean
  // `{ ok: false, reason }`, never a thrown error and never a truthy `result.anchor` that
  // downstream code (renewalStatus/checkCoverage) could be handed anyway.
  const settings = providedSettings({ pfxPath: validPfxPath, pfxPassphrase: VALID_PFX_PASSPHRASE });

  // Sub-mode 1: the native method is simply not there (e.g. a future Node that renamed
  // or removed it) — `context.context.getCertificate` is not a function.
  const missingMethod = provision(settings, {
    localAddresses: addressesCoveredByValidPfx,
    createSecureContext: () => ({ context: {} }),
  });
  assert.equal(missingMethod.ok, false);
  assert.equal(typeof missingMethod.reason, 'string');
  assert.ok(missingMethod.reason.length > 0);
  assert.equal(missingMethod.credential, undefined);
  assert.equal(missingMethod.anchor, undefined);

  // Sub-mode 2: the native method exists but returns something `X509Certificate` rejects
  // (`null`) — this is what makes `new X509Certificate(null)` throw a TypeError.
  const nullCertificate = provision(settings, {
    localAddresses: addressesCoveredByValidPfx,
    createSecureContext: () => ({ context: { getCertificate: () => null } }),
  });
  assert.equal(nullCertificate.ok, false);
  assert.equal(typeof nullCertificate.reason, 'string');
  assert.ok(nullCertificate.reason.length > 0);
  assert.equal(nullCertificate.credential, undefined);
  assert.equal(nullCertificate.anchor, undefined);

  // Neither sub-mode throws out of provision() itself.
  assert.doesNotThrow(() =>
    provision(settings, {
      localAddresses: addressesCoveredByValidPfx,
      createSecureContext: () => ({ context: {} }),
    }),
  );
  assert.doesNotThrow(() =>
    provision(settings, {
      localAddresses: addressesCoveredByValidPfx,
      createSecureContext: () => ({ context: { getCertificate: () => null } }),
    }),
  );
});

test('a missing certificate file is reported with its path', () => {
  const missingPath = fixture('does-not-exist.pem');
  const settings = providedSettings({ certificatePath: missingPath, keyPath: validKeyPath });
  const result = provision(settings, { localAddresses: addressesCoveredByValidPem });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes(missingPath));
});

test('a missing key file is reported with its path', () => {
  const missingKeyPath = fixture('valid/does-not-exist-key.pem');
  const settings = providedSettings({ certificatePath: validCertPath, keyPath: missingKeyPath });
  const result = provision(settings, { localAddresses: addressesCoveredByValidPem });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes(missingKeyPath));
});

test('a missing PFX file is reported with its path', () => {
  const missingPfxPath = fixture('does-not-exist.pfx');
  const settings = providedSettings({ pfxPath: missingPfxPath, pfxPassphrase: 'anything' });
  const result = provision(settings, { localAddresses: addressesCoveredByValidPfx });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes(missingPfxPath));
});

test('an expired certificate is reported as expired rather than loaded', () => {
  const settings = providedSettings({ certificatePath: expiredCertPath, keyPath: expiredKeyPath });
  const result = provision(settings, {
    localAddresses: () => ({
      hostnames: ['vidvnc-test-expired.invalid'],
      ips: ['127.0.0.1'],
      errors: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/i);
  assert.equal(result.credential, undefined);
});

test("a certificate that covers none of the machine's current addresses produces a warning but still loads", () => {
  const settings = providedSettings({ certificatePath: validCertPath, keyPath: validKeyPath });
  const result = provision(settings, { localAddresses: addressesNotCoveredByEither });

  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /totally-different-host\.invalid/);
  assert.match(result.warnings[0], /10\.0\.0\.1/);
  // Still loads: credential and anchor are present and usable, same as the clean case.
  assert.ok(result.anchor instanceof X509Certificate);
  assert.doesNotThrow(() => createSecureContext(result.credential));
});

test("a certificate covering only some of the machine's current addresses names just the gap", () => {
  const settings = providedSettings({ certificatePath: validCertPath, keyPath: validKeyPath });
  const result = provision(settings, {
    localAddresses: () => ({
      hostnames: ['vidvnc-test.invalid'],
      ips: ['127.0.0.1', '203.0.113.25', '10.0.0.99'], // one extra, uncovered IP
      errors: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /10\.0\.0\.99/);
  assert.ok(!result.warnings[0].includes('vidvnc-test.invalid'));
});

test('default dependencies (no explicit localAddresses) do not throw against this real machine', () => {
  // Uses the real, un-injected localAddresses() — proves the default wiring works, even
  // though coverage against the fixture's fake SANs will realistically be incomplete.
  const settings = providedSettings({ certificatePath: validCertPath, keyPath: validKeyPath });
  assert.doesNotThrow(() => provision(settings));
  const result = provision(settings);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.warnings));
});
