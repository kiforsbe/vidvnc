import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/http-app.mjs';
import { ApprovedClientStore } from '../src/approved-clients.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { AdmissionBudget } from '../src/admission-budget.mjs';

const post = (url, route, body, token) =>
  fetch(`${url}/api/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function withServer(run, { connectionMode = 'session-key', listenerScope = 'local' } = {}) {
  const sessionStore = new SessionStore();
  const approvedClients = await ApprovedClientStore.open(null, {
    keys: sessionStore.keys,
  });
  const server = createHttpApp({
    sessionStore,
    approvedClients,
    serverName: 'Thor',
    access: { snapshot: () => ({ connectionMode }) },
    listenerScope,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, server, approvedClients);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('metered key start returns a one-use ticket for client registration', () =>
  withServer(async (url, server, approvedClients) => {
    const setup = server.sessionStore.keys.createSetup();
    const start = await post(url, 'key-start', { key: setup.key });
    assert.equal(start.status, 202);
    const ticket = await start.json();
    assert.match(ticket.registrationTicket, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(server.sessionStore.keys.inspect(setup.key), null);
    const input = {
      registrationTicket: ticket.registrationTicket,
      deviceName: 'Phone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-1',
      client: 'Safari',
    };
    const response = await post(url, 'approved-clients/register', input);
    assert.equal(response.status, 202);
    assert.equal((await post(url, 'approved-clients/register', input)).status, 401);
    assert.equal(approvedClients.status().pending.length, 1);
  }));

test('legacy key-inspection and connect endpoints are not exposed', () =>
  withServer(async (url, server) => {
    assert.equal(
      (await post(url, 'connection-key', { key: server.sessionStore.password })).status,
      404,
    );
    assert.equal(
      (await post(url, 'connect', { password: server.sessionStore.password })).status,
      404,
    );
  }));

test('key start rejects a standing password on a public handler but admits a one-time code', () =>
  withServer(
    async (url, server) => {
      assert.equal(
        (await post(url, 'key-start', { key: server.sessionStore.password })).status,
        401,
      );
      const once = server.sessionStore.keys.createOneTimeConnection();
      assert.equal((await post(url, 'key-start', { key: once.key })).status, 201);
    },
    { listenerScope: 'public' },
  ));

test('metered key start keeps an occupied one-time code for retry', () =>
  withServer(
    async (url, server) => {
      const once = server.sessionStore.keys.createOneTimeConnection();
      const occupied = server.sessionStore.connectApproved({ id: 'occupier' });
      assert.equal((await post(url, 'key-start', { key: once.key })).status, 409);
      assert.ok(server.sessionStore.keys.inspect(once.key));
      server.sessionStore.disconnect(occupied.sessionId);
      assert.equal((await post(url, 'key-start', { key: once.key })).status, 201);
    },
    { connectionMode: 'one-time-keys' },
  ));

test('key-start guesses are capped before a valid code is inspected', async () => {
  const sessionStore = new SessionStore();
  const admission = new AdmissionBudget();
  const server = createHttpApp({ sessionStore, admission });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 5; i++)
      assert.equal((await post(url, 'key-start', { key: `AAAA-AAA${i}` })).status, 401);
    const sessionPolicy = sessionStore.keys.activeSession();
    sessionStore.keys.activeSession = () => sessionPolicy;
    let inspected = 0;
    const inspect = sessionStore.keys.inspect.bind(sessionStore.keys);
    sessionStore.keys.inspect = (...args) => {
      inspected++;
      return inspect(...args);
    };
    for (let i = 5; i < 8; i++) {
      const blocked = await post(url, 'key-start', { key: `AAAA-AAA${i}` });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    }
    const valid = await post(url, 'key-start', { key: sessionStore.password });
    assert.equal(valid.status, 429);
    assert.equal(inspected, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed key-start bodies consume the short-code attempt budget before parsing', () =>
  withServer(async (url, server) => {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${url}/api/key-start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal(response.status, 400);
    }
    assert.equal((await post(url, 'key-start', { key: server.sessionStore.password })).status, 429);
  }));

test('expired registration ticket cannot enroll a client', async () => {
  let now = 1_000;
  const sessionStore = new SessionStore({ clock: () => now });
  const approvedClients = await ApprovedClientStore.open(null, {
    keys: sessionStore.keys,
    clock: () => now,
  });
  const server = createHttpApp({ sessionStore, approvedClients });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const setup = sessionStore.keys.createSetup();
    const start = await post(url, 'key-start', { key: setup.key });
    const { registrationTicket } = await start.json();
    now += 600_000;
    assert.equal(
      (
        await post(url, 'approved-clients/register', {
          registrationTicket,
          deviceName: 'Phone',
          username: 'kim',
          password: 'correct horse battery staple',
          installationId: 'browser-1',
          client: 'Safari',
        })
      ).status,
      401,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('sign-in and status endpoints enforce their rolling budgets', () =>
  withServer(async (url) => {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await post(url, 'approved-clients/sign-in', { clientId: `unknown-${i}` })).status,
        401,
      );
    assert.equal((await post(url, 'approved-clients/sign-in', { clientId: 'known' })).status, 429);
    for (let i = 0; i < 60; i++)
      assert.equal(
        (await post(url, 'approved-clients/status', { requestId: 'unknown' })).status,
        401,
      );
    assert.equal(
      (await post(url, 'approved-clients/status', { requestId: 'unknown' })).status,
      429,
    );
  }));

test('registration endpoint enforces its rolling budget before ticket lookup', () =>
  withServer(async (url) => {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await post(url, 'approved-clients/register', { registrationTicket: `bad-${i}` })).status,
        401,
      );
    assert.equal(
      (await post(url, 'approved-clients/register', { registrationTicket: 'bad-final' })).status,
      429,
    );
  }));

test('HTTP registration waits for host approval and releases the credential only to its claimant', () =>
  withServer(async (url, server, approvedClients) => {
    const setup = server.sessionStore.keys.createSetup({ ttlMs: 60_000 });
    const dispatch = await post(url, 'key-start', { key: setup.key });
    assert.equal(dispatch.status, 202);
    const { registrationTicket } = await dispatch.json();
    assert.equal((await post(url, 'key-start', { key: setup.key })).status, 401);

    const registrationResponse = await post(url, 'approved-clients/register', {
      registrationTicket,
      deviceName: 'Kim’s iPhone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-installation-1',
      client: 'Safari on iOS',
    });
    assert.equal(registrationResponse.status, 202);
    const registration = await registrationResponse.json();
    assert.equal((await post(url, 'key-start', { key: setup.key })).status, 401);
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
      const busyRequest = await post(url, 'key-start', { key: once.key });
      assert.equal(busyRequest.status, 409);
      assert.equal(server.sessionStore.keys.inspect(once.key).purpose, 'one-time-connection');
      server.sessionStore.disconnect(occupiedSession.sessionId);
      const connected = await post(url, 'key-start', { key: once.key });
      assert.equal(connected.status, 201);
      const session = await connected.json();
      assert.equal(server.sessionStore.keys.inspect(once.key), null);
      await post(url, 'disconnect', {}, session.sessionId);
      assert.equal((await post(url, 'key-start', { key: once.key })).status, 401);
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
    const setup = sessionStore.keys.createSetup({ ttlMs: 60_000 });
    assert.equal((await post(url, 'key-start', { key: sessionStore.password })).status, 401);
    assert.equal((await post(url, 'key-start', { key: setup.key })).status, 202);
    const once = sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
    assert.equal(sessionStore.keys.inspect(setup.key), null);
    assert.equal((await post(url, 'key-start', { key: once.key })).status, 201);

    setting.connectionMode = 'approved-only';
    const another = sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
    assert.equal((await post(url, 'key-start', { key: another.key })).status, 401);
    assert.equal(sessionStore.keys.inspect(another.key).purpose, 'one-time-connection');
    const allowedSetup = sessionStore.keys.createSetup({ ttlMs: 60_000 });
    assert.equal((await post(url, 'key-start', { key: allowedSetup.key })).status, 202);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('session-key mode also permits an explicitly requested one-time connection', () =>
  withServer(async (url, server) => {
    const once = server.sessionStore.keys.createOneTimeConnection({ ttlMs: 60_000 });
    assert.equal((await post(url, 'key-start', { key: once.key })).status, 201);
    assert.equal(server.sessionStore.keys.inspect(once.key), null);
  }));
