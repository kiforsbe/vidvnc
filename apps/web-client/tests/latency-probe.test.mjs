import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LAYOUT,
  buildResults,
  classify,
  decodePosition,
  decodeTimestamp,
  desktopRect,
  encodePosition,
  encodeTimestamp,
  handTime,
  outcomeReport,
  readFrame,
  runLatencyProbe,
  strokePoint,
  summarize,
  unwrapTimestamp,
} from '../src/viewer/latency-probe.js';

// A frame as the probe page paints it, read back as luma per cell.
function paintedFrame({ time, key, move, x = 0, black = 16, white = 235, grey = 128 }) {
  const cells = new Map();
  const set = (column, row, value) => cells.set(`${column},${row}`, value);
  const { column, row, perRow } = LAYOUT.barcode;
  set(column, row, black);
  set(column + 1, row, white);
  set(column, row + 1, white);
  set(column + 1, row + 1, black);
  encodeTimestamp(time).forEach((bit, index) =>
    set(column + 2 + (index % perRow), row + Math.floor(index / perRow), bit ? white : black),
  );
  encodePosition(x).forEach((bit, index) =>
    set(LAYOUT.position.column + index, LAYOUT.position.row, bit ? white : black),
  );
  for (const [patch, on] of [
    [LAYOUT.keyPatch, key],
    [LAYOUT.movePatch, move],
  ])
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) set(patch.column + dx, patch.row + dy, on ? white : black);
  return (c, r) => cells.get(`${c},${r}`) ?? grey;
}

test('timestamps survive the barcode, low 32 bits', () => {
  for (const ms of [0, 1, 1_700_000_000_123, 2 ** 32 - 1, 2 ** 32 + 5])
    assert.equal(decodeTimestamp(encodeTimestamp(ms)), ms % 2 ** 32);
});

test('a flipped bit or an unreadable cell fails the barcode', () => {
  const bits = encodeTimestamp(1_700_000_000_123);
  for (const index of [0, 17, 31, 39]) {
    const corrupt = [...bits];
    corrupt[index] ^= 1;
    assert.equal(decodeTimestamp(corrupt), null);
  }
  assert.equal(decodeTimestamp([...bits.slice(0, 39), null]), null);
  assert.equal(decodeTimestamp(bits.slice(1)), null);
});

test('unwrapping finds the host time nearest the viewer clock', () => {
  const host = 1_760_000_000_000;
  const low = host % 2 ** 32;
  assert.equal(unwrapTimestamp(low, host + 25), host);
  assert.equal(unwrapTimestamp(low, host - 25), host);
});

test('cells between the references are unreadable', () => {
  assert.equal(classify(20, 16, 235), 0);
  assert.equal(classify(230, 16, 235), 1);
  assert.equal(classify(128, 16, 235), null);
  assert.equal(classify(128, 120, 140), null, 'too little contrast');
});

test('pointer positions survive their barcode to 1/4095 of the screen, and a flip fails it', () => {
  for (const x of [0, 0.2, 0.5, 0.7531, 1])
    assert.ok(Math.abs(decodePosition(encodePosition(x)) - x) <= 0.5 / 4095, String(x));
  assert.equal(decodePosition(encodePosition(1.5)), 1, 'clamped');
  const bits = encodePosition(0.37);
  for (const index of [0, 5, 11, 12, 15]) {
    const corrupt = [...bits];
    corrupt[index] ^= 1;
    assert.equal(decodePosition(corrupt), null, `bit ${index}`);
  }
  assert.equal(decodePosition([...bits.slice(0, 15), null]), null);
});

test('a painted frame reads back time, both patches and the pointer position', () => {
  const time = 1_760_000_123_456;
  const read = readFrame(paintedFrame({ time, key: 1, move: 0, x: 0.25 }));
  assert.deepEqual(
    { ...read, x: Math.round(read.x * 4095) },
    { hostTime: time % 2 ** 32, key: 1, move: 0, x: Math.round(0.25 * 4095) },
  );
  // Compression narrows the range; the references carry it.
  const narrow = readFrame(paintedFrame({ time, key: 0, move: 1, x: 0.8, black: 60, white: 190 }));
  assert.deepEqual([narrow.hostTime, narrow.key, narrow.move], [time % 2 ** 32, 0, 1]);
  assert.ok(Math.abs(narrow.x - 0.8) < 0.001);
});

test('a frame without the probe page reads nothing', () => {
  assert.deepEqual(
    readFrame(() => 128),
    { hostTime: null, key: null, move: null, x: null },
  );
});

test('a stroke eases in and out like a hand, along a gentle arc', () => {
  const stroke = { from: 0.2, to: 0.8 };
  assert.deepEqual(strokePoint(stroke, 0), { x: 0.2, y: 0.75 });
  assert.deepEqual(strokePoint(stroke, 1), { x: 0.8, y: 0.75 });
  const middle = strokePoint(stroke, 0.5);
  assert.ok(Math.abs(middle.x - 0.5) < 1e-9);
  assert.ok(middle.y < 0.75 && middle.y >= 0.7, 'arcs up, away from the patches at the top');
  // Slow at both ends, fastest in the middle.
  const step = (t) => strokePoint(stroke, t + 0.05).x - strokePoint(stroke, t).x;
  assert.ok(step(0) < step(0.475) / 4 && step(0.95) < step(0.475) / 4);
  assert.ok(strokePoint({ from: 0.8, to: 0.2 }, 0.25).x > 0.5, 'and backwards');
});

test('the hand time at a position is interpolated along the stroke, once it got there', () => {
  const points = [
    { x: 0.2, at: 100 },
    { x: 0.3, at: 116 },
    { x: 0.5, at: 132 },
  ];
  assert.equal(handTime(points, 0.4), 124);
  assert.equal(handTime(points, 0.3), 116);
  assert.equal(handTime(points, 0.6), null, 'the hand has not been there yet');
  assert.equal(handTime(points, 0.1), null);
  const back = points.map(({ x, at }) => ({ x: 1 - x, at }));
  assert.equal(handTime(back, 0.6), 124);
});

test('the desktop rectangle allows for the bars the host encodes', () => {
  assert.deepEqual(desktopRect(1280, 720, null), { x: 0, y: 0, width: 1280, height: 720 });
  assert.deepEqual(desktopRect(1280, 720, { width: 1920, height: 1080 }), {
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
  });
  // A 16:10 screen in a 16:9 profile: bars left and right.
  assert.deepEqual(desktopRect(1280, 720, { width: 2560, height: 1600 }), {
    x: 64,
    y: 0,
    width: 1152,
    height: 720,
  });
});

test('summaries give count, min, median, p95 and max', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.deepEqual(summarize(values), { count: 100, min: 1, median: 50, p95: 95, max: 100 });
  assert.deepEqual(summarize([null, Number.NaN]), { count: 0 });
});

test('results follow the server schema field by field', () => {
  const results = buildResults({
    samples: {
      move: [
        { handToGlass: 10, handToReceive: 4 },
        { handToGlass: 20, handToReceive: null },
      ],
      key: [],
    },
    timeouts: { move: 1, key: 0, drag: 2 },
    drag: { follow: [12, 14, -1], settle: [40] },
    clock: { offsetMs: -553.26, uncertaintyMs: 3.04 },
    glass: [548, 583, 70_000],
    overhead: { callbackMs: [1, 2], skippedFrames: 3 },
    receiver: { decodeFps: 60, jitterBufferMs: 30, decodeMs: undefined, rttMs: Number.NaN },
    video: { width: 1280, height: 720 },
    browser: 'x'.repeat(300),
  });
  assert.deepEqual(Object.keys(results).sort(), [
    'browser',
    'clock',
    'dragMs',
    'glassToGlassMs',
    'handToGlassMs',
    'handToReceiveMs',
    'overhead',
    'receiver',
    'timeouts',
    'video',
  ]);
  assert.deepEqual(results.handToGlassMs, {
    move: { count: 2, min: 10, median: 10, p95: 20, max: 20 },
    key: { count: 0 },
  });
  assert.deepEqual(results.handToReceiveMs.move, { count: 1, min: 4, median: 4, p95: 4, max: 4 });
  // Corrected by the clock offset; out of the schema's range, 70 s is left out rather than
  // failing the whole report.
  assert.deepEqual(results.glassToGlassMs, {
    count: 2,
    min: -5.3,
    median: -5.3,
    p95: 29.7,
    max: 29.7,
  });
  assert.deepEqual(results.clock, { offsetMs: -553.3, uncertaintyMs: 3 });
  assert.deepEqual(results.dragMs, {
    follow: { count: 2, min: 12, median: 12, p95: 14, max: 14 },
    settle: { count: 1, min: 40, median: 40, p95: 40, max: 40 },
  });
  assert.deepEqual(results.overhead, {
    callbackMs: { count: 2, min: 1, median: 1, p95: 2, max: 2 },
    skippedFrames: 3,
  });
  assert.deepEqual(results.receiver, {
    decodeFps: 60,
    jitterBufferMs: 30,
    decodeMs: null,
    rttMs: null,
    lostInterval: null,
    framesDropped: null,
  });
  assert.equal(results.browser.length, 200);
  assert.deepEqual(results.timeouts, { move: 1, key: 0, drag: 2 });
  assert.deepEqual(results.video, { width: 1280, height: 720 });
});

test('results without receiver stats carry nulls, and long sample lists stay within 1,000', () => {
  const many = Array.from({ length: 2_500 }, (_, index) => index % 50);
  const results = buildResults({
    samples: { move: [], key: [] },
    timeouts: { move: 0, key: 0, drag: 0 },
    drag: { follow: [], settle: [] },
    clock: { offsetMs: 0, uncertaintyMs: 1 },
    glass: many,
    overhead: { callbackMs: many, skippedFrames: 0 },
    receiver: null,
    video: { width: 0, height: 0 },
    browser: '',
  });
  assert.equal(results.receiver.rttMs, null);
  assert.equal(results.glassToGlassMs.count, 1_000);
  assert.equal(results.overhead.callbackMs.count, 1_000);
});

test('without a clock check, glass-to-glass is left empty rather than off by the offset', () => {
  const results = buildResults({
    samples: { move: [], key: [] },
    timeouts: { move: 0, key: 0, drag: 0 },
    drag: { follow: [], settle: [] },
    clock: null,
    glass: [548, 583],
    overhead: { callbackMs: [], skippedFrames: 0 },
    receiver: null,
    video: { width: 0, height: 0 },
    browser: '',
  });
  assert.deepEqual(results.glassToGlassMs, { count: 0 });
  assert.equal(results.clock, null);
});

// A video whose frames come from a scripted probe page: the key patch flips on each key
// press and the move patch follows the pointer, a few milliseconds after the input.
function fakeHost({
  barcode = true,
  keyWorks = true,
  frameMs = 2,
  inputMs = 6,
  hostAheadMs = 0,
} = {}) {
  const state = { key: 0, move: 0, x: 0.5 };
  const sent = [];
  let callbacks = [];
  let presented = 0;
  const timer = setInterval(() => {
    const due = callbacks;
    callbacks = [];
    presented++;
    const shown = performance.now();
    for (const callback of due)
      callback(shown, {
        expectedDisplayTime: shown,
        presentedFrames: presented,
        receiveTime: shown - 1,
      });
  }, frameMs);
  return {
    state,
    sent,
    stop: () => clearInterval(timer),
    // The probe page leaves the screen: frames no longer carry the barcode or the patches.
    hide: () => (barcode = false),
    video: {
      videoWidth: 1280,
      videoHeight: 720,
      requestVideoFrameCallback: (callback) => callbacks.push(callback),
    },
    readFrameFrom: () =>
      barcode
        ? { hostTime: (Date.now() + hostAheadMs) % 2 ** 32, ...state }
        : { hostTime: null, key: null, move: null, x: null },
    // The server's clock (the host PC's), read halfway through a short round trip.
    clock: () =>
      new Promise((resolve) => {
        const sent = Date.now();
        setTimeout(() => resolve((sent + Date.now()) / 2 + hostAheadMs), 2);
      }),
    send(message) {
      sent.push(message);
      setTimeout(() => {
        if (message.type === 'move') {
          state.move = message.x > 0.5 ? 1 : 0;
          state.x = message.x;
        }
        if (message.type === 'key' && message.down && keyWorks) state.key ^= 1;
      }, inputMs);
    },
  };
}

function run(host, options = {}) {
  return runLatencyProbe({
    video: host.video,
    send: (message) => host.send(message),
    canControl: () => true,
    source: () => null,
    getStats: null,
    summarizeReceiver: null,
    readFrameFrom: host.readFrameFrom,
    trials: 3,
    strokes: 0,
    probeWaitMs: 100,
    trialTimeoutMs: 200,
    pauseMs: () => 1,
    strokeMs: () => 120,
    strokePauseMs: () => 1,
    nextFrame: () => new Promise((resolve) => setTimeout(resolve, 4)),
    clockSamples: 3,
    ...options,
  });
}

test('a run without requestVideoFrameCallback is unsupported', async () => {
  const host = fakeHost();
  host.stop();
  const outcome = await run({ ...host, video: { videoWidth: 1, videoHeight: 1 } });
  assert.deepEqual(outcome, { state: 'failed', reason: 'unsupported' });
});

test('a run without control is no-control, and sends nothing', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  assert.deepEqual(await run(host, { canControl: () => false }), {
    state: 'failed',
    reason: 'no-control',
  });
  assert.equal(host.sent.length, 0);
});

test('a run that cannot read the probe page within the wait is no-probe-page', async (t) => {
  const host = fakeHost({ barcode: false });
  t.after(host.stop);
  let started = false;
  const outcome = await run(host, { onRunning: () => (started = true) });
  assert.deepEqual(outcome, { state: 'failed', reason: 'no-probe-page' });
  assert.equal(started, false, 'running is reported only after the checks pass');
  assert.equal(host.sent.length, 0);
});

test('a key press that does not flip the patch stops the run as no-probe-page', async (t) => {
  const host = fakeHost({ keyWorks: false });
  t.after(host.stop);
  assert.deepEqual(await run(host), { state: 'failed', reason: 'no-probe-page' });
});

test('a full run reports done with a sample per trial', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  let started = 0;
  const outcome = await run(host, { onRunning: () => started++ });
  assert.equal(started, 1);
  assert.equal(outcome.state, 'done');
  const { results } = outcome;
  assert.equal(results.handToGlassMs.move.count, 3);
  assert.equal(results.handToGlassMs.key.count, 3);
  assert.ok(results.handToGlassMs.key.min >= 5, 'measured after the input took effect');
  assert.equal(results.handToReceiveMs.move.count, 3);
  assert.deepEqual(results.glassToGlassMs, { count: 0 }, 'no clock check, no glass to glass');
  assert.equal(results.clock, null);
  assert.ok(results.overhead.callbackMs.count > 0);
  assert.deepEqual(results.timeouts, { move: 0, key: 0, drag: 0 });
  assert.equal(host.sent.filter((message) => message.type === 'move').length, 3);
  assert.equal(host.sent.filter((message) => message.type === 'key').length, 6);
});

test('the planned length goes with running: pauses, trials, strokes and clock checks', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  let planned = null;
  await run(host, {
    trials: 2,
    strokes: 2,
    pauseMs: () => 100,
    strokeMs: () => 500,
    strokePauseMs: () => 300,
    onRunning: (plannedMs) => (planned = plannedMs),
  });
  // 4 trials of (100 + 120), 2 strokes of (500 + 150 + 300), and 2 x 3 clock checks of 30.
  assert.equal(planned, 4 * 220 + 2 * 950 + 6 * 30);
  const controller = new AbortController();
  await run(host, {
    trials: 40,
    pauseMs: () => 5_000,
    deadlineMs: 60_000,
    signal: controller.signal,
    onRunning: (plannedMs) => {
      planned = plannedMs;
      controller.abort();
    },
  });
  assert.equal(planned, 60_000, 'never past the deadline');
});

test('drag strokes go through the user move path and time the cursor following the hand', async (t) => {
  const host = fakeHost({ inputMs: 10 });
  t.after(host.stop);
  const moves = [];
  const outcome = await run(host, {
    trials: 1,
    strokes: 3,
    userMove: (point) => {
      moves.push(point);
      host.send({ type: 'move', ...point });
    },
  });
  assert.equal(outcome.state, 'done');
  const { dragMs, timeouts } = outcome.results;
  assert.ok(moves.length > 20, `${moves.length} user moves`);
  assert.equal(timeouts.drag, 0);
  assert.equal(dragMs.settle.count, 3, 'one settle per stroke');
  assert.ok(dragMs.follow.count > 5, `${dragMs.follow.count} follow samples`);
  // The fake host shows a move 10 ms after it is sent, on a 2 ms frame clock.
  // (Timers on Windows can add up to about 16 ms more.)
  assert.ok(dragMs.follow.median >= 9 && dragMs.follow.median < 60, `${dragMs.follow.median}`);
  assert.ok(dragMs.settle.min >= 9, `${dragMs.settle.min}`);
});

test('a stroke whose end never reaches the screen counts as a drag timeout', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  // A user move path that drops everything past the middle, as a throttle without a trailing
  // send can drop a stroke's last move.
  const outcome = await run(host, {
    trials: 1,
    strokes: 2,
    trialTimeoutMs: 100,
    userMove: (point) => {
      if (Math.abs(point.x - 0.5) < 0.1) host.send({ type: 'move', ...point });
    },
  });
  assert.equal(outcome.state, 'done');
  assert.equal(outcome.results.timeouts.drag, 2);
  assert.equal(outcome.results.dragMs.settle.count, 0);
});

test('glass-to-glass is corrected by the clock checked against the server', async (t) => {
  const host = fakeHost({ hostAheadMs: 600 });
  t.after(host.stop);
  const outcome = await run(host, { clock: host.clock });
  const { clock, glassToGlassMs } = outcome.results;
  assert.ok(clock.uncertaintyMs >= 0 && clock.uncertaintyMs < 20, `${clock.uncertaintyMs}`);
  assert.ok(
    Math.abs(clock.offsetMs - 600) <= clock.uncertaintyMs + 2,
    `offset ${clock.offsetMs} +/- ${clock.uncertaintyMs}`,
  );
  assert.ok(glassToGlassMs.count > 0);
  assert.ok(
    glassToGlassMs.median > -20 && glassToGlassMs.median < 40,
    `glass to glass ${glassToGlassMs.median}`,
  );
  const unchecked = await run(host, {
    clock: async () => {
      throw new Error('Unknown measurement');
    },
  });
  assert.equal(unchecked.results.clock, null);
  assert.deepEqual(unchecked.results.glassToGlassMs, { count: 0 });
});

test('aborting mid-run is cancelled, and no input is sent after the abort', async (t) => {
  const host = fakeHost({ inputMs: 30 });
  t.after(host.stop);
  const controller = new AbortController();
  const send = (message) => {
    host.send(message);
    if (host.sent.length === 1) controller.abort();
  };
  const outcome = await run(host, { send, signal: controller.signal, trials: 10 });
  assert.deepEqual(outcome, { state: 'failed', reason: 'cancelled' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.sent.length, 1);
});

test('losing control mid-run is control-lost, and stops input at once', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  let control = true;
  const send = (message) => {
    host.send(message);
    if (host.sent.length === 3) control = false;
  };
  const outcome = await run(host, { send, canControl: () => control, trials: 10 });
  assert.deepEqual(outcome, { state: 'failed', reason: 'control-lost' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.sent.length, 3);
});

test('a run stops reading frames when it returns', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  let reads = 0;
  await run(host, { readFrameFrom: (video) => (reads++, host.readFrameFrom(video)) });
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, after);
});

test('a run whose running report is refused stops at once and sends nothing', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  const outcome = await run(host, {
    onRunning: async () => {
      throw new Error('Unknown measurement');
    },
  });
  assert.deepEqual(outcome, { state: 'failed', reason: 'refused' });
  assert.equal(host.sent.length, 0);
});

test('a probe page that leaves the screen mid-run stops the run as no-probe-page', async (t) => {
  const host = fakeHost();
  t.after(host.stop);
  const send = (message) => {
    host.send(message);
    if (host.sent.length === 4) host.hide();
  };
  const outcome = await run(host, { send, trials: 40, probeWaitMs: 100, trialTimeoutMs: 50 });
  assert.deepEqual(outcome, { state: 'failed', reason: 'no-probe-page' });
  assert.ok(host.sent.length <= 6, `sent ${host.sent.length} messages`);
});

test('a run that reaches its deadline ends with the samples it has', async (t) => {
  const host = fakeHost({ inputMs: 20 });
  t.after(host.stop);
  const outcome = await run(host, { trials: 40, deadlineMs: 150 });
  assert.equal(outcome.state, 'done');
  const taken = outcome.results.handToGlassMs.move.count + outcome.results.handToGlassMs.key.count;
  assert.ok(taken > 0 && taken < 80, `took ${taken} samples`);
});

test('the outcome a viewer reports: none after a refusal or when it goes away', () => {
  const results = { any: 1 };
  assert.deepEqual(outcomeReport({ state: 'done', results }, null), { state: 'done', results });
  assert.deepEqual(outcomeReport({ state: 'failed', reason: 'cancelled' }, 'stream-changed'), {
    state: 'failed',
    reason: 'stream-changed',
  });
  assert.deepEqual(outcomeReport({ state: 'failed', reason: 'no-control' }, 'cancelled'), {
    state: 'failed',
    reason: 'no-control',
  });
  assert.equal(outcomeReport({ state: 'failed', reason: 'refused' }, null), null);
  // Disconnecting or leaving the page: the stream's end settles it on the server.
  assert.equal(outcomeReport({ state: 'failed', reason: 'cancelled' }, 'gone'), null);
});
