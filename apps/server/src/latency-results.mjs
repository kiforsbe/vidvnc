// The results a viewer reports for a latency measurement (latency-probes.mjs), checked field by
// field: they come from a viewer, so nothing but these bounded numbers and one short string
// is kept. See docs/superpowers/specs/2026-10-14-latency-probe-from-diagnostics-design.md.

// Why a viewer could not finish a measurement.
export const LATENCY_REASONS = Object.freeze([
  'no-control',
  'no-probe-page',
  'unsupported',
  'cancelled',
  'stream-changed',
  'control-lost',
]);

const MAX_MS = 60_000;
const MAX_COUNT = 1_000;
const MAX_VIDEO_SIDE = 16_384;
const MAX_BROWSER = 200;
const RECEIVER_FIELDS = [
  'decodeFps',
  'jitterBufferMs',
  'decodeMs',
  'rttMs',
  'lostInterval',
  'framesDropped',
];

function invalid() {
  return new Error('Invalid latency results');
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    throw invalid();
  return value;
}

function integer(value, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw invalid();
  return value;
}

function milliseconds(value, minimum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > MAX_MS)
    throw invalid();
  return value;
}

// {count: 0}, or {count, min, median, p95, max}.
function timing(value, minimum = 0) {
  if (value?.count === 0) {
    object(value, ['count']);
    return { count: 0 };
  }
  object(value, ['count', 'min', 'median', 'p95', 'max']);
  const result = { count: integer(value.count, MAX_COUNT) };
  for (const key of ['min', 'median', 'p95', 'max'])
    result[key] = milliseconds(value[key], minimum);
  return result;
}

function moveAndKey(value) {
  object(value, ['move', 'key']);
  return { move: timing(value.move), key: timing(value.key) };
}

// A copy of `value` holding exactly the results fields, or an error.
export function validateLatencyResults(value) {
  object(value, [
    'handToGlassMs',
    'handToReceiveMs',
    'glassToGlassMs',
    'timeouts',
    'overhead',
    'receiver',
    'video',
    'browser',
  ]);
  object(value.timeouts, ['move', 'key']);
  object(value.overhead, ['callbackMs', 'skippedFrames']);
  object(value.receiver, RECEIVER_FIELDS);
  object(value.video, ['width', 'height']);
  if (typeof value.browser !== 'string' || value.browser.length > MAX_BROWSER) throw invalid();
  const receiver = {};
  for (const key of RECEIVER_FIELDS) {
    const entry = value.receiver[key];
    if (entry !== null && (typeof entry !== 'number' || !Number.isFinite(entry))) throw invalid();
    receiver[key] = entry;
  }
  return {
    handToGlassMs: moveAndKey(value.handToGlassMs),
    handToReceiveMs: moveAndKey(value.handToReceiveMs),
    // From another device it includes the offset between the two clocks.
    glassToGlassMs: timing(value.glassToGlassMs, -MAX_MS),
    timeouts: {
      move: integer(value.timeouts.move, MAX_COUNT),
      key: integer(value.timeouts.key, MAX_COUNT),
    },
    overhead: {
      callbackMs: timing(value.overhead.callbackMs),
      skippedFrames: integer(value.overhead.skippedFrames, Number.MAX_SAFE_INTEGER),
    },
    receiver,
    video: {
      width: integer(value.video.width, MAX_VIDEO_SIDE),
      height: integer(value.video.height, MAX_VIDEO_SIDE),
    },
    browser: value.browser,
  };
}
