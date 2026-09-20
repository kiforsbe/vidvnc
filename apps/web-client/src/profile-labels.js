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

// Tooltip for a profile choice or the current profile: its description, then one details line
// (size, frame rate, bitrate, rate mode). Missing fields are skipped; '' when nothing is known.
export function profileTooltip(profile) {
  const details = [];
  if (profile?.width && profile?.height) details.push(`${profile.width} × ${profile.height}`);
  if (profile?.fps) details.push(`${profile.fps} fps`);
  if (Number.isFinite(profile?.bitrateKbps)) details.push(bitrateText(profile));
  if (profile?.bitrateMode === 'vbr') {
    const quality = profile.quality;
    details.push(
      quality ? `Variable (${quality[0].toUpperCase()}${quality.slice(1)})` : 'Variable',
    );
  } else if (profile?.bitrateMode === 'cbr') details.push('Constant');
  return [profile?.description, details.join(' · ')].filter(Boolean).join('\n');
}
