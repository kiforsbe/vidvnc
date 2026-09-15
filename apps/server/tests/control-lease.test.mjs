import test from 'node:test';
import assert from 'node:assert/strict';

test('exclusive transfer awaits old worker release before granting a different owner', async () => {
  const { ControlLease } = await import('../src/control-lease.mjs');
  const events = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let wait = false;
  const lease = new ControlLease({
    isActive: () => true,
    media: {
      async setPermission(id, allowed) {
        events.push([id, allowed]);
        if (!allowed && wait) await released;
        return allowed;
      },
      async removePeer(id) {
        events.push(['removed', id]);
      },
    },
  });
  await lease.grant('alice', 'stream-a');
  wait = true;
  const transfer = lease.grant('bob', 'stream-b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    ['stream-a', true],
    ['stream-a', false],
  ]);
  assert.equal(lease.owner, null);
  release();
  await transfer;
  assert.deepEqual(lease.owner, { sessionId: 'bob', streamId: 'stream-b' });
  await lease.revoke('alice');
  assert.equal(lease.owner.sessionId, 'bob');
  await lease.revoke('bob');
  assert.equal(lease.owner, null);
});

test('failed acknowledgement removes the old peer before transfer and expired owner cannot renew', async () => {
  const { ControlLease } = await import('../src/control-lease.mjs');
  const events = [];
  let active = true;
  const lease = new ControlLease({
    isActive: () => active,
    media: {
      async setPermission(id, allowed) {
        events.push([id, allowed]);
        if (!allowed) throw new Error('lost acknowledgement');
        return allowed;
      },
      async removePeer(id) {
        events.push(['removed', id]);
      },
    },
  });
  await lease.grant('alice', 'a');
  await lease.grant('bob', 'b');
  assert.deepEqual(events, [
    ['a', true],
    ['a', false],
    ['removed', 'a'],
    ['b', true],
  ]);
  active = false;
  await lease.renew();
  assert.equal(lease.owner, null);
  assert.deepEqual(events.slice(-2), [
    ['b', false],
    ['removed', 'b'],
  ]);
  await assert.rejects(lease.grant('expired', 'c'), /inactive/i);
});
