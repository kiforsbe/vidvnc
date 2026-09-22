import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { ensureCertificate, DEFAULT_STRATEGIES } from '../../src/tls/ensure-certificate.mjs';
import { anchorReport } from '../../src/tls/anchor.mjs';
import { fingerprint as certificateFingerprint } from '../../src/tls/certificate-facts.mjs';
import { defaultTlsSettings } from '../../src/tls/tls-settings.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../fixtures/tls/${relativePath}`, import.meta.url));

function autoSettings(overrides) {
  return { ...defaultTlsSettings(), mode: 'auto', ...overrides };
}
function providedSettings(overrides) {
  return { ...defaultTlsSettings(), mode: 'provided', ...overrides };
}
function offSettings() {
  return { ...defaultTlsSettings(), mode: 'off' };
}

// Every fake strategy below is entirely self-contained: no fake ever touches the real
// filesystem, spawns a real process, or reaches VidVNC's real per-user state directory.
// This is the one hazard this task was warned about twice over (Tasks 5 and 6 each had a
// test slip through that reached real tooling); every strategy this module orchestrates
// is injected as a fake, with no exceptions and no default fallback to a real strategy.

// A fake that throws if either of its two contract methods is ever called — used to
// prove a strategy was never even consulted (not just that its result was ignored).
function neverCalledStrategy(name) {
  return {
    name,
    isAvailable() {
      throw new Error(`${name}.isAvailable must never be called in this test`);
    },
    provision() {
      throw new Error(`${name}.provision must never be called in this test`);
    },
  };
}

// A fake whose availability and outcome are both fixed, recording every call it
// receives (with the exact `settings`/`deps` it was invoked with) onto a shared `log`
// array so tests can assert both *that* and *in what order* strategies were consulted.
function fakeStrategy(name, { available = true, result, log = [] } = {}) {
  return {
    name,
    isAvailable(settings, deps) {
      log.push({ strategy: name, call: 'isAvailable' });
      return available;
    },
    provision(settings, deps) {
      log.push({ strategy: name, call: 'provision' });
      return result;
    },
  };
}

const okResult = (name, overrides = {}) => ({
  ok: true,
  credential: { cert: `${name}-cert`, key: `${name}-key` },
  anchor: { subject: `CN=${name}` },
  warnings: [],
  ...overrides,
});
const failResult = (reason) => ({ ok: false, reason });

test('the default strategy order is provided, then mkcert, then windows-self-signed', () => {
  assert.deepEqual(
    DEFAULT_STRATEGIES.map((s) => s.name),
    ['provided', 'mkcert', 'windows-self-signed'],
  );
});

test('in auto mode, strategies are consulted in order: provided, then mkcert, then self-signed', () => {
  const log = [];
  const strategies = [
    fakeStrategy('provided', { available: false, log }),
    fakeStrategy('mkcert', { available: true, result: failResult('mkcert not installed'), log }),
    fakeStrategy('windows-self-signed', {
      available: true,
      result: okResult('windows-self-signed'),
      log,
    }),
  ];

  const result = ensureCertificate(autoSettings(), { strategies });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'windows-self-signed');
  assert.deepEqual(
    log.map((entry) => entry.strategy),
    ['provided', 'mkcert', 'mkcert', 'windows-self-signed', 'windows-self-signed'],
  );
});

test('"provided" short-circuits: its failure is reported and nothing else is ever consulted', () => {
  const strategies = [
    fakeStrategy('provided', { available: true, result: failResult('wrong passphrase') }),
    neverCalledStrategy('mkcert'),
    neverCalledStrategy('windows-self-signed'),
  ];

  const result = ensureCertificate(providedSettings(), { strategies });

  assert.equal(result.ok, false);
  assert.equal(result.strategy, null);
  assert.equal(result.credential, null);
  assert.equal(result.anchor, null);
  assert.deepEqual(result.reasons, [{ strategy: 'provided', reason: 'wrong passphrase' }]);
  assert.match(result.reason, /wrong passphrase/);
});

test('"provided" mode never consults mkcert or self-signed even if they would have succeeded', () => {
  const strategies = [
    fakeStrategy('provided', { available: true, result: failResult('certificate expired') }),
    neverCalledStrategy('mkcert'),
    neverCalledStrategy('windows-self-signed'),
  ];

  assert.doesNotThrow(() => ensureCertificate(providedSettings(), { strategies }));
});

// Candidate selection for "provided" mode must be by strategy identity (`name`), not by
// list position — see ensure-certificate.mjs's module-level comment for why a positional
// `strategies[0]` check was rejected in review: nothing enforces that "index 0" and "the
// strategy named provided" stay the same thing. These two tests would both still pass
// under the old, rejected positional check if they used a normally-ordered list, so each
// deliberately puts `provided` somewhere other than first.
test('"provided" mode selects the strategy named "provided" by identity, even when it is not first in the list', () => {
  const strategies = [
    neverCalledStrategy('mkcert'), // deliberately first — position must not matter
    fakeStrategy('provided', { available: true, result: failResult('bad passphrase') }),
    neverCalledStrategy('windows-self-signed'),
  ];

  const result = ensureCertificate(providedSettings(), { strategies });

  assert.equal(result.ok, false);
  assert.equal(result.strategy, null);
  assert.deepEqual(result.reasons, [{ strategy: 'provided', reason: 'bad passphrase' }]);
});

test('"provided" mode ignores an unrelated strategy inserted before "provided" in the list, and still finds and wins on "provided"', () => {
  const strategies = [
    neverCalledStrategy('some-future-strategy'),
    fakeStrategy('provided', { available: true, result: okResult('provided') }),
    neverCalledStrategy('mkcert'),
    neverCalledStrategy('windows-self-signed'),
  ];

  const result = ensureCertificate(providedSettings(), { strategies });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'provided');
});

test('a failing mkcert falls through to self-signed and records why', () => {
  const log = [];
  const strategies = [
    fakeStrategy('provided', { available: false, log }),
    fakeStrategy('mkcert', { available: true, result: failResult('mkcert -CAROOT exited 1'), log }),
    fakeStrategy('windows-self-signed', {
      available: true,
      result: okResult('windows-self-signed'),
      log,
    }),
  ];

  const result = ensureCertificate(autoSettings(), { strategies });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'windows-self-signed');
  assert.deepEqual(result.credential, {
    cert: 'windows-self-signed-cert',
    key: 'windows-self-signed-key',
  });
  assert.deepEqual(result.reasons, [
    { strategy: 'provided', reason: 'provided is not available' },
    { strategy: 'mkcert', reason: 'mkcert -CAROOT exited 1' },
  ]);
});

test('total failure returns no credential and a reason, rather than throwing', () => {
  const strategies = [
    fakeStrategy('provided', { available: false }),
    fakeStrategy('mkcert', { available: true, result: failResult('mkcert not installed') }),
    fakeStrategy('windows-self-signed', {
      available: true,
      result: failResult('PowerShell unavailable'),
    }),
  ];

  let result;
  assert.doesNotThrow(() => {
    result = ensureCertificate(autoSettings(), { strategies });
  });

  assert.equal(result.ok, false);
  assert.equal(result.credential, null);
  assert.equal(result.anchor, null);
  assert.equal(typeof result.reason, 'string');
  assert.match(result.reason, /mkcert not installed/);
  assert.match(result.reason, /PowerShell unavailable/);
  assert.equal(result.reasons.length, 3);
});

test('mode "off" produces no credential without consulting any strategy at all', () => {
  const strategies = [
    neverCalledStrategy('provided'),
    neverCalledStrategy('mkcert'),
    neverCalledStrategy('windows-self-signed'),
  ];

  let result;
  assert.doesNotThrow(() => {
    result = ensureCertificate(offSettings(), { strategies });
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempted, false);
  assert.equal(result.strategy, null);
  assert.equal(result.credential, null);
  assert.equal(result.anchor, null);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.reason, null);
});

test('the returned report names the winning strategy and, via anchorReport, carries the anchor and fingerprint', () => {
  const anchor = new X509Certificate(readFileSync(fixture('valid/cert.pem')));
  const strategies = [
    fakeStrategy('provided', { available: false }),
    fakeStrategy('mkcert', {
      available: true,
      result: { ok: true, credential: { cert: 'c', key: 'k' }, anchor, warnings: [] },
    }),
    neverCalledStrategy('windows-self-signed'),
  ];

  const result = ensureCertificate(autoSettings(), { strategies });
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'mkcert');
  assert.equal(result.anchor, anchor);

  const report = anchorReport(result);
  assert.equal(report.active, true);
  assert.equal(report.strategy, 'mkcert');
  assert.equal(report.anchor, anchor);
  assert.equal(report.fingerprint, certificateFingerprint(anchor));
});

// --- Reissue triggers: proven through a fake that mimics the internal reuse pattern
// `mkcert.mjs`/`windows-self-signed.mjs` already implement and are already tested for in
// their own suites. What THIS layer is responsible for, and what these tests pin, is
// narrower: ensureCertificate() calls provision() exactly once per attempt, and
// whatever the strategy decided (reuse vs. reissue) passes through unmodified — this
// module adds no reissue arithmetic of its own that could fire a second time or
// disagree with the strategy's own decision.

// A minimal stand-in for "a strategy with internal reuse logic": `state` describes
// whatever would make a real strategy decide to reuse vs. reissue (absent, expired,
// inside the renewal window, no longer covering an address), and `state.writes` counts
// how many times this fake decided to "reissue" (its analogue of writing a new
// credential to disk). `calls` counts how many times `provision` itself was invoked.
function reuseAwareStrategy(name, state) {
  return {
    name,
    isAvailable: () => true,
    provision() {
      state.calls += 1;
      const mustReissue = state.absent || state.expired || state.needsRenewal || !state.covers;
      if (mustReissue) {
        state.writes += 1;
        state.credentialId += 1;
      }
      return {
        ok: true,
        credential: { id: state.credentialId },
        anchor: { subject: `CN=${name}-${state.credentialId}` },
        warnings: [],
      };
    },
  };
}

function reissueScenario(triggerState) {
  const state = {
    credentialId: 0,
    calls: 0,
    writes: 0,
    absent: false,
    expired: false,
    needsRenewal: false,
    covers: true,
    ...triggerState,
  };
  const strategies = [
    // In auto mode `provided` IS consulted (its `isAvailable` is called and legitimately
    // returns false, matching its real behaviour outside "provided" mode) — only its
    // `provision` must never run, since it never becomes available here.
    fakeStrategy('provided', { available: false }),
    reuseAwareStrategy('mkcert', state),
    neverCalledStrategy('windows-self-signed'),
  ];
  const result = ensureCertificate(autoSettings(), { strategies });
  return { result, state };
}

test('reissue trigger: credential absent causes exactly one reissue', () => {
  const { result, state } = reissueScenario({ absent: true, credentialId: 0 });
  assert.equal(result.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(state.writes, 1);
});

test('reissue trigger: an expired credential causes exactly one reissue', () => {
  const { result, state } = reissueScenario({ expired: true, credentialId: 5 });
  assert.equal(result.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(state.writes, 1);
});

test('reissue trigger: expiry inside the renewal window causes exactly one reissue', () => {
  const { result, state } = reissueScenario({ needsRenewal: true, credentialId: 5 });
  assert.equal(result.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(state.writes, 1);
});

test('reissue trigger: no longer covering a current address causes exactly one reissue', () => {
  const { result, state } = reissueScenario({ covers: false, credentialId: 5 });
  assert.equal(result.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(state.writes, 1);
});

test('a still-valid credential causes no reissue and no write', () => {
  const { result, state } = reissueScenario({ credentialId: 7 });
  assert.equal(result.ok, true);
  assert.equal(state.calls, 1);
  assert.equal(state.writes, 0);
  assert.equal(result.credential.id, 7);
});

test('every strategy is called uniformly with the same settings and deps object, never special-cased', () => {
  const receivedSettings = [];
  const receivedDeps = [];
  const settings = autoSettings();
  const deps = { readFile: () => {}, now: () => new Date() };
  const strategies = ['provided', 'mkcert', 'windows-self-signed'].map((name) => ({
    name,
    isAvailable(s, d) {
      receivedSettings.push(s);
      receivedDeps.push(d);
      return false;
    },
    provision() {
      throw new Error('must not be called when isAvailable is false');
    },
  }));

  ensureCertificate(settings, { ...deps, strategies });

  assert.equal(receivedSettings.length, 3);
  for (const s of receivedSettings) assert.equal(s, settings);
  for (const d of receivedDeps) {
    assert.equal(d.readFile, deps.readFile);
    assert.equal(d.now, deps.now);
  }
});

// `force` (Task 14's host UI regenerate action). This module owns only *forwarding* it —
// what "reissue" means stays inside each strategy, as the module header says. What is
// asserted here is the forwarding itself and the two places it is deliberately withheld.

// Records the `force` each strategy actually received, so the assertions below read the
// value at the boundary rather than inferring it from a strategy's behaviour.
function forceRecordingStrategy(name, { available = true, result, seen } = {}) {
  return {
    name,
    isAvailable(settings, deps) {
      seen.push({ strategy: name, call: 'isAvailable', force: deps.force });
      return available;
    },
    provision(settings, deps) {
      seen.push({ strategy: name, call: 'provision', force: deps.force });
      return result;
    },
  };
}

test('force is forwarded to the strategy that provisions, and defaults to false', () => {
  for (const [deps, expected] of [
    [{}, false],
    [{ force: false }, false],
    [{ force: true }, true],
  ]) {
    const seen = [];
    const strategies = [
      forceRecordingStrategy('provided', { available: false, seen }),
      forceRecordingStrategy('mkcert', { result: okResult('mkcert'), seen }),
    ];
    const result = ensureCertificate(autoSettings(), { ...deps, strategies });
    assert.equal(result.ok, true);
    assert.equal(
      seen.find((entry) => entry.strategy === 'mkcert' && entry.call === 'provision').force,
      expected,
    );
  }
});

test('force is never forwarded to the provided strategy, even when the caller asks for it', () => {
  const seen = [];
  // `auto` mode, where `provided` is still a candidate: it must be consulted normally but
  // never told to regenerate. An operator-supplied certificate is loaded, not generated.
  const strategies = [
    forceRecordingStrategy('provided', { result: okResult('provided'), seen }),
    forceRecordingStrategy('mkcert', { result: okResult('mkcert'), seen }),
  ];
  const result = ensureCertificate(autoSettings(), { force: true, strategies });
  assert.equal(result.strategy, 'provided');
  for (const entry of seen.filter((e) => e.strategy === 'provided'))
    assert.equal(entry.force, false, `provided was told to force on ${entry.call}`);
});

test('force in provided mode reaches nothing that could regenerate a certificate', () => {
  const seen = [];
  const strategies = [
    forceRecordingStrategy('provided', { result: okResult('provided'), seen }),
    neverCalledStrategy('mkcert'),
    neverCalledStrategy('windows-self-signed'),
  ];
  const result = ensureCertificate(providedSettings(), { force: true, strategies });
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'provided');
  assert.deepEqual(
    seen.map((entry) => entry.force),
    [false, false],
  );
});

test('force in mode off consults no strategy at all, so nothing is regenerated', () => {
  const strategies = [
    neverCalledStrategy('provided'),
    neverCalledStrategy('mkcert'),
    neverCalledStrategy('windows-self-signed'),
  ];
  const result = ensureCertificate(offSettings(), { force: true, strategies });
  assert.equal(result.ok, false);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, null);
});

test('every other dep is still forwarded unchanged alongside force', () => {
  const readFile = () => {};
  const now = () => new Date();
  let received;
  const strategies = [
    {
      name: 'mkcert',
      isAvailable: () => true,
      provision(settings, deps) {
        received = deps;
        return okResult('mkcert');
      },
    },
  ];
  ensureCertificate(autoSettings(), { readFile, now, force: true, strategies });
  assert.equal(received.readFile, readFile);
  assert.equal(received.now, now);
  assert.equal(received.force, true);
});
