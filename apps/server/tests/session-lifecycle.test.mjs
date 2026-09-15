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

test('invalid session limits cannot silently allow unbounded admission', () => {
  for (const maxSessions of [0, -1, Infinity, NaN, 1.5, '2', 65])
    assert.throws(() => new SessionStore({ maxSessions }), /session limit/i);
});
