// Latency probe, for development: measures hand-to-glass and glass-to-glass latency against
// the host probe page (tools/debug/latency-probe.html) shown full screen on the shared
// display. The viewer creates it only with ?latency-probe in its address, and it sends input
// only while this device holds keyboard and mouse control, through the normal input path.
//
// The probe page divides the screen into a grid of cells. Two rows of cells carry a barcode
// of the host's clock (Date.now(), low 32 bits, and an 8-bit check), each row led by a black
// and a white reference cell; one patch flips between black and white on each press of the
// probe key, another follows which half of the screen the pointer is in. The viewer times
// each input from sending it to the first decoded frame that shows its effect, on its own
// clock, so hand-to-glass needs no clock sync. Glass-to-glass compares the barcode with the
// viewer's clock and is exact only when the viewer runs on the host itself.

export const GRID = { columns: 32, rows: 18 };
export const LAYOUT = {
  barcode: { column: 1, row: 1, bits: 40, perRow: 20 },
  keyPatch: { column: 25, row: 1 },
  movePatch: { column: 28, row: 1 },
};
export const PROBE_KEY = 'KeyL';
// Pointer targets for the move patch, as normalized desktop points: black, then white.
export const MOVE_TARGETS = [
  { x: 0.25, y: 0.75 },
  { x: 0.75, y: 0.75 },
];
const CELL = 4; // Canvas pixels per grid cell when reading a frame.
const WRAP = 2 ** 32;

// 40 bits, most significant first: the low 32 bits of `ms`, then their bytes XORed with 0xa5.
export function encodeTimestamp(ms) {
  const value = Math.floor(ms) % WRAP;
  const bytes = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const check = (bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3] ^ 0xa5) & 255;
  const bits = [];
  for (let bit = 31; bit >= 0; bit--) bits.push(Math.floor(value / 2 ** bit) % 2);
  for (let bit = 7; bit >= 0; bit--) bits.push((check >> bit) & 1);
  return bits;
}

// The low 32 bits of the host's clock, or null when a bit is unreadable or the check fails.
export function decodeTimestamp(bits) {
  if (bits.length !== LAYOUT.barcode.bits || bits.some((bit) => bit !== 0 && bit !== 1))
    return null;
  let value = 0;
  for (let index = 0; index < 32; index++) value = value * 2 + bits[index];
  let check = 0;
  for (let index = 32; index < 40; index++) check = check * 2 + bits[index];
  const bytes = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  return ((bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3] ^ 0xa5) & 255) === check ? value : null;
}

// The full host time nearest `now` whose low 32 bits are `low`.
export function unwrapTimestamp(low, now) {
  return low + Math.round((now - low) / WRAP) * WRAP;
}

// 0 for black, 1 for white, null when the cell is between the two references.
export function classify(luma, black, white) {
  if (!(white - black >= 48)) return null;
  const level = (luma - black) / (white - black);
  return level < 0.3 ? 0 : level > 0.7 ? 1 : null;
}

// Reads one frame from `lumaAt(column, row)`: the host time, if the barcode is readable, and
// the state of both patches.
export function readFrame(lumaAt) {
  const { column, row, perRow, bits: count } = LAYOUT.barcode;
  const blacks = [lumaAt(column, row), lumaAt(column + 1, row + 1)];
  const whites = [lumaAt(column + 1, row), lumaAt(column, row + 1)];
  const black = (blacks[0] + blacks[1]) / 2,
    white = (whites[0] + whites[1]) / 2;
  const references =
    classify(blacks[0], black, white) === 0 &&
    classify(blacks[1], black, white) === 0 &&
    classify(whites[0], black, white) === 1 &&
    classify(whites[1], black, white) === 1;
  if (!references) return { hostTime: null, key: null, move: null };
  const bits = [];
  for (let index = 0; index < count; index++)
    bits.push(
      classify(
        lumaAt(column + 2 + (index % perRow), row + Math.floor(index / perRow)),
        black,
        white,
      ),
    );
  const patch = ({ column: c, row: r }) => {
    const luma = (lumaAt(c, r) + lumaAt(c + 1, r) + lumaAt(c, r + 1) + lumaAt(c + 1, r + 1)) / 4;
    return classify(luma, black, white);
  };
  return {
    hostTime: decodeTimestamp(bits),
    key: patch(LAYOUT.keyPatch),
    move: patch(LAYOUT.movePatch),
  };
}

// The rectangle of the video frame that shows the desktop: the host scales the screen to fit
// the profile's size, centred, unless the stream is stretched (no `source`).
export function desktopRect(videoWidth, videoHeight, source) {
  if (!(source?.width > 0 && source?.height > 0))
    return { x: 0, y: 0, width: videoWidth, height: videoHeight };
  const fit = Math.min(videoWidth / source.width, videoHeight / source.height);
  const width = source.width * fit,
    height = source.height * fit;
  return { x: (videoWidth - width) / 2, y: (videoHeight - height) / 2, width, height };
}

export function summarize(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  const round = (value) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
  };
}

// The inbound video report and its candidate pair from an RTCStatsReport.
export function videoReceiverStats(stats) {
  let inbound = null;
  for (const report of stats.values())
    if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video')
      inbound = report;
  if (!inbound) return null;
  const transport = stats.get(inbound.transportId);
  const pair =
    stats.get(transport?.selectedCandidatePairId) ||
    [...stats.values()].find(
      (report) =>
        report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded',
    ) ||
    {};
  return { inbound, pair };
}

const randomPause = () => new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250));

// The panel and the measurement loop. `send` is the viewer's input sender, `canControl` says
// whether this device holds control, `source` gives the shared display's size (null for a
// stretched stream), and `getStats` the peer connection's stats, or null.
export function createLatencyProbe({
  video,
  send,
  canControl,
  source,
  getStats,
  summarizeReceiver,
}) {
  const panel = document.createElement('section');
  panel.className = 'latency-probe';
  panel.setAttribute('aria-label', 'Latency probe');
  const heading = document.createElement('strong');
  heading.textContent = 'Latency probe';
  const start = document.createElement('button');
  start.className = 'secondary';
  start.textContent = 'Measure';
  const copy = document.createElement('button');
  copy.className = 'secondary';
  copy.textContent = 'Copy results';
  copy.disabled = true;
  const output = document.createElement('pre');
  output.textContent =
    'Show tools/debug/latency-probe.html full screen on the shared display, enable keyboard & mouse, then Measure. Keep your hands off the mouse while it runs.';
  panel.append(heading, start, copy, output);
  document.body.append(panel);

  const canvas = document.createElement('canvas');
  canvas.width = GRID.columns * CELL;
  canvas.height = GRID.rows * CELL;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let disposed = false,
    running = false,
    latest = { hostTime: null, key: null, move: null },
    lastHostTime = null,
    pending = null,
    glass = [],
    results = null;

  function read() {
    const width = video.videoWidth,
      height = video.videoHeight;
    if (!width || !height) return null;
    const rect = desktopRect(width, height, source());
    context.drawImage(
      video,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    // The middle two by two pixels of each cell, away from its blurred edges.
    return readFrame((column, row) => {
      let sum = 0;
      for (let dy = 1; dy <= 2; dy++)
        for (let dx = 1; dx <= 2; dx++) {
          const offset = ((row * CELL + dy) * canvas.width + column * CELL + dx) * 4;
          sum += 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
        }
      return sum / 4;
    });
  }

  function onFrame(now, metadata) {
    if (disposed) return;
    video.requestVideoFrameCallback(onFrame);
    const frame = read();
    if (!frame) return;
    latest = frame;
    const shown = metadata.expectedDisplayTime ?? now;
    if (running && frame.hostTime !== null && frame.hostTime !== lastHostTime) {
      const host = unwrapTimestamp(frame.hostTime, Date.now());
      glass.push(performance.timeOrigin + shown - host);
    }
    if (frame.hostTime !== null) lastHostTime = frame.hostTime;
    if (pending && frame[pending.kind] === pending.expected) {
      const { resolve, sentAt } = pending;
      pending = null;
      resolve({
        handToGlass: shown - sentAt,
        handToReceive: Number.isFinite(metadata.receiveTime) ? metadata.receiveTime - sentAt : null,
      });
    }
  }

  function trial(kind) {
    const current = latest[kind];
    if (current === null) return Promise.resolve(null);
    const expected = current ^ 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending = null;
        resolve({ timeout: true });
      }, 2000);
      pending = {
        kind,
        expected,
        sentAt: performance.now(),
        resolve: (sample) => {
          clearTimeout(timer);
          resolve(sample);
        },
      };
      if (kind === 'move') send({ type: 'move', ...MOVE_TARGETS[expected] });
      else {
        send({ type: 'key', code: PROBE_KEY, down: true });
        send({ type: 'key', code: PROBE_KEY, down: false });
      }
    });
  }

  async function receiverSnapshot() {
    const stats = getStats ? await getStats().catch(() => null) : null;
    return stats ? videoReceiverStats(stats) : null;
  }

  async function measure(trials = 40) {
    if (latest.hostTime === null) {
      output.textContent =
        'The probe page is not visible: show tools/debug/latency-probe.html full screen on the shared display.';
      return;
    }
    if (!canControl()) {
      output.textContent = 'Enable keyboard & mouse first.';
      return;
    }
    running = true;
    start.textContent = 'Stop';
    copy.disabled = true;
    glass = [];
    const samples = { move: [], key: [] };
    const timeouts = { move: 0, key: 0 };
    const before = await receiverSnapshot();
    for (let index = 0; running && index < trials * 2; index++) {
      if (!canControl()) break;
      const kind = index % 2 ? 'key' : 'move';
      const sample = await trial(kind);
      if (sample?.timeout) timeouts[kind]++;
      else if (sample) samples[kind].push(sample);
      // The first key trial that times out means the key is going somewhere else: stop.
      if (kind === 'key' && timeouts.key && !samples.key.length) break;
      output.textContent = `Measuring… ${index + 1} of ${trials * 2}`;
      await randomPause();
    }
    running = false;
    start.textContent = 'Measure';
    const after = await receiverSnapshot();
    const receiver =
      after && summarizeReceiver
        ? summarizeReceiver(after.inbound, before?.inbound, after.pair)
        : null;
    const pick = (kind, name) => samples[kind].map((sample) => sample[name]);
    results = {
      measuredAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      video: { width: video.videoWidth, height: video.videoHeight },
      handToGlassMs: {
        move: summarize(pick('move', 'handToGlass')),
        key: summarize(pick('key', 'handToGlass')),
      },
      handToReceiveMs: {
        move: summarize(pick('move', 'handToReceive')),
        key: summarize(pick('key', 'handToReceive')),
      },
      timeouts,
      glassToGlassMs: summarize(glass),
      glassToGlassNote:
        'Exact only when the viewer runs on the host; otherwise includes the clock offset.',
      receiver: receiver && {
        decodeFps: receiver.decodeFps,
        jitterBufferMs: receiver.jitterBufferMs,
        decodeMs: receiver.decodeMs,
        rttMs: receiver.rttMs,
        lostInterval: receiver.lostInterval,
        framesDropped: receiver.framesDropped,
      },
    };
    output.textContent = JSON.stringify(results, null, 2);
    copy.disabled = false;
    console.info('Latency probe', results);
  }

  start.onclick = () => {
    if (running) running = false;
    else measure();
  };
  copy.onclick = () => navigator.clipboard?.writeText(JSON.stringify(results, null, 2));
  if (typeof video.requestVideoFrameCallback === 'function')
    video.requestVideoFrameCallback(onFrame);
  else {
    output.textContent = 'This browser has no requestVideoFrameCallback, so it cannot measure.';
    start.disabled = true;
  }
  return {
    dispose() {
      disposed = true;
      running = false;
      panel.remove();
    },
  };
}
