import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeMedia } from '../src/native-media.mjs';
import { SessionStore } from '../src/session-store.mjs';

test('disconnect and expiry revoke session ownership exactly once', () => {
  let now = 0;
  const revoked = [];
  const store = new SessionStore({
    clock: () => now,
    sessionTtlMs: 100,
    onRevoke: (id) => revoked.push(id),
  });
  const first = store.connect(store.password).sessionId;
  assert.equal(store.disconnect(first), true);
  assert.equal(store.disconnect(first), false);
  const second = store.connect(store.password).sessionId;
  now = 100;
  store.sweep();
  assert.equal(store.get(second), null);
  assert.deepEqual(revoked, [first, second]);
});
test('single-session configuration rejects a second authenticated client', () => {
  const store = new SessionStore();
  assert.equal(store.connect(store.password).ok, true);
  assert.deepEqual(store.connect(store.password), { ok: false, reason: 'busy' });
});
test('rotation revokes media ownership', () => {
  const revoked = [];
  const store = new SessionStore({ onRevoke: (id) => revoked.push(id) });
  const id = store.connect(store.password).sessionId;
  store.rotatePassword();
  assert.deepEqual(revoked, [id]);
  assert.equal(store.get(id), null);
});

const launch = () =>
  spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/media-process.mjs', import.meta.url))],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
const profile = (fps) => ({ name: 'fixture', fps, width: 1280, height: 720, bitrateKbps: 1000 });

test('intentional worker replacement does not revoke its reserved authenticated session', async (t) => {
  const store = new SessionStore({ maxSessions: 2 });
  const media = new NativeMedia({
    launch,
    onExit: (id, exit) => {
      if (!exit?.expected) store.disconnect(id);
    },
  });
  t.after(() => media.shutdown());
  const first = store.connect(store.password);
  await media.offer(first.sessionId, 'a', profile(15));
  await media.stop(first.sessionId);
  assert.ok(store.get(first.sessionId));
  const next = store.replaceSession(first.sessionId);
  assert.equal(next.ok, true);
  await assert.rejects(media.offer(next.sessionId, 'fail', profile(15)));
  assert.equal(store.get(next.sessionId), null);
});

test('workers have independent negotiation, metrics and teardown; closing workers retain capacity', async (t) => {
  const media = new NativeMedia({ maxWorkers: 2, launch });
  t.after(() => media.shutdown());
  assert.deepEqual(
    await Promise.all([media.offer('a', 'a', profile(15)), media.offer('b', 'b', profile(30))]),
    ['answer:a', 'answer:b'],
  );
  const a = media.workers.get('a');
  const b = media.workers.get('b');
  assert.equal(a.diagnostics.snapshot().server.captureFps, 15);
  assert.equal(b.diagnostics.snapshot().server.captureFps, 30);
  await assert.rejects(media.offer('a', 'replacement', profile(15)), { code: 'MEDIA_BUSY' });
  await assert.rejects(media.offer('c', 'c', profile(15)), { code: 'MEDIA_BUSY' });
  const closing = media.stop('a');
  assert.equal(media.stop('a'), closing);
  await assert.rejects(media.offer('c', 'c', profile(15)));
  await closing;
  assert.equal(a.child.exitCode, 0);
  assert.equal(b.child.exitCode, null);
  assert.equal(await media.offer('c', 'c', profile(15)), 'answer:c');
  await media.shutdown();
  assert.equal(media.workers.size, 0);
  assert.equal(b.child.exitCode, 0);
});

test('failed negotiation releases only its worker slot', async (t) => {
  const media = new NativeMedia({ maxWorkers: 2, launch });
  t.after(() => media.shutdown());
  await media.offer('a', 'a', profile(15));
  await assert.rejects(media.offer('b', 'fail', profile(30)));
  assert.equal(media.workers.size, 1);
  assert.equal(media.workers.get('a').child.exitCode, null);
  assert.equal(await media.offer('b', 'retry', profile(30)), 'answer:retry');
});

test('owner permission commands await acknowledgement from the addressed worker', async (t) => {
  const media = new NativeMedia({ maxWorkers: 2, launch, hostControl: true });
  t.after(() => media.shutdown());
  await media.offer('a', 'a', profile(15));
  await media.offer('b', 'b', profile(30));
  assert.equal(await media.setPermission('a', true), true);
  assert.equal(await media.setPermission('a', false), false);
  assert.equal(await media.setPermission('b', true), true);
  await assert.rejects(media.setPermission('absent', true), /inactive/i);
  await media.stop('a');
  await assert.rejects(media.setPermission('a', true), /inactive/i);
});
