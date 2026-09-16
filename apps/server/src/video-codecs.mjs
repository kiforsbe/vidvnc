// Codec identifiers everywhere (protocol, policy, CLI arguments): 'h264', 'h265', 'av1'.
// Default host order: most efficient first, h264 always last as the universal fallback.
export const VIDEO_CODECS = Object.freeze(['av1', 'h265', 'h264']);
export const CODEC_LABELS = Object.freeze({ av1: 'AV1', h265: 'H.265', h264: 'H.264' });

// The new encoders have larger minimum input sizes than the policy's 64x64 floor, so a tiny
// custom profile must fall back to a smaller codec instead of failing in the worker.
const MINIMUM_DIMENSIONS = {
  av1: { width: 192, height: 128 },
  h265: { width: 144, height: 48 },
};

// Codec ids whose encoding name appears in an `a=rtpmap:<pt> <NAME>/90000` line inside an
// `m=video` section. Names are matched case-insensitively.
export function offeredVideoCodecs(sdp) {
  const found = new Set();
  if (typeof sdp !== 'string') return found;
  let inVideoSection = false;
  for (const line of sdp.split(/\r\n|\r|\n/)) {
    if (/^m=/.test(line)) {
      inVideoSection = /^m=video\b/i.test(line);
      continue;
    }
    if (!inVideoSection) continue;
    const match = /^a=rtpmap:\d+\s+([A-Za-z0-9-]+)\/90000/i.exec(line);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (VIDEO_CODECS.includes(name)) found.add(name);
  }
  return found;
}

// Returns the first id in policyCodecs that is in hostCodecs, is offered by the browser, and
// fits the encoder's minimum input size for the resolved profile.
export function selectVideoCodec(sdp, policyCodecs, hostCodecs, profile) {
  const offered = offeredVideoCodecs(sdp);
  for (const codec of policyCodecs) {
    if (!hostCodecs.includes(codec) || !offered.has(codec)) continue;
    const minimum = MINIMUM_DIMENSIONS[codec];
    if (minimum && (profile.width < minimum.width || profile.height < minimum.height)) continue;
    return codec;
  }
  throw Object.assign(new Error('Browser must offer a supported video codec.'), { status: 400 });
}
