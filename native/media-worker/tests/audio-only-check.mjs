// Explicit Windows SDK-backed WebRTC check. System loopback audio only; no desktop video or input.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeMedia } from '../../../apps/server/src/native-media.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

// Test against current packages and a worker built from the current sources.
ensureJsDependencies();
ensureNativeWorker();
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const media = new NativeMedia({ hostControl: true });
try {
  const page = await browser.newPage();
  const offer = await page.evaluate(async () => {
    window.pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete')
      await new Promise((resolve) => {
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        });
      });
    return pc.localDescription.sdp;
  });
  const sdp = await media.offer(
    'audio-test',
    offer,
    { name: 'mobile', width: 1280, height: 720, fps: 15, bitrateKbps: 2000 },
    { mode: 'on' },
    null,
    { video: false },
  );
  assert.match(sdp, /m=audio /);
  assert.doesNotMatch(sdp, /m=video /);
  await page.evaluate((sdp) => pc.setRemoteDescription({ type: 'answer', sdp }), sdp);
  await page.waitForFunction(() => pc.connectionState === 'connected');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const metrics = media.active.diagnostics.snapshot();
  assert.equal(metrics.server.captureFrames, 0);
  assert.equal(metrics.server.encodedFrames, 0);
  assert.equal(
    await media.setPermission('audio-test', 'audio-test', true),
    false,
    'audio-only worker cannot own input',
  );
  assert.equal(
    media.active.stderr,
    '',
    'audio-only pipeline must not install video probes or emit critical warnings',
  );
  console.log(
    'PASS: native audio-only WebRTC connects without video capture/encoding or input permission',
  );
} finally {
  await media.shutdown();
  await browser.close();
}
