import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  GRID,
  LAYOUT,
  PROBE_KEY,
  classify,
  decodeTimestamp,
  desktopRect,
  encodeTimestamp,
  readFrame,
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
