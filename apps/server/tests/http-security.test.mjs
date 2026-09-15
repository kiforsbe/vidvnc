import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/http-app.mjs';
async function withServer(run) {
  const server = createHttpApp({ serverName: 'Test PC' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const post = (url, body, token, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

test('serves every browser entry asset through workspace resolution', () =>
  withServer(async (url) => {
    for (const asset of [
      '/',
      '/app.js',
      '/password-entry.js',
      '/receiver-stats.js',
      '/style.css',
      '/shell.css',
      '/theme.js',
      '/diagnostics',
      '/diagnostics.js',
      '/diagnostics.css',
    ]) {
      const response = await fetch(url + asset);
      assert.equal(response.status, 200, asset);
      assert.match(
        response.headers.get('content-type'),
        asset.endsWith('.js') ? /javascript/ : asset.endsWith('.css') ? /css/ : /html/,
      );
      assert.ok((await response.text()).length > 0, asset);
    }
    assert.equal((await fetch(url + '/package.json')).status, 404);
  }));
test('accepts a dashless lowercase password through the real HTTP endpoint', () =>
  withServer(async (url, server) => {
    const password = server.sessionStore.password.replace('-', '').toLowerCase();
    assert.equal((await post(url + '/api/connect', { password })).status, 201);
  }));
test('returns the selected stream profile without exposing the password', () =>
  withServer(async (url, server) => {
    const response = await post(
      url + '/api/connect',
      { password: server.sessionStore.password, profile: 'mobile' },
      null,
      { 'user-agent': 'Mozilla/5.0 (iPhone)' },
    );
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(body.profile, {
      name: 'mobile',
      width: 1280,
      height: 720,
      fps: 15,
      bitrateKbps: 2000,
      mtu: 1200,
    });
    assert.equal(body.audio.codec, 'Opus');
    assert.equal(JSON.stringify(body).includes(server.sessionStore.password), false);
  }));
test('reports unavailable hardware honestly and never discloses the password', () =>
  withServer(async (url, server) => {
    const info = await (await fetch(url + '/api/info')).json();
    assert.equal(info.control.available, false);
    assert.equal(info.display, null);
    assert.equal(JSON.stringify(info).includes(server.sessionStore.password), false);
  }));
test('authenticates, rejects a second owner, and disconnects only with bearer authorization', () =>
  withServer(async (url, server) => {
    const response = await post(url + '/api/connect', { password: server.sessionStore.password });
    assert.equal(response.status, 201);
    const { sessionId, controlEnabled } = await response.json();
    assert.equal(controlEnabled, false);
    assert.equal(
      (await post(url + '/api/connect', { password: server.sessionStore.password })).status,
      409,
    );
    assert.equal((await post(url + '/api/disconnect', {})).status, 401);
    assert.equal((await post(url + '/api/stop', {})).status, 404);
    assert.equal((await post(url + '/api/heartbeat', {}, sessionId)).status, 204);
    assert.equal((await post(url + '/api/disconnect', {}, sessionId)).status, 204);
    assert.equal((await post(url + '/api/heartbeat', {}, sessionId)).status, 401);
  }));
test('blocks cross-origin, malformed, oversized and unauthenticated signaling requests', () =>
  withServer(async (url) => {
    assert.equal(
      (await post(url + '/api/connect', {}, null, { origin: 'https://attacker.example' })).status,
      403,
    );
    assert.equal((await post(url + '/api/connect', null)).status, 400);
    assert.equal((await post(url + '/api/connect', { password: 'x'.repeat(140000) })).status, 413);
    assert.equal((await post(url + '/api/offer', { sdp: 'anything' })).status, 401);
  }));
