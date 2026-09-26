// Explicit Windows acceptance check for the authenticating media relay: prototype gates P1
// and P2 of docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-design.md.
//
// Usage: node relay-check.mjs <playwright> [--video] [--direct] [--peers N] [--seconds N]
//                             [--port N]
//   <playwright>  path to a `playwright` package install matching the local
//                 chromium_headless_shell revision.
//   --video       stream the primary display (1920x1080 at 60 fps) instead of loopback audio.
//   --direct      baseline for P2: no relay, the worker gathers on every interface as today;
//                 only the round-trip times are reported.
//   --peers N     peer connections from one browser through the one relay port (default 2).
//   --seconds N   how long to sample round-trip times after connecting (default 10).
//   --port N      the relay's UDP port (default 4384).
//
// Answers, with evidence, the P1 questions:
//   1. the worker gathers on 127.0.0.1 only (candidate check and `netstat`);
//   2. its answer passes the relay-mode validation (the SDP line allow-list);
//   3. webrtcbin completes ICE and DTLS when the browser exists only as a peer-reflexive
//      candidate arriving through the relay;
//   4. what the browser makes of the loopback XOR-MAPPED-ADDRESS (its selected local
//      candidate);
//   5. several peer connections share the relay's one port.
// And reports, for P2, the round-trip time percentiles over the relayed path and the relay's
// counters. Chromium only; Firefox and Safari are checked by hand (see the plan).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { NativeMedia } from '../../../apps/server/src/native-media.mjs';
import { RelayCore } from '../../../apps/server/src/media-relay/relay.mjs';
import {
  announceRelay,
  iceCredentials,
  stripOfferCandidates,
  validateRelayAnswer,
} from '../../../apps/server/src/sdp-candidates.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

ensureJsDependencies();
ensureNativeWorker();

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const VIDEO = process.argv.includes('--video');
const DIRECT = process.argv.includes('--direct');
const PEERS = option('--peers', 2);
const SECONDS = option('--seconds', 10);
const PORT = option('--port', 4384);

// The browser reaches the relay on this PC's LAN address, so the client leg is not loopback.
const lanAddress =
  Object.values(networkInterfaces())
    .flat()
    .find((row) => row?.family === 'IPv4' && !row.internal)?.address ?? '127.0.0.1';

function sockets(pid, protocol) {
  const rows = [];
  for (const line of execFileSync('netstat', ['-ano', '-p', protocol], {
    encoding: 'utf8',
  }).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== protocol.toUpperCase() || Number(fields.at(-1)) !== pid) continue;
    rows.push({ local: fields[1], state: protocol === 'tcp' ? fields[3] : null });
  }
  return rows;
}

const percentile = (values, p) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const events = [];
const relay = new RelayCore({
  createSocket: (options) => createSocket(options),
  onEvent: (event) => events.push(event),
});
const sweeper = setInterval(() => relay.sweep(), 1000);
const media = new NativeMedia({
  hostControl: true,
  iceBind: () => (DIRECT ? null : 'loopback'),
  maxWorkers: 16,
});
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const results = [];
const report = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` - ${detail}` : ''}`);
};

try {
  if (!DIRECT) await relay.start(PORT);
  const page = await browser.newPage();
  for (let index = 0; index < PEERS; index++) {
    const offer = await page.evaluate(
      async ({ index, video }) => {
        window.pcs ??= [];
        const pc = new RTCPeerConnection({ iceServers: [] });
        window.pcs[index] = pc;
        pc.addTransceiver(video ? 'video' : 'audio', { direction: 'recvonly' });
        await pc.setLocalDescription(await pc.createOffer());
        if (pc.iceGatheringState !== 'complete')
          await new Promise((resolve) =>
            pc.addEventListener('icegatheringstatechange', () => {
              if (pc.iceGatheringState === 'complete') resolve();
            }),
          );
        return pc.localDescription.sdp;
      },
      { index, video: VIDEO },
    );
    const client = iceCredentials(offer);
    const answer = await media.offer(
      `relay-check-${index}`,
      DIRECT ? offer : stripOfferCandidates(offer),
      VIDEO
        ? { name: 'desktop', width: 1920, height: 1080, fps: 60, bitrateKbps: 20000 }
        : { name: 'mobile', width: 1280, height: 720, fps: 15, bitrateKbps: 2000 },
      VIDEO ? { mode: 'off' } : { mode: 'on' },
      null,
      { video: VIDEO },
    );

    if (DIRECT) {
      await page.evaluate(
        ({ index, sdp }) => window.pcs[index].setRemoteDescription({ type: 'answer', sdp }),
        { index, sdp: answer },
      );
      continue;
    }
    const candidates = answer.split(/\r\n/).filter((line) => line.startsWith('a=candidate:'));
    report(
      `peer ${index}: the worker offers only 127.0.0.1`,
      candidates.length > 0 && candidates.every((line) => line.split(' ')[4] === '127.0.0.1'),
      candidates.join(' | '),
    );
    let worker;
    try {
      worker = validateRelayAnswer(answer);
      report(`peer ${index}: the answer passes relay-mode validation`, true);
    } catch (error) {
      report(`peer ${index}: the answer passes relay-mode validation`, false, error.message);
      console.log(answer);
      throw error;
    }
    relay.allow({
      streamId: `relay-check-${index}`,
      ufrag: worker.ufrag,
      pwd: worker.pwd,
      clientUfrag: client.ufrag,
      clientPwd: client.pwd,
      workerPort: worker.port,
      clientHint: lanAddress,
      expiresMs: 15000,
    });
    const announced = announceRelay(answer, [lanAddress], PORT);
    await page.evaluate(
      ({ index, sdp }) => window.pcs[index].setRemoteDescription({ type: 'answer', sdp }),
      { index, sdp: announced },
    );
  }

  for (let index = 0; index < PEERS; index++) {
    const connected = await page
      .waitForFunction((i) => window.pcs[i].connectionState === 'connected', index, {
        timeout: 20000,
      })
      .then(
        () => true,
        () => false,
      );
    report(`peer ${index}: ICE and DTLS complete${DIRECT ? '' : ' through the relay'}`, connected);
  }

  const selected = DIRECT
    ? []
    : await page.evaluate(async () => {
        const rows = [];
        for (const pc of window.pcs) {
          const stats = await pc.getStats();
          let pair;
          stats.forEach((row) => {
            if (row.type === 'transport' && row.selectedCandidatePairId)
              pair = stats.get(row.selectedCandidatePairId);
          });
          const local = pair && stats.get(pair.localCandidateId);
          const remote = pair && stats.get(pair.remoteCandidateId);
          rows.push({
            local: local && `${local.candidateType} ${local.address ?? '?'}:${local.port}`,
            remote: remote && `${remote.candidateType} ${remote.address ?? '?'}:${remote.port}`,
          });
        }
        return rows;
      });
  for (const [index, row] of selected.entries())
    console.log(`INFO: peer ${index} selected pair: local ${row.local}, remote ${row.remote}`);
  if (!DIRECT)
    report(
      'the browser accepted the loopback mapped address (a pair was selected)',
      selected.every((row) => row.local && row.remote),
    );

  const pids = [...media.workers.values()].map((active) => active.child.pid);
  const exposed = pids.flatMap((pid) =>
    sockets(pid, 'udp').filter(({ local }) => !local.startsWith('127.0.0.1:')),
  );
  if (!DIRECT) {
    report(
      'netstat: every worker UDP socket is on 127.0.0.1',
      pids.length > 0 && exposed.length === 0,
      exposed.map(({ local }) => local).join(', '),
    );
    const listening = pids.flatMap((pid) =>
      sockets(pid, 'tcp').filter(({ state }) => state === 'LISTENING'),
    );
    report('netstat: no worker listens on TCP', listening.length === 0);
    report(
      `all ${PEERS} peers share the relay's port ${PORT}`,
      events.filter((event) => event.type === 'pinned').length >= PEERS,
    );
  }

  const rtt = [];
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    const samples = await page.evaluate(async () => {
      const values = [];
      for (const pc of window.pcs) {
        const stats = await pc.getStats();
        stats.forEach((row) => {
          if (row.type === 'candidate-pair' && row.nominated && row.currentRoundTripTime)
            values.push(row.currentRoundTripTime * 1000);
        });
      }
      return values;
    });
    rtt.push(...samples);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(
    `INFO: round trip ${DIRECT ? 'direct (baseline)' : 'through the relay'} over ${SECONDS} s ` +
      `(${rtt.length} samples): ` +
      `p50 ${percentile(rtt, 50).toFixed(2)} ms, p95 ${percentile(rtt, 95).toFixed(2)} ms, ` +
      `p99 ${percentile(rtt, 99).toFixed(2)} ms`,
  );
  if (!DIRECT) {
    console.log(`INFO: relay counters ${JSON.stringify(relay.metrics())}`);
    console.log(`INFO: relay events ${JSON.stringify(events)}`);
  }
  assert.ok(
    results.every((row) => row.ok),
    'every check passes',
  );
  console.log('PASS: relay check');
} finally {
  clearInterval(sweeper);
  await media.shutdown();
  relay.close();
  await browser.close();
}
