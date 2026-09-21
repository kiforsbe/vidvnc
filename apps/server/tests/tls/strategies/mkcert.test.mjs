import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import {
  isAvailable,
  provision,
  mkcertStrategy,
  name,
} from '../../../src/tls/strategies/mkcert.mjs';
import { defaultTlsSettings } from '../../../src/tls/tls-settings.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../../fixtures/tls/${relativePath}`, import.meta.url));

// `valid/` stands in for a leaf mkcert would issue (real, parseable, 10-year validity).
const validLeafCertPath = fixture('valid/cert.pem');
const validLeafKeyPath = fixture('valid/key.pem');
// `expired/` stands in for the mkcert CA root in these tests: a second real, parseable
// certificate with a subject distinct from the leaf, so assertions can tell root and leaf
// apart. Its own expiry is irrelevant here — anchors are never expiry-checked.
const rootCertPath = fixture('expired/cert.pem');

// Addresses this fixture's leaf covers exactly, matching provided.test.mjs's pattern.
const addressesCoveredByValidLeaf = () => ({
  hostnames: ['vidvnc-test.invalid'],
  ips: ['127.0.0.1', '203.0.113.25'],
  errors: [],
});

function mkcertSettings(overrides) {
  return { ...defaultTlsSettings(), mode: 'auto', ...overrides };
}

// A fresh scratch directory per test, confined entirely to the OS temp dir, so the
// strategy under test never touches real VidVNC state or any real mkcert installation.
function makeScratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vidvnc-mkcert-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Builds a fake `spawnSync` that answers `mkcert -CAROOT` by pointing at `caRootDir`
// (which the caller must have already populated with a `rootCA.pem`), and hands issuance
// calls (`-cert-file ... -key-file ...`) to `onIssue`, or fails the test outright if no
// `onIssue` was supplied — this is what proves issuance was never attempted in the reuse
// test below.
function fakeSpawnSync({ caRootDir, caRootStatus = 0, caRootStderr = '', onIssue } = {}) {
  return (command, args) => {
    assert.equal(command, 'mkcert');
    if (args[0] === '-CAROOT') {
      return {
        status: caRootStatus,
        stdout: caRootDir ?? '',
        stderr: caRootStderr,
        error: undefined,
      };
    }
    if (!onIssue) {
      throw new Error(`unexpected mkcert issuance invocation with args: ${JSON.stringify(args)}`);
    }
    return onIssue(args);
  };
}

test('the module exposes the shared strategy shape: name, isAvailable, provision', () => {
  assert.equal(name, 'mkcert');
  assert.equal(mkcertStrategy.name, 'mkcert');
  assert.equal(mkcertStrategy.isAvailable, isAvailable);
  assert.equal(mkcertStrategy.provision, provision);
  assert.equal(typeof mkcertStrategy.isAvailable, 'function');
  assert.equal(typeof mkcertStrategy.provision, 'function');
});

test('isAvailable is false when the mkcert binary does not resolve', () => {
  const spawnSync = () => {
    const error = new Error('spawnSync mkcert ENOENT');
    error.code = 'ENOENT';
    return { status: null, stdout: '', stderr: '', error };
  };
  assert.doesNotThrow(() => isAvailable(mkcertSettings(), { spawnSync }));
  assert.equal(isAvailable(mkcertSettings(), { spawnSync }), false);
});

test('isAvailable is false when spawnSync itself throws', () => {
  const spawnSync = () => {
    throw new Error('boom');
  };
  assert.doesNotThrow(() => isAvailable(mkcertSettings(), { spawnSync }));
  assert.equal(isAvailable(mkcertSettings(), { spawnSync }), false);
});

test('isAvailable is true when the mkcert binary resolves and -CAROOT succeeds', () => {
  const spawnSync = fakeSpawnSync({ caRootDir: 'C:\\fake\\caroot' });
  assert.equal(isAvailable(mkcertSettings(), { spawnSync }), true);
});

test('isAvailable is false when mkcert resolves but -CAROOT exits non-zero', () => {
  const spawnSync = fakeSpawnSync({ caRootStatus: 1, caRootStderr: 'no CA found' });
  assert.equal(isAvailable(mkcertSettings(), { spawnSync }), false);
});

test('issuing passes every discovered hostname and IP to mkcert', (t) => {
  const scratch = makeScratch(t);
  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  const discovered = {
    hostnames: ['localhost', 'my-machine'],
    ips: ['127.0.0.1', '192.168.1.50'],
    errors: [],
  };

  let issueArgs;
  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: (args) => {
      issueArgs = args;
      const certFile = args[args.indexOf('-cert-file') + 1];
      const keyFile = args[args.indexOf('-key-file') + 1];
      writeFileSync(certFile, 'fake issued cert bytes');
      writeFileSync(keyFile, 'fake issued key bytes');
      return { status: 0, stdout: '', stderr: '', error: undefined };
    },
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => discovered,
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, true);
  for (const name of [...discovered.hostnames, ...discovered.ips]) {
    assert.ok(issueArgs.includes(name), `expected mkcert to be issued for ${name}`);
  }
});

test('the CA root path is located by asking mkcert, not guessed', (t) => {
  const scratch = makeScratch(t);
  // Deliberately not a conventional per-platform mkcert CAROOT location — proves the
  // strategy follows whatever `-CAROOT` reports rather than any hardcoded guess.
  const rootDir = join(scratch, 'wherever-mkcert-says-it-is');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));
  const expectedRoot = new X509Certificate(readFileSync(rootCertPath));

  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: (args) => {
      const certFile = args[args.indexOf('-cert-file') + 1];
      const keyFile = args[args.indexOf('-key-file') + 1];
      writeFileSync(certFile, 'fake issued cert bytes');
      writeFileSync(keyFile, 'fake issued key bytes');
      return { status: 0, stdout: '', stderr: '', error: undefined };
    },
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, true);
  assert.ok(result.anchor instanceof X509Certificate);
  assert.equal(result.anchor.subject, expectedRoot.subject);
  // Anchor is the CA root, not the freshly issued leaf.
  assert.notEqual(result.anchor.subject, 'CN=vidvnc-test.invalid');
});

test('a non-zero exit from mkcert issuance is reported as a reason, with its own message preserved', (t) => {
  const scratch = makeScratch(t);
  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: () => ({
      status: 1,
      stdout: '',
      stderr: 'mkcert: ERROR: failed to generate certificate: something specific went wrong',
      error: undefined,
    }),
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /failed to generate certificate: something specific went wrong/);
  assert.equal(result.credential, undefined);
  assert.equal(result.anchor, undefined);
});

test('a missing CA root file after mkcert claims success is reported, not a credential with no anchor', (t) => {
  const scratch = makeScratch(t);
  // -CAROOT reports a directory, but no rootCA.pem is ever placed inside it.
  const rootDir = join(scratch, 'caroot-missing-file');
  mkdirSync(rootDir, { recursive: true });

  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: (args) => {
      const certFile = args[args.indexOf('-cert-file') + 1];
      const keyFile = args[args.indexOf('-key-file') + 1];
      writeFileSync(certFile, 'fake issued cert bytes');
      writeFileSync(keyFile, 'fake issued key bytes');
      return { status: 0, stdout: '', stderr: '', error: undefined };
    },
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.match(result.reason, /rootCA\.pem/);
  // The leaf was successfully issued and readable, but must not leak through as a
  // credential with no anchor.
  assert.equal(result.credential, undefined);
  assert.equal(result.anchor, undefined);
});

test('issuing is not attempted at all when the existing credential still serves', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  mkdirSync(stateDir, { recursive: true });
  copyFileSync(validLeafCertPath, join(stateDir, 'cert.pem'));
  copyFileSync(validLeafKeyPath, join(stateDir, 'key.pem'));

  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  // No `onIssue` supplied: the fake throws if issuance is invoked at all.
  const spawnSync = fakeSpawnSync({ caRootDir: rootDir });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => stateDir,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.credential.cert, readFileSync(join(stateDir, 'cert.pem')));
  assert.deepEqual(result.credential.key, readFileSync(join(stateDir, 'key.pem')));
  assert.ok(result.anchor instanceof X509Certificate);
});

test('an existing but expired credential is reissued rather than reused', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  mkdirSync(stateDir, { recursive: true });
  copyFileSync(fixture('expired/cert.pem'), join(stateDir, 'cert.pem'));
  copyFileSync(fixture('expired/key.pem'), join(stateDir, 'key.pem'));

  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  let issued = false;
  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: (args) => {
      issued = true;
      const certFile = args[args.indexOf('-cert-file') + 1];
      const keyFile = args[args.indexOf('-key-file') + 1];
      writeFileSync(certFile, 'freshly issued cert bytes');
      writeFileSync(keyFile, 'freshly issued key bytes');
      return { status: 0, stdout: '', stderr: '', error: undefined };
    },
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => ({
      hostnames: ['vidvnc-test-expired.invalid'],
      ips: ['127.0.0.1'],
      errors: [],
    }),
    certificateDirectory: () => stateDir,
  });

  assert.equal(issued, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.credential.cert, Buffer.from('freshly issued cert bytes'));
});

test('an existing credential that no longer covers current addresses is reissued', (t) => {
  const scratch = makeScratch(t);
  const stateDir = join(scratch, 'state');
  mkdirSync(stateDir, { recursive: true });
  copyFileSync(validLeafCertPath, join(stateDir, 'cert.pem'));
  copyFileSync(validLeafKeyPath, join(stateDir, 'key.pem'));

  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  let issued = false;
  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: (args) => {
      issued = true;
      const certFile = args[args.indexOf('-cert-file') + 1];
      const keyFile = args[args.indexOf('-key-file') + 1];
      writeFileSync(certFile, 'freshly issued cert bytes');
      writeFileSync(keyFile, 'freshly issued key bytes');
      return { status: 0, stdout: '', stderr: '', error: undefined };
    },
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    // A brand-new address the existing fixture certificate does not cover at all.
    localAddresses: () => ({ hostnames: [], ips: ['10.0.0.250'], errors: [] }),
    certificateDirectory: () => stateDir,
  });

  assert.equal(issued, true);
  assert.equal(result.ok, true);
});

test('when no existing credential is present, one is issued and loaded', (t) => {
  const scratch = makeScratch(t);
  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  const spawnSync = fakeSpawnSync({
    caRootDir: rootDir,
    onIssue: (args) => {
      const certFile = args[args.indexOf('-cert-file') + 1];
      const keyFile = args[args.indexOf('-key-file') + 1];
      writeFileSync(certFile, 'brand new cert bytes');
      writeFileSync(keyFile, 'brand new key bytes');
      return { status: 0, stdout: '', stderr: '', error: undefined };
    },
  });

  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => join(scratch, 'state'),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.credential.cert, Buffer.from('brand new cert bytes'));
  assert.deepEqual(result.credential.key, Buffer.from('brand new key bytes'));
  assert.ok(result.anchor instanceof X509Certificate);
  assert.deepEqual(result.warnings, []);
});

test('when mkcert is unavailable (binary missing), provision fails cleanly rather than throwing', (t) => {
  const scratch = makeScratch(t);
  const spawnSync = () => {
    const error = new Error('spawnSync mkcert ENOENT');
    error.code = 'ENOENT';
    return { status: null, stdout: '', stderr: '', error };
  };

  assert.doesNotThrow(() =>
    provision(mkcertSettings(), {
      spawnSync,
      localAddresses: () => addressesCoveredByValidLeaf(),
      certificateDirectory: () => join(scratch, 'state'),
    }),
  );
  const result = provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => join(scratch, 'state'),
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('default dependencies (no explicit spawnSync) do not throw against this real machine', (t) => {
  // Uses the real, un-injected spawnSync against whatever mkcert (if any) is actually on
  // this machine's PATH — proves the default wiring works, whichever way it resolves.
  // certificateDirectory is still confined to a scratch temp dir so this never touches
  // real VidVNC state.
  const scratch = makeScratch(t);
  assert.doesNotThrow(() =>
    provision(mkcertSettings(), { certificateDirectory: () => join(scratch, 'state') }),
  );
  const result = provision(mkcertSettings(), {
    certificateDirectory: () => join(scratch, 'state'),
  });
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) assert.equal(typeof result.reason, 'string');
});

test('the strategy never attempts to install anything (no -install argument is ever passed)', (t) => {
  const scratch = makeScratch(t);
  const rootDir = join(scratch, 'caroot');
  mkdirSync(rootDir, { recursive: true });
  copyFileSync(rootCertPath, join(rootDir, 'rootCA.pem'));

  const seenArgs = [];
  const spawnSync = (command, args) => {
    seenArgs.push(args);
    if (args[0] === '-CAROOT') return { status: 0, stdout: rootDir, stderr: '', error: undefined };
    const certFile = args[args.indexOf('-cert-file') + 1];
    const keyFile = args[args.indexOf('-key-file') + 1];
    writeFileSync(certFile, 'cert bytes');
    writeFileSync(keyFile, 'key bytes');
    return { status: 0, stdout: '', stderr: '', error: undefined };
  };

  provision(mkcertSettings(), {
    spawnSync,
    localAddresses: () => addressesCoveredByValidLeaf(),
    certificateDirectory: () => join(scratch, 'state'),
  });

  for (const args of seenArgs) {
    assert.ok(!args.includes('-install'), `mkcert must never be invoked with -install (${args})`);
  }
});
