// Codec identifiers everywhere (protocol, policy, CLI arguments): 'h264', 'h265', 'av1'.
// Default host order: most efficient first, h264 always last as the universal fallback.
export const VIDEO_CODECS = Object.freeze(['av1', 'h265', 'h264']);
export const CODEC_LABELS = Object.freeze({ av1: 'AV1', h265: 'H.265', h264: 'H.264' });

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

// Minimum input size belongs to the encoder element, not to the codec: NVENC needs 192x128 for
// AV1 while Quick Sync needs 16x16. Eligibility is therefore asked of the backends the probe
// reported, which carry their own minimums, rather than of a table keyed by codec.
function canEncode(backend, codec, profile) {
  if (!backend.codecs.includes(codec)) return false;
  const minimum = backend.minimums?.[codec];
  if (!minimum) return true;
  return profile.width >= minimum.width && profile.height >= minimum.height;
}

// Returns the first id in policyCodecs that the browser offered and that some usable backend
// can encode at the resolved profile's size. `encoderBackend` is the host's setting: `auto`, or
// a backend id. Naming a backend the machine does not have falls back to considering them all,
// mirroring the worker, which substitutes automatic selection rather than failing the session.
export function selectVideoCodec(sdp, policyCodecs, backends, profile, encoderBackend = 'auto') {
  const offered = offeredVideoCodecs(sdp);
  const forced =
    encoderBackend !== 'auto' && backends.some((backend) => backend.id === encoderBackend);
  const usable = forced ? backends.filter((backend) => backend.id === encoderBackend) : backends;
  for (const codec of policyCodecs) {
    if (!offered.has(codec)) continue;
    if (usable.some((backend) => canEncode(backend, codec, profile))) return codec;
  }
  throw Object.assign(new Error('Browser must offer a supported video codec.'), { status: 400 });
}
