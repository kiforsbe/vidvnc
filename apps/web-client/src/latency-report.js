// The Diagnostics page's view of a latency measurement (latency-probes.mjs on the server):
// its state as a sentence, and its results as table rows. Everything here becomes text.

const REASONS = {
  'no-control': "The viewer doesn't have keyboard and mouse control.",
  'no-probe-page': "The probe page isn't visible on the shared display.",
  unsupported: "The viewer's browser can't measure.",
  cancelled: 'Cancelled on the viewer.',
  'stream-changed': "The viewer isn't showing this stream.",
  'control-lost': 'The viewer lost control during the run.',
  expired: "The viewer didn't respond.",
  ended: 'The stream ended.',
  'invalid-report': 'The viewer sent invalid results.',
};

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const withUnit = (value, unit, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : '—';

export function describeState(measurement) {
  if (!measurement) return 'No measurement yet.';
  if (measurement.state === 'requested') return 'Waiting for the viewer…';
  if (measurement.state === 'running') return 'Measuring…';
  if (measurement.state === 'done') return 'Done';
  return REASONS[measurement.reason] ?? 'Failed.';
}

function timingRow(label, timing) {
  if (!timing?.count) return [label, '—', '—', '—', '0'];
  return [
    label,
    number(timing.median),
    number(timing.p95),
    `${number(timing.min)}–${number(timing.max)}`,
    String(timing.count),
  ];
}

// [label, median, p95, range, count], in milliseconds.
export function resultRows(results) {
  return [
    timingRow('Moves · hand to glass', results.handToGlassMs.move),
    timingRow('Key presses · hand to glass', results.handToGlassMs.key),
    timingRow('Moves · hand to last packet', results.handToReceiveMs.move),
    timingRow('Key presses · hand to last packet', results.handToReceiveMs.key),
    timingRow(
      'Glass to glass (exact only when the viewer runs on this PC)',
      results.glassToGlassMs,
    ),
    timingRow('Time per frame read', results.overhead.callbackMs),
  ];
}

// [label, value] for the figures that are not timings.
export function detailRows(results) {
  const { receiver } = results;
  return [
    [
      'Trials without a change',
      `${results.timeouts.move} moves, ${results.timeouts.key} key presses`,
    ],
    ['Frames the probe missed', String(results.overhead.skippedFrames)],
    ['Decode rate', withUnit(receiver.decodeFps, 'fps')],
    ['Jitter buffer', withUnit(receiver.jitterBufferMs, 'ms')],
    ['Decode time', withUnit(receiver.decodeMs, 'ms')],
    ['Round trip', withUnit(receiver.rttMs, 'ms')],
    ['Packets lost', number(receiver.lostInterval, 0)],
    ['Frames dropped', number(receiver.framesDropped, 0)],
    ['Video', `${results.video.width} × ${results.video.height}`],
    ['Browser', results.browser],
  ];
}

// Identifies a measurement snapshot's state, so a notice from the last click (a busy server,
// for example) can be shown only until that state changes.
export function latencySignature(probe) {
  return `${probe?.active?.id ?? ''}:${probe?.active?.state ?? ''}:${probe?.history?.[0]?.id ?? ''}`;
}

// The state line: the notice `{text, seen}` while the snapshot is still the one it was given
// against, otherwise the measurement's state.
export function stateLine(probe, notice) {
  if (notice && notice.seen === latencySignature(probe)) return notice.text;
  return describeState(probe?.active ?? probe?.history?.[0] ?? null);
}
