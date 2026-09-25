// Explicit hardware acceptance: one desktop capture/encode shared by loopback viewers.
// Captures the primary display but never sends keyboard, pointer or touch events.
//
// Usage: node shared-stream-check.mjs <playwright> [codec]
//   <playwright>  path to a `playwright` package install matching the local
//                 chromium_headless_shell revision.
//   [codec]       optional codec id, one of h264 (default), h265, av1.
//
// Exits 0 with `NOT TESTED: ...` and does no further work in two cases:
//   - the GPU has no encoder for the requested codec (`probe().codecs`).
//   - this Chromium build cannot decode the requested codec (checked via
//     `RTCRtpReceiver.getCapabilities('video')`) — expected for H.265 on a
//     headless Chromium without hardware HEVC support.
//
// Known flake: the first run in a session can time out waiting on WebRTC
// negotiation while the GPU/driver warms up from a cold state (first
// GStreamer/NVENC session of the process). Re-run once before treating a
// timeout as a real failure; a warm re-run passes reliably.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeMedia, probe } from '../../../apps/server/src/native-media.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

// Test against current packages and a worker built from the current sources.
ensureJsDependencies();
ensureNativeWorker();
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const codec = process.argv[3] ?? 'h264';
const codecMimeType = { h264: 'video/H264', h265: 'video/H265', av1: 'video/AV1' }[codec];
const codecEncodingName = { h264: 'H264', h265: 'H265', av1: 'AV1' }[codec];
assert.ok(codecMimeType, `Unknown codec ${codec}`);
if (!probe().codecs.includes(codec)) {
  console.log(`NOT TESTED: GPU has no ${codec} encoder`);
  process.exit(0);
}
const display =
  probe().displays.find((d) => d.persistent && d.primary) ??
  probe().displays.find((d) => d.persistent);
assert.ok(display, 'This acceptance check requires a connected display');
const { id, x, y, width, height, rotation } = display;
let latest = null;
const media = new NativeMedia({
  maxWorkers: 2,
  hostControl: true,
  onMetrics: (_source, message) => (latest = message),
});
const browser = await chromium.launch({ headless: true });
// Codec support depends only on the browser build, so one throwaway page is enough to decide
// whether decoding this codec is even possible here.
const capabilityPage = await browser.newPage();
const codecEntries = await capabilityPage.evaluate(
  (mimeType) =>
    (RTCRtpReceiver.getCapabilities('video')?.codecs ?? []).filter(
      (entry) => entry.mimeType.toLowerCase() === mimeType.toLowerCase(),
    ).length,
  codecMimeType,
);
await capabilityPage.close();
if (codecEntries === 0) {
  console.log(`NOT TESTED: Chromium cannot decode ${codec}`);
  await browser.close();
  process.exit(0);
}
const pages = new Map();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decoded = (peerId) =>
  pages
    .get(peerId)
    .evaluate(() => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames);
async function inboundCodecMimeType(peerId) {
  return pages.get(peerId).evaluate(async () => {
    const stats = await pc.getStats();
    let inbound;
    for (const report of stats.values())
      if (report.type === 'inbound-rtp' && report.kind === 'video') inbound = report;
    return inbound ? (stats.get(inbound.codecId)?.mimeType ?? null) : null;
  });
}
async function viewer(peerId) {
  const page = await browser.newPage();
  pages.set(peerId, page);
  const offer = await page.evaluate(async (mimeType) => {
    window.pc = new RTCPeerConnection({ iceServers: [] });
    const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    const capabilities = RTCRtpReceiver.getCapabilities('video').codecs;
    transceiver.setCodecPreferences(
      capabilities.filter(
        (entry) =>
          entry.mimeType.toLowerCase() === mimeType.toLowerCase() ||
          entry.mimeType.toLowerCase() === 'video/rtx',
      ),
    );
    window.input = pc.createDataChannel('input');
    window.lastControl = null;
    input.onmessage = (event) => {
      const value = JSON.parse(event.data);
      if (typeof value.control === 'boolean') window.lastControl = value.control;
    };
    pc.ontrack = (event) => {
      const video = document.createElement('video');
      Object.assign(video, { muted: true, autoplay: true, playsInline: true });
      video.srcObject = new MediaStream([event.track]);
      document.body.append(video);
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete')
      await new Promise((resolve) =>
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        }),
      );
    return pc.localDescription.sdp;
  }, codecMimeType);
  const answer = await media.addPeer('shared', peerId, offer);
  assert.match(
    answer,
    new RegExp(`a=rtpmap:\\d+ ${codecEncodingName}/90000`),
    `answer SDP for ${peerId} carries an ${codecEncodingName}/90000 rtpmap`,
  );
  return page.evaluate(async (sdp) => {
    const applied = performance.now();
    await pc.setRemoteDescription({ type: 'answer', sdp });
    while (!document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return performance.now() - applied;
  }, answer);
}
async function control(peerId, enabled) {
  await pages.get(peerId).evaluate((enabled) => {
    window.lastControl = null;
    input.send(JSON.stringify({ type: 'control', enabled }));
  }, enabled);
  await pages.get(peerId).waitForFunction(() => window.lastControl !== null);
  return pages.get(peerId).evaluate(() => window.lastControl);
}
let stderr = '';
try {
  await media.start('shared', {
    video: true,
    codec,
    profile: { name: 'balanced', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 },
    display: { id, x, y, width, height, rotation },
  });
  const worker = media.workers.get('shared');
  worker.child.stderr.on('data', (data) => (stderr += data));
  await Promise.all([viewer('a'), viewer('b')]);
  await wait(1500);
  assert.equal(media.workers.size, 1, 'both viewers share one worker');
  assert.equal(latest.codec, codec, 'metrics report the negotiated codec');
  for (const peerId of ['a', 'b'])
    assert.ok((await decoded(peerId)) > 30, `${peerId} decodes the shared stream`);
  assert.ok(latest.peers.a?.videoRtpPackets > 0 && latest.peers.b?.videoRtpPackets > 0);
  for (const peerId of ['a', 'b']) {
    const mimeType = await inboundCodecMimeType(peerId);
    assert.ok(mimeType, `${peerId} has an inbound-rtp codec`);
    assert.equal(
      mimeType.toLowerCase(),
      codecMimeType.toLowerCase(),
      `${peerId} decodes with the negotiated codec`,
    );
  }

  await media.removePeer('shared', 'b');
  const before = await decoded('a');
  await wait(1000);
  assert.ok((await decoded('a')) - before >= 20, 'removing b leaves a playing');

  const keyframesBefore = latest.encodedKeyframes;
  const joinMs = await viewer('c');
  assert.ok(joinMs < 1000, `late join decoded after ${Math.round(joinMs)} ms`);
  await wait(1100);
  const keyframesAfter = latest.encodedKeyframes;
  console.log(`encodedKeyframes before join ${keyframesBefore}, after ${keyframesAfter}`);
  assert.ok(keyframesAfter > keyframesBefore);
  assert.equal(latest.peers.b, undefined);

  // Permission toggles only; no OS input is sent.
  assert.equal(await media.setPermission('shared', 'a', true), true);
  assert.equal(await control('a', true), true);
  assert.equal(await control('c', true), false);
  await pages.get('a').evaluate(() => (window.lastControl = null));
  assert.equal(await media.setPermission('shared', 'a', false), false);
  await pages.get('a').waitForFunction(() => window.lastControl === false);

  await media.shutdown();
  assert.equal(media.workers.size, 0);
  assert.ok(worker.child.exitCode !== null);
  assert.equal(stderr, '', 'native worker reports no errors');
  console.log(
    `PASS: one capture/encode served three peers with isolated removal, ${Math.round(joinMs)} ms late join and per-peer control (${codec})`,
  );
} finally {
  await media.shutdown();
  await browser.close();
}
