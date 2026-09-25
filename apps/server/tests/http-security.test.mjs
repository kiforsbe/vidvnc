import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHttpApp } from '../src/http-app.mjs';
import { DiagnosticsCapabilities } from '../src/diagnostics-capabilities.mjs';
import { SessionStore } from '../src/session-store.mjs';
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
      '/profile-labels.js',
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

test('viewer assets require a live session grant while cookies cannot authorize APIs', () =>
  withServer(async (url, server) => {
    const asset = '/viewer/receiver-stats.js';
    assert.equal((await fetch(url + asset)).status, 404);
    const admission = await post(url + '/api/key-start', { key: server.sessionStore.password });
    assert.equal(admission.status, 201);
    const setCookie = admission.headers.get('set-cookie');
    assert.match(
      setCookie,
      /^vidvnc-viewer=[A-Za-z0-9_-]{43}; Path=\/viewer; HttpOnly; SameSite=Strict$/,
    );
    const cookie = setCookie.split(';', 1)[0];
    const allowed = await fetch(url + asset, {
      headers: { cookie, 'x-forwarded-for': '203.0.113.4' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.match(await allowed.text(), /summarizeReceiver/);
    assert.equal(
      (await fetch(url + asset, { headers: { cookie: cookie + '; ' + cookie } })).status,
      404,
    );
    assert.equal((await fetch(url + '/viewer/unknown.js', { headers: { cookie } })).status, 404);
    assert.equal((await post(url + '/api/profiles', {}, null, { cookie })).status, 401);
    server.sessionStore.disconnect((await admission.json()).sessionId);
    assert.equal((await fetch(url + asset, { headers: { cookie } })).status, 404);
  }));

test('revocation during a viewer asset read prevents protected bytes from being returned', () => {
  let readStarted;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  let finishRead;
  const held = new Promise((resolve) => {
    finishRead = resolve;
  });
  return withServer(
    async (url, server) => {
      const admitted = await post(url + '/api/key-start', { key: server.sessionStore.password });
      const cookie = admitted.headers.get('set-cookie').split(';', 1)[0];
      const { sessionId } = await admitted.json();
      const responsePromise = fetch(url + '/viewer/receiver-stats.js', { headers: { cookie } });
      await started;
      server.sessionStore.disconnect(sessionId);
      finishRead();
      const response = await responsePromise;
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /summarizeReceiver/);
    },
    {
      assetReader: async (url) => {
        readStarted();
        await held;
        return readFile(url);
      },
    },
  );
});

test('Host allowlist accepts bracketed IPv6 and follows adapter changes after app construction', () => {
  const adapters = {
    Ethernet: [
      { address: '192.168.10.12', family: 'IPv4', internal: false },
      { address: 'fd12::42', family: 'IPv6', internal: false },
    ],
  };
  return withServer(
    async (url, server) => {
      const port = server.address().port;
      assert.equal((await rawGet(url + '/api/info', { host: `[fd12::42]:${port}` })).status, 200);
      assert.equal(
        (await rawGet(url + '/api/info', { host: `192.168.10.12:${port}` })).status,
        200,
      );
      adapters.Ethernet[0].address = '192.168.10.13';
      assert.equal(
        (await rawGet(url + '/api/info', { host: `192.168.10.13:${port}` })).status,
        200,
      );
      assert.equal(
        (await rawGet(url + '/api/info', { host: `192.168.10.12:${port}` })).status,
        403,
      );
    },
    {
      interfaces: () => adapters,
    },
  );
});

test('public-capable handler has no diagnostics routes, even for loopback with a valid bearer', () => {
  const capabilities = new DiagnosticsCapabilities();
  const token = capabilities.issue().token;
  return withServer(
    async (url, server) => {
      const headers = { host: `localhost:${server.address().port}` };
      for (const route of [
        '/diagnostics',
        '/api/diagnostics',
        '/diagnostics.js',
        '/diagnostics-auth.js',
        '/diagnostics.css',
      ]) {
        const denied = await rawGet(url + route, { ...headers, authorization: `Bearer ${token}` });
        assert.equal(denied.status, 404, route);
        assert.equal(denied.headers.location, undefined, route);
        assert.doesNotMatch(denied.body, /private-stream-label/);
      }
    },
    {
      diagnosticsCapabilities: capabilities,
      diagnostics: { snapshot: () => ({ label: 'private-stream-label' }) },
      tls: { status: () => ({ active: true, port: 443 }) },
    },
  );
});
test('accepts a dashless lowercase password through the real HTTP endpoint', () =>
  withServer(async (url, server) => {
    const password = server.sessionStore.password.replace('-', '').toLowerCase();
    assert.equal((await post(url + '/api/key-start', { key: password })).status, 201);
  }));

test('inactive required HTTPS denies every viewer, admission, bearer, and signaling path on HTTP', () =>
  withServer(
    async (url, server) => {
      for (const path of ['/', '/api/info', '/viewer/receiver-stats.js']) {
        const response = await fetch(url + path);
        assert.equal(response.status, 503, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
      }
      for (const [path, body] of [
        ['/api/key-start', { key: server.sessionStore.password }],
        ['/api/approved-clients/sign-in', {}],
        ['/api/heartbeat', {}],
        ['/api/offer', { sdp: 'offer' }],
        ['/api/stream-offer', { sdp: 'offer' }],
      ]) {
        const response = await post(url + path, body, 'not-a-session');
        assert.equal(response.status, 503, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
      }
    },
    { tls: { status: () => ({ active: false, port: null }) }, plaintextMode: 'https-required' },
  ));

test('deliberate LAN HTTP mode still admits a loopback session when TLS is off', () =>
  withServer(
    async (url, server) => {
      const response = await post(url + '/api/key-start', { key: server.sessionStore.password });
      assert.equal(response.status, 201);
    },
    { tls: { status: () => ({ active: false, port: null }) }, plaintextMode: 'lan-http' },
  ));

test('an out-of-scope HTTP peer is rejected before ordinary routing', () =>
  withServer(
    async (url) => {
      const response = await fetch(url + '/api/info');
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    },
    { localSessionScope: { allows: () => false } },
  ));

test('an in-flight protected request cannot return data after its bearer is revoked', async () => {
  const sessions = new SessionStore();
  const sessionId = sessions.connectApproved(
    { id: 'client-1', generation: 0 },
    '127.0.0.1',
  ).sessionId;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  await withServer(
    async (url) => {
      const response = post(url + '/api/stream-select', { streamId: 'x' }, sessionId);
      await started;
      sessions.disconnect(sessionId);
      finish({ streamId: 'x', privateLabel: 'must-not-leak' });
      const result = await response;
      assert.equal(result.status, 401);
      assert.doesNotMatch(await result.text(), /must-not-leak/);
    },
    {
      sessionStore: sessions,
      runtime: {
        async selectStream() {
          entered();
          return pending;
        },
      },
    },
  );
});
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
test('public info exposes only the owner-chosen label, not host capabilities', () =>
  withServer(
    async (url, server) => {
      const info = await (await fetch(url + '/api/info')).json();
      assert.deepEqual(info, { publicName: 'Owner label' });
      assert.equal(JSON.stringify(info).includes(server.sessionStore.password), false);
      assert.equal(JSON.stringify(info).includes('Test PC'), false);
    },
    { access: { snapshot: () => ({ publicName: 'Owner label' }) } },
  ));
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
