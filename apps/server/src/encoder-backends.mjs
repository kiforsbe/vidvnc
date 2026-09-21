// Hardware encoder families the native worker can encode with. These ids appear in the stream
// policy, the CLI and the host app; they never reach a client, the SDP, or the wire protocol,
// because which GPU encodes a frame is the host's business and not the viewer's.
//
// The order matches the worker's own tie-break for automatic selection. It only decides which
// backend wins when none of them sits on the adapter the frames were captured on.
export const ENCODER_BACKENDS = Object.freeze(['nvenc', 'qsv', 'amf', 'mediafoundation']);

// `auto` is the default and means the worker picks per machine, preferring the GPU that
// captured the frame. A forced backend that turns out to be absent falls back to automatic
// rather than failing the session: a policy file follows its machine, and the hardware it
// names may simply not be there.
export const DEFAULT_ENCODER_BACKEND = 'auto';
export const ENCODER_BACKEND_CHOICES = Object.freeze([
  DEFAULT_ENCODER_BACKEND,
  ...ENCODER_BACKENDS,
]);

export const BACKEND_LABELS = Object.freeze({
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  amf: 'AMD AMF',
  mediafoundation: 'Media Foundation',
});
