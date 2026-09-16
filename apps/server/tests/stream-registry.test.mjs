import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamRegistry, audioFormat } from '../src/stream-registry.mjs';

const display = (id = 'display-a', extra = {}) => ({
  id,
  x: 0,
  y: 0,
  width: 2560,
  height: 1440,
  rotation: 0,
  ...extra,
});
const plan = (overrides = {}) => ({
  revision: 1,
  display: display(),
  profile: { id: 'mobile', name: 'Mobile', width: 1280, height: 720, fps: 30, bitrateKbps: 2000 },
  audio: { mode: 'off', enabled: false },
  codec: 'h264',
  ...overrides,
});

test('default host stream budget fits the GPU encoder session limit, not the device count', () => {
  assert.deepEqual(new StreamRegistry().limits, {
    maxStreams: 8,
    perSession: 2,
    bitrateKbps: 32000,
    pixelsPerSecond: 500_000_000,
  });
});

test('equal keys share one source; profile names do not participate', () => {
  const registry = new StreamRegistry();
  const alice = registry.subscribe('alice', plan());
  const bob = registry.subscribe(
    'bob',
    plan({ profile: { ...plan().profile, id: 'custom', name: 'Renamed' } }),
  );
  assert.equal(alice.created, true);
  assert.equal(bob.created, false);
  assert.equal(alice.source.id, bob.source.id);
  assert.deepEqual(registry.source(alice.source.id).subscriptions, [
    alice.stream.id,
    bob.stream.id,
  ]);
  assert.equal(registry.get('alice', bob.stream.id), null);
  assert.equal(registry.get('bob', bob.stream.id).plan.profile.name, 'Renamed');
  alice.stream.plan.profile.width = 1;
  registry.sources()[0].subscriptions.length = 0;
  assert.equal(registry.get('alice', alice.stream.id).plan.profile.width, 1280);
  assert.equal(registry.sources()[0].subscriptions.length, 2);
  assert.equal(registry.sourceOf(bob.stream.id).id, alice.source.id);
});

test('each differing key field creates a new source', () => {
  const registry = new StreamRegistry({ maxStreams: 16, perSession: 16 });
  const base = plan();
  const variants = [
    base,
    plan({ revision: 2 }),
    plan({ display: display('display-b') }),
    plan({ display: display('display-a', { x: 1 }) }),
    plan({ display: display('display-a', { rotation: 90 }) }),
    plan({ profile: { ...base.profile, width: 1920 } }),
    plan({ profile: { ...base.profile, fps: 15 } }),
    plan({ profile: { ...base.profile, bitrateKbps: 3000 } }),
    plan({ codec: 'av1' }),
  ];
  const ids = variants.map((p) => registry.subscribe('alice', p).source.id);
  assert.equal(new Set(ids).size, variants.length);
});

test('host budgets count sources while the per-session limit counts subscriptions', () => {
  const registry = new StreamRegistry({ maxStreams: 2, perSession: 2 });
  for (const session of ['a', 'b', 'c', 'd']) registry.subscribe(session, plan());
  assert.equal(registry.sources().length, 1);
  registry.subscribe('c', plan({ display: display('display-b') }));
  assert.throws(
    () => registry.subscribe('d', plan({ display: display('display-c') })),
    /capacity/i,
  );
  assert.throws(() => registry.subscribe('c', plan()), /capacity/i);
  assert.equal(registry.subscribe('d', plan({ display: display('display-b') })).created, false);
});

test('a closing source is never joined and keeps its budget until released', () => {
  const registry = new StreamRegistry({ maxStreams: 1 });
  const first = registry.subscribe('alice', plan());
  assert.equal(registry.markReady(first.source.id), true);
  const { source, last } = registry.unsubscribe(first.stream.id);
  assert.equal(last, true);
  assert.equal(source.state, 'closing');
  assert.equal(registry.unsubscribe(first.stream.id).last, false);
  assert.throws(() => registry.subscribe('bob', plan()), /capacity/i);
  assert.equal(registry.releaseSource(first.source.id), true);
  const next = registry.subscribe('bob', plan());
  assert.equal(next.created, true);
  assert.notEqual(next.source.id, first.source.id);
});

test('audio subscriptions share per format and allow one per session', () => {
  const registry = new StreamRegistry({ maxStreams: 1 });
  registry.subscribe('a', plan());
  const mono = { kind: 'audio', format: audioFormat({ fps: 15 }) };
  const a = registry.subscribe('a', mono);
  const b = registry.subscribe('b', mono);
  assert.equal(a.source.id, b.source.id);
  const stereo = registry.subscribe('c', { kind: 'audio', format: audioFormat({ fps: 30 }) });
  assert.notEqual(stereo.source.id, a.source.id);
  assert.throws(() => registry.subscribe('a', mono), /audio/);
  assert.deepEqual(
    registry.list('a').map((s) => s.kind),
    ['video'],
  );
  assert.deepEqual(
    registry.list('a', 'audio').map((s) => s.id),
    [a.stream.id],
  );
  assert.equal(registry.get('a', a.stream.id), null);
  assert.equal(registry.subscription(a.stream.id).kind, 'audio');
  assert.throws(() => registry.subscribe('d', { kind: 'audio', format: 'surround' }), /plan/);
});

test('aggregate bitrate and pixel budgets reject oversubscription without disturbing admitted streams', () => {
  const registry = new StreamRegistry({
    maxStreams: 4,
    perSession: 2,
    bitrateKbps: 5000,
    pixelsPerSecond: 80_000_000,
  });
  const profile = { width: 1280, height: 720, fps: 30, bitrateKbps: 3000 };
  const first = registry.subscribe('alice', plan({ profile }));
  assert.throws(
    () => registry.subscribe('bob', plan({ profile, display: display('display-b') })),
    /bitrate/i,
  );
  assert.throws(
    () =>
      registry.subscribe(
        'bob',
        plan({
          profile: { ...profile, width: 1920, height: 1080, bitrateKbps: 1000 },
          display: display('display-b'),
        }),
      ),
    /pixel/i,
  );
  for (const fps of [0, -1, NaN, Infinity, '30'])
    assert.throws(() => registry.subscribe('bob', plan({ profile: { ...profile, fps } })), /plan/i);
  assert.equal(registry.list().length, 1);
  assert.ok(registry.get('alice', first.stream.id));
});

test('closing and releasing a source drops its remaining subscriptions', () => {
  const registry = new StreamRegistry();
  const a = registry.subscribe('alice', plan());
  const b = registry.subscribe('bob', plan());
  assert.equal(registry.transition('bob', a.stream.id, 'live'), false);
  assert.equal(registry.transition('alice', a.stream.id, 'live'), true);
  assert.equal(registry.closeSource(a.source.id), true);
  assert.equal(registry.get('bob', b.stream.id).state, 'closing');
  assert.equal(registry.transition('alice', a.stream.id, 'live'), false);
  assert.equal(registry.releaseSource(a.source.id), true);
  assert.equal(registry.get('alice', a.stream.id), null);
  assert.equal(registry.get('bob', b.stream.id), null);
  assert.deepEqual(registry.sources(), []);
});
