import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import {
  isAvailable,
  provision,
  windowsSelfSignedStrategy,
  name,
} from '../../../src/tls/strategies/windows-self-signed.mjs';
import { defaultTlsSettings } from '../../../src/tls/tls-settings.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../../fixtures/tls/${relativePath}`, import.meta.url));

// Stands in for a leaf this strategy would itself export via Export-PfxCertificate.
// Its own SANs/subject are irrelevant to these tests: the "does the loader accept the
// export" tests only care that a real PFX round-trips through node:tls, not that its
// contents match what a real New-SelfSignedCertificate call produced.
const validPfxPath = fixture('pfx/cert.pfx');
const VALID_PFX_PASSPHRASE = 'vidvnc-test-pfx-passphrase';

function selfSignedSettings(overrides) {
  return { ...defaultTlsSettings(), mode: 'auto', ...overrides };
}

// A fresh scratch directory per test, confined entirely to the OS temp dir, so the
// strategy under test never touches real VidVNC state.
function makeScratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vidvnc-windows-self-signed-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Builds a fake `spawnSync` that never spawns anything real. It classifies each call by
// inspecting the PowerShell script text passed after `-Command` and routes it to
// `onCreate`/`onExport`/`onRemove`, throwing loudly if a call arrives with no handler
// supplied — this is what proves, e.g., that cleanup is never attempted when nothing was
// ever created, or that issuance is exactly the only call made in a given test.
function fakeSpawnSync({ onCreate, onExport, onRemove } = {}) {
  const calls = [];
  const fn = (command, args) => {
    assert.equal(command, 'powershell.exe');
    const commandIndex = args.indexOf('-Command');
    assert.ok(commandIndex !== -1, 'expected a -Command argument');
    const script = args[commandIndex + 1];
    calls.push(script);

    if (script.includes('New-SelfSignedCertificate')) {
      if (!onCreate) throw new Error(`unexpected create invocation: ${script}`);
      return onCreate(script);
    }
    if (script.includes('Export-PfxCertificate')) {
      if (!onExport) throw new Error(`unexpected export invocation: ${script}`);
      return onExport(script);
    }
    if (script.includes('Remove-Item')) {
      if (!onRemove) throw new Error(`unexpected remove invocation: ${script}`);
      return onRemove(script);
    }
    throw new Error(`unrecognized PowerShell script: ${script}`);
  };
  fn.calls = calls;
  return fn;
}

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: undefined });
const failed = (stderr) => ({ status: 1, stdout: '', stderr, error: undefined });

test('the module exposes the shared strategy shape: name, isAvailable, provision', () => {
  assert.equal(name, 'windows-self-signed');
  assert.equal(windowsSelfSignedStrategy.name, 'windows-self-signed');
  assert.equal(windowsSelfSignedStrategy.isAvailable, isAvailable);
  assert.equal(windowsSelfSignedStrategy.provision, provision);
  assert.equal(typeof windowsSelfSignedStrategy.isAvailable, 'function');
  assert.equal(typeof windowsSelfSignedStrategy.provision, 'function');
});

// --- isAvailable: platform + PowerShell probe, never throws, always injectable ---

test('isAvailable is false on non-Windows platforms, without even probing PowerShell', () => {
  const spawnSync = () => {
    throw new Error('must not be called on a non-Windows platform');
  };
  assert.doesNotThrow(() => isAvailable(selfSignedSettings(), { platform: 'linux', spawnSync }));
  assert.equal(isAvailable(selfSignedSettings(), { platform: 'linux', spawnSync }), false);
  assert.equal(isAvailable(selfSignedSettings(), { platform: 'darwin', spawnSync }), false);
});

test('isAvailable is true on Windows when PowerShell resolves', () => {
  const spawnSync = () => ok();
  assert.equal(isAvailable(selfSignedSettings(), { platform: 'win32', spawnSync }), true);
});

test('isAvailable is false on Windows when PowerShell itself fails to run', () => {
  const spawnSync = () => {
    const error = new Error('spawnSync powershell.exe ENOENT');
    error.code = 'ENOENT';
    return { status: null, stdout: '', stderr: '', error };
  };
  assert.doesNotThrow(() => isAvailable(selfSignedSettings(), { platform: 'win32', spawnSync }));
  assert.equal(isAvailable(selfSignedSettings(), { platform: 'win32', spawnSync }), false);
});

test('isAvailable is false when spawnSync itself throws', () => {
  const spawnSync = () => {
    throw new Error('boom');
  };
  assert.doesNotThrow(() => isAvailable(selfSignedSettings(), { platform: 'win32', spawnSync }));
  assert.equal(isAvailable(selfSignedSettings(), { platform: 'win32', spawnSync }), false);
});

// --- provision: non-Windows reports unavailable rather than throwing ---

test('provision reports unavailable on non-Windows platforms rather than throwing', (t) => {
  const scratch = makeScratch(t);
  const spawnSync = () => {
    throw new Error('must not be called on a non-Windows platform');
  };

  assert.doesNotThrow(() =>
    provision(selfSignedSettings(), {
      platform: 'linux',
      spawnSync,
      certificateDirectory: () => join(scratch, 'state'),
    }),
  );
  const result = provision(selfSignedSettings(), {
    platform: 'linux',
    spawnSync,
    certificateDirectory: () => join(scratch, 'state'),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not available/i);
  assert.match(result.reason, /"linux"/);
});

// --- SAN request shape ---

test('the SAN request includes every discovered hostname and IP, with IPs expressed as IP entries and not as DNS names', (t) => {
  const scratch = makeScratch(t);
  const discovered = {
    hostnames: ['localhost', 'my-machine'],
    ips: ['127.0.0.1', '192.168.1.50'],
    errors: [],
  };

  let createScript;
  const spawnSync = fakeSpawnSync({
    onCreate: (script) => {
      createScript = script;
      return ok('FAKETHUMBPRINT1234567890\r\n');
    },
    onExport: () => failed('export not reached in this test'),
    onRemove: () => ok(),
  });

  provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: () => discovered,
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.ok(createScript, 'expected New-SelfSignedCertificate to be invoked');
  for (const hostname of discovered.hostnames) {
    assert.ok(
      createScript.includes(`DNS=${hostname}`),
      `expected the SAN request to include DNS=${hostname}`,
    );
  }
  for (const ip of discovered.ips) {
    assert.ok(
      createScript.includes(`IPAddress=${ip}`),
      `expected the SAN request to include IPAddress=${ip}`,
    );
    // The fact this task depends on: IPs must be genuine IP-typed SAN entries, never
    // smuggled in as DNS names.
    assert.ok(
      !createScript.includes(`DNS=${ip}`),
      `expected the SAN request to never carry ${ip} as a DNS entry`,
    );
  }
});

// --- tooling failures are reported with the tool's own message ---

test("a tooling failure issuing the certificate is reported as a reason with the tool's message, and nothing is cleaned up", (t) => {
  const scratch = makeScratch(t);
  const spawnSync = fakeSpawnSync({
    onCreate: () => failed('New-SelfSignedCertificate : Access is denied. (very specific message)'),
  });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Access is denied\. \(very specific message\)/);
  assert.equal(result.credential, undefined);
  assert.equal(result.anchor, undefined);
  // No certificate was ever created, so no cleanup call should have been attempted.
  assert.equal(spawnSync.calls.length, 1);
});

test('spawnSync itself throwing (PowerShell not found) is reported as a reason, not thrown', (t) => {
  const scratch = makeScratch(t);
  const spawnSync = () => {
    const error = new Error('spawnSync powershell.exe ENOENT');
    error.code = 'ENOENT';
    return { status: null, stdout: '', stderr: '', error };
  };

  assert.doesNotThrow(() =>
    provision(selfSignedSettings(), {
      platform: 'win32',
      spawnSync,
      localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
      certificateDirectory: () => join(scratch, 'state'),
    }),
  );
  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
    certificateDirectory: () => join(scratch, 'state'),
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.match(result.reason, /ENOENT|powershell/i);
});

// --- cleanup: the store entry is removed on both the success and failure paths ---

test("a tooling failure exporting the certificate is reported with the tool's message, and the temporary store entry is still cleaned up (including its key, via -DeleteKey)", (t) => {
  const scratch = makeScratch(t);
  let removeScript;
  const spawnSync = fakeSpawnSync({
    onCreate: () => ok('DEADBEEF00112233\r\n'),
    onExport: () =>
      failed('Export-PfxCertificate : The specified network password is not correct.'),
    onRemove: (script) => {
      removeScript = script;
      return ok();
    },
  });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /network password is not correct/);
  assert.equal(result.credential, undefined);
  assert.equal(result.anchor, undefined);

  // Cleanup happened even though export failed, named the same certificate that was
  // created, and included -DeleteKey so the key container does not linger either.
  assert.ok(removeScript, 'expected Remove-Item to be invoked even after export failed');
  assert.ok(removeScript.includes('DEADBEEF00112233'));
  assert.ok(removeScript.includes('-DeleteKey'));
});

test('on success, the export produces a credential the loader accepts, and the temporary store entry is cleaned up (including its key, via -DeleteKey)', (t) => {
  const scratch = makeScratch(t);
  let removeScript;
  let removeCallCount = 0;
  const spawnSync = fakeSpawnSync({
    onCreate: () => ok('C0FFEE1234567890\r\n'),
    onExport: (script) => {
      // Extracts the -FilePath the implementation asked to export to, and drops a real
      // PFX (the fixture) there — standing in for what a real Export-PfxCertificate call
      // would have written, so the credential-loading half of this strategy is exercised
      // against real bytes, not a fake buffer.
      const match = script.match(/-FilePath\s+'([^']+)'/);
      assert.ok(match, `expected an -FilePath argument in: ${script}`);
      copyFileSync(validPfxPath, match[1]);
      return ok();
    },
    onRemove: (script) => {
      removeCallCount += 1;
      removeScript = script;
      return ok();
    },
  });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
    certificateDirectory: () => join(scratch, 'state'),
    // Matches the fixture PFX's real passphrase, so the (fake) export step's canned PFX
    // bytes are actually decryptable with whatever passphrase provision() generated.
    randomPassphrase: () => VALID_PFX_PASSPHRASE,
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.warnings, []);

  // credential is a PFX, usable as-is by node:tls, never converted to PEM.
  assert.ok(Buffer.isBuffer(result.credential.pfx));
  assert.equal(result.credential.cert, undefined);
  assert.equal(result.credential.key, undefined);
  assert.equal(result.credential.passphrase, VALID_PFX_PASSPHRASE);
  assert.doesNotThrow(() => createSecureContext(result.credential));

  // The anchor IS the leaf: a self-signed certificate is its own anchor. Proven here by
  // rebuilding a secure context straight from the credential and confirming its leaf
  // (read the same way provided.mjs does) has the identical fingerprint as `anchor`.
  assert.ok(result.anchor instanceof X509Certificate);
  const contextFromCredential = createSecureContext(result.credential);
  const leafFromCredential = new X509Certificate(contextFromCredential.context.getCertificate());
  assert.equal(result.anchor.fingerprint256, leafFromCredential.fingerprint256);

  // Cleanup happened on the success path too, named the same certificate, with -DeleteKey.
  assert.equal(removeCallCount, 1);
  assert.ok(removeScript.includes('C0FFEE1234567890'));
  assert.ok(removeScript.includes('-DeleteKey'));
});

test('when the issued PFX cannot actually be read back after a claimed-successful export, provision fails cleanly', (t) => {
  const scratch = makeScratch(t);
  // Export "succeeds" (exit 0) but never actually writes the file, mirroring
  // mkcert.mjs's "claimed success but output unreadable" case.
  const spawnSync = fakeSpawnSync({
    onCreate: () => ok('ABCDEF0011223344\r\n'),
    onExport: () => ok(),
    onRemove: () => ok(),
  });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.equal(result.credential, undefined);
  assert.equal(result.anchor, undefined);
});

// --- reuse across restarts: the sidecar passphrase makes the exported PFX reopenable ---
//
// Every reissue under this strategy invalidates every device that already trusts the
// previous leaf (the anchor IS the leaf here), so reuse is not a nice-to-have: it is
// what stops a normal restart from silently un-enrolling every device. Reuse only works
// because the passphrase used to export the PFX is persisted to a sidecar file next to
// it — these tests exercise that persistence directly, by pre-seeding the sidecar the
// way a prior provision() call would have left it.

// Matches `pfx/cert.pfx`'s real SAN set exactly (same fixture, same addresses used in
// provided.test.mjs), so coverage passes cleanly regardless of this machine's own
// addresses.
const addressesCoveredByFixturePfx = () => ({
  hostnames: ['vidvnc-test-pfx.invalid'],
  ips: ['127.0.0.1', '203.0.113.25'],
  errors: [],
});

// Seeds `stateDir` with exactly what a prior successful provision() call would have
// left behind: the exported PFX and (unless told not to) its passphrase sidecar.
function seedExistingCredential(
  stateDir,
  { passphrase = VALID_PFX_PASSPHRASE, withSidecar = true } = {},
) {
  mkdirSync(stateDir, { recursive: true });
  copyFileSync(validPfxPath, join(stateDir, 'cert.pfx'));
  if (withSidecar) {
    writeFileSync(join(stateDir, 'cert.pfx.passphrase'), passphrase, 'utf8');
  }
}

// A fake `spawnSync` that always succeeds end to end (create, export a copy of the real
// fixture PFX, remove), for the "this should reissue exactly once" tests below, where
// what matters is *whether* create was invoked and how many times, not its result.
function fullSuccessSpawnSync({ thumbprint = 'REISSUED0000000000' } = {}) {
  return fakeSpawnSync({
    onCreate: () => ok(`${thumbprint}\r\n`),
    onExport: (script) => {
      const match = script.match(/-FilePath\s+'([^']+)'/);
      assert.ok(match, `expected an -FilePath argument in: ${script}`);
      copyFileSync(validPfxPath, match[1]);
      return ok();
    },
    onRemove: () => ok(),
  });
}

test('a still-valid existing credential is reused with no PowerShell call at all', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  seedExistingCredential(stateDir);

  const spawnSync = () => {
    throw new Error('must not call PowerShell when an existing credential still serves');
  };

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: addressesCoveredByFixturePfx,
    certificateDirectory: () => stateDir,
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.credential.pfx, readFileSync(join(stateDir, 'cert.pfx')));
  assert.equal(result.credential.passphrase, VALID_PFX_PASSPHRASE);
  assert.equal(result.anchor.subject, 'CN=vidvnc-test-pfx.invalid');
  assert.deepEqual(result.warnings, []);
});

test('an expired existing credential is reissued exactly once, not reused', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  seedExistingCredential(stateDir);

  const spawnSync = fullSuccessSpawnSync({ thumbprint: 'EXPIREDREISSUE0001' });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: addressesCoveredByFixturePfx,
    certificateDirectory: () => stateDir,
    // Long past the fixture's real 2036-09-21 expiry.
    now: () => new Date('2040-01-01T00:00:00Z'),
    // Matches the fixture PFX's real passphrase, so the (fake) export step's canned PFX
    // bytes are actually decryptable with whatever passphrase provision() generated.
    randomPassphrase: () => VALID_PFX_PASSPHRASE,
  });

  assert.equal(result.ok, true, result.reason);
  const createCalls = spawnSync.calls.filter((script) =>
    script.includes('New-SelfSignedCertificate'),
  );
  assert.equal(createCalls.length, 1, 'expected exactly one reissue');
});

test('an existing credential inside its renewal window (but not yet expired) is reissued exactly once, not reused', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  seedExistingCredential(stateDir);

  const spawnSync = fullSuccessSpawnSync({ thumbprint: 'RENEWALWINDOW0001' });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: addressesCoveredByFixturePfx,
    certificateDirectory: () => stateDir,
    // 10 days before the fixture's 2036-09-21 expiry: inside the default 30-day renewal
    // window but not yet expired — proves `needsRenewal` alone triggers reissue too, per
    // certificate-facts.mjs's documented `expired || needsRenewal` rule (never
    // `needsRenewal` alone would still pass this test; `expired` alone would not).
    now: () => new Date('2036-09-11T00:00:00Z'),
    randomPassphrase: () => VALID_PFX_PASSPHRASE,
  });

  assert.equal(result.ok, true, result.reason);
  const createCalls = spawnSync.calls.filter((script) =>
    script.includes('New-SelfSignedCertificate'),
  );
  assert.equal(createCalls.length, 1, 'expected exactly one reissue');
});

test('an existing credential that no longer covers current addresses is reissued exactly once, not reused', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  seedExistingCredential(stateDir);

  const spawnSync = fullSuccessSpawnSync({ thumbprint: 'COVERAGELOSS0001' });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    // A brand-new address the fixture's SAN set does not cover at all.
    localAddresses: () => ({ hostnames: [], ips: ['10.0.0.250'], errors: [] }),
    certificateDirectory: () => stateDir,
    randomPassphrase: () => VALID_PFX_PASSPHRASE,
  });

  assert.equal(result.ok, true, result.reason);
  const createCalls = spawnSync.calls.filter((script) =>
    script.includes('New-SelfSignedCertificate'),
  );
  assert.equal(createCalls.length, 1, 'expected exactly one reissue');
});

test('a missing sidecar passphrase falls back to reissuing rather than failing', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  seedExistingCredential(stateDir, { withSidecar: false });

  const spawnSync = fullSuccessSpawnSync({ thumbprint: 'NOSIDECAR0001' });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: addressesCoveredByFixturePfx,
    certificateDirectory: () => stateDir,
    randomPassphrase: () => VALID_PFX_PASSPHRASE,
  });

  assert.equal(result.ok, true, result.reason);
  const createCalls = spawnSync.calls.filter((script) =>
    script.includes('New-SelfSignedCertificate'),
  );
  assert.equal(createCalls.length, 1, 'expected exactly one reissue');
});

test('an unreadable sidecar passphrase (pointing at a directory, not a file) falls back to reissuing rather than failing', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  seedExistingCredential(stateDir, { withSidecar: false });
  // A directory at the sidecar's path throws EISDIR on read — a different flavor of
  // "unreadable" than simply missing (ENOENT), and both must fall through to reissue.
  mkdirSync(join(stateDir, 'cert.pfx.passphrase'));

  const spawnSync = fullSuccessSpawnSync({ thumbprint: 'UNREADABLESIDECAR0001' });

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    localAddresses: addressesCoveredByFixturePfx,
    certificateDirectory: () => stateDir,
    randomPassphrase: () => VALID_PFX_PASSPHRASE,
  });

  assert.equal(result.ok, true, result.reason);
  const createCalls = spawnSync.calls.filter((script) =>
    script.includes('New-SelfSignedCertificate'),
  );
  assert.equal(createCalls.length, 1, 'expected exactly one reissue');
});

// --- mkdir failure: cleanup still happens, and a readable reason comes back ---

test('when creating the TLS state directory fails, the store entry is still cleaned up and a readable reason comes back', (t) => {
  const scratch = makeScratch(t);
  let removeScript;
  const spawnSync = fakeSpawnSync({
    onCreate: () => ok('MKDIRFAIL0001\r\n'),
    onRemove: (script) => {
      removeScript = script;
      return ok();
    },
  });

  const mkdir = () => {
    throw new Error('EACCES: permission denied, mkdir fake state dir');
  };

  const result = provision(selfSignedSettings(), {
    platform: 'win32',
    spawnSync,
    mkdir,
    localAddresses: () => ({ hostnames: ['localhost'], ips: ['127.0.0.1'], errors: [] }),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.match(result.reason, /permission denied|EACCES/);
  assert.equal(result.credential, undefined);
  assert.equal(result.anchor, undefined);

  // The certificate created in the store before mkdir failed was still cleaned up,
  // including its key container — export was never even attempted (no onExport handler
  // was supplied above; the fake would have thrown if it had been reached).
  assert.ok(removeScript, 'expected Remove-Item to be invoked even after mkdir failed');
  assert.ok(removeScript.includes('MKDIRFAIL0001'));
  assert.ok(removeScript.includes('-DeleteKey'));
});
