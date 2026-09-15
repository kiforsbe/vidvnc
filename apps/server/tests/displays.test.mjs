import test from 'node:test';
import assert from 'node:assert/strict';
import { DisplayInventory } from '../src/displays.mjs';
import { defaultStreamPolicy, validateStreamPolicy } from '../src/stream-policy.mjs';
import { createHttpApp } from '../src/http-app.mjs';

const primary = {
  id: 'a'.repeat(64),
  name: 'Primary',
  primary: true,
  persistent: true,
  x: 0,
  y: 0,
  width: 2560,
  height: 1440,
  rotation: 0,
};
const secondary = {
  ...primary,
  id: 'b'.repeat(64),
  name: 'Left display',
  primary: false,
  x: -1920,
  width: 1920,
  height: 1080,
};
test('display switching is authenticated, validated before teardown, and bound to the worker', async (t) => {
  const inventory = new DisplayInventory([primary, secondary]);
  const policy = defaultStreamPolicy();
  policy.displaySharing = { [primary.id]: true };
  policy.displayDefaults = { [secondary.id]: 'balanced' };
  let offered;
  let onStop = () => {};
  const server = createHttpApp({
    inventory,
    policy: { snapshot: () => structuredClone(policy) },
    media: {
      stop: async () => onStop(),
      offer: async (...args) => {
        offered = args;
        return 'v=0';
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (route, body = {}, token) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post('profiles')).status, 401);
  const first = await (await post('connect', { password: server.sessionStore.password })).json();
  assert.equal(first.display.id, primary.id);
  assert.equal((await post('reconnect', { displayId: secondary.id }, first.sessionId)).status, 403);
  assert.equal((await post('heartbeat', {}, first.sessionId)).status, 204);
  policy.displaySharing[secondary.id] = true;
  const second = await (
    await post('reconnect', { displayId: secondary.id }, first.sessionId)
  ).json();
  assert.equal(second.profile.name, 'balanced');
  assert.equal((await post('offer', { sdp: 'v=0' }, second.sessionId)).status, 200);
  assert.equal(offered[4].id, secondary.id);
  assert.equal(offered[4].x, -1920);
  onStop = () => inventory.update([primary]);
  assert.equal((await post('reconnect', {}, second.sessionId)).status, 409);
  assert.equal(server.sessionStore.list().length, 0);
});
test('display authorization uses identity, never monitor order or silent fallback', () => {
  const inventory = new DisplayInventory([secondary, primary]);
  const policy = defaultStreamPolicy();
  policy.displaySharing = { [primary.id]: true };
  assert.equal(inventory.select(policy).id, primary.id);
  assert.deepEqual(
    inventory.allowed(policy).map((d) => d.id),
    [primary.id],
  );
  assert.throws(() => inventory.select(policy, secondary.id), /not shared/);
  policy.displaySharing[secondary.id] = true;
  assert.equal(inventory.select(policy, secondary.id).x, -1920);
  const revision = inventory.revision;
  inventory.update([primary]);
  assert.notEqual(inventory.revision, revision);
  assert.throws(() => inventory.select(policy, secondary.id), /unavailable/);
  policy.displaySharing = {};
  assert.throws(() => inventory.select(policy), /No shared/);
});
test('sharing preferences validate and legacy policies migrate without enabling new monitors', () => {
  const policy = defaultStreamPolicy();
  delete policy.displaySharing;
  assert.equal(validateStreamPolicy(policy).displaySharing, null);
  policy.displaySharing = { [secondary.id]: true };
  assert.deepEqual(validateStreamPolicy(policy).displaySharing, policy.displaySharing);
  policy.displaySharing[primary.id] = 'yes';
  assert.throws(() => validateStreamPolicy(policy), /sharing/i);
});
