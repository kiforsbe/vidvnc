import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/http-app.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('authenticated catalog and reconnect enforce host settings before stopping media', async (t) => {
  const policy = defaultStreamPolicy();
  policy.clientMode = 'options';
  policy.allowAudio = false;
  policy.profiles.find((p) => p.id === 'desktop').enabled = false;
  const stopped = [];
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profileOrderFile = join(directory, 'profile-order.json');
  await writeFile(profileOrderFile, JSON.stringify(['balanced', 'desktop', 'mobile']));
  const server = createHttpApp({
    profileOrderFile,
    serverName: 'Test host',
    display: { width: 2560, height: 1440 },
    policy: { snapshot: () => structuredClone(policy), busy: false },
    media: {
      stop: async (id) => {
        stopped.push(id);
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}, token) =>
    fetch(url + '/api/' + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post('profiles')).status, 401);
  assert.equal((await post('reconnect', { profile: 'balanced' })).status, 401);
  const info = await (await fetch(url + '/api/info')).json();
  assert.deepEqual(info, { publicName: 'VidVNC host' }, 'display inventory is not public');
  const admission = await post('key-start', { key: server.sessionStore.password });
  const firstCookie = admission.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(firstCookie, /^vidvnc-viewer=[A-Za-z0-9_-]{43}$/);
  const connected = await admission.json();
  const catalog = await (await post('profiles', {}, connected.sessionId)).json();
  assert.equal(catalog.clientMode, 'options');
  assert.equal(catalog.allowAudio, false);
  assert.deepEqual(catalog.allowedOptions.frameRates, [15, 30]);
  assert.equal(catalog.display.name, 'Primary display');
  assert.ok(catalog.profiles.every((p) => p.id !== 'desktop'));
  assert.deepEqual(
    catalog.profiles.slice(0, 2).map((p) => p.id),
    ['balanced', 'mobile'],
  );
  const denied = await post('reconnect', { profile: 'desktop' }, connected.sessionId);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('set-cookie'), null);
  assert.equal(stopped.length, 0, 'denied change must retain current media');
  const result = await post('reconnect', { profile: 'balanced', audio: 'on' }, connected.sessionId);
  assert.equal(result.status, 201);
  const nextCookie = result.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(nextCookie, /^vidvnc-viewer=[A-Za-z0-9_-]{43}$/);
  assert.notEqual(nextCookie, firstCookie);
  const changed = await result.json();
  assert.notEqual(changed.sessionId, connected.sessionId);
  assert.equal(changed.profile.name, 'balanced');
  assert.equal(changed.audio.enabled, false);
  assert.ok(stopped.includes(connected.sessionId));
  assert.equal((await post('heartbeat', {}, connected.sessionId)).status, 401);
  assert.equal((await post('heartbeat', {}, changed.sessionId)).status, 204);
  assert.equal(
    (await fetch(url + '/viewer/receiver-stats.js', { headers: { cookie: firstCookie } })).status,
    404,
  );
  assert.equal(
    (await fetch(url + '/viewer/receiver-stats.js', { headers: { cookie: nextCookie } })).status,
    200,
  );
});
