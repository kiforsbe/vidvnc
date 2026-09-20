import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StreamPolicyStore } from '../src/stream-policy-store.mjs';
import { PolicyController } from '../src/policy-controller.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { createHttpApp } from '../src/http-app.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vidvnc-controller-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await StreamPolicyStore.open(join(dir, 'policy.json'));
  const sessions = new SessionStore();
  const controller = new PolicyController(store, sessions, { shutdown: async () => {} });
  return { controller, sessions };
}
test('policy changes require confirmation and validation failure retains connected client', async (t) => {
  const { controller, sessions } = await fixture(t);
  const connection = sessions.connect(sessions.password);
  await assert.rejects(controller.replace(controller.snapshot(), 0, false), /disconnect/i);
  const bad = controller.snapshot();
  bad.defaultProfileId = 'missing';
  await assert.rejects(controller.replace(bad, 0, true));
  assert.ok(sessions.get(connection.sessionId));
  await controller.replace(controller.snapshot(), 0, true);
  assert.equal(sessions.get(connection.sessionId), null);
  assert.equal(controller.busy, false);
});
test('HTTP denies unavailable profiles, applies audio policy, and rejects stale offers', async (t) => {
  const { controller, sessions } = await fixture(t);
  const p = controller.snapshot();
  p.allowAudio = false;
  p.profiles.find((p) => p.id === 'desktop').enabled = false;
  await controller.replace(p, 0, false);
  let offers = 0;
  const server = createHttpApp({
    sessionStore: sessions,
    policy: controller,
    media: {
      offer() {
        offers++;
      },
      stop() {},
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (route, data, token) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
  assert.equal((await post('profiles', {})).status, 401);
  assert.equal(
    (await post('connect', { password: sessions.password, profile: 'desktop' })).status,
    403,
  );
  const result = await post('connect', {
    password: sessions.password,
    profile: 'balanced',
    audio: 'on',
  });
  assert.equal(result.status, 201);
  const connected = await result.json();
  assert.equal(connected.audio.enabled, false);
  const catalog = await (await post('profiles', {}, connected.sessionId)).json();
  assert.ok(catalog.profiles.every((p) => p.id !== 'desktop'));
  await controller.replace(controller.snapshot(), 1, true);
  assert.equal((await post('offer', { sdp: 'v=0\r\n' }, connected.sessionId)).status, 401);
  assert.equal(offers, 0);
});

test('HTTP custom stream requests obey persisted mode and approved option lists', async (t) => {
  const { controller, sessions } = await fixture(t);
  const server = createHttpApp({
    sessionStore: sessions,
    policy: controller,
    media: { stop() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const connect = (custom) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: sessions.password, custom }),
    });
  const approved = { width: 1600, height: 900, fps: 24, bitrateKbps: 3000 };
  assert.equal((await connect(approved)).status, 403);
  const policy = controller.snapshot();
  policy.clientMode = 'options';
  policy.allowedOptions = {
    resolutions: [{ width: 1600, height: 900 }],
    frameRates: [24],
    bitratesKbps: [3000],
  };
  await controller.replace(policy, 0, false);
  for (const denied of [
    { ...approved, width: 1920 },
    { ...approved, fps: 30 },
    { ...approved, bitrateKbps: 4000 },
  ])
    assert.equal((await connect(denied)).status, 403);
  const response = await connect(approved);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.deepEqual(result.profile, {
    name: 'custom',
    ...approved,
    bitrateMode: 'cbr',
    quality: 'balanced',
    mtu: 1200,
  });
  await controller.replace({ ...controller.snapshot(), clientMode: 'profiles' }, 1, true);
  assert.equal((await connect(approved)).status, 403);
});
