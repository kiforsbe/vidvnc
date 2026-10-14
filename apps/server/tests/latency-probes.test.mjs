import test from 'node:test';
import assert from 'node:assert/strict';
import { LatencyProbes } from '../src/latency-probes.mjs';

const timing = { count: 1, min: 5, median: 5, p95: 5, max: 5 };
const RESULTS = {
  handToGlassMs: { move: timing, key: timing },
  handToReceiveMs: { move: timing, key: timing },
  glassToGlassMs: timing,
  timeouts: { move: 0, key: 0 },
  overhead: { callbackMs: timing, skippedFrames: 0 },
  receiver: {
    decodeFps: 60,
    jitterBufferMs: 30,
    decodeMs: 2,
    rttMs: 1,
    lostInterval: 0,
    framesDropped: 0,
  },
  video: { width: 1920, height: 1080 },
  browser: 'test',
};

function setup() {
  let now = 1_000;
  let ids = 0;
  const live = new Set(['s1/v1', 's1/v2', 's2/v3']);
  const probes = new LatencyProbes({
    isLive: (sessionId, streamId) => live.has(`${sessionId}/${streamId}`),
    now: () => now,
    randomId: () => `id-${++ids}`,
  });
  return {
    probes,
    live,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('one measurement at a time; a second request is busy', () => {
  const { probes } = setup();
  assert.deepEqual(probes.request('v1', 's1'), { id: 'id-1', state: 'requested' });
  assert.throws(
    () => probes.request('v3', 's2'),
    (error) => error.code === 'busy' && /already running/.test(error.message),
  );
});

test('the viewer picks a request up once, and only for its own session and stream', () => {
  const { probes } = setup();
  probes.request('v1', 's1');
  assert.equal(probes.pickup('s2', 'v1'), null);
  assert.equal(probes.pickup('s1', 'v2'), null);
  assert.deepEqual(probes.pickup('s1', 'v1'), { id: 'id-1' });
  assert.equal(probes.pickup('s1', 'v1'), null);
});

test('a request nobody picks up expires after 15 s, a run without results after 120 s', () => {
  const { probes, advance } = setup();
  probes.request('v1', 's1');
  advance(15_000);
  assert.equal(probes.snapshot('v1').active.state, 'requested');
  advance(1);
  assert.equal(probes.snapshot('v1').active, null);
  assert.deepEqual(
    {
      state: probes.snapshot('v1').history[0].state,
      reason: probes.snapshot('v1').history[0].reason,
    },
    { state: 'failed', reason: 'expired' },
  );
  probes.request('v1', 's1');
  probes.pickup('s1', 'v1');
  assert.equal(probes.report('s1', { streamId: 'v1', id: 'id-2', state: 'running' }), true);
  advance(120_001);
  assert.equal(probes.snapshot('v1').history[0].reason, 'expired');
  assert.equal(probes.allowsAsset('s1'), false);
});

test('a stream that ends ends its measurement, and the module is no longer allowed', () => {
  const { probes, live } = setup();
  probes.request('v1', 's1');
  assert.equal(probes.allowsAsset('s1'), true);
  assert.equal(probes.allowsAsset('s2'), false);
  live.delete('s1/v1');
  assert.equal(probes.allowsAsset('s1'), false);
  assert.deepEqual(
    {
      state: probes.snapshot('v1').history[0].state,
      reason: probes.snapshot('v1').history[0].reason,
    },
    { state: 'failed', reason: 'ended' },
  );
  // The registry is free again.
  assert.equal(probes.request('v3', 's2').state, 'requested');
});

test('a run reports running, then done with validated results', () => {
  const { probes, advance } = setup();
  probes.request('v1', 's1');
  probes.pickup('s1', 'v1');
  assert.equal(probes.report('s1', { streamId: 'v1', id: 'id-1', state: 'running' }), true);
  assert.equal(probes.snapshot('v1').active.state, 'running');
  advance(30_000);
  assert.equal(
    probes.report('s1', { streamId: 'v1', id: 'id-1', state: 'done', results: RESULTS }),
    true,
  );
  const [done] = probes.snapshot('v1').history;
  assert.equal(done.state, 'done');
  assert.equal(done.endedAt, 31_000);
  assert.equal(done.requestedAt, 1_000);
  assert.deepEqual(done.results, RESULTS);
  assert.equal(probes.snapshot('v1').active, null);
});

test('a viewer can fail a measurement with one of its reasons, even before running', () => {
  const { probes } = setup();
  probes.request('v1', 's1');
  probes.pickup('s1', 'v1');
  assert.equal(
    probes.report('s1', { streamId: 'v1', id: 'id-1', state: 'failed', reason: 'stream-changed' }),
    true,
  );
  assert.equal(probes.snapshot('v1').history[0].reason, 'stream-changed');
});

test('reports for another id, session or stream, or after the end, are refused and change nothing', () => {
  const { probes, advance } = setup();
  probes.request('v1', 's1');
  probes.pickup('s1', 'v1');
  assert.equal(probes.report('s1', { streamId: 'v1', id: 'id-9', state: 'running' }), false);
  assert.equal(probes.report('s2', { streamId: 'v1', id: 'id-1', state: 'running' }), false);
  assert.equal(probes.report('s1', { streamId: 'v2', id: 'id-1', state: 'running' }), false);
  assert.equal(probes.snapshot('v1').active.state, 'requested');
  advance(15_001);
  assert.equal(
    probes.report('s1', { streamId: 'v1', id: 'id-1', state: 'done', results: RESULTS }),
    false,
  );
  assert.equal(probes.snapshot('v1').history[0].reason, 'expired');
  assert.equal(probes.snapshot('v1').history[0].results, null);
});

test('an invalid report fails the measurement as invalid-report', () => {
  for (const report of [
    { state: 'done', results: { ...RESULTS, extra: 1 } },
    { state: 'done' },
    { state: 'failed', reason: 'bored' },
    { state: 'finished' },
    { state: 'running', reason: 'cancelled' },
  ]) {
    const { probes } = setup();
    probes.request('v1', 's1');
    probes.pickup('s1', 'v1');
    assert.throws(
      () => probes.report('s1', { streamId: 'v1', id: 'id-1', ...report }),
      /invalid latency report/i,
      JSON.stringify(report),
    );
    assert.deepEqual(
      {
        state: probes.snapshot('v1').history[0].state,
        reason: probes.snapshot('v1').history[0].reason,
      },
      { state: 'failed', reason: 'invalid-report' },
    );
  }
});

test('done needs running first, and running happens once', () => {
  const { probes } = setup();
  probes.request('v1', 's1');
  probes.pickup('s1', 'v1');
  assert.throws(
    () => probes.report('s1', { streamId: 'v1', id: 'id-1', state: 'done', results: RESULTS }),
    /invalid latency report/i,
  );
  probes.request('v1', 's1');
  probes.pickup('s1', 'v1');
  probes.report('s1', { streamId: 'v1', id: 'id-2', state: 'running' });
  assert.throws(
    () => probes.report('s1', { streamId: 'v1', id: 'id-2', state: 'running' }),
    /invalid latency report/i,
  );
});

test('history keeps the last five per stream, newest first', () => {
  const { probes } = setup();
  for (let index = 1; index <= 7; index++) {
    probes.request('v1', 's1');
    probes.pickup('s1', 'v1');
    probes.report('s1', {
      streamId: 'v1',
      id: `id-${index}`,
      state: 'failed',
      reason: 'cancelled',
    });
  }
  probes.request('v3', 's2');
  probes.pickup('s2', 'v3');
  probes.report('s2', { streamId: 'v3', id: 'id-8', state: 'failed', reason: 'no-control' });
  assert.deepEqual(
    probes.snapshot('v1').history.map((measurement) => measurement.id),
    ['id-7', 'id-6', 'id-5', 'id-4', 'id-3'],
  );
  assert.deepEqual(
    probes.snapshot('v3').history.map((measurement) => measurement.id),
    ['id-8'],
  );
  assert.deepEqual(probes.snapshot('v2'), { active: null, history: [] });
});

test('the default ids are 128 random bits in base64url', () => {
  const probes = new LatencyProbes({ isLive: () => true });
  assert.match(probes.request('v1', 's1').id, /^[A-Za-z0-9_-]{22}$/);
});
