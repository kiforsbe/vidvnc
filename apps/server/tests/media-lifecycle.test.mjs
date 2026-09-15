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
  await assert.rejects(media.offer(next.sessionId, 'crash', profile(15)));
  assert.equal(store.get(next.sessionId), null);
});

test('sources negotiate peers independently, share metrics and keep capacity until exit', async (t) => {
  const metrics = [];
  const media = new NativeMedia({
    maxWorkers: 2,
    launch,
    onMetrics: (id, message) => metrics.push([id, message]),
  });
  t.after(() => media.shutdown());
  await Promise.all([
    media.start('a', { video: true, profile: profile(15) }),
    media.start('b', { video: true, profile: profile(30) }),
  ]);
  assert.equal(await media.addPeer('a', 'p1', 'x'), 'answer:x');
  assert.equal(await media.addPeer('a', 'p2', 'y'), 'answer:y');
  const a = media.workers.get('a');
  assert.deepEqual([...a.peers.keys()], ['p1', 'p2']);
  assert.equal(media.workers.size, 2);
  const [source, latest] = metrics.at(-1);
  assert.equal(source, 'a');
  assert.equal(latest.captureFps, 15);
  assert.equal(latest.peers.p2.videoRtpPackets, 2);
  await assert.rejects(media.addPeer('a', 'p1', 'z'), { code: 'MEDIA_BUSY' });
  await assert.rejects(media.start('c', { video: true, profile: profile(15) }), {
    code: 'MEDIA_BUSY',
  });
  const closing = media.stop('a');
  assert.equal(media.stop('a'), closing);
  await assert.rejects(media.start('c', { video: true, profile: profile(15) }), {
    code: 'MEDIA_BUSY',
  });
  await closing;
  assert.equal(a.child.exitCode, 0);
  await media.start('c', { video: true, profile: profile(15) });
  await media.shutdown();
  assert.equal(media.workers.size, 0);
});

test('peer failure, negotiation timeout and removal stay within one peer', async (t) => {
  const failures = [];
  const media = new NativeMedia({
    launch,
    negotiationTimeoutMs: 100,
    onPeerFailed: (...args) => failures.push(args),
  });
  t.after(() => media.shutdown());
  await media.start('s', { video: true, profile: profile(15) });
  await assert.rejects(media.addPeer('s', 'bad', 'fail'), /Invalid SDP/);
  const worker = media.workers.get('s');
  assert.equal(worker.child.exitCode, null);
  await assert.rejects(media.addPeer('s', 'slow', 'hang'), /timed out/);
  await media.removePeer('s', 'slow');
  assert.equal(await media.addPeer('s', 'live', 'x'), 'answer:x');
  const removing = media.removePeer('s', 'live');
  assert.equal(media.removePeer('s', 'live'), removing);
  await removing;
  assert.equal(worker.peers.has('live'), false);
  assert.equal(await media.addPeer('s', 'other', 'y'), 'answer:y');
  worker.child.stdin.write(JSON.stringify({ type: 'fail-peer', peerId: 'other' }) + '\n');
  while (!failures.length) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(failures, [['s', 'other', 'WebRTC connection failed.']]);
  assert.equal(worker.peers.has('other'), false);
  assert.equal(media.workers.has('s'), true);
});

test('unacknowledged removal stops the source', async (t) => {
  const media = new NativeMedia({ launch, removalTimeoutMs: 100 });
  t.after(() => media.shutdown());
  await media.start('s', { video: true, profile: profile(15) });
  await media.addPeer('s', 'p', 'no-remove');
  const worker = media.workers.get('s');
  await media.removePeer('s', 'p');
  assert.equal(media.workers.has('s'), false);
  assert.equal(worker.child.exitCode, 0);
});

test('owner permission commands address one peer', async (t) => {
  const media = new NativeMedia({ maxWorkers: 2, launch, hostControl: true });
  t.after(() => media.shutdown());
  await media.start('v', { video: true, profile: profile(15) });
  await media.addPeer('v', 'p1', 'x');
  await media.addPeer('v', 'p2', 'y');
  assert.equal(await media.setPermission('v', 'p1', true), true);
  assert.equal(await media.setPermission('v', 'p1', false), false);
  assert.equal(await media.setPermission('v', 'absent', true), false);
  await media.start('audio', { video: false, audioFormat: 'mono-32k' });
  await media.addPeer('audio', 'p1', 'x');
  assert.equal(await media.setPermission('audio', 'p1', true), false);
  await assert.rejects(media.setPermission('absent', 'p1', true), /inactive/i);
});

test('keyframes are limited per source', async (t) => {
  const media = new NativeMedia({ maxWorkers: 2, launch });
  t.after(() => media.shutdown());
  await media.start('a', { video: true, profile: profile(15) });
  await media.start('b', { video: true, profile: profile(15) });
  assert.equal(media.keyframe('a'), true);
  assert.equal(media.keyframe('a'), false);
  assert.equal(media.keyframe('b'), true);
  assert.equal(media.keyframe('absent'), false);
});

test('compatibility offer runs one worker-owned peer and frees the slot on failure', async (t) => {
  const media = new NativeMedia({ maxWorkers: 2, launch });
  t.after(() => media.shutdown());
  assert.equal(await media.offer('legacy', 'x', profile(15)), 'answer:x');
  assert.equal(media.workers.get('legacy').diagnostics.snapshot().server.captureFps, 15);
  await assert.rejects(media.offer('legacy', 'again', profile(15)), { code: 'MEDIA_BUSY' });
  assert.equal(media.workers.get('legacy').child.exitCode, null);
  await assert.rejects(media.offer('legacy2', 'fail', profile(15)), /Invalid SDP/);
  assert.equal(media.workers.has('legacy2'), false);
});
