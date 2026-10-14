import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  GRID,
  LAYOUT,
  PROBE_KEY,
  buildResults,
  classify,
  decodeTimestamp,
  desktopRect,
  encodeTimestamp,
  outcomeReport,
  readFrame,
  runLatencyProbe,
  summarize,
  unwrapTimestamp,
} from '../src/viewer/latency-probe.js';

const probePage = new URL('../../../tools/debug/latency-probe.html', import.meta.url);

// A frame as the probe page paints it, read back as luma per cell.
function paintedFrame({ time, key, move, black = 16, white = 235, grey = 128 }) {
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

test('a painted frame reads back time and both patches', () => {
  const time = 1_760_000_123_456;
  assert.deepEqual(readFrame(paintedFrame({ time, key: 1, move: 0 })), {
    hostTime: time % 2 ** 32,
    key: 1,
    move: 0,
  });
  // Compression narrows the range; the references carry it.
  assert.deepEqual(readFrame(paintedFrame({ time, key: 0, move: 1, black: 60, white: 190 })), {
    hostTime: time % 2 ** 32,
    key: 0,
    move: 1,
  });
});

test('a frame without the probe page reads nothing', () => {
  assert.deepEqual(
    readFrame(() => 128),
    { hostTime: null, key: null, move: null },
  );
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

test('the host probe page paints what the viewer reads', async () => {
  const html = await readFile(probePage, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const page = vm.runInNewContext(`${script}\n;({ GRID, LAYOUT, PROBE_KEY, encodeTimestamp })`, {});
  assert.deepEqual(JSON.parse(JSON.stringify(page.GRID)), GRID);
  assert.deepEqual(JSON.parse(JSON.stringify(page.LAYOUT)), LAYOUT);
  assert.equal(page.PROBE_KEY, PROBE_KEY);
  for (const ms of [0, 1_760_000_123_456, 2 ** 32 + 99])
    assert.deepEqual([...page.encodeTimestamp(ms)], encodeTimestamp(ms));
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
    timeouts: { move: 1, key: 0 },
    glass: [-5, 30, 70_000],
    overhead: { callbackMs: [1, 2], skippedFrames: 3 },
    receiver: { decodeFps: 60, jitterBufferMs: 30, decodeMs: undefined, rttMs: Number.NaN },
    video: { width: 1280, height: 720 },
    browser: 'x'.repeat(300),
  });
  assert.deepEqual(Object.keys(results).sort(), [
    'browser',
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
  // Out of the schema's range, 70 s is left out rather than failing the whole report.
  assert.deepEqual(results.glassToGlassMs, { count: 2, min: -5, median: -5, p95: 30, max: 30 });
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
  assert.deepEqual(results.timeouts, { move: 1, key: 0 });
  assert.deepEqual(results.video, { width: 1280, height: 720 });
});

test('results without receiver stats carry nulls, and long sample lists stay within 1,000', () => {
  const many = Array.from({ length: 2_500 }, (_, index) => index % 50);
  const results = buildResults({
    samples: { move: [], key: [] },
    timeouts: { move: 0, key: 0 },
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

// A video whose frames come from a scripted probe page: the key patch flips on each key
// press and the move patch follows the pointer, a few milliseconds after the input.
function fakeHost({ barcode = true, keyWorks = true, frameMs = 2, inputMs = 6 } = {}) {
  const state = { key: 0, move: 0 };
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
    video: {
      videoWidth: 1280,
      videoHeight: 720,
      requestVideoFrameCallback: (callback) => callbacks.push(callback),
    },
    readFrameFrom: () => ({ hostTime: barcode ? Date.now() % 2 ** 32 : null, ...state }),
    send(message) {
      sent.push(message);
      setTimeout(() => {
        if (message.type === 'move') state.move = message.x > 0.5 ? 1 : 0;
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
    probeWaitMs: 100,
    trialTimeoutMs: 200,
    pauseMs: () => 1,
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
  assert.ok(results.glassToGlassMs.count > 0);
  assert.ok(results.overhead.callbackMs.count > 0);
  assert.deepEqual(results.timeouts, { move: 0, key: 0 });
  assert.equal(host.sent.filter((message) => message.type === 'move').length, 3);
  assert.equal(host.sent.filter((message) => message.type === 'key').length, 6);
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
