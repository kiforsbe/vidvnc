import assert from 'node:assert/strict';
import test from 'node:test';
import { moveHalf, paintProbe } from '../src/latency-probe-page.js';
import { GRID, readFrame } from '../src/viewer/latency-probe.js';

// A 2D context that keeps its rectangles, read back as luma at a point (the last fill wins).
function fakeContext() {
  const rects = [];
  return {
    rects,
    fillStyle: '#000',
    fillRect(x, y, width, height) {
      rects.push({ x, y, width, height, fill: this.fillStyle });
    },
    lumaAt(x, y) {
      const hit = rects.findLast(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
      );
      return { '#000': 16, '#fff': 235, '#808080': 128 }[hit?.fill] ?? 0;
    },
  };
}

test('the Diagnostics probe layer paints what the viewer reads', () => {
  for (const [width, height] of [
    [2560, 1440],
    [1366, 768],
    [3840, 2400],
  ]) {
    const time = 1_760_000_123_456;
    for (const [key, move, x] of [
      [0, 1, 0.8],
      [1, 0, 0.2],
    ]) {
      const context = fakeContext();
      paintProbe(context, width, height, { time, key, move, x });
      const cell = (column, row) =>
        context.lumaAt(((column + 0.5) * width) / GRID.columns, ((row + 0.5) * height) / GRID.rows);
      const read = readFrame(cell);
      assert.deepEqual(
        { ...read, x: Math.round(read.x * 4095) },
        { hostTime: time % 2 ** 32, key, move, x: Math.round(x * 4095) },
        `${width}`,
      );
    }
  }
});

test('cells are whole pixels that tile without gaps or overlaps', () => {
  const context = fakeContext();
  paintProbe(context, 1366, 768, { time: 0, key: 0, move: 0, x: 0.5 });
  for (const { x, y, width, height } of context.rects)
    assert.ok([x, y, width, height].every(Number.isInteger));
  const [background, ...cells] = context.rects;
  assert.deepEqual(background, { x: 0, y: 0, width: 1366, height: 768, fill: '#808080' });
  const right = new Map(cells.map((r) => [`${r.x + r.width},${r.y}`, r]));
  for (const r of cells) {
    const left = right.get(`${r.x},${r.y}`);
    if (left) assert.equal(left.height, r.height, 'neighbours line up');
  }
});

test('the move patch follows the half the pointer is in', () => {
  assert.equal(moveHalf(0, 1920), 0);
  assert.equal(moveHalf(960, 1920), 0);
  assert.equal(moveHalf(961, 1920), 1);
  assert.equal(moveHalf(1919, 1920), 1);
});
