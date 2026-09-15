const modes = Object.freeze({
  on: Object.freeze({
    mode: 'on',
    enabled: true,
    codec: 'Opus',
    compression: 'lossy',
    sampleRate: 48000,
    channels: 2,
    bitrateKbps: 96,
  }),
  off: Object.freeze({
    mode: 'off',
    enabled: false,
    codec: null,
    sampleRate: null,
    channels: null,
    bitrateKbps: 0,
  }),
});

export function audioModes() {
  return Object.keys(modes);
}
export function getAudioMode(mode) {
  return modes[mode] ? { ...modes[mode] } : null;
}
export function chooseAudioMode(requested = 'on') {
  return getAudioMode(requested) || getAudioMode('on');
}
