// Real child-process protocol fixture: no capture, network or OS input.
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = (message) => console.log(JSON.stringify(message));
let started = null;
const peers = new Map();
input.on('line', (line) => {
  const message = JSON.parse(line);
  const { peerId } = message;
  if (message.type === 'start') {
    if (started || message.display?.id === 'fail') return process.exit(2);
    started = message;
    // Echoes the received codec so tests can observe what NativeMedia forwarded.
    send({ type: 'ready', codec: message.codec });
  }
  if (message.type === 'add-peer') {
    if (message.sdp === 'crash') return process.exit(2);
    if (!started || peers.has(peerId) || message.sdp === 'fail')
      return send({ type: 'peer-failed', peerId, reason: 'Invalid SDP' });
    peers.set(peerId, message.sdp);
    if (message.sdp.includes('hang')) return;
    send({
      type: 'metrics',
      captureFps: started.streamPlan?.fps ?? 0,
      peers: { [peerId]: { videoRtpPackets: peers.size } },
    });
    send({ type: 'answer', peerId, sdp: `answer:${message.sdp}` });
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
