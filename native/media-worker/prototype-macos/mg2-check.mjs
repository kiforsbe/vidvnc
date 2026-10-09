// MG2 prototype only (throwaway): ScreenCaptureKit -> VideoToolbox -> frames -> media-net ->
// media relay -> Chrome, with glass-to-glass latency and CPU.
//
// Usage: VIDVNC_MEDIA_WORKER=<prototype media-worker> node mg2-check.mjs <playwright>
//          [--codec h264|h265] [--width N] [--height N] [--fps N] [--bitrate KBPS]
//          [--seconds N] [--port N] [--direct] [--vbr]
//
// Chrome runs visible and full screen on the main display. The page animates (so capture has
// work to do) and draws its own clock into the top-left corner as 24 black or white blocks.
// The same page receives the stream; on every received frame (requestVideoFrameCallback) it
// reads the blocks back out of the decoded video, so `display time - drawn time` covers
// render, capture, encode, the frames pipe, media-net, the relay, the browser's jitter buffer
// and decode, on one clock. It is accurate to about one display refresh.
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { NativeMedia } from '../../../apps/server/src/native-media.mjs';
import { RelayCore } from '../../../apps/server/src/media-relay/relay.mjs';
import {
  announceRelay,
  iceCredentials,
  stripOfferCandidates,
  validateRelayAnswer,
} from '../../../apps/server/src/sdp-candidates.mjs';

const value = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const CODEC = value('--codec', 'h264');
const WIDTH = Number(value('--width', 1920));
const HEIGHT = Number(value('--height', 1080));
const FPS = Number(value('--fps', 60));
const BITRATE = Number(value('--bitrate', 20000));
const SECONDS = Number(value('--seconds', 20));
const PORT = Number(value('--port', 4384));
const DIRECT = process.argv.includes('--direct');
const VBR = process.argv.includes('--vbr');
const STATS = path.join(tmpdir(), `vidvnc-mg2-${process.pid}.jsonl`);
process.env.VIDVNC_MG2_STATS = STATS;

const lanAddress =
  Object.values(networkInterfaces())
    .flat()
    .find((row) => row?.family === 'IPv4' && !row.internal)?.address ?? '127.0.0.1';
const percentile = (values, p) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const summary = (values, digits = 1) =>
  values.length
    ? `p50 ${percentile(values, 50).toFixed(digits)}, p95 ${percentile(values, 95).toFixed(digits)}, ` +
      `p99 ${percentile(values, 99).toFixed(digits)}, max ${Math.max(...values).toFixed(digits)} ms (${values.length})`
    : 'no samples';

// Cumulative CPU seconds per process, from `ps -o time`.
function cpuSeconds() {
  const rows = execFileSync('ps', ['-axo', 'pid=,time=,command='], { encoding: 'utf8' });
  const totals = { worker: 0, net: 0, chrome: 0 };
  for (const line of rows.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, , time, command] = match;
    const parts = time.split(/[:.]/).map(Number);
    const seconds =
      parts.length === 4
        ? parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 100
        : parts[0] * 60 + parts[1] + (parts[2] ?? 0) / 100;
    if (command.startsWith(process.env.VIDVNC_MEDIA_WORKER))
      totals[command.includes('--network') ? 'net' : 'worker'] += seconds;
    else if (command.includes('Google Chrome')) totals.chrome += seconds;
  }
  return totals;
}

const relay = new RelayCore({ createSocket, onEvent: () => {} });
const sweeper = setInterval(() => relay.sweep(), 1000);
const media = new NativeMedia({ hostControl: true, iceBind: () => (DIRECT ? null : 'loopback') });
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({
  headless: false,
  args: [
    '--enable-features=WebRtcAllowH265Receive,PlatformHEVCDecoderSupport',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
let failed = false;
try {
  if (!DIRECT) await relay.start(PORT);
  const page = await browser.newPage({ viewport: null });
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  await page.waitForTimeout(1500);

  const offer = await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    // The animation: moving gradients and shapes over the whole screen.
    const stage = document.createElement('canvas');
    stage.width = innerWidth * devicePixelRatio;
    stage.height = innerHeight * devicePixelRatio;
    stage.style.cssText = `position:fixed;inset:0;width:${innerWidth}px;height:${innerHeight}px`;
    document.body.append(stage);
    const g = stage.getContext('2d');
    const BLOCK = 48;
    const BITS = 24;
    window.drawn = 0;
    const draw = () => {
      const t = performance.now();
      const w = stage.width;
      const h = stage.height;
      const gradient = g.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, `hsl(${(t / 20) % 360},70%,40%)`);
      gradient.addColorStop(1, `hsl(${(t / 20 + 180) % 360},70%,40%)`);
      g.fillStyle = gradient;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 40; i++) {
        const x = ((Math.sin(t / 900 + i) + 1) / 2) * w;
        const y = ((Math.cos(t / 700 + i * 1.7) + 1) / 2) * h;
        g.fillStyle = `hsl(${(i * 37 + t / 10) % 360},80%,60%)`;
        g.beginPath();
        g.arc(x, y, 30 + 20 * Math.sin(t / 300 + i), 0, Math.PI * 2);
        g.fill();
      }
      g.font = `${32 * devicePixelRatio}px monospace`;
      g.fillStyle = '#fff';
      g.fillText(new Date().toISOString(), 200 * devicePixelRatio, h - 80 * devicePixelRatio);
      // The clock: a white and a black calibration block, then 24 bits of wall-clock ms.
      const now = Math.round(performance.timeOrigin + t) & 0xffffff;
      const s = BLOCK * devicePixelRatio;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, s, s);
      g.fillStyle = '#000';
      g.fillRect(s, 0, s, s);
      for (let bit = 0; bit < BITS; bit++) {
        g.fillStyle = (now >> bit) & 1 ? '#fff' : '#000';
        g.fillRect((bit + 2) * s, 0, s, s);
      }
      window.drawn++;
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);

    window.latencies = [];
    window.unreadable = 0;
    const pc = new RTCPeerConnection({ iceServers: [] });
    window.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    window.replies = 0;
    const channel = pc.createDataChannel('input', { ordered: true });
    channel.onopen = () => setInterval(() => channel.send(JSON.stringify({ type: 'ping' })), 1000);
    channel.onmessage = () => window.replies++;
    pc.ontrack = ({ track }) => {
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      // Small and in the bottom-right corner, away from the clock.
      video.style.cssText = 'position:fixed;right:0;bottom:0;width:160px;height:90px';
      document.body.append(video);
      const probe = document.createElement('canvas').getContext('2d', {
        willReadFrequently: true,
      });
      let last = -1;
      const onFrame = (_, meta) => {
        const W = meta.width;
        const H = meta.height;
        // ScreenCaptureKit keeps the aspect ratio: the screen is letterboxed into W x H.
        const scale = Math.min(W / screen.width, H / screen.height);
        const ox = (W - screen.width * scale) / 2;
        const oy = (H - screen.height * scale) / 2;
        const stripW = Math.ceil((BITS + 2) * BLOCK * scale) + 2;
        const stripH = Math.ceil(BLOCK * scale) + 2;
        probe.canvas.width = stripW;
        probe.canvas.height = stripH;
        probe.drawImage(video, ox, oy, stripW, stripH, 0, 0, stripW, stripH);
        const pixels = probe.getImageData(0, 0, stripW, stripH).data;
        const luma = (i) => {
          const x = Math.round((i + 0.5) * BLOCK * scale);
          const y = Math.round(0.5 * BLOCK * scale);
          const o = (y * stripW + x) * 4;
          return (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3;
        };
        if (luma(0) > 160 && luma(1) < 96) {
          let value = 0;
          for (let bit = 0; bit < BITS; bit++) if (luma(bit + 2) > 128) value |= 1 << bit;
          if (value !== last) {
            last = value;
            const shown = Math.round(performance.timeOrigin + meta.expectedDisplayTime) & 0xffffff;
            const latency = (shown - value + 0x1000000) % 0x1000000;
            if (latency < 5000) window.latencies.push(latency);
            else window.unreadable++;
          }
        } else window.unreadable++;
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete')
      await new Promise((resolve) =>
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve();
        }),
      );
    return pc.localDescription.sdp;
  });

  const client = iceCredentials(offer);
  await media.start('mg2', {
    video: true,
    codec: CODEC,
    profile: {
      name: 'desktop',
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      bitrateKbps: BITRATE,
      bitrateMode: VBR ? 'vbr' : 'cbr',
    },
  });
  const answer = await media.addPeer('mg2', 'mg2', DIRECT ? offer : stripOfferCandidates(offer));
  if (DIRECT) {
    await page.evaluate((sdp) => window.pc.setRemoteDescription({ type: 'answer', sdp }), answer);
  } else {
    const worker = validateRelayAnswer(answer);
    relay.allow({
      streamId: 'mg2',
      ufrag: worker.ufrag,
      pwd: worker.pwd,
      clientUfrag: client.ufrag,
      clientPwd: client.pwd,
      workerPort: worker.port,
      clientHint: lanAddress,
      expiresMs: 15000,
    });
    const announced = announceRelay(answer, [lanAddress], PORT);
    await page.evaluate((sdp) => window.pc.setRemoteDescription({ type: 'answer', sdp }), announced);
  }
  await page.waitForFunction(() => window.pc.connectionState === 'connected', null, {
    timeout: 20000,
  });
  // Settle for 3 s (first keyframe, encoder ramp), then measure.
  await page.waitForTimeout(3000);
  rmSync(STATS, { force: true });
  await page.evaluate(() => {
    window.latencies = [];
    window.unreadable = 0;
    window.drawn = 0;
  });
  const statsAt = async () =>
    page.evaluate(async () => {
      let row = {};
      (await window.pc.getStats()).forEach((entry) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') row = { ...entry };
      });
      const codec = row.codecId && (await window.pc.getStats()).get(row.codecId);
      return { ...row, mimeType: codec?.mimeType };
    });
  const before = await statsAt();
  const cpuBefore = cpuSeconds();
  const started = Date.now();
  await page.waitForTimeout(SECONDS * 1000);
  const elapsed = (Date.now() - started) / 1000;
  const cpuAfter = cpuSeconds();
  const after = await statsAt();
  const page_ = await page.evaluate(() => ({
    latencies: window.latencies,
    unreadable: window.unreadable,
    drawn: window.drawn,
    replies: window.replies,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
  }));

  const delta = (key) => (after[key] ?? 0) - (before[key] ?? 0);
  const frames = delta('framesDecoded');
  const encoderRows = readFileSync(STATS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const sum = (key) => encoderRows.reduce((total, row) => total + (row.encoder[key] ?? 0), 0);
  const cpu = (key) => (((cpuAfter[key] - cpuBefore[key]) / elapsed) * 100).toFixed(1);

  console.log(
    `MG2 ${CODEC} ${WIDTH}x${HEIGHT}@${FPS} ${BITRATE} kbit/s ${VBR ? 'VBR' : 'CBR'} ` +
      `${DIRECT ? 'direct' : 'through the relay'}, ${elapsed.toFixed(1)} s, screen ${page_.screen}`,
  );
  console.log(
    `  browser: ${after.mimeType} decoder ${after.decoderImplementation} ` +
      `(power-efficient ${after.powerEfficientDecoder}), ${after.frameWidth}x${after.frameHeight}, ` +
      `${(frames / elapsed).toFixed(1)} fps decoded, page drew ${(page_.drawn / elapsed).toFixed(1)} fps`,
  );
  console.log(
    `  glass to glass: ${summary(page_.latencies)}; unreadable frames ${page_.unreadable}`,
  );
  console.log(
    `  browser per frame: jitter buffer ${((delta('jitterBufferDelay') / Math.max(1, delta('jitterBufferEmittedCount'))) * 1000).toFixed(1)} ms, ` +
      `decode ${((delta('totalDecodeTime') / Math.max(1, frames)) * 1000).toFixed(1)} ms, ` +
      `receive to decoded ${((delta('totalProcessingDelay') / Math.max(1, frames)) * 1000).toFixed(1)} ms`,
  );
  console.log(
    `  network: ${((delta('bytesReceived') * 8) / elapsed / 1000).toFixed(0)} kbit/s received, ` +
      `lost ${delta('packetsLost')}, NACK ${delta('nackCount')}, PLI ${delta('pliCount')}, ` +
      `freezes ${delta('freezeCount')}, dropped ${delta('framesDropped')}, keyframes ${delta('keyFramesDecoded')}`,
  );
  const encoderLatency = encoderRows.flatMap((row) =>
    row.encoder.captureToUnitMs ? [row.encoder.captureToUnitMs.p50] : [],
  );
  const encodeOnly = encoderRows.flatMap((row) =>
    row.encoder.encodeMs ? [row.encoder.encodeMs.p95] : [],
  );
  const last = encoderRows.at(-1)?.encoder ?? {};
  console.log(
    `  worker: captured ${(sum('captured') / elapsed).toFixed(1)} fps (idle ${sum('idle')}), ` +
      `encoded ${sum('encoded')}, dropped ${sum('dropped')}, keyframes ${sum('keyframes')}, ` +
      `${((sum('bytes') * 8) / elapsed / 1000).toFixed(0)} kbit/s, low-latency RC ${last.lowLatency}, ` +
      `display ${last.display}, refused [${(last.refused ?? []).join(' ')}], ` +
      `overflows ${encoderRows.reduce((t, r) => t + r.overflows, 0)}`,
  );
  console.log(
    `  worker: display time to access unit p50 per 2 s window ${encoderLatency.map((v) => v.toFixed(1)).join(' ')} ms; ` +
      `encode only p95 ${encodeOnly.map((v) => v.toFixed(1)).join(' ')} ms`,
  );
  console.log(
    `  CPU (% of one core): worker ${cpu('worker')}, media-net ${cpu('net')}, Chrome (all processes) ${cpu('chrome')}`,
  );
  console.log(`  input pings answered: ${page_.replies}`);
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error.stack ?? error}`);
} finally {
  clearInterval(sweeper);
  await media.shutdown();
  relay.close();
  await browser.close();
  rmSync(STATS, { force: true });
}
process.exit(failed ? 1 : 0);
