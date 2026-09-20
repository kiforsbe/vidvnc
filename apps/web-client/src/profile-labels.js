// Labels for a stream profile's bitrate. Under variable bitrate (VBR) `bitrateKbps` is the
// sustained cap rather than a constant rate, so the label says "up to". CBR profiles and
// profiles that carry no `bitrateMode` (older servers) keep the plain text.
const isVbr = (profile) => profile?.bitrateMode === 'vbr';

export function bitrateText(profile) {
  const text = `${profile.bitrateKbps / 1000} Mbit/s`;
  return isVbr(profile) ? `up to ${text}` : text;
}

export function targetBitrateText(profile) {
  const kbps = Number.isFinite(profile?.bitrateKbps) ? profile.bitrateKbps.toFixed(0) : '—';
  const text = `${kbps} kbit/s`;
  return isVbr(profile) ? `VBR up to ${text}` : text;
}
