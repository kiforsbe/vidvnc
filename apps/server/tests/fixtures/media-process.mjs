// Real child-process protocol fixture: no capture, network or OS input.
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = (message) => console.log(JSON.stringify(message));
const encoders = {
  nvenc: { label: 'NVIDIA NVENC', element: 'nvd3d11h264enc' },
  qsv: { label: 'Intel Quick Sync', element: 'qsvh264enc' },
  amf: { label: 'AMD AMF', element: 'amfh264enc' },
  mediafoundation: { label: 'Media Foundation', element: 'mfh264enc' },
};
let started = null;
const peers = new Map();
input.on('line', (line) => {
  const message = JSON.parse(line);
  const { peerId } = message;
  if (message.type === 'start') {
    if (started || message.display?.id === 'fail') return process.exit(2);
    started = message;
    // Echoes the received codec and resolved encoder so tests can observe what NativeMedia
    // forwarded. Real live workers receive the backend resolved from the startup probe.
    const backend = message.encoderBackend === 'auto' ? 'nvenc' : message.encoderBackend;
    const encoder = encoders[backend] ?? encoders.nvenc;
    send({
      type: 'ready',
      codec: message.codec,
      encoderBackend: backend,
      encoderLabel: encoder.label,
      encoder: encoder.element,
      encoderReason: message.encoderBackend === 'auto' ? 'capture-adapter' : 'forced',
    });
  }
  if (message.type === 'add-peer') {
    if (message.sdp === 'crash') return process.exit(2);
    if (!started || peers.has(peerId) || message.sdp === 'fail' || message.sdp.startsWith('fail:'))
      return send({ type: 'peer-failed', peerId, reason: 'Invalid SDP' });
    peers.set(peerId, message.sdp);
    if (message.sdp.includes('hang')) return;
    send({
      type: 'metrics',
      captureFps: started.streamPlan?.fps ?? 0,
      peers: { [peerId]: { videoRtpPackets: peers.size } },
    });
    // An offer for the media relay gets a webrtcbin-shaped answer with one loopback
    // candidate; the relay tests check the worker never sees the client's candidates.
    if (message.sdp.includes('a=ice-ufrag:')) {
      if (message.sdp.includes('a=candidate:'))
        return send({ type: 'peer-failed', peerId, reason: 'Offer still had candidates' });
      const port = 50000 + peers.size;
      const bad = message.sdp.includes('bad-answer');
      return send({
        type: 'answer',
        peerId,
        sdp: [
          'v=0',
          'o=- 1 0 IN IP4 0.0.0.0',
          's=-',
          't=0 0',
          'a=group:BUNDLE video0',
          'm=video 9 UDP/TLS/RTP/SAVPF 96',
          'c=IN IP4 0.0.0.0',
          'a=ice-ufrag:WkrU',
          'a=ice-pwd:workerpasswordworkerpass',
          'a=fingerprint:sha-256 AA:BB',
          'a=setup:active',
          'a=mid:video0',
          'a=sendonly',
          'a=rtcp-mux',
          'a=rtpmap:96 H264/90000',
          `a=candidate:1 1 UDP 2015363327 ${bad ? '192.168.1.5' : '127.0.0.1'} ${port} typ host`,
          '',
        ].join('\r\n'),
      });
    }
    send({ type: 'answer', peerId, sdp: `answer:${message.sdp}` });
  }
  // The worker's answer attestation: a port the fixture's relay answer used, unless the
  // offer asked for a foreign one.
  if (message.type === 'check-port') {
    const offer = peers.get(peerId) ?? '';
    const owned = offer.includes('a=ice-ufrag:') && !offer.includes('foreign-port');
    return send({ type: 'port-owned', peerId, port: message.port, owned });
  }
  if (message.type === 'remove-peer') {
    if (peers.get(peerId)?.includes('no-remove')) return;
    peers.delete(peerId);
    send({ type: 'peer-closed', peerId });
  }
  // Test-only injection of a transport failure for one peer.
  if (message.type === 'fail-peer') {
    peers.delete(peerId);
    send({ type: 'peer-failed', peerId, reason: 'WebRTC connection failed.' });
  }
  if (message.type === 'stop') setTimeout(() => process.exit(0), 100);
  if (message.type === 'control-permission') {
    if (message.allowed === false && peers.get(peerId)?.includes('no-revoke')) return;
    send({
      type: 'control-result',
      requestId: message.requestId,
      allowed: message.allowed && started?.video === true && peers.has(peerId),
    });
  }
});
