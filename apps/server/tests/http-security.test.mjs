import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHttpApp } from '../src/http-app.mjs';
import { DiagnosticsCapabilities } from '../src/diagnostics-capabilities.mjs';
async function withServer(run, options = {}) {
  const server = createHttpApp({ serverName: 'Test PC', ...options });
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
const rawGet = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body }),
      );
    });
    request.on('error', reject);
    request.end();
  });

test('serves every browser entry asset through workspace resolution', () =>
  withServer(async (url) => {
    for (const asset of [
      '/',
      '/app.js',
      '/connection-link.js',
      '/password-entry.js',
      '/receiver-stats.js',
      '/style.css',
      '/shell.css',
      '/theme.js',
      '/diagnostics',
      '/diagnostics.js',
      '/profile-labels.js',
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

test('same-host proxy cannot read live diagnostics without an owner capability', () => {
  let now = 1_000;
  const capabilities = new DiagnosticsCapabilities({ clock: () => now });
  const token = capabilities.issue().token;
  const headers = { host: 'localhost' };
  return withServer(
    async (url) => {
      const denied = await rawGet(url + '/api/diagnostics', headers);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers['cache-control'], 'no-store');
      assert.doesNotMatch(denied.body, /private-stream-label/);
      assert.equal(
        (await rawGet(url + '/api/diagnostics?capability=' + token, headers)).status,
        403,
      );
      assert.equal(
        (await rawGet(url + '/api/diagnostics', { ...headers, cookie: `capability=${token}` }))
          .status,
        403,
      );
      assert.equal(
        (await rawGet(url + '/api/diagnostics', { ...headers, authorization: 'Bearer wrong' }))
          .status,
        403,
      );
      const allowed = await rawGet(url + '/api/diagnostics', {
        ...headers,
        authorization: `Bearer ${token}`,
      });
      assert.equal(allowed.status, 200);
      assert.equal(JSON.parse(allowed.body).label, 'private-stream-label');
      assert.equal(
        (
          await rawGet(url + '/api/diagnostics', {
            host: 'remote.example',
            authorization: `Bearer ${token}`,
          })
        ).status,
        403,
      );
      now += 900_000;
      assert.equal(
        (await rawGet(url + '/api/diagnostics', { ...headers, authorization: `Bearer ${token}` }))
          .status,
        403,
      );
    },
    {
      diagnosticsCapabilities: capabilities,
      diagnostics: { snapshot: () => ({ label: 'private-stream-label' }) },
    },
  );
});
test('accepts a dashless lowercase password through the real HTTP endpoint', () =>
  withServer(async (url, server) => {
    const password = server.sessionStore.password.replace('-', '').toLowerCase();
    assert.equal((await post(url + '/api/key-start', { key: password })).status, 201);
  }));
test('public listener rejects a standing password even from loopback with localhost and forwarded LAN headers', () =>
  withServer(
    async (url, server) => {
      const denied = await post(
        url + '/api/key-start',
        { key: server.sessionStore.password },
        null,
        { host: 'localhost', 'x-forwarded-for': '192.168.10.44' },
      );
      assert.equal(denied.status, 401);
      const once = server.sessionStore.keys.createOneTimeConnection();
      assert.equal((await post(url + '/api/key-start', { key: once.key })).status, 201);
    },
    { listenerScope: 'public' },
  ));
test('returns the selected stream profile without exposing the password', () =>
  withServer(async (url, server) => {
    const response = await post(
      url + '/api/key-start',
      { key: server.sessionStore.password, profile: 'mobile' },
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
      bitrateMode: 'cbr',
      quality: 'balanced',
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
    const response = await post(url + '/api/key-start', { key: server.sessionStore.password });
    assert.equal(response.status, 201);
    const { sessionId, controlEnabled } = await response.json();
    assert.equal(controlEnabled, false);
    assert.equal(
      (await post(url + '/api/key-start', { key: server.sessionStore.password })).status,
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
      (await post(url + '/api/key-start', {}, null, { origin: 'https://attacker.example' })).status,
      403,
    );
    assert.equal((await post(url + '/api/key-start', null)).status, 400);
    assert.equal((await post(url + '/api/key-start', { key: 'x'.repeat(140000) })).status, 413);
    assert.equal((await post(url + '/api/offer', { sdp: 'anything' })).status, 401);
  }));
