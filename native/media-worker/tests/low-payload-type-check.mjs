// Explicit hardware acceptance: a browser that numbers its video codec below the classic
// dynamic range (96-127) still receives video. Safari numbers H.265 as 35, and libwebrtc falls
// back to 35-63 once 96-127 are taken; GStreamer payloaders only produce 96-127 on their own.
// Chromium is made to offer H.264 as payload 35 (RTX 36) by renumbering its offer before it is
// applied. Captures the primary display but never sends keyboard, pointer or touch events.
//
// Usage: node low-payload-type-check.mjs <playwright>
//   <playwright>  path to a `playwright` package install matching the local
//                 chromium_headless_shell revision.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeMedia, probe } from '../../../apps/server/src/native-media.mjs';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const display =
  probe().displays.find((d) => d.persistent && d.primary) ??
  probe().displays.find((d) => d.persistent);
assert.ok(display, 'This acceptance check requires a connected display');
const { id, x, y, width, height, rotation } = display;
const media = new NativeMedia({ maxWorkers: 1, hostControl: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let stderr = '';
try {
  await media.start('low-pt', {
    video: true,
    codec: 'h264',
    profile: { name: 'balanced', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 },
    display: { id, x, y, width, height, rotation },
  });
  media.workers.get('low-pt').child.stderr.on('data', (data) => (stderr += data));
  const offer = await page.evaluate(async () => {
    window.pc = new RTCPeerConnection({ iceServers: [] });
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
    const h264 = codecs.find(
      (c) =>
        c.mimeType === 'video/H264' &&
        /packetization-mode=1/.test(c.sdpFmtpLine) &&
        /profile-level-id=42e01f/.test(c.sdpFmtpLine),
    );
    transceiver.setCodecPreferences([h264, codecs.find((c) => c.mimeType === 'video/rtx')]);
    pc.ontrack = (event) => {
      const video = document.createElement('video');
      Object.assign(video, { muted: true, autoplay: true, playsInline: true });
      video.srcObject = new MediaStream([event.track]);
      document.body.append(video);
    };
    const created = await pc.createOffer();
    const [, primary, repair] = created.sdp.match(/^m=video \S+ \S+ (\d+) (\d+)\r?$/m);
    const renumbered = created.sdp
      .replace(/^(m=video \S+ \S+) \d+ \d+/m, '$1 35 36')
      .replace(new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${primary} `, 'gm'), 'a=$1:35 ')
      .replace(new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${repair} `, 'gm'), 'a=$1:36 ')
      .replace(new RegExp(`^a=fmtp:36 apt=${primary}\\b`, 'm'), 'a=fmtp:36 apt=35');
    await pc.setLocalDescription({ type: 'offer', sdp: renumbered });
    if (pc.iceGatheringState !== 'complete')
      await new Promise((resolve) =>
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        }),
      );
    return pc.localDescription.sdp;
  });
  assert.match(offer, /^a=rtpmap:35 H264\/90000/m, 'Chromium applied the renumbered offer');
  const answer = await media.addPeer('low-pt', 'viewer', offer);
  assert.match(answer, /^a=rtpmap:35 H264\/90000/m, 'answer keeps the offered payload type');
  assert.match(answer, /^a=sendonly/m, 'answer sends video rather than going inactive');
  await page.evaluate((sdp) => pc.setRemoteDescription({ type: 'answer', sdp }), answer);
  await page.waitForFunction(
    () => document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames > 30,
    null,
    { timeout: 10000 },
  );
  const payloadType = await page.evaluate(async () => {
    const stats = await pc.getStats();
    for (const report of stats.values())
      if (report.type === 'inbound-rtp' && report.kind === 'video')
        return stats.get(report.codecId)?.payloadType;
  });
  assert.equal(payloadType, 35, 'decoded packets carry payload type 35');
  await media.shutdown();
  assert.equal(stderr, '', 'native worker reports no errors');
  console.log('PASS: video offered as payload type 35 is answered, sent and decoded');
} finally {
  await media.shutdown();
  await browser.close();
}
