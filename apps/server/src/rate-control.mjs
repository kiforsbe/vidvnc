// Server profile rate control, in policy files and resolved plans: bitrateMode 'cbr' | 'vbr' and
// quality 'efficient' | 'balanced' | 'high'. Under VBR, bitrateKbps is the sustained cap.
// A profile without either field loads as CBR / balanced, which is the encoder's behaviour today.
export const BITRATE_MODES = Object.freeze(['cbr', 'vbr']);
export const QUALITY_LEVELS = Object.freeze(['efficient', 'balanced', 'high']);
export const DEFAULT_BITRATE_MODE = 'cbr';
export const DEFAULT_QUALITY = 'balanced';
