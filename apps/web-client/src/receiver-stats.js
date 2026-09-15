const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export function summarizeReceiver(current, previous, pair = {}) {
  const same = previous && current.id === previous.id && current.timestamp > previous.timestamp;
  const elapsed = same ? (current.timestamp - previous.timestamp) / 1000 : null;
  const delta = (name) =>
    same &&
    number(current[name]) !== null &&
    number(previous[name]) !== null &&
    current[name] >= previous[name]
      ? current[name] - previous[name]
      : null;
  const rate = (name, multiplier = 1) => {
    const value = delta(name);
    return value === null ? null : (value * multiplier) / elapsed;
  };
  const averageMs = (total, count) => {
    const value = delta(total),
      samples = delta(count);
    return value !== null && samples > 0 ? Math.round((value / samples) * 1e6) / 1000 : null;
  };
  return {
    receiveMbps: rate('bytesReceived', 8 / 1e6),
    decodeFps: rate('framesDecoded'),
    framesReceived: number(current.framesReceived),
    framesDecoded: number(current.framesDecoded),
    framesDropped: number(current.framesDropped),
    packetsLost: number(current.packetsLost),
    packetsReceived: number(current.packetsReceived),
    lostInterval: delta('packetsLost'),
    nackCount: number(current.nackCount),
    pliCount: number(current.pliCount),
    firCount: number(current.firCount),
    keyFramesDecoded: number(current.keyFramesDecoded),
    completeFrameFps: rate('framesReceived'),
    jitterMs: number(current.jitter) === null ? null : current.jitter * 1000,
    decodeMs: averageMs('totalDecodeTime', 'framesDecoded'),
    jitterBufferMs: averageMs('jitterBufferDelay', 'jitterBufferEmittedCount'),
    freezeCount: number(current.freezeCount),
    freezeSeconds: number(current.totalFreezesDuration),
    rttMs: number(pair.currentRoundTripTime) === null ? null : pair.currentRoundTripTime * 1000,
    frameWidth: number(current.frameWidth),
    frameHeight: number(current.frameHeight),
  };
}
export function summarizeAudioReceiver(current, previous) {
  const same = previous && current.id === previous.id && current.timestamp > previous.timestamp;
  const delta = (name) =>
    same &&
    number(current[name]) !== null &&
    number(previous[name]) !== null &&
    current[name] >= previous[name]
      ? current[name] - previous[name]
      : null;
  return {
    audioPacketsLost: number(current.packetsLost),
    audioPacketsReceived: number(current.packetsReceived),
    audioLostInterval: delta('packetsLost'),
    audioJitterMs: number(current.jitter) === null ? null : current.jitter * 1000,
    audioConcealedSamples: number(current.concealedSamples),
  };
}
