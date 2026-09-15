import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../src/http-app.mjs';
test('audio-off session and authenticated recovery feedback reach the worker contract', async () => {
  const calls = [];
  const server = createHttpApp({
    media: {
      stop() {},
      receiverFeedback(...args) {
        calls.push(args);
      },
      async offer(...args) {
        calls.push(args);
        return 'v=0\r\n';
      },
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/`;
  const post = (route, body, token) =>
    fetch(url + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const session = await (
      await post('connect', {
        password: server.sessionStore.password,
        profile: 'mobile',
        audio: 'off',
      })
    ).json();
    assert.equal(session.audio.enabled, false);
    assert.equal((await post('telemetry', { pliCount: 1 })).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await post('offer', { sdp: 'v=0\r\n' }, session.sessionId)).status, 200);
    assert.equal(calls[0][3].mode, 'off');
    assert.equal((await post('telemetry', { pliCount: 1 }, session.sessionId)).status, 204);
    assert.deepEqual(calls[1], [session.sessionId, { pliCount: 1 }]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
