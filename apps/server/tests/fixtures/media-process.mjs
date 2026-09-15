// Real child-process protocol fixture: no capture, network or OS input.
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'offer') {
    if (message.sdp === 'fail') return process.exit(2);
    console.log(JSON.stringify({ type: 'metrics', captureFps: message.streamPlan.fps }));
    console.log(JSON.stringify({ type: 'answer', sdp: `answer:${message.sdp}` }));
  }
  if (message.type === 'stop') setTimeout(() => process.exit(0), 100);
  if (message.type === 'control-permission')
    console.log(
      JSON.stringify({
        type: 'control-result',
        requestId: message.requestId,
        allowed: message.allowed,
      }),
    );
});
