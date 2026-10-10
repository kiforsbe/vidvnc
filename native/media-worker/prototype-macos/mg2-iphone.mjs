// MG2/MG6 prototype only (throwaway): a LAN test server for iPhone Safari. Run it under the
// MG3 host app (`open --env MG_TASK=mg2-iphone ...`), so capture uses the app's Screen
// Recording grant and its network traffic is attributed to the app (MG6: Local Network).
//
//   http://<mac>:8099/        the viewer page for the iPhone: pick codec and size, Start
//   http://127.0.0.1:8099/clock   the clock page for the Mac's screen (animation + time code)
//
// The viewer negotiates WebRTC through an in-process media relay (UDP 4384) to the prototype
// worker (ScreenCaptureKit -> VideoToolbox -> media-net). It reads the clock page's time code
// back out of the received video and, with an NTP-style offset from /time, reports glass-to-glass
// latency on the Mac's clock. Everything is logged to ~/Library/Logs/VidVNC-MG3/iphone.log.
import { createSocket } from 'node:dgram';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeMedia } from '../../../apps/server/src/native-media.mjs';
import { RelayCore } from '../../../apps/server/src/media-relay/relay.mjs';
import {
  announceRelay,
  iceCredentials,
  stripOfferCandidates,
  validateRelayAnswer,
} from '../../../apps/server/src/sdp-candidates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.VIDVNC_MEDIA_WORKER = path.join(here, 'build-xcode/Release/media-worker');
const HTTP_PORT = 8099;
const RELAY_PORT = 4384;
const MINUTES = Number(process.env.MG_MINUTES ?? 20);
const logs = path.join(homedir(), 'Library/Logs/VidVNC-MG3');
mkdirSync(logs, { recursive: true });
const logFile = path.join(logs, 'iphone.log');
const log = (text) => appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((row) => row?.family === 'IPv4' && !row.internal)?.address;
const relayEvents = [];
const relay = new RelayCore({
  createSocket,
  onEvent: (event) => {
    relayEvents.push(event);
    log(`RELAY EVENT ${JSON.stringify(event)}`);
  },
});
await relay.start(RELAY_PORT);
const sweeper = setInterval(() => relay.sweep(), 1000);
const metrics = setInterval(() => log(`RELAY METRICS ${JSON.stringify(relay.metrics())}`), 5000);
const media = new NativeMedia({
  hostControl: true,
  iceBind: () => 'loopback',
  log: (text) => log(`WORKER ${text.trim()}`),
});
let geometry = null;
let sequence = 0;

const viewer = String.raw`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>VidVNC MG2</title>
<body style="margin:0;background:#111;color:#eee;font:14px -apple-system,sans-serif">
<div style="padding:8px">
<select id=codec><option value=h264>H.264</option><option value=h265>H.265</option></select>
<select id=size><option value="1920,1080,60,20000">1080p60</option><option value="3840,2160,30,30000">4K30</option></select>
<button id=go>Start</button> <button id=stop>Stop</button>
</div>
<video id=v playsinline muted autoplay style="width:100%;background:#000"></video>
<pre id=out style="white-space:pre-wrap;padding:8px;margin:0"></pre>
<script>
const out = document.getElementById('out');
const say = (t) => (out.textContent = t);
let pc = null, offset = 0, latencies = [], unreadable = 0, timer = null, run = 0;
async function syncClock() {
  let best = { rtt: Infinity, offset: 0 };
  for (let i = 0; i < 12; i++) {
    const t0 = performance.timeOrigin + performance.now();
    const { now } = await (await fetch('/time', { cache: 'no-store' })).json();
    const t1 = performance.timeOrigin + performance.now();
    if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: now - (t0 + t1) / 2 };
  }
  return best;
}
async function start() {
  if (pc) pc.close();
  run++;
  latencies = []; unreadable = 0;
  const codec = document.getElementById('codec').value;
  const [width, height, fps, bitrate] = document.getElementById('size').value.split(',').map(Number);
  say('Syncing clocks...');
  const sync = await syncClock();
  offset = sync.offset;
  say('Clock offset ' + offset.toFixed(1) + ' ms (rtt ' + sync.rtt.toFixed(1) + ' ms). Negotiating...');
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.oniceconnectionstatechange = () => post({ type: 'ice', state: pc.iceConnectionState });
  pc.onconnectionstatechange = () => post({ type: 'connection', state: pc.connectionState });
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== 'complete')
    await new Promise((r) => pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r()));
  const response = await fetch('/offer', { method: 'POST', body: JSON.stringify({ sdp: pc.localDescription.sdp, codec, width, height, fps, bitrate }) });
  const reply = await response.json();
  if (!response.ok) { say('Offer failed: ' + reply.error); post({ type: 'offer-failed', error: reply.error }); return; }
  const v = document.getElementById('v');
  pc.ontrack = ({ track }) => { v.srcObject = new MediaStream([track]); v.requestVideoFrameCallback(onFrame); };
  await pc.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
  const thisRun = run;
  clearInterval(timer);
  timer = setInterval(() => thisRun === run && report(codec, width, height, fps, bitrate, sync), 2000);
}
const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
let last = -1, geometry = null;
async function onFrame(_, meta) {
  const v = document.getElementById('v');
  if (!geometry || Math.random() < 0.01) geometry = await (await fetch('/geometry')).json().catch(() => null);
  const g = geometry;
  if (g && g.screenWidth) {
    const W = meta.width, H = meta.height;
    const scale = Math.min(W / g.screenWidth, H / g.screenHeight);
    const ox = (W - g.screenWidth * scale) / 2 + g.left * scale;
    const oy = (H - g.screenHeight * scale) / 2 + g.top * scale;
    const BLOCK = 48, BITS = 24;
    const sw = Math.ceil((BITS + 2) * BLOCK * scale) + 2, sh = Math.ceil(BLOCK * scale) + 2;
    probe.canvas.width = sw; probe.canvas.height = sh;
    probe.drawImage(v, ox, oy, sw, sh, 0, 0, sw, sh);
    const px = probe.getImageData(0, 0, sw, sh).data;
    const luma = (i) => { const x = Math.round((i + 0.5) * BLOCK * scale), y = Math.round(0.5 * BLOCK * scale), o = (y * sw + x) * 4; return (px[o] + px[o + 1] + px[o + 2]) / 3; };
    if (luma(0) > 160 && luma(1) < 96) {
      let value = 0;
      for (let b = 0; b < BITS; b++) if (luma(b + 2) > 128) value |= 1 << b;
      if (value !== last) {
        last = value;
        const shown = Math.round(performance.timeOrigin + meta.expectedDisplayTime + offset) & 0xffffff;
        const latency = (shown - value + 0x1000000) % 0x1000000;
        if (latency < 5000) latencies.push(latency); else unreadable++;
      }
    } else unreadable++;
  }
  v.requestVideoFrameCallback(onFrame);
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
let previous = null;
async function report(codec, width, height, fps, bitrate, sync) {
  let row = {}, pair = null, codecRow = null;
  const stats = await pc.getStats();
  stats.forEach((e) => {
    if (e.type === 'inbound-rtp' && e.kind === 'video') row = { ...e };
    if (e.type === 'transport' && e.selectedCandidatePairId) pair = stats.get(e.selectedCandidatePairId);
  });
  if (row.codecId) codecRow = stats.get(row.codecId);
  const p = previous; previous = row;
  const d = (k) => p ? (row[k] ?? 0) - (p[k] ?? 0) : 0;
  const frames = d('framesDecoded');
  const sample = {
    type: 'stats', codec, requested: width + 'x' + height + '@' + fps, bitrate,
    mime: codecRow?.mimeType, size: row.frameWidth + 'x' + row.frameHeight,
    fps: frames / 2, kbps: Math.round(d('bytesReceived') * 8 / 2 / 1000),
    jitterBufferMs: d('jitterBufferEmittedCount') ? Math.round(d('jitterBufferDelay') / d('jitterBufferEmittedCount') * 1000) : null,
    decodeMs: frames ? +(d('totalDecodeTime') / frames * 1000).toFixed(1) : null,
    lost: row.packetsLost, nack: row.nackCount, pli: row.pliCount, freezes: row.freezeCount, dropped: row.framesDropped,
    g2g: { p50: pct(latencies, 50), p95: pct(latencies, 95), n: latencies.length, unreadable },
    clock: { offset: +sync.offset.toFixed(1), rtt: +sync.rtt.toFixed(1) },
    pairRtt: pair?.currentRoundTripTime, state: pc.connectionState,
  };
  latencies = []; unreadable = 0;
  say(JSON.stringify(sample, null, 1));
  post(sample);
}
function post(o) { fetch('/stats', { method: 'POST', body: JSON.stringify({ ...o, ua: navigator.userAgent }) }).catch(() => {}); }
document.getElementById('go').onclick = () => start().catch((e) => { say('Error: ' + e); post({ type: 'error', error: String(e) }); });
document.getElementById('stop').onclick = () => { if (pc) pc.close(); pc = null; clearInterval(timer); post({ type: 'stopped' }); };
post({ type: 'loaded' });
</script>`;

const clock = String.raw`<!doctype html><title>VidVNC MG2 clock</title>
<body style="margin:0;background:#000;overflow:hidden"><canvas id=c style="position:fixed;inset:0"></canvas>
<script>
const stage = document.getElementById('c');
const fit = () => { stage.width = innerWidth * devicePixelRatio; stage.height = innerHeight * devicePixelRatio; stage.style.width = innerWidth + 'px'; stage.style.height = innerHeight + 'px'; };
fit(); addEventListener('resize', fit);
const g = stage.getContext('2d');
const BLOCK = 48, BITS = 24;
const draw = () => {
  const t = performance.now(), w = stage.width, h = stage.height;
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, 'hsl(' + (t / 20) % 360 + ',70%,40%)'); gr.addColorStop(1, 'hsl(' + (t / 20 + 180) % 360 + ',70%,40%)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = 'hsl(' + (i * 37 + t / 10) % 360 + ',80%,60%)';
    g.beginPath(); g.arc((Math.sin(t / 900 + i) + 1) / 2 * w, (Math.cos(t / 700 + i * 1.7) + 1) / 2 * h, 30 + 20 * Math.sin(t / 300 + i), 0, 7); g.fill();
  }
  const now = Math.round(performance.timeOrigin + t) & 0xffffff, s = BLOCK * devicePixelRatio;
  g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.fillStyle = '#000'; g.fillRect(s, 0, s, s);
  for (let b = 0; b < BITS; b++) { g.fillStyle = (now >> b) & 1 ? '#fff' : '#000'; g.fillRect((b + 2) * s, 0, s, s); }
  requestAnimationFrame(draw);
};
requestAnimationFrame(draw);
setInterval(() => fetch('/geometry', { method: 'POST', body: JSON.stringify({
  left: screenX + (outerWidth - innerWidth) / 2, top: screenY + (outerHeight - innerHeight),
  screenWidth: screen.width, screenHeight: screen.height }) }), 1000);
</script>`;

const body = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text));
  });
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const client = request.socket.remoteAddress?.replace(/^::ffff:/, '');
  try {
    if (url.pathname === '/') {
      log(`HTTP viewer page to ${client}`);
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(viewer);
    }
    if (url.pathname === '/clock') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(clock);
    }
    if (url.pathname === '/time') return json(response, 200, { now: Date.now() });
    if (url.pathname === '/geometry' && request.method === 'POST') {
      geometry = JSON.parse(await body(request));
      return json(response, 200, {});
    }
    if (url.pathname === '/geometry') return json(response, 200, geometry ?? {});
    if (url.pathname === '/stats' && request.method === 'POST') {
      log(`VIEWER ${client} ${await body(request)}`);
      return json(response, 200, {});
    }
    if (url.pathname === '/offer' && request.method === 'POST') {
      const offer = JSON.parse(await body(request));
      // One source at a time: the previous one is stopped.
      for (const id of [...media.workers.keys()]) await media.stop(id);
      const id = `iphone-${++sequence}`;
      log(`OFFER ${id} from ${client}: ${offer.codec} ${offer.width}x${offer.height}@${offer.fps} ${offer.bitrate} kbit/s`);
      await media.start(id, {
        video: true,
        codec: offer.codec,
        profile: {
          name: 'desktop',
          width: offer.width,
          height: offer.height,
          fps: offer.fps,
          bitrateKbps: offer.bitrate,
          bitrateMode: 'cbr',
        },
      });
      const credentials = iceCredentials(offer.sdp);
      const answer = await media.addPeer(id, id, stripOfferCandidates(offer.sdp));
      const worker = validateRelayAnswer(answer);
      relay.allow({
        streamId: id,
        ufrag: worker.ufrag,
        pwd: worker.pwd,
        clientUfrag: credentials.ufrag,
        clientPwd: credentials.pwd,
        workerPort: worker.port,
        clientHint: client,
        expiresMs: 15000,
      });
      log(`ANSWER ${id} worker port ${worker.port}, relay ${lanAddress}:${RELAY_PORT}`);
      return json(response, 200, { sdp: announceRelay(answer, [lanAddress], RELAY_PORT) });
    }
    if (url.pathname === '/stop') {
      json(response, 200, { stopping: true });
      return shutdown('stop requested');
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    log(`ERROR ${url.pathname}: ${error.stack ?? error}`);
    json(response, 500, { error: String(error.message ?? error) });
  }
});

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`STOP ${reason}`);
  clearInterval(sweeper);
  clearInterval(metrics);
  server.close();
  await media.shutdown();
  relay.close();
  console.log(`mg2-iphone stopped: ${reason}. Log: ${logFile}`);
  process.exit(0);
}
server.listen(HTTP_PORT, '0.0.0.0', () =>
  log(`START http://${lanAddress}:${HTTP_PORT}/ relay UDP ${RELAY_PORT}, for ${MINUTES} min`),
);
setTimeout(() => shutdown('time limit'), MINUTES * 60_000);
await new Promise(() => {});
