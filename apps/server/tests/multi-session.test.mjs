import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.mjs';
import { createHttpApp } from '../src/http-app.mjs';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';

test('worker admission refusal does not revoke the authenticated device', async (t) => {
  const stopped = [];
  const server = createHttpApp({
    media: {
      offer: async () => {
        throw Object.assign(new Error('Media capacity reached'), { code: 'MEDIA_BUSY' });
      },
      stop: async (id) => stopped.push(id),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { sessionId } = server.sessionStore.connect(server.sessionStore.password, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionId}` },
    body: JSON.stringify({ sdp: 'v=0' }),
  });
  assert.equal(response.status, 409);
  assert.ok(server.sessionStore.get(sessionId));
  assert.deepEqual(stopped, []);
});

test('one reconnect cannot block another owner or lose its reserved session slot', async (t) => {
  const store = new SessionStore({ maxSessions: 3 });
  const stopped = [];
  let pauseId;
  let resume;
  let stopStarted;
  const started = new Promise((resolve) => (stopStarted = resolve));
  const paused = new Promise((resolve) => (resume = resolve));
  const server = createHttpApp({
    sessionStore: store,
    policy: { snapshot: () => defaultStreamPolicy() },
    media: {
      async stop(id) {
        stopped.push(id);
        if (id === pauseId) {
          stopStarted();
          await paused;
        }
      },
      async offer() {
        return 'v=0';
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    resume();
    await new Promise((resolve) => server.close(resolve));
  });
  const post = (path, body, token) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const connect = () => post('key-start', { key: store.password });
  const a = await (await connect()).json();
  const b = await (await connect()).json();
  pauseId = a.sessionId;
  const reconnect = post('reconnect', { profile: 'balanced' }, a.sessionId);
  await started;
  assert.equal((await post('offer', { sdp: 'v=0' }, b.sessionId)).status, 200);
  assert.equal((await connect()).status, 201, 'unrelated connection may use the remaining slot');
  assert.equal((await connect()).status, 409, 'reconnecting owner retains its reservation');
  resume();
  const replacement = await reconnect;
  assert.equal(replacement.status, 201);
  assert.notEqual((await replacement.json()).sessionId, a.sessionId);
  assert.equal((await post('heartbeat', {}, b.sessionId)).status, 204);
  assert.ok(!stopped.includes(b.sessionId));
});

test('telemetry admission is per session rather than shared across all clients', async (t) => {
  const store = new SessionStore({ maxSessions: 2 });
  const server = createHttpApp({ sessionStore: store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const a = store.connect(store.password, '127.0.0.1');
  const b = store.connect(store.password, '127.0.0.1');
  const post = (token) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    });
  assert.equal((await post(a.sessionId)).status, 204);
  assert.equal((await post(b.sessionId)).status, 204);
  assert.equal((await post(a.sessionId)).status, 429);
});

test('disconnect during a pending reconnect cannot resurrect its revoked bearer', async (t) => {
  const store = new SessionStore({ maxSessions: 2 });
  let resume;
  let started;
  const stopped = new Promise((resolve) => (started = resolve));
  const pause = new Promise((resolve) => (resume = resolve));
  const server = createHttpApp({
    sessionStore: store,
    media: {
      async stop() {
        started();
        await pause;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    resume();
    await new Promise((resolve) => server.close(resolve));
  });
  const first = store.connect(store.password, '127.0.0.1');
  const post = (route) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${first.sessionId}` },
      body: '{}',
    });
  const reconnect = post('reconnect');
  await stopped;
  const disconnect = post('disconnect');
  // The actual authenticated request must revoke before teardown is released.
  for (let attempt = 0; attempt < 100 && store.list().length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.list().length, 0);
  resume();
  assert.equal((await disconnect).status, 204);
  assert.equal((await reconnect).status, 409);
  assert.equal(store.list().length, 0);
});
