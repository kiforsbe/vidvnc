// A source worker's metrics carry per-peer transport rows; each viewer sees the shared source
// fields plus only its own transport.
export function peerSample(message, peerId) {
  const { peers, ...source } = message;
  return { ...source, ...peers?.[peerId] };
}
