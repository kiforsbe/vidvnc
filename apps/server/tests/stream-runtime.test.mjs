import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/session-store.mjs';
import { NativeMedia } from '../src/native-media.mjs';
import { DisplayInventory } from '../src/displays.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';

async function setup(t, defaultControl = 'approval') {
  const { StreamRuntime } = await import('../src/stream-runtime.mjs');
  const sessions = new SessionStore({ maxSessions: 2 });
  const media = new NativeMedia({
    maxWorkers: 6,
    hostControl: true,
    launch: () =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/media-process.mjs', import.meta.url))],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      ),
  });
  const policy = defaultStreamPolicy();
  const displays = [0, 1].map((index) => ({
    id: (index ? 'b' : 'a').repeat(64),
    name: `Display ${index + 1}`,
    primary: index === 0,
    persistent: true,
    x: index * 1920,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
  }));
  policy.displaySharing = Object.fromEntries(displays.map((d) => [d.id, true]));
  const inventory = new DisplayInventory(displays);
  const access = { defaultControl };
  const runtime = new StreamRuntime({
    sessions,
    media,
    inventory,
    access: { snapshot: () => ({ ...access }) },
    policy: { snapshot: () => structuredClone(policy) },
  });
  t.after(() => runtime.shutdown());
  const a = sessions.connect(sessions.password, 'a').sessionId;
  const b = sessions.connect(sessions.password, 'b').sessionId;
  for (const id of [a, b])
    sessions.setProfile(id, {
      name: 'mobile',
      width: 1280,
      height: 720,
      fps: 15,
      bitrateKbps: 2000,
    });
  const offer = (sessionId, index = 0, profile = 'mobile') =>
    runtime.offerVideo(sessionId, { sdp: 'v=0', displayId: displays[index].id, profile });
  return { sessions, media, runtime, a, b, displays, inventory, offer, access };
}

test('automatic access grants once, never steals control or undoes a host revoke', async (t) => {
  const { runtime, a, b, offer } = await setup(t, 'available');
  const first = await offer(a);
  const second = await offer(b);
  await runtime.selectStream(a, first.streamId);
  assert.equal(runtime.control.owner?.sessionId, a);
  await runtime.selectStream(b, second.streamId);
  assert.equal(runtime.control.owner?.sessionId, a);
  await runtime.command({ action: 'revoke', sessionId: a });
  await runtime.selectStream(a, first.streamId);
  await runtime.selectStream(b, second.streamId);
  assert.equal(runtime.control.owner, null);
  const replacement = await offer(a, 1);
  await runtime.selectStream(a, replacement.streamId);
  assert.equal(runtime.control.owner, null);
});

test('access default is captured at admission, not when a client selects its stream', async (t) => {
  const { runtime, sessions, a, b, offer, access } = await setup(t);
  access.defaultControl = 'available';
  const first = await offer(a);
  await runtime.selectStream(a, first.streamId);
  assert.equal(runtime.control.owner, null);
  sessions.disconnect(b);
  await runtime.stopSession(b);
  const fresh = sessions.connect(sessions.password, 'fresh').sessionId;
  access.defaultControl = 'approval';
  const next = await offer(fresh);
  await runtime.selectStream(fresh, next.streamId);
  assert.equal(runtime.control.owner?.sessionId, fresh);
});

test('simultaneous automatic clients cannot transfer control from the first grantee', async (t) => {
  const { runtime, a, b, offer } = await setup(t, 'available');
  const first = await offer(a);
  const second = await offer(b);
  await Promise.all([
    runtime.selectStream(a, first.streamId),
    runtime.selectStream(b, second.streamId),
  ]);
  assert.equal(runtime.control.owner?.sessionId, a);
});

test('host revoke before the first stream selection cancels automatic eligibility', async (t) => {
  const { runtime, a, offer } = await setup(t, 'available');
  await runtime.command({ action: 'revoke', sessionId: a });
  const first = await offer(a);
  await runtime.selectStream(a, first.streamId);
  assert.equal(runtime.control.owner, null);
});

test('runtime negotiates owner-scoped streams with separate metrics and revokes only the addressed device', async (t) => {
  const { runtime, media, sessions, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(a, 1, 'balanced');
  const other = await offer(b);
  assert.notEqual(first.streamId, a, 'public stream identifier must not be its bearer');
  assert.equal(runtime.list(a).length, 2);
  assert.equal(runtime.list(b).length, 1);
  assert.equal(runtime.record(a, first.streamId, { decodeFps: 12 }), true);
  assert.equal(runtime.record(b, first.streamId, { decodeFps: 999 }), false);
  assert.equal(media.workers.get(first.streamId).diagnostics.snapshot().client.decodeFps, 12);
  assert.equal(media.workers.get(second.streamId).diagnostics.snapshot().client, null);
  await assert.rejects(runtime.stopStream(b, first.streamId), /stream/i);
  await runtime.stopStream(a, first.streamId);
  assert.ok(media.workers.has(second.streamId));
  assert.ok(media.workers.has(other.streamId));
  sessions.disconnect(a);
  await runtime.stopSession(a);
  assert.equal(media.workers.has(second.streamId), false);
  assert.ok(media.workers.has(other.streamId));
  assert.ok(sessions.get(b));
});

test('topology invalidation stops affected displays without disconnecting unaffected subscriptions', async (t) => {
  const { runtime, media, sessions, a, b, displays, inventory, offer } = await setup(t);
  const first = await offer(a, 0);
  const second = await offer(b, 1);
  inventory.update([displays[0]]);
  await runtime.revalidate();
  assert.ok(media.workers.has(first.streamId));
  assert.equal(media.workers.has(second.streamId), false);
  assert.ok(sessions.get(a));
  assert.ok(sessions.get(b));
});

test('audio is one independent subscription per device and survives closing its video', async (t) => {
  const { runtime, media, sessions, a, b, offer } = await setup(t);
  const audio = await runtime.offerAudio(a, 'v=0');
  assert.equal(media.workers.get(audio.streamId).video, false);
  const first = await offer(a);
  const second = await offer(a, 1);
  await assert.rejects(runtime.offerAudio(a, 'v=0'), /audio/i);
  await runtime.stopStream(a, first.streamId);
  await runtime.stopStream(a, second.streamId);
  assert.ok(media.workers.has(audio.streamId));
  sessions.disconnect(a);
  await runtime.stopSession(a);
  assert.equal(media.workers.size, 0);
  sessions.setAudio(b, { mode: 'off', enabled: false });
  await assert.rejects(runtime.offerAudio(b, 'v=0'), /audio/i);
});

test('host status keeps each stream graph separate and reports only acknowledged control', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(a, 1, 'balanced');
  await offer(b);
  runtime.record(a, first.streamId, { decodeFps: 12 });
  runtime.record(a, second.streamId, { decodeFps: 29 });
  media.workers.get(first.streamId).diagnostics.record('server', { captureFps: 15, encodeFps: 15 });
  await runtime.control.grant(a, second.streamId);
  const status = runtime.status();
  assert.equal(status.streamCount, 3);
  const row = status.sessions.find((s) => s.id === a);
  assert.equal(row.control, 'Granted');
  assert.equal(row.controlStreamId, second.streamId);
  assert.deepEqual(
    row.streams.map((s) => [s.id, s.fps]),
    [
      [first.streamId, 12],
      [second.streamId, 29],
    ],
  );
  assert.equal(row.streams[0].stability.generated.at(-1).captureFps, 15);
  assert.equal(row.streams[1].stability.points.at(-1).fps, 29);
  assert.equal(status.sessions.find((s) => s.id === b).control, 'View only');
  await runtime.stopStream(a, second.streamId);
  assert.equal(runtime.status().sessions.find((s) => s.id === a).control, 'View only');
  assert.equal(runtime.diagnostics(first.streamId).client.decodeFps, 12);
  assert.equal(runtime.diagnostics(second.streamId), null);
  assert.equal(
    JSON.stringify(runtime.diagnosticStreams()).includes(a),
    false,
    'local picker must not expose bearer tokens',
  );
});

test('host grant follows selected stream and client selection cannot acquire another owner control', async (t) => {
  const { runtime, a, b, offer, media } = await setup(t);
  const first = await offer(a);
  const second = await offer(a, 1);
  const other = await offer(b);
  await runtime.selectStream(a, first.streamId);
  await runtime.command({ action: 'grant', sessionId: a });
  assert.deepEqual(runtime.control.owner, { sessionId: a, streamId: first.streamId });
  await runtime.selectStream(b, other.streamId);
  assert.equal(runtime.control.owner.sessionId, a);
  await runtime.selectStream(a, second.streamId);
  assert.deepEqual(runtime.control.owner, { sessionId: a, streamId: second.streamId });
  await assert.rejects(
    runtime.command({ action: 'stop-stream', sessionId: b, streamId: second.streamId }),
    /stream/i,
  );
  await runtime.command({ action: 'revoke', sessionId: a });
  assert.equal(runtime.control.owner, null);
  await runtime.command({ action: 'stop-stream', sessionId: a, streamId: second.streamId });
  assert.ok(media.workers.has(first.streamId));
  assert.equal(media.workers.has(second.streamId), false);
});
