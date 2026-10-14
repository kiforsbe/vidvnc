import test from 'node:test';
import assert from 'node:assert/strict';
import { LATENCY_REASONS, validateLatencyResults } from '../src/latency-results.mjs';

const timing = (median = 40) => ({ count: 40, min: 20, median, p95: 60, max: 80 });
function valid() {
  return {
    handToGlassMs: { move: timing(70), key: timing(75) },
    handToReceiveMs: { move: timing(50), key: { count: 0 } },
    glassToGlassMs: { count: 300, min: -12.5, median: 30, p95: 45, max: 90 },
    timeouts: { move: 0, key: 1 },
    overhead: { callbackMs: timing(1.5), skippedFrames: 2 },
    receiver: {
      decodeFps: 59.9,
      jitterBufferMs: 35,
      decodeMs: 4,
      rttMs: 3,
      lostInterval: 0,
      framesDropped: null,
    },
    video: { width: 2560, height: 1440 },
    browser: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)',
  };
}
const rejects = (value, message) =>
  assert.throws(() => validateLatencyResults(value), /invalid latency results/i, message);

test('a complete results body is accepted and copied', () => {
  const input = valid();
  const output = validateLatencyResults(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.handToGlassMs, input.handToGlassMs);
});

test('every timing rejects values that are not finite milliseconds in range', () => {
  const paths = [
    ['handToGlassMs', 'move'],
    ['handToGlassMs', 'key'],
    ['handToReceiveMs', 'move'],
    ['handToReceiveMs', 'key'],
    ['glassToGlassMs'],
    ['overhead', 'callbackMs'],
  ];
  for (const path of paths)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '40', 60_001]) {
      if (path[0] === 'glassToGlassMs' && bad === -1) continue;
      const value = valid();
      const holder = path.slice(0, -1).reduce((object, key) => object[key], value);
      holder[path.at(-1)] = { ...timing(), max: bad };
      rejects(value, `${path.join('.')} max ${String(bad)}`);
    }
});

test('glass-to-glass may be negative, down to -60,000, because of the clock offset', () => {
  const value = valid();
  value.glassToGlassMs = { count: 3, min: -59_999, median: -100, p95: 10, max: 20 };
  assert.equal(validateLatencyResults(value).glassToGlassMs.min, -59_999);
  value.glassToGlassMs.min = -60_001;
  rejects(value);
});

test('counts are whole numbers up to 1,000, and an empty timing is just a zero count', () => {
  for (const count of [1.5, 1_001, -1]) {
    const value = valid();
    value.handToGlassMs.move.count = count;
    rejects(value, `count ${count}`);
  }
  const value = valid();
  value.handToGlassMs.move = { count: 0 };
  assert.deepEqual(validateLatencyResults(value).handToGlassMs.move, { count: 0 });
  value.handToGlassMs.move = { count: 0, median: 3 };
  rejects(value, 'an empty timing carries no figures');
});

test('unknown fields are rejected, at the top and inside', () => {
  rejects({ ...valid(), extra: 1 });
  const nested = valid();
  nested.receiver.pixels = 1;
  rejects(nested);
  const timingExtra = valid();
  timingExtra.handToGlassMs.key.mean = 40;
  rejects(timingExtra);
  const missing = valid();
  delete missing.timeouts;
  rejects(missing);
});

test('receiver figures are finite numbers or null', () => {
  const value = valid();
  value.receiver.rttMs = null;
  assert.equal(validateLatencyResults(value).receiver.rttMs, null);
  value.receiver.rttMs = Number.NaN;
  rejects(value);
  value.receiver.rttMs = '3';
  rejects(value);
});

test('the browser string, video size, timeouts and skipped frames are bounded', () => {
  const browser = valid();
  browser.browser = 'x'.repeat(201);
  rejects(browser);
  browser.browser = 'x'.repeat(200);
  assert.equal(validateLatencyResults(browser).browser.length, 200);
  const video = valid();
  video.video.width = 16_385;
  rejects(video);
  const timeouts = valid();
  timeouts.timeouts.key = 1_001;
  rejects(timeouts);
  const skipped = valid();
  skipped.overhead.skippedFrames = 1.5;
  rejects(skipped);
  for (const bad of [null, [], 'results', 7]) rejects(bad);
});

test('the viewer reasons are the fixed set', () => {
  assert.deepEqual([...LATENCY_REASONS].sort(), [
    'cancelled',
    'control-lost',
    'no-control',
    'no-probe-page',
    'stream-changed',
    'unsupported',
  ]);
  assert.ok(Object.isFrozen(LATENCY_REASONS));
});
