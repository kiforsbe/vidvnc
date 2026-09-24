import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, isValidPasswordFormat } from '../src/session-store.mjs';

test('generates a readable password in the documented format', () => {
  const store = new SessionStore();

  assert.match(
    store.password,
    /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
  );
  assert.equal(isValidPasswordFormat(store.password), true);
  assert.equal(isValidPasswordFormat('2ABC-DEF3'), true);
  assert.equal(isValidPasswordFormat('0ABC-DEFG'), false);
  assert.equal(isValidPasswordFormat('abcd-efgh'), false);
  assert.equal(isValidPasswordFormat('ABCDE-FGHI'), false);
});

test('creates an authenticated session with control disabled', () => {
  const store = new SessionStore();

  const result = store.connect(store.password, '192.168.1.20');

  assert.equal(result.ok, true);
  assert.match(result.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(result.controlEnabled, false);
  assert.deepEqual(result.media, { state: 'unavailable' });
});

test('rejects a wrong password without revealing the valid password', () => {
  const store = new SessionStore();
  const wrongPassword = `${store.password[0] === 'A' ? 'B' : 'A'}${store.password.slice(1)}`;

  const result = store.connect(wrongPassword, '192.168.1.20');

  assert.deepEqual(result, { ok: false, reason: 'invalid-password' });
});

test('rotating unknown sources cannot permanently lock out a later valid source', () => {
  const store = new SessionStore({ maxAttempts: 1 });
  for (let i = 0; i < 1024; i++) assert.equal(store.connect('BAD', `192.0.2.${i}`).ok, false);
  assert.equal(store.connect(store.password, 'fresh-source').ok, true);
});

test('allows an active session to explicitly toggle control', () => {
  const store = new SessionStore();
  const session = store.connect(store.password, '192.168.1.20');

  assert.deepEqual(store.setControl(session.sessionId, true), { ok: true, controlEnabled: true });
  assert.equal(store.get(session.sessionId).controlEnabled, true);
  assert.deepEqual(store.setControl(session.sessionId, false), { ok: true, controlEnabled: false });
});

test('expires idle sessions and invalidates all sessions when stopped', () => {
  let now = 10_000;
  const store = new SessionStore({ clock: () => now, sessionTtlMs: 100 });
  const first = store.connect(store.password, '192.168.1.20');

  now += 101;
  assert.equal(store.get(first.sessionId), null);

  const second = store.connect(store.password, '192.168.1.20');
  const previousPassword = store.password;
  store.stop();

  assert.equal(store.get(second.sessionId), null);
  assert.notEqual(store.password, previousPassword);
});

test('explicit session-password rotation selects letters without disconnecting an existing session', () => {
  const store = new SessionStore({ maxSessions: 2 });
  const old = store.password;
  const connected = store.connect(old, '192.168.1.20');
  const next = store.rotateConnectionKey('letters', { globalLimit: 10, sourceLimit: 3 });
  assert.match(next, /^[A-HJKMNPQRSTUVWXYZ]{4}-[A-HJKMNPQRSTUVWXYZ]{4}$/);
  assert.notEqual(next, old);
  assert.equal(store.get(connected.sessionId)?.sessionId, connected.sessionId);
  assert.equal(store.connect(old, '192.168.1.21').ok, false);
  assert.deepEqual(
    store.keys.activeSession() && {
      globalLimit: store.keys.activeSession().globalLimit,
      sourceLimit: store.keys.activeSession().sourceLimit,
    },
    { globalLimit: 10, sourceLimit: 3 },
  );
});

test('rate-limits repeated failed passwords per client key', () => {
  const store = new SessionStore({ maxAttempts: 2, windowMs: 1_000 });

  assert.equal(store.connect('AAAA-BBBB', '192.168.1.20').reason, 'invalid-password');
  assert.equal(store.connect('AAAA-BBBB', '192.168.1.20').reason, 'invalid-password');
  assert.equal(store.connect('AAAA-BBBB', '192.168.1.20').reason, 'rate-limited');
});
