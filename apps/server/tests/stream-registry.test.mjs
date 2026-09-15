import test from 'node:test';
import assert from 'node:assert/strict';

test('stream reservations are owner scoped, isolated copies, bounded until exit and independently released', async () => {
  const { StreamRegistry } = await import('../src/stream-registry.mjs');
  const registry = new StreamRegistry({
    maxStreams: 3,
    perSession: 2,
    bitrateKbps: 10000,
    pixelsPerSecond: 200_000_000,
  });
  const plan = {
    profile: { width: 1280, height: 720, fps: 30, bitrateKbps: 2000 },
    display: { id: 'display-a' },
  };
  const a = registry.reserve('alice', plan);
  const b = registry.reserve('bob', plan);
  assert.notEqual(a.id, b.id);
  assert.equal(registry.get('alice', b.id), null);
  plan.profile.width = 1920;
  a.plan.profile.width = 1;
  assert.equal(registry.get('alice', a.id).plan.profile.width, 1280);
  assert.equal(registry.transition('bob', a.id, 'closing'), false);
  assert.equal(registry.transition('alice', a.id, 'live'), true);
  registry.transition('alice', a.id, 'closing');
  const c = registry.reserve('alice', plan);
  assert.throws(() => registry.reserve('alice', plan), /limit|capacity/i);
  assert.throws(() => registry.reserve('bob', plan), /limit|capacity/i);
  assert.equal(registry.transition('alice', a.id, 'live'), false);
  registry.release(a.id);
  assert.ok(registry.get('bob', b.id));
  assert.ok(registry.reserve('bob', plan));
  assert.deepEqual(
    registry.list('alice').map((s) => s.id),
    [c.id],
  );
});

test('aggregate bitrate and pixel budgets reject oversubscription without disturbing admitted streams', async () => {
  const { StreamRegistry } = await import('../src/stream-registry.mjs');
  const registry = new StreamRegistry({
    maxStreams: 4,
    perSession: 2,
    bitrateKbps: 5000,
    pixelsPerSecond: 80_000_000,
  });
  const plan = { profile: { width: 1280, height: 720, fps: 30, bitrateKbps: 3000 } };
  const first = registry.reserve('alice', plan);
  assert.throws(() => registry.reserve('bob', plan), /bitrate/i);
  assert.throws(
    () =>
      registry.reserve('bob', {
        profile: { ...plan.profile, width: 1920, height: 1080, bitrateKbps: 1000 },
      }),
    /pixel/i,
  );
  for (const fps of [0, -1, NaN, Infinity, '30'])
    assert.throws(() => registry.reserve('bob', { profile: { ...plan.profile, fps } }), /plan/i);
  assert.equal(registry.list().length, 1);
  assert.ok(registry.get('alice', first.id));
});
