import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/http-app.mjs';
import { ApprovedClientStore } from '../src/approved-clients.mjs';
import { SessionStore } from '../src/session-store.mjs';

const post = (url, route, body, token) =>
  fetch(`${url}/api/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function withServer(run, { connectionMode = 'session-key' } = {}) {
  const sessionStore = new SessionStore();
  const approvedClients = await ApprovedClientStore.open(null, {
    keys: sessionStore.keys,
  });
  const server = createHttpApp({
    sessionStore,
    approvedClients,
    serverName: 'Thor',
    access: { snapshot: () => ({ connectionMode }) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, server, approvedClients);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP registration waits for host approval and releases the credential only to its claimant', () =>
  withServer(async (url, server, approvedClients) => {
    const setup = server.sessionStore.keys.createSetup({ ttlMs: 60_000 });
    const dispatch = await post(url, 'connection-key', { key: setup.key });
    assert.equal(dispatch.status, 200);
    assert.deepEqual(await dispatch.json(), {
      purpose: 'approved-client-setup',
      usage: 'single-use',
      expiresAt: setup.expiresAt,
    });
    assert.equal((await post(url, 'connect', { password: setup.key })).status, 401);

    const registrationResponse = await post(url, 'approved-clients/register', {
      key: setup.key,
      deviceName: 'Kim’s iPhone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-installation-1',
      client: 'Safari on iOS',
    });
    assert.equal(registrationResponse.status, 202);
    const registration = await registrationResponse.json();
    assert.equal((await post(url, 'connection-key', { key: setup.key })).status, 401);
    assert.equal(
      (await post(url, 'approved-clients/status', { ...registration, claimToken: 'wrong' })).status,
      401,
    );
    assert.deepEqual(await (await post(url, 'approved-clients/status', registration)).json(), {
      state: 'pending',
    });

    await approvedClients.approve(registration.requestId);
    const credential = await (await post(url, 'approved-clients/status', registration)).json();
    assert.equal(credential.state, 'approved');
    assert.equal(credential.username, 'kim');
    assert.equal(JSON.stringify(credential).includes('correct horse'), false);
    assert.equal(
      (
        await post(url, 'approved-clients/sign-in', {
          ...credential,
          username: 'wrong',
          password: 'correct horse battery staple',
        })
      ).status,
      401,
    );
    const signedIn = await post(url, 'approved-clients/sign-in', {
      ...credential,
      username: 'kim',
      password: 'correct horse battery staple',
    });
    assert.equal(signedIn.status, 201);
    const session = await signedIn.json();
    assert.match(session.sessionId, /^[a-f0-9-]{36}$/);
    assert.equal(JSON.stringify(session).includes(credential.clientSecret), false);
    assert.equal(typeof approvedClients.status().approved[0].lastConnectedAt, 'number');
  }));

test('one-time connection keys admit exactly one ordinary session and are then deleted', () =>
  withServer(
    async (url, server) => {
      const once = server.sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
      const occupiedSession = server.sessionStore.connectApproved({ id: 'occupied' });
      const busyRequest = await post(url, 'connect', { password: once.key });
      assert.equal(busyRequest.status, 409);
      assert.equal(server.sessionStore.keys.inspect(once.key).purpose, 'one-time-connection');
      server.sessionStore.disconnect(occupiedSession.sessionId);
      const connected = await post(url, 'connect', { password: once.key });
      assert.equal(connected.status, 201);
      const session = await connected.json();
      assert.equal(server.sessionStore.keys.inspect(once.key), null);
      await post(url, 'disconnect', {}, session.sessionId);
      assert.equal((await post(url, 'connect', { password: once.key })).status, 401);
    },
    { connectionMode: 'one-time-keys' },
  ));

test('connection mode allows only its ordinary key type while approved-client setup stays available', async () => {
  const sessionStore = new SessionStore({ maxSessions: 4 });
  const approvedClients = await ApprovedClientStore.open(null, { keys: sessionStore.keys });
  const setting = { connectionMode: 'one-time-keys' };
  const server = createHttpApp({
    sessionStore,
    approvedClients,
    access: { snapshot: () => ({ ...setting }) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const once = sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
    const setup = sessionStore.keys.createSetup({ ttlMs: 60_000 });
    assert.equal((await post(url, 'connect', { password: sessionStore.password })).status, 401);
    assert.equal((await post(url, 'connection-key', { key: sessionStore.password })).status, 401);
    assert.equal((await post(url, 'connection-key', { key: setup.key })).status, 200);
    assert.equal((await post(url, 'connect', { password: once.key })).status, 201);

    setting.connectionMode = 'approved-only';
    const another = sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
    assert.equal((await post(url, 'connection-key', { key: another.key })).status, 401);
    assert.equal((await post(url, 'connect', { password: another.key })).status, 401);
    assert.equal(sessionStore.keys.inspect(another.key).purpose, 'one-time-connection');
    assert.equal((await post(url, 'connection-key', { key: setup.key })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('session-key mode also permits an explicitly requested one-time connection', () =>
  withServer(async (url, server) => {
    const once = server.sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
    assert.equal((await post(url, 'connection-key', { key: once.key })).status, 200);
    assert.equal((await post(url, 'connect', { password: once.key })).status, 201);
    assert.equal(server.sessionStore.keys.inspect(once.key), null);
  }));
