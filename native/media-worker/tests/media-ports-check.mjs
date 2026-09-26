// Explicit Windows acceptance check for the worker's own ICE port range (VIDVNC_ICE_PORTS),
// which the server used before the media relay (security analysis finding R8) and no longer
// sets. Kept until the worker's range support is removed. System loopback audio only; no
// desktop capture or input.
//
// Usage: node media-ports-check.mjs <playwright>
//   <playwright>  path to a `playwright` package install matching the local
//                 chromium_headless_shell revision.
//
// Checks that with VIDVNC_ICE_PORTS set, the worker:
//   - offers only UDP host candidates, all inside the range (ICE-TCP is off);
//   - still connects a real browser peer;
//   - holds no UDP socket outside the range and no listening TCP socket, per `netstat`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { NativeMedia } from '../../../apps/server/src/native-media.mjs';
import { executable, workerEnvironment } from '../runtime.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

// Test against current packages and a worker built from the current sources.
ensureJsDependencies();
ensureNativeWorker();

const RANGE = { min: 41000, max: 41049 };
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const media = new NativeMedia({
  hostControl: true,
  launch: () =>
    spawn(executable, ['--session'], {
      env: { ...workerEnvironment(), VIDVNC_ICE_PORTS: `${RANGE.min}-${RANGE.max}` },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
});

// Local ports the process owns, from `netstat -ano -p <protocol>`, e.g.
// "  UDP    0.0.0.0:41000    *:*    1234" or "  TCP  [::]:41001  [::]:0  LISTENING  1234".
function sockets(pid, protocol) {
  const rows = [];
  for (const line of execFileSync('netstat', ['-ano', '-p', protocol], {
    encoding: 'utf8',
  }).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== protocol.toUpperCase() || Number(fields.at(-1)) !== pid) continue;
    const port = Number(fields[1].slice(fields[1].lastIndexOf(':') + 1));
    rows.push({ local: fields[1], port, state: protocol === 'tcp' ? fields[3] : null });
  }
  return rows;
}

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
  const answer = await media.offer(
    'ports-test',
    offer,
    { name: 'mobile', width: 1280, height: 720, fps: 15, bitrateKbps: 2000 },
    { mode: 'on' },
    null,
    { video: false },
  );

  const candidates = answer
    .split(/\r?\n/)
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.split(' '));
  assert.ok(candidates.length > 0, 'the answer carries host candidates');
  for (const [, , transport, , address, port] of candidates) {
    assert.equal(transport.toLowerCase(), 'udp', `ICE-TCP candidate ${address}:${port}`);
    assert.ok(
      Number(port) >= RANGE.min && Number(port) <= RANGE.max,
      `candidate port ${port} is outside ${RANGE.min}-${RANGE.max}`,
    );
  }

  await page.evaluate((sdp) => pc.setRemoteDescription({ type: 'answer', sdp }), answer);
  await page.waitForFunction(() => pc.connectionState === 'connected', null, { timeout: 15000 });

  const pid = media.active.child.pid;
  const udp = sockets(pid, 'udp');
  assert.ok(udp.length > 0, 'netstat shows the worker’s UDP sockets');
  const outside = udp.filter(({ port }) => port < RANGE.min || port > RANGE.max);
  assert.deepEqual(outside, [], 'every worker UDP socket is inside the range');
  const listening = sockets(pid, 'tcp').filter(({ state }) => state === 'LISTENING');
  assert.deepEqual(listening, [], 'the worker listens on no TCP port');

  console.log(
    `PASS: media ports ${RANGE.min}-${RANGE.max}: ${candidates.length} UDP candidate(s), ` +
      `${udp.length} UDP socket(s) in range, no TCP listener, browser connected`,
  );
} finally {
  await media.shutdown();
  await browser.close();
}
