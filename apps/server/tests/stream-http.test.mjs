import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHttpApp } from '../src/http-app.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { NativeMedia } from '../src/native-media.mjs';
import { StreamRuntime } from '../src/stream-runtime.mjs';
import { DisplayInventory } from '../src/displays.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';

const videoSdp = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 H264/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
].join('\r\n');

test('authenticated stream routes isolate owners and cannot bypass the stream runtime', async (t) => {
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
  const display = {
    id: 'a'.repeat(64),
    primary: true,
    persistent: true,
    name: 'Main',
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
  };
  const inventory = new DisplayInventory([display]);
  const policy = {
    snapshot: () => ({ ...defaultStreamPolicy(), displaySharing: { [display.id]: true } }),
  };
  // These routes are about authorization, not encoding, but a runtime with no backends can
  // encode nothing, so give it the one every machine is required to have.
  const videoBackends = [
    {
      id: 'nvenc',
      label: 'NVIDIA NVENC',
      codecs: ['h264'],
      minimums: { h264: { width: 64, height: 64 } },
    },
  ];
  const runtime = new StreamRuntime({ sessions, media, inventory, policy, videoBackends });
  const server = createHttpApp({ sessionStore: sessions, media, inventory, policy, runtime });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await runtime.shutdown();
  });
  const post = (route, body = {}, token) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post('streams')).status, 401);
  const a = await (await post('key-start', { key: sessions.password })).json();
  const b = await (await post('key-start', { key: sessions.password })).json();
  assert.equal(a.mode, 'streams');
  assert.equal(
    (await post('stream-offer', { sdp: videoSdp, profile: 'not-approved' }, a.sessionId)).status,
    403,
  );
  const response = await post('stream-offer', { sdp: videoSdp, profile: 'mobile' }, a.sessionId);
  assert.equal(response.status, 200);
  const stream = await response.json();
  assert.notEqual(stream.streamId, a.sessionId);
  assert.equal(
    (await post('stream-select', { streamId: stream.streamId }, b.sessionId)).status,
    404,
  );
  const selection = await post('stream-select', { streamId: stream.streamId }, a.sessionId);
  assert.equal(selection.status, 200);
  assert.equal((await selection.json()).controlStreamId, null);
  assert.equal(
    (await post('session-command', { action: 'grant', sessionId: a.sessionId }, a.sessionId))
      .status,
    404,
  );
  assert.equal((await post('stream-stop', { streamId: stream.streamId }, b.sessionId)).status, 404);
  assert.equal(
    (await post('stream-telemetry', { streamId: stream.streamId, decodeFps: 999 }, b.sessionId))
      .status,
    404,
  );
  assert.equal(
    (await post('stream-telemetry', { streamId: stream.streamId, decodeFps: 15 }, a.sessionId))
      .status,
    204,
  );
  const diagnosticsUrl = `http://127.0.0.1:${server.address().port}/api/diagnostics`;
  const diagnostic = await fetch(diagnosticsUrl + '?stream=' + stream.streamId).then((r) =>
    r.json(),
  );
  assert.equal(diagnostic.client.decodeFps, 15);
  assert.equal(diagnostic.selectedStreamId, stream.streamId);
  assert.equal(diagnostic.streams.length, 1);
  assert.equal(JSON.stringify(diagnostic).includes(a.sessionId), false);
  const absent = await fetch(diagnosticsUrl + '?stream=missing').then((r) => r.json());
  assert.equal(
    absent.client,
    undefined,
    'a missing selected stream must not silently show another stream',
  );
  assert.equal((await post('offer', { sdp: 'v=0' }, a.sessionId)).status, 409);
  const second = await (
    await post('stream-offer', { sdp: videoSdp, profile: 'mobile' }, a.sessionId)
  ).json();
  assert.equal(
    (await post('stream-offer', { sdp: videoSdp, profile: 'mobile' }, a.sessionId)).status,
    409,
  );
  await post('stream-stop', { streamId: second.streamId }, a.sessionId);
  assert.equal((await post('streams', {}, b.sessionId).then((r) => r.json())).streams.length, 0);
  assert.equal((await post('audio-offer', { sdp: 'invalid' }, a.sessionId)).status, 400);
  const audioResponse = await post('audio-offer', { sdp: 'v=0' }, a.sessionId);
  assert.equal(audioResponse.status, 200);
  const audio = await audioResponse.json();
  assert.equal(
    (await post('audio-telemetry', { streamId: audio.streamId, audioPacketsLost: 3 }, b.sessionId))
      .status,
    404,
  );
  assert.equal(
    (await post('audio-telemetry', { streamId: audio.streamId, audioPacketsLost: 3 }, a.sessionId))
      .status,
    204,
  );
  const withAudio = await fetch(diagnosticsUrl + '?stream=' + stream.streamId).then((r) =>
    r.json(),
  );
  assert.equal(withAudio.sessionAudio.client.audioPacketsLost, 3);
  assert.equal(
    withAudio.client.decodeFps,
    15,
    'session audio must not replace video receiver history',
  );
  assert.equal((await post('audio-offer', { sdp: 'v=0' }, a.sessionId)).status, 409);
  assert.equal((await post('stream-stop', { streamId: audio.streamId }, b.sessionId)).status, 404);
  assert.equal((await post('stream-stop', { streamId: stream.streamId }, a.sessionId)).status, 204);
  assert.equal(media.workers.size, 1, 'session audio survives video stop');
  assert.equal((await post('heartbeat', {}, a.sessionId)).status, 200);
  assert.equal((await post('disconnect', {}, a.sessionId)).status, 204);
  assert.equal(media.workers.size, 0);
});
