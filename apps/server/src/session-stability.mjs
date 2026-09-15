// Receiver counters are cumulative. Never turn the first sample or a reset into
// an event, or repeat an event when the host polls the same sample twice.
export function sessionStability(metrics, since) {
  const at = Number.isFinite(metrics.at) ? metrics.at : Date.now();
  const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const points = [];
  const generated = [];
  let serverAt;
  let previous;
  for (const sample of (metrics.history ?? []).slice(-600)) {
    if (
      sample.source === 'server' &&
      Number.isFinite(sample.at) &&
      sample.at >= since &&
      sample.at >= at - 60000 &&
      sample.at <= at &&
      (serverAt === undefined || sample.at > serverAt)
    ) {
      generated.push({
        at: sample.at,
        captureFps: valid(sample.captureFps) ? sample.captureFps : null,
        encodeFps: valid(sample.encodeFps) ? sample.encodeFps : null,
      });
      serverAt = sample.at;
    }
    if (
      sample.source !== 'client' ||
      !Number.isFinite(sample.at) ||
      sample.at < since ||
      sample.at > at ||
      (previous && sample.at <= previous.at)
    )
      continue;
    const delta = (key) =>
      previous && valid(previous[key]) && valid(sample[key]) && sample[key] >= previous[key]
        ? sample[key] - previous[key]
        : null;
    const pli = delta('pliCount'),
      fir = delta('firCount');
    const reset =
      previous &&
      ['pliCount', 'firCount'].some(
        (key) => valid(previous[key]) && valid(sample[key]) && sample[key] < previous[key],
      );
    if (sample.at >= at - 60000)
      points.push({
        at: sample.at,
        intervalMs: previous ? sample.at - previous.at : null,
        fps: valid(sample.decodeFps) ? sample.decodeFps : null,
        drops: delta('framesDropped'),
        freezes: delta('freezeCount'),
        recovery: reset || (pli === null && fir === null) ? null : (pli ?? 0) + (fir ?? 0),
        lost: delta('packetsLost'),
        rttMs: valid(sample.rttMs) ? sample.rttMs : null,
        jitterMs: valid(sample.jitterMs) ? sample.jitterMs : null,
      });
    previous = sample;
  }
  return {
    at,
    stale: !previous || at - previous.at >= 5000,
    serverStale: serverAt === undefined || at - serverAt >= 5000,
    generated: generated.slice(-76),
    points: points.slice(-76),
  };
}
