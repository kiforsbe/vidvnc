import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultTlsSettings,
  validateTlsSettings,
  DEFAULT_TLS_PORT,
} from '../../src/tls/tls-settings.mjs';

test('defaults are auto mode on a sensible, non-colliding port with no certificate paths', () => {
  const defaults = defaultTlsSettings();
  assert.deepEqual(defaults, {
    mode: 'auto',
    port: DEFAULT_TLS_PORT,
    certificatePath: null,
    keyPath: null,
    pfxPath: null,
    pfxPassphrase: null,
  });
  assert.notEqual(defaults.port, 4382);
  assert.deepEqual(validateTlsSettings(defaults), defaults);
});

test('auto and off modes validate as-is and reject any certificate settings', () => {
  assert.deepEqual(validateTlsSettings({ mode: 'auto', port: 4400 }).mode, 'auto');
  assert.deepEqual(validateTlsSettings({ mode: 'off', port: 4400 }).mode, 'off');
  assert.throws(
    () => validateTlsSettings({ mode: 'off', port: 4400, certificatePath: 'a', keyPath: 'b' }),
    /provided mode/i,
  );
  assert.throws(
    () => validateTlsSettings({ mode: 'auto', port: 4400, pfxPath: 'a.pfx' }),
    /provided mode/i,
  );
});

test('provided mode validates with a certificate and key pair', () => {
  const value = validateTlsSettings({
    mode: 'provided',
    port: 4400,
    certificatePath: 'C:/certs/cert.pem',
    keyPath: 'C:/certs/key.pem',
  });
  assert.equal(value.mode, 'provided');
  assert.equal(value.certificatePath, 'C:/certs/cert.pem');
  assert.equal(value.keyPath, 'C:/certs/key.pem');
  assert.equal(value.pfxPath, null);
});

test('provided mode validates with a single PFX file and optional passphrase', () => {
  const value = validateTlsSettings({
    mode: 'provided',
    port: 4400,
    pfxPath: 'C:/certs/cert.pfx',
    pfxPassphrase: 'secret',
  });
  assert.equal(value.pfxPath, 'C:/certs/cert.pfx');
  assert.equal(value.pfxPassphrase, 'secret');

  const withoutPassphrase = validateTlsSettings({
    mode: 'provided',
    port: 4400,
    pfxPath: 'C:/certs/cert.pfx',
  });
  assert.equal(withoutPassphrase.pfxPassphrase, null);
});

test('an unknown mode is rejected by name', () => {
  assert.throws(() => validateTlsSettings({ mode: 'always', port: 4400 }), /mode/i);
});

test('port must be an in-range integer that does not collide with the plaintext port', () => {
  for (const port of [0, -1, 65536, 1.5, '4400', null, NaN])
    assert.throws(() => validateTlsSettings({ mode: 'auto', port }), /port/i);
  assert.throws(() => validateTlsSettings({ mode: 'auto', port: 4382 }), /plaintext/i);
  assert.doesNotThrow(() => validateTlsSettings({ mode: 'auto', port: 1 }));
  assert.doesNotThrow(() => validateTlsSettings({ mode: 'auto', port: 65535 }));
});

test('provided mode rejects neither a pair nor a PFX', () => {
  assert.throws(
    () => validateTlsSettings({ mode: 'provided', port: 4400 }),
    /certificate and key pair or a PFX/i,
  );
});

test('provided mode rejects both a pair and a PFX together', () => {
  assert.throws(
    () =>
      validateTlsSettings({
        mode: 'provided',
        port: 4400,
        certificatePath: 'a.pem',
        keyPath: 'b.pem',
        pfxPath: 'c.pfx',
      }),
    /not both/i,
  );
});

test('provided mode rejects a partial certificate/key pair', () => {
  assert.throws(
    () =>
      validateTlsSettings({
        mode: 'provided',
        port: 4400,
        certificatePath: 'a.pem',
        keyPath: null,
      }),
    /together/i,
  );
  assert.throws(
    () => validateTlsSettings({ mode: 'provided', port: 4400, keyPath: 'b.pem' }),
    /together/i,
  );
});

test('provided mode rejects a passphrase without a PFX file', () => {
  assert.throws(
    () =>
      validateTlsSettings({
        mode: 'provided',
        port: 4400,
        certificatePath: 'a.pem',
        keyPath: 'b.pem',
        pfxPassphrase: 'secret',
      }),
    /passphrase/i,
  );
});

test('certificate and key paths must be strings, not other types', () => {
  for (const bad of [1, true, {}, []])
    assert.throws(
      () =>
        validateTlsSettings({
          mode: 'provided',
          port: 4400,
          certificatePath: bad,
          keyPath: 'b.pem',
        }),
      /string path/i,
    );
  assert.throws(
    () => validateTlsSettings({ mode: 'provided', port: 4400, pfxPath: 42 }),
    /string path/i,
  );
  assert.throws(
    () => validateTlsSettings({ mode: 'provided', port: 4400, pfxPath: '' }),
    /string path/i,
  );
});

test('unknown keys are rejected', () => {
  assert.throws(() => validateTlsSettings({ mode: 'auto', port: 4400, unknown: true }), /unknown/i);
});

test('settings absent from an older file validate to the defaults without mutating the input', () => {
  const input = { mode: 'off' };
  const before = { ...input };
  const value = validateTlsSettings(input);
  assert.deepEqual(value, {
    mode: 'off',
    port: DEFAULT_TLS_PORT,
    certificatePath: null,
    keyPath: null,
    pfxPath: null,
    pfxPassphrase: null,
  });
  assert.deepEqual(input, before);
});

test('the validator rejects non-object input', () => {
  for (const bad of [null, undefined, 'x', 1, [], true])
    assert.throws(() => validateTlsSettings(bad), /object/i);
});
