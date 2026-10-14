// The latency probe page, shown full screen inside Diagnostics while a measurement runs: a
// barcode of this PC's clock, a patch that flips on each press of L, one that follows the
// half of the screen the pointer is in, and a row of cells with the pointer's x. The viewer reads them from the stream
// (viewer/latency-probe.js, which owns the layout). See tools/debug/README.md#latency-probe.

import {
  GRID,
  LAYOUT,
  PROBE_KEY,
  encodePosition,
  encodeTimestamp,
} from './viewer/latency-probe.js';

// Paints one frame on a `width` × `height` canvas.
export function paintProbe(context, width, height, { time, key, move, x }) {
  const cell = (column, row, white) => {
    // Whole pixels, so neighbouring cells never blend.
    const x = Math.round((column * width) / GRID.columns),
      y = Math.round((row * height) / GRID.rows);
    context.fillStyle = white ? '#fff' : '#000';
    context.fillRect(
      x,
      y,
      Math.round(((column + 1) * width) / GRID.columns) - x,
      Math.round(((row + 1) * height) / GRID.rows) - y,
    );
  };
  const patch = ({ column, row }, white) => {
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) cell(column + dx, row + dy, white);
  };
  context.fillStyle = '#808080';
  context.fillRect(0, 0, width, height);
  const { column, row, perRow } = LAYOUT.barcode;
  cell(column, row, false);
  cell(column + 1, row, true);
  cell(column, row + 1, true);
  cell(column + 1, row + 1, false);
  encodeTimestamp(time).forEach((bit, index) =>
    cell(column + 2 + (index % perRow), row + Math.floor(index / perRow), bit === 1),
  );
  encodePosition(x).forEach((bit, index) =>
    cell(LAYOUT.position.column + index, LAYOUT.position.row, bit === 1),
  );
  patch(LAYOUT.keyPatch, key === 1);
  patch(LAYOUT.movePatch, move === 1);
}

// 1 when the pointer is in the right half of a `width`-wide screen.
export function moveHalf(clientX, width) {
  return clientX > width / 2 ? 1 : 0;
}

// Shows `layer` (which holds a canvas) full screen and paints the probe every frame until
// close(). Call it from a click: full screen needs the gesture, so nothing may be awaited
// first. Rejects when full screen is refused. `onExit` runs when the person leaves full screen
// (Esc) rather than close() ending it.
export async function showProbe(layer, { onExit = () => {} } = {}) {
  const canvas = layer.querySelector('canvas');
  const context = canvas.getContext('2d');
  let key = 0,
    move = 0,
    x = 0.5,
    frame = 0,
    closed = false;
  layer.hidden = false;
  try {
    await layer.requestFullscreen();
  } catch (error) {
    layer.hidden = true;
    throw error;
  }
  const draw = () => {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth * ratio),
      height = Math.round(window.innerHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    paintProbe(context, width, height, { time: Date.now(), key, move, x });
  };
  const loop = () => {
    draw();
    frame = requestAnimationFrame(loop);
  };
  const onKey = (event) => {
    if (event.code !== PROBE_KEY) return;
    event.preventDefault();
    if (event.repeat) return;
    key ^= 1;
    draw();
  };
  const onMove = (event) => {
    x = event.clientX / window.innerWidth;
    move = moveHalf(event.clientX, window.innerWidth);
    draw();
  };
  const onChange = () => {
    if (document.fullscreenElement !== layer) close(true);
  };
  function close(exited) {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('fullscreenchange', onChange);
    layer.hidden = true;
    if (document.fullscreenElement === layer) document.exitFullscreen().catch(() => {});
    if (exited) onExit();
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointermove', onMove);
  document.addEventListener('fullscreenchange', onChange);
  onChange();
  if (!closed) loop();
  return { close: () => close(false) };
}
