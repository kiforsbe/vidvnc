import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeIssuer } from '../src/code-issuance.mjs';
import { ConnectionKeyRegistry } from '../src/connection-keys.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { AdmissionBudget } from '../src/admission-budget.mjs';

test('owner issuance snapshots configured lifetime, limits and per-request alphabet', () => {
  let now = 1_000;
  let settings = {
    connectionMode: 'session-key',
    shortCodeTtlSeconds: 60,
    shortCodeMaxFailures: 12,
    shortCodePerSourceMaxFailures: 3,
    sessionPasswordMaxFailures: 9,
    defaultCodeAlphabet: 'letters-digits',
  };
  const keys = new ConnectionKeyRegistry({ clock: () => now });
  const store = new SessionStore({ keys, clock: () => now, maxSessions: 2 });
  const issuer = createCodeIssuer({ access: { snapshot: () => settings }, sessionStore: store });
  const first = issuer.oneTime('letters');
  assert.match(first.key, /^[A-HJKMNPQRSTUVWXYZ]{4}-[A-HJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(first.expiresAt, now + 60_000);
  assert.equal(keys.activeEphemeral().generation, first.generation);
  assert.equal(keys.activeEphemeral().globalLimit, 12);
  assert.equal(keys.activeEphemeral().sourceLimit, 3);
  settings = { ...settings, shortCodeTtlSeconds: 120, shortCodeMaxFailures: 10 };
  const second = issuer.setup();
  assert.equal(second.expiresAt, now + 120_000);
  assert.equal(keys.inspect(first.key), null);
  assert.match(second.key, /^[23456789A-HJKMNPQRSTUVWXYZ]{4}-[23456789A-HJKMNPQRSTUVWXYZ]{4}$/);
  const active = store.connect(store.password, '192.168.1.20');
  const rotated = issuer.rotateSession('letters');
  assert.match(rotated.key, /^[A-HJKMNPQRSTUVWXYZ]{4}-[A-HJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(store.get(active.sessionId)?.sessionId, active.sessionId);
  assert.equal(keys.activeSession().globalLimit, 9);
  now += 120_000;
  assert.equal(keys.inspect(second.key), null);
  assert.throws(() => issuer.oneTime('unsafe'), /alphabet/i);
});

test('owner status reports active-code expiry and generation-matched lockout without revealing a key', () => {
  const settings = {
    connectionMode: 'one-time-keys',
    shortCodeTtlSeconds: 60,
    shortCodeMaxFailures: 1,
    shortCodePerSourceMaxFailures: 1,
    sessionPasswordMaxFailures: 2,
    defaultCodeAlphabet: 'letters-digits',
  };
  const keys = new ConnectionKeyRegistry();
  const store = new SessionStore({ keys });
  const admission = new AdmissionBudget();
  const issuer = createCodeIssuer({
    access: { snapshot: () => settings },
    sessionStore: store,
    admission,
  });
  const issued = issuer.oneTime();
  const attempt = admission.beginKeyStart('192.0.2.1', {
    ephemeral: keys.activeEphemeral(),
    session: null,
  });
  attempt.finish(null, false);
  const status = issuer.status();
  assert.equal(status.ephemeral.expiresAt, issued.expiresAt);
  assert.equal(status.ephemeral.locked, true);
  assert.equal(JSON.stringify(status).includes(issued.key), false);
  issuer.oneTime();
  assert.equal(issuer.status().ephemeral.locked, false);
});
