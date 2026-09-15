import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.mjs';

test('bounded sessions admit independent owners and reclaim only expired or disconnected slots', () => {
  let now = 0;
  const revoked = [];
  const store = new SessionStore({
    maxSessions: 2,
    clock: () => now,
    sessionTtlMs: 100,
    onRevoke: (id) => revoked.push(id),
  });
  const a = store.connect(store.password, 'a');
  now = 10;
  const b = store.connect(store.password, 'b');
  assert.equal(b.ok, true);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(store.connect(store.password, 'c').reason, 'busy');
  now = 101;
  store.sweep();
  assert.deepEqual(revoked, [a.sessionId]);
  assert.ok(store.get(b.sessionId));
  const c = store.connect(store.password, 'c');
  assert.equal(c.ok, true);
  store.disconnect(b.sessionId);
  assert.ok(store.get(c.sessionId));
  store.stop();
  assert.equal(store.list().length, 0);
  assert.equal(new Set(revoked).size, 3);
});

test('a live session limit applies to new admissions without evicting connected devices', () => {
  let limit = 1;
  const revoked = [];
  const store = new SessionStore({ maxSessions: () => limit, onRevoke: (id) => revoked.push(id) });
  const a = store.connect(store.password, 'a');
  assert.equal(store.connect(store.password, 'b').reason, 'busy');
  limit = 3;
  assert.equal(store.maxSessions, 3);
  const b = store.connect(store.password, 'b');
  assert.equal(store.connect(store.password, 'c').ok, true);
  limit = 1;
  assert.equal(store.list().length, 3);
  assert.deepEqual(revoked, []);
  store.disconnect(a.sessionId);
  store.disconnect(b.sessionId);
  assert.equal(store.connect(store.password, 'd').reason, 'busy');
  limit = 0;
  assert.throws(() => store.maxSessions, /session limit/i);
});

test('invalid session limits cannot silently allow unbounded admission', () => {
  for (const maxSessions of [0, -1, Infinity, NaN, 1.5, '2', 65])
    assert.throws(() => new SessionStore({ maxSessions }), /session limit/i);
});
