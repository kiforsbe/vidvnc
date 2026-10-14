// Latency probe: measures hand-to-glass and glass-to-glass latency against the host probe
// page (tools/debug/latency-probe.html) shown full screen on the shared display. The viewer
// imports it only when the host starts a measurement from Diagnostics, and the server serves
// it only then. It sends input only while this device holds keyboard and mouse control,
// through the normal input path.
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

const MAX_SAMPLES = 1_000; // The server's limit on a timing's count.
const MAX_MS = 60_000;
const RECEIVER_FIELDS = [
  'decodeFps',
  'jitterBufferMs',
  'decodeMs',
  'rttMs',
  'lostInterval',
  'framesDropped',
];

// Keeps a uniform sample of at most MAX_SAMPLES values from a stream of them.
function reservoir() {
  const values = [];
  let seen = 0;
  return {
    values,
    add(value) {
      seen++;
      if (values.length < MAX_SAMPLES) values.push(value);
      else {
        const index = Math.floor(Math.random() * seen);
        if (index < MAX_SAMPLES) values[index] = value;
      }
    },
  };
}

// A timing in the server's schema: values outside its range are left out rather than failing
// the whole report.
const within = (values, minimum) =>
  summarize(
    values
      .filter((value) => Number.isFinite(value) && value >= minimum && value <= MAX_MS)
      .slice(0, MAX_SAMPLES),
  );

// The results body for POST /api/latency-result, exactly in the server's schema
// (apps/server/src/latency-results.mjs).
export function buildResults({ samples, timeouts, glass, overhead, receiver, video, browser }) {
  const pick = (kind, name) => samples[kind].map((sample) => sample[name]);
  const finite = (value) => (Number.isFinite(value) ? value : null);
  return {
    handToGlassMs: {
      move: within(pick('move', 'handToGlass'), 0),
      key: within(pick('key', 'handToGlass'), 0),
    },
    handToReceiveMs: {
      move: within(pick('move', 'handToReceive'), 0),
      key: within(pick('key', 'handToReceive'), 0),
    },
    // From another device it includes the offset between the two clocks, so it may be
    // negative.
    glassToGlassMs: within(glass, -MAX_MS),
    timeouts: { move: timeouts.move, key: timeouts.key },
    overhead: {
      callbackMs: within(overhead.callbackMs, 0),
      skippedFrames: overhead.skippedFrames,
    },
    receiver: Object.fromEntries(
      RECEIVER_FIELDS.map((field) => [field, finite(receiver?.[field])]),
    ),
    video: { width: video.width, height: video.height },
    browser: String(browser).slice(0, 200),
  };
}

// Reads frames on a GPU-backed canvas: the browser scales the frame on the GPU, and only the
// small grid-sized result is read back. (willReadFrequently would keep the canvas in system
// memory, copying the whole decoded frame there first.)
function canvasReader(source) {
  const canvas = document.createElement('canvas');
  canvas.width = GRID.columns * CELL;
  canvas.height = GRID.rows * CELL;
  const context = canvas.getContext('2d');
  return (video) => {
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
  };
}

const failed = (reason) => ({ state: 'failed', reason });

// One measurement: checks that it can run, then times `trials` pointer moves and as many key
// presses, alternating, each to the first frame that shows its effect. Frames are read only
// while it runs. `send` is the viewer's input sender, `canControl` says whether this device
// holds control, `source` gives the shared display's size (null for a stretched stream),
// `getStats` the peer connection's stats, or null, and `onRunning` is called once the checks
// pass. Resolves to {state: 'done', results} or {state: 'failed', reason}.
export async function runLatencyProbe({
  video,
  send,
  canControl,
  source,
  getStats,
  summarizeReceiver,
  signal = new AbortController().signal,
  trials = 40,
  onRunning = () => {},
  readFrameFrom = null,
  probeWaitMs = 2_000,
  trialTimeoutMs = 2_000,
  pauseMs = () => 150 + Math.random() * 250,
  browser = globalThis.navigator?.userAgent ?? '',
}) {
  if (typeof video.requestVideoFrameCallback !== 'function') return failed('unsupported');
  if (!canControl()) return failed('no-control');
  if (signal.aborted) return failed('cancelled');
  const read = readFrameFrom ?? canvasReader(source);

  let stopped = false,
    running = false,
    latest = { hostTime: null, key: null, move: null },
    lastHostTime = null,
    lastPresented = null,
    pending = null,
    waiters = [];
  const glass = reservoir();
  const callbackMs = reservoir();
  let skippedFrames = 0;

  function onFrame(now, metadata) {
    if (stopped) return;
    video.requestVideoFrameCallback(onFrame);
    const started = performance.now();
    const frame = read(video);
    callbackMs.add(performance.now() - started);
    if (Number.isFinite(metadata.presentedFrames)) {
      if (lastPresented !== null && metadata.presentedFrames - lastPresented > 1)
        skippedFrames += metadata.presentedFrames - lastPresented - 1;
      lastPresented = metadata.presentedFrames;
    }
    if (!frame) return;
    latest = frame;
    const shown = metadata.expectedDisplayTime ?? now;
    if (running && frame.hostTime !== null && frame.hostTime !== lastHostTime) {
      const host = unwrapTimestamp(frame.hostTime, Date.now());
      glass.add(performance.timeOrigin + shown - host);
    }
    if (frame.hostTime !== null) lastHostTime = frame.hostTime;
    for (const wake of waiters.splice(0)) wake();
    if (pending && frame[pending.kind] === pending.expected) {
      const { resolve, sentAt } = pending;
      pending = null;
      resolve({
        handToGlass: shown - sentAt,
        handToReceive: Number.isFinite(metadata.receiveTime) ? metadata.receiveTime - sentAt : null,
      });
    }
  }

  // Resolves after `ms`, or at once on abort, or (with `frames`) on the next frame read.
  function wait(ms, { frames = false } = {}) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      if (frames) waiters.push(done);
    });
  }

  async function trial(kind) {
    const current = latest[kind];
    if (current === null) return null;
    const expected = current ^ 1;
    let sample = { timeout: true };
    const shown = new Promise((resolve) => {
      pending = { kind, expected, sentAt: performance.now(), resolve };
    });
    if (kind === 'move') send({ type: 'move', ...MOVE_TARGETS[expected] });
    else {
      send({ type: 'key', code: PROBE_KEY, down: true });
      send({ type: 'key', code: PROBE_KEY, down: false });
    }
    await Promise.race([shown.then((value) => (sample = value)), wait(trialTimeoutMs)]);
    pending = null;
    return sample;
  }

  async function receiverSnapshot() {
    const stats = getStats ? await getStats().catch(() => null) : null;
    return stats ? videoReceiverStats(stats) : null;
  }

  video.requestVideoFrameCallback(onFrame);
  try {
    const deadline = performance.now() + probeWaitMs;
    while (latest.hostTime === null && !signal.aborted && performance.now() < deadline)
      await wait(deadline - performance.now(), { frames: true });
    if (signal.aborted) return failed('cancelled');
    if (latest.hostTime === null) return failed('no-probe-page');
    if (!canControl()) return failed('no-control');
    await onRunning();
    running = true;
    const before = await receiverSnapshot();
    const samples = { move: [], key: [] };
    const timeouts = { move: 0, key: 0 };
    for (let index = 0; index < trials * 2; index++) {
      if (signal.aborted) return failed('cancelled');
      if (!canControl()) return failed('control-lost');
      const kind = index % 2 ? 'key' : 'move';
      const sample = await trial(kind);
      if (signal.aborted) return failed('cancelled');
      if (sample?.timeout) timeouts[kind]++;
      else if (sample) samples[kind].push(sample);
      // The first key press that doesn't flip the patch means the key goes somewhere else.
      if (kind === 'key' && timeouts.key && !samples.key.length) return failed('no-probe-page');
      await wait(pauseMs());
    }
    if (signal.aborted) return failed('cancelled');
    running = false;
    const after = await receiverSnapshot();
    const receiver =
      after && summarizeReceiver
        ? summarizeReceiver(after.inbound, before?.inbound, after.pair)
        : null;
    return {
      state: 'done',
      results: buildResults({
        samples,
        timeouts,
        glass: glass.values,
        overhead: { callbackMs: callbackMs.values, skippedFrames },
        receiver,
        video: { width: video.videoWidth, height: video.videoHeight },
        browser,
      }),
    };
  } finally {
    stopped = true;
    pending = null;
    for (const wake of waiters.splice(0)) wake();
  }
}
