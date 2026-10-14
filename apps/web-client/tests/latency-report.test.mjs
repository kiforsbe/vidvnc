import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countdown,
  describeState,
  detailRows,
  latencySignature,
  resultRows,
  stateLine,
} from '../src/latency-report.js';

const timing = (median) => ({ count: 40, min: 20.04, median, p95: 61.25, max: 80 });
const results = {
  handToGlassMs: { move: timing(42.36), key: { count: 0 } },
  handToReceiveMs: { move: timing(30), key: timing(31) },
  glassToGlassMs: { count: 900, min: -3, median: 35.5, p95: 50, max: 90 },
  dragMs: { follow: timing(48), settle: timing(70) },
  timeouts: { move: 0, key: 2, drag: 1 },
  clock: { offsetMs: 553.3, uncertaintyMs: 3 },
  overhead: {
    callbackMs: { count: 900, min: 0.2, median: 0.4, p95: 1.1, max: 3 },
    skippedFrames: 4,
  },
  receiver: {
    decodeFps: 59.94,
    jitterBufferMs: 35,
    decodeMs: 3.25,
    rttMs: null,
    lostInterval: 0,
    framesDropped: 1,
  },
  video: { width: 2560, height: 1440 },
  browser: 'Mozilla/5.0 (iPhone)',
};

test('every state and reason reads as a sentence', () => {
  assert.equal(describeState(null), 'No measurement yet.');
  assert.equal(describeState({ state: 'requested' }), 'Waiting for the viewer…');
  assert.equal(describeState({ state: 'running' }), 'Measuring…');
  assert.equal(
    describeState({ state: 'running', runningAt: 10_000, plannedMs: 30_000 }, 20_500),
    'Measuring… about 20 s left',
  );
  assert.equal(describeState({ state: 'done' }), 'Done');
  const reasons = {
    'no-control': "The viewer doesn't have keyboard and mouse control.",
    'no-probe-page': "The probe page isn't visible on the shared display.",
    unsupported: "The viewer's browser can't measure.",
    cancelled: 'Cancelled on the viewer.',
    'host-cancelled': 'Cancelled in Diagnostics.',
    'stream-changed': "The viewer isn't showing this stream.",
    'control-lost': 'The viewer lost control during the run.',
    expired: "The viewer didn't respond.",
    ended: 'The stream ended.',
    'invalid-report': 'The viewer sent invalid results.',
  };
  for (const [reason, sentence] of Object.entries(reasons))
    assert.equal(describeState({ state: 'failed', reason }), sentence, reason);
  assert.equal(describeState({ state: 'failed', reason: 'something new' }), 'Failed.');
});

test('timing rows give median, p95, range and count, rounded to 0.1 ms', () => {
  const rows = resultRows(results);
  assert.deepEqual(rows[0], ['Moves · hand to glass', '42.4', '61.3', '20.0–80.0', '40']);
  assert.deepEqual(rows[1], ['Key presses · hand to glass', '—', '—', '—', '0']);
  assert.deepEqual(
    rows.map(([label]) => label),
    [
      'Moves · hand to glass',
      'Key presses · hand to glass',
      'Drags · cursor behind the hand',
      'Drags · hand stops to cursor there',
      'Moves · hand to last packet',
      'Key presses · hand to last packet',
      'Glass to glass',
      'Time per frame read',
    ],
  );
  assert.deepEqual(rows[2], ['Drags · cursor behind the hand', '48.0', '61.3', '20.0–80.0', '40']);
  assert.deepEqual(rows[6], ['Glass to glass', '35.5', '50.0', '-3.0–90.0', '900']);
});

test('detail rows give the receiver, overhead, timeouts, video and browser', () => {
  assert.deepEqual(detailRows(results), [
    ['Trials without a change', '0 moves, 2 key presses, 1 drag'],
    ['Viewer clock', '553.3 ms behind this PC, ± 3.0 ms (glass to glass is corrected)'],
    ['Frames the probe missed', '4'],
    ['Decode rate', '59.9 fps'],
    ['Jitter buffer', '35.0 ms'],
    ['Decode time', '3.3 ms'],
    ['Round trip', '—'],
    ['Packets lost', '0'],
    ['Frames dropped', '1'],
    ['Video', '2560 × 1440'],
    ['Browser', 'Mozilla/5.0 (iPhone)'],
  ]);
});

test('the viewer clock reads ahead or behind, or unchecked', () => {
  const clock = (value) => detailRows({ ...results, clock: value })[1][1];
  assert.equal(
    clock({ offsetMs: -12.5, uncertaintyMs: 1 }),
    '12.5 ms ahead of this PC, ± 1.0 ms (glass to glass is corrected)',
  );
  assert.equal(clock(null), 'Not checked, so no glass to glass');
});

test('the probe page counts down from the planned length', () => {
  assert.equal(countdown(null, 0), 'Starting…');
  assert.equal(countdown({ state: 'requested' }, 0), 'Waiting for the viewer…');
  assert.equal(countdown({ state: 'running', runningAt: 0, plannedMs: null }, 1_000), 'Measuring…');
  const running = { state: 'running', runningAt: 10_000, plannedMs: 30_000 };
  assert.equal(countdown(running, 10_000), 'About 30 s left');
  assert.equal(countdown(running, 39_001), 'About 1 s left');
  assert.equal(countdown(running, 40_000), 'Finishing…');
});

test('a notice from the last click lasts only until the measurement state changes', () => {
  const idle = { active: null, history: [{ id: 'a', state: 'done' }] };
  const notice = { text: 'A measurement is already running.', seen: latencySignature(idle) };
  assert.equal(stateLine(idle, notice), 'A measurement is already running.');
  assert.equal(
    stateLine({ active: { id: 'b', state: 'requested' }, history: idle.history }, notice),
    'Waiting for the viewer…',
  );
  assert.equal(
    stateLine({ active: null, history: [{ id: 'b', state: 'done' }, ...idle.history] }, notice),
    'Done',
  );
  assert.equal(stateLine(idle, null), 'Done');
  assert.equal(stateLine(undefined, null), 'No measurement yet.');
});
