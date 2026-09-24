import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/session-store.mjs';
import { NativeMedia } from '../src/native-media.mjs';
import { DisplayInventory } from '../src/displays.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';

async function waitFor(condition, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const videoSdp = (marker = '') =>
  [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 H264/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    ...(marker ? [`a=tag:${marker}`] : []),
  ].join('\r\n');
const av1H264Sdp = () =>
  [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'a=rtpmap:96 AV1/90000',
    'a=rtpmap:97 H264/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
  ].join('\r\n');
const noKnownCodecSdp = () =>
  [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 VP8/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
  ].join('\r\n');

// One probe-shaped backend carrying the real NVENC minimums, so a test that restricts the
// runtime's codecs keeps meaning what it meant before eligibility moved onto the backends.
const NVENC_MINIMUMS = {
  av1: { width: 192, height: 128 },
  h265: { width: 144, height: 48 },
  h264: { width: 64, height: 64 },
};
const nvencBackends = (codecs) => [
  {
    id: 'nvenc',
    label: 'NVIDIA NVENC',
    codecs: [...codecs],
    minimums: Object.fromEntries(codecs.map((codec) => [codec, NVENC_MINIMUMS[codec]])),
  },
];

async function setup(
  t,
  defaultControl = 'approval',
  approvedClients = undefined,
  { registry, videoCodecs = ['av1', 'h265', 'h264'], videoBackends, ...mediaOptions } = {},
) {
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
    ...mediaOptions,
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
    approvedClients,
    policy: { snapshot: () => structuredClone(policy) },
    ...(registry ? { registry } : {}),
    videoCodecs,
    videoBackends: videoBackends ?? nvencBackends(videoCodecs),
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
  const offer = (sessionId, index = 0, profile = 'mobile', sdp = videoSdp()) =>
    runtime.offerVideo(sessionId, { sdp, displayId: displays[index].id, profile });
  const starts = [];
  const start = media.start.bind(media);
  media.start = (sourceId, options) => {
    starts.push([sourceId, options]);
    return start(sourceId, options);
  };
  return { sessions, media, runtime, a, b, displays, inventory, offer, access, starts };
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

test('automatic eligibility is captured at admission but current permission is checked at selection', async (t) => {
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
  assert.equal(runtime.control.owner, null);
});

test('approved-client overrides replace the Access default for that client', async (t) => {
  const permissions = { allowed: 'available', watcher: 'view-only' };
  const approvedClients = {
    authorization: (id) =>
      permissions[id] ? { id, generation: 0, permission: permissions[id] } : null,
  };
  const { runtime, sessions, a, b, offer } = await setup(t, 'approval', approvedClients);
  for (const id of [a, b]) {
    sessions.disconnect(id);
    await runtime.stopSession(id);
  }
  const allowed = sessions.connectApproved({ id: 'allowed', generation: 0 }, 'allowed').sessionId;
  const watcher = sessions.connectApproved({ id: 'watcher', generation: 0 }, 'watcher').sessionId;
  const watched = await offer(watcher);
  await runtime.selectStream(watcher, watched.streamId);
  await assert.rejects(
    () => runtime.command({ action: 'grant', sessionId: watcher }),
    /view only/i,
  );
  assert.equal(runtime.control.owner, null);
  const stream = await offer(allowed);
  await runtime.selectStream(allowed, stream.streamId);
  assert.equal(runtime.control.owner?.sessionId, allowed);
});

test('downgrade before first selection cancels an approved client automatic grant', async (t) => {
  let authorized = true;
  const approvedClients = {
    authorization: (id) => (authorized ? { id, generation: 0, permission: 'available' } : null),
  };
  const { runtime, sessions, a, b, offer } = await setup(t, 'approval', approvedClients);
  for (const id of [a, b]) {
    sessions.disconnect(id);
    await runtime.stopSession(id);
  }
  const client = sessions.connectApproved({ id: 'client-1', generation: 0 }).sessionId;
  const stream = await offer(client);
  authorized = false;
  await runtime.selectStream(client, stream.streamId);
  assert.equal(runtime.control.owner, null);
});

test('downgrade during a native grant releases control before the grant resolves', async (t) => {
  let authorized = true;
  const approvedClients = {
    authorization: (id) => (authorized ? { id, generation: 0, permission: 'approval' } : null),
  };
  const { runtime, sessions, media, a, b, offer } = await setup(t, 'approval', approvedClients);
  for (const id of [a, b]) {
    sessions.disconnect(id);
    await runtime.stopSession(id);
  }
  const client = sessions.connectApproved({ id: 'client-1', generation: 0 }).sessionId;
  const stream = await offer(client);
  await runtime.selectStream(client, stream.streamId);
  let nativeGrantStarted;
  const started = new Promise((resolve) => {
    nativeGrantStarted = resolve;
  });
  let releaseGrant;
  const gate = new Promise((resolve) => {
    releaseGrant = resolve;
  });
  const setPermission = media.setPermission.bind(media);
  const events = [];
  media.setPermission = async (...args) => {
    events.push(args.at(-1));
    if (args.at(-1) === true) {
      nativeGrantStarted();
      await gate;
    }
    return setPermission(...args);
  };
  const granting = runtime.command({ action: 'grant', sessionId: client });
  await started;
  authorized = false;
  releaseGrant();
  await assert.rejects(granting, /inactive|permission|view only/i);
  assert.equal(runtime.control.owner, null);
  assert.ok(events.includes(false));
});

test('renewal rejects a client whose current authorization was revoked', async (t) => {
  let authorized = true;
  const approvedClients = {
    authorization: (id) => (authorized ? { id, generation: 0, permission: 'approval' } : null),
  };
  const { runtime, sessions, a, b, offer } = await setup(t, 'approval', approvedClients);
  for (const id of [a, b]) {
    sessions.disconnect(id);
    await runtime.stopSession(id);
  }
  const client = sessions.connectApproved({ id: 'client-1', generation: 0 }).sessionId;
  const stream = await offer(client);
  await runtime.selectStream(client, stream.streamId);
  await runtime.command({ action: 'grant', sessionId: client });
  authorized = false;
  await runtime.control.renew();
  assert.equal(runtime.control.owner, null);
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
  assert.equal(runtime.streamDiagnostics.get(first.streamId).snapshot().client.decodeFps, 12);
  assert.equal(runtime.streamDiagnostics.get(second.streamId).snapshot().client, null);
  assert.equal(runtime.streamDiagnostics.get(other.streamId).snapshot().client, null);
  await assert.rejects(runtime.stopStream(b, first.streamId), /stream/i);
  await runtime.stopStream(a, first.streamId);
  assert.equal(runtime.list(b)[0].state, 'live');
  assert.equal(media.workers.size, 2);
  sessions.disconnect(a);
  await runtime.stopSession(a);
  assert.equal(media.workers.size, 1);
  assert.equal(runtime.list(b)[0].streamId, other.streamId);
  assert.ok(sessions.get(b));
});

test('topology invalidation stops affected displays without disconnecting unaffected subscriptions', async (t) => {
  const { runtime, sessions, a, b, displays, inventory, offer } = await setup(t);
  await offer(a, 0);
  await offer(b, 1);
  inventory.update([displays[0]]);
  await runtime.revalidate();
  assert.equal(runtime.list(a).length, 1);
  assert.equal(runtime.list(b).length, 0);
  assert.ok(sessions.get(a));
  assert.ok(sessions.get(b));
});

test('audio is one independent subscription per device and survives closing its video', async (t) => {
  const { runtime, media, sessions, a, b, offer } = await setup(t);
  const audio = await runtime.offerAudio(a, 'v=0');
  assert.equal(runtime.audio.get(a).id, audio.streamId);
  const first = await offer(a);
  const second = await offer(a, 1);
  await assert.rejects(runtime.offerAudio(a, 'v=0'), /audio/i);
  await runtime.stopStream(a, first.streamId);
  await runtime.stopStream(a, second.streamId);
  assert.equal(runtime.audio.size, 1);
  assert.equal(media.workers.size, 1);
  sessions.disconnect(a);
  await runtime.stopSession(a);
  assert.equal(media.workers.size, 0);
  sessions.setAudio(b, { mode: 'off', enabled: false });
  await assert.rejects(runtime.offerAudio(b, 'v=0'), /audio/i);
});

test('host status keeps each stream graph separate and reports only acknowledged control', async (t) => {
  const { runtime, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(a, 1, 'balanced');
  await offer(b);
  runtime.record(a, first.streamId, { decodeFps: 12 });
  runtime.record(a, second.streamId, { decodeFps: 29 });
  runtime.streamDiagnostics.get(first.streamId).record('server', { captureFps: 15, encodeFps: 15 });
  await runtime.control.grant(a, second.streamId, { explicitOwner: true });
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
  const { runtime, a, b, offer } = await setup(t);
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
  assert.deepEqual(
    runtime.list(a).map((s) => s.streamId),
    [first.streamId],
  );
});

test('identical display and profile subscriptions share one worker and stop it with the last viewer', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(b);
  assert.equal(media.workers.size, 1);
  assert.deepEqual(runtime.registry.sources()[0].subscriptions, [first.streamId, second.streamId]);
  assert.deepEqual(
    runtime.status().sessions.flatMap((s) => s.streams.map((stream) => stream.viewers)),
    [2, 2],
  );
  await runtime.stopStream(a, first.streamId);
  assert.equal(media.workers.size, 1);
  assert.equal(runtime.list(b)[0].state, 'live');
  await runtime.stopStream(b, second.streamId);
  assert.equal(media.workers.size, 0);
  assert.equal(runtime.registry.sources().length, 0);
});

test('different profiles on one display use separate workers', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  await offer(a);
  await offer(b, 0, 'balanced');
  assert.equal(media.workers.size, 2);
  assert.deepEqual(
    runtime.status().sessions.flatMap((s) => s.streams.map((stream) => stream.viewers)),
    [1, 1],
  );
});

test('source metrics reach every viewer while peer transport stays with its subscription', async (t) => {
  const { runtime, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(b);
  const own = runtime.streamDiagnostics.get(first.streamId).snapshot().server;
  const shared = runtime.streamDiagnostics.get(second.streamId).snapshot().server;
  assert.equal(own.captureFps, 15);
  assert.equal(own.videoRtpPackets, null);
  assert.equal(shared.videoRtpPackets, 2);
});

test('a worker exit releases every subscription of that source only', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  const shared = await offer(a);
  await offer(b);
  const own = await offer(a, 1);
  const child = media.workers.get(runtime.registry.sourceOf(shared.streamId).id).child;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill();
  await closed;
  assert.deepEqual(
    runtime.list(a).map((s) => s.streamId),
    [own.streamId],
  );
  assert.deepEqual(runtime.list(b), []);
  assert.equal(runtime.registry.sources().length, 1);
  assert.equal(runtime.streamDiagnostics.has(shared.streamId), false);
});

test('a failed peer ends only its own subscription', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(b);
  const worker = media.workers.get(runtime.registry.sourceOf(first.streamId).id);
  worker.child.stdin.write(JSON.stringify({ type: 'fail-peer', peerId: second.streamId }) + '\n');
  await waitFor(() => runtime.list(b).length === 0);
  assert.equal(runtime.list(a)[0].state, 'live');
  assert.equal(media.workers.size, 1);
});

test('negotiation timeout removes the peer and stops a source without viewers', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t, 'approval', undefined, {
    negotiationTimeoutMs: 200,
  });
  const first = await offer(a);
  await assert.rejects(offer(b, 0, 'mobile', videoSdp('hang')), /timed out/);
  assert.deepEqual(runtime.list(b), []);
  assert.equal(media.workers.size, 1);
  await runtime.stopStream(a, first.streamId);
  await assert.rejects(offer(b, 0, 'mobile', videoSdp('hang')), /timed out/);
  assert.equal(media.workers.size, 0);
});

test('control transfers between two viewers of one source and addresses each peer', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(b);
  const calls = [];
  const setPermission = media.setPermission.bind(media);
  media.setPermission = (sourceId, peerId, allowed) => {
    calls.push([peerId, allowed]);
    return setPermission(sourceId, peerId, allowed);
  };
  await runtime.control.grant(a, first.streamId, { explicitOwner: true });
  await runtime.control.grant(b, second.streamId, { explicitOwner: true });
  assert.deepEqual(calls, [
    [first.streamId, true],
    [first.streamId, false],
    [second.streamId, true],
  ]);
  assert.equal(runtime.control.owner.sessionId, b);
});

test('an unacknowledged revoke removes only that peer', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  await offer(a);
  const second = await offer(b, 0, 'mobile', videoSdp('no-revoke'));
  await runtime.control.grant(b, second.streamId, { explicitOwner: true });
  await runtime.control.revoke(b);
  assert.equal(runtime.control.owner, null);
  assert.deepEqual(runtime.list(b), []);
  assert.equal(runtime.list(a)[0].state, 'live');
  assert.equal(media.workers.size, 1);
});

test('an unacknowledged removal stops the whole source', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t, 'approval', undefined, {
    removalTimeoutMs: 200,
  });
  await offer(a);
  const second = await offer(b, 0, 'mobile', videoSdp('no-revoke no-remove'));
  await runtime.control.grant(b, second.streamId, { explicitOwner: true });
  await runtime.control.revoke(b);
  assert.deepEqual(runtime.list(a), []);
  assert.equal(media.workers.size, 0);
});

test('recovery trips from two viewers produce one shared keyframe per two seconds', async (t) => {
  const { runtime, media, a, b, offer } = await setup(t);
  const first = await offer(a);
  const second = await offer(b);
  const results = [];
  const keyframe = media.keyframe.bind(media);
  media.keyframe = (sourceId) => {
    const sent = keyframe(sourceId);
    results.push(sent);
    return sent;
  };
  runtime.record(a, first.streamId, { pliCount: 0 });
  runtime.record(b, second.streamId, { pliCount: 0 });
  runtime.telemetryTimes.clear();
  runtime.record(a, first.streamId, { pliCount: 1 });
  runtime.record(b, second.streamId, { pliCount: 1 });
  assert.deepEqual(results, [true, false]);
});

test('audio subscriptions share one worker per format', async (t) => {
  const { runtime, media, sessions, a, b } = await setup(t);
  await runtime.offerAudio(a, 'v=0');
  await runtime.offerAudio(b, 'v=0');
  assert.equal(media.workers.size, 1);
  assert.equal(runtime.audio.size, 2);
  assert.deepEqual(
    runtime.status().sessions.map((s) => s.audioViewers),
    [2, 2],
  );
  sessions.disconnect(b);
  await runtime.stopSession(b);
  const fresh = sessions.connect(sessions.password, 'fresh').sessionId;
  sessions.setProfile(fresh, {
    name: 'balanced',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 4000,
  });
  await runtime.offerAudio(fresh, 'v=0');
  assert.equal(media.workers.size, 2);
});

test('budget refusals happen only when a new source is required', async (t) => {
  const { StreamRegistry } = await import('../src/stream-registry.mjs');
  const { a, b, offer } = await setup(t, 'approval', undefined, {
    registry: new StreamRegistry({ maxStreams: 1 }),
  });
  await offer(a);
  await offer(b);
  await assert.rejects(offer(b, 1), (error) => error.status === 409);
});

test('an offer containing AV1 is started, answered and reported with the AV1 codec', async (t) => {
  const { runtime, a, offer, starts } = await setup(t);
  const first = await offer(a, 0, 'mobile', av1H264Sdp());
  assert.equal(starts.at(-1)[1].codec, 'av1');
  assert.equal(first.codec, 'av1');
  assert.equal(runtime.status().sessions[0].streams[0].codec, 'av1');
});

test('the worker plan carries the startup-resolved encoder backend', async (t) => {
  const { a, offer, starts } = await setup(t);
  await offer(a, 0);
  assert.equal(starts.at(-1)[1].encoderBackend, 'nvenc');
});

test('status reports the available backends, the host setting and what the worker chose', async (t) => {
  const backends = [
    {
      id: 'amf',
      label: 'AMD AMF',
      codecs: ['h264'],
      minimums: { h264: { width: 64, height: 64 } },
    },
  ];
  const { runtime, a, offer } = await setup(t, 'approval', undefined, {
    videoCodecs: ['h264'],
    videoBackends: backends,
  });
  assert.deepEqual(runtime.status().encoders, {
    available: [{ id: 'amf', label: 'AMD AMF', codecs: ['h264'] }],
    setting: 'auto',
  });
  await offer(a, 0);
  // The startup probe resolved Automatic to AMF before the worker started, so the worker never
  // has to instantiate a disposable encoder merely to rediscover adapter affinity.
  assert.deepEqual(runtime.status().sessions[0].streams[0].encoder, {
    backend: 'amf',
    label: 'AMD AMF',
    element: 'amfh264enc',
    reason: 'forced',
  });
});

test('two sessions on the same profile and display get separate sources when they support different codecs', async (t) => {
  const { a, b, offer, media, starts } = await setup(t);
  await offer(a, 0, 'mobile', av1H264Sdp());
  await offer(b, 0, 'mobile', videoSdp());
  assert.equal(media.workers.size, 2);
  assert.deepEqual(starts.map(([, options]) => options.codec).sort(), ['av1', 'h264']);
});

test('two sessions both offering AV1 share one source', async (t) => {
  const { a, b, offer, media } = await setup(t);
  await offer(a, 0, 'mobile', av1H264Sdp());
  await offer(b, 0, 'mobile', av1H264Sdp());
  assert.equal(media.workers.size, 1);
});

test('an offer without any known video codec is rejected and admits nothing', async (t) => {
  const { a, offer, runtime, starts } = await setup(t);
  await assert.rejects(offer(a, 0, 'mobile', noKnownCodecSdp()), (error) => error.status === 400);
  assert.deepEqual(runtime.registry.sources(), []);
  assert.equal(starts.length, 0);
});

test('the worker start message carries exactly the seven stream plan keys, VBR and CBR', async (t) => {
  const written = [];
  const media = new NativeMedia({
    maxWorkers: 2,
    launch: () => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/media-process.mjs', import.meta.url))],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        written.push(JSON.parse(String(chunk)));
        return write(chunk, ...rest);
      };
      return child;
    },
  });
  t.after(() => media.shutdown());
  const size = { width: 1920, height: 1080, fps: 30, bitrateKbps: 8000 };
  await media.start('vbr', {
    profile: { name: 'vbr', ...size, bitrateMode: 'vbr', quality: 'high' },
  });
  await media.start('cbr', {
    profile: { name: 'cbr', ...size, bitrateMode: 'cbr', quality: 'balanced' },
  });
  const keys = ['bitrateKbps', 'bitrateMode', 'fps', 'height', 'mtu', 'quality', 'width'];
  assert.deepEqual(Object.keys(written[0].streamPlan).sort(), keys);
  assert.deepEqual(written[0].streamPlan, {
    ...size,
    mtu: 1200,
    bitrateMode: 'vbr',
    quality: 'high',
  });
  assert.deepEqual(Object.keys(written[1].streamPlan).sort(), keys);
  assert.equal(written[1].streamPlan.bitrateMode, 'cbr');
  assert.equal(written[1].streamPlan.quality, 'balanced');
});

test('a runtime restricted to H.264 ignores AV1 support in the offer', async (t) => {
  const { a, offer, starts } = await setup(t, 'approval', undefined, { videoCodecs: ['h264'] });
  const first = await offer(a, 0, 'mobile', av1H264Sdp());
  assert.equal(first.codec, 'h264');
  assert.equal(starts.at(-1)[1].codec, 'h264');
});
