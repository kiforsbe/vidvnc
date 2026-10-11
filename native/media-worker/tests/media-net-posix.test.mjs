// media-net over POSIX pipes on macOS (design D2): the real `media-worker --network`, given
// its four pipe ends as descriptors 3-6 the way the worker's launcher maps them, reports
// ready, answers a viewer with a candidate on 127.0.0.1 only, owns that port, and ends when
// the worker says so, closes its pipe or sends a malformed frame record. Runs only on a Mac
// with the worker built (./build-native.sh); the sandbox around it is phase 4's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { defaultWorker } from '../runtime-paths.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const worker = process.env.VIDVNC_MEDIA_WORKER || defaultWorker(root, 'darwin');
const skip =
  process.platform !== 'darwin'
    ? 'macOS only'
    : !existsSync(worker)
      ? `no media worker at ${worker} (run ./build-native.sh)`
      : false;

// An offer as a browser makes one for an audio-only source with the input data channel. The
// fingerprint is never checked: no DTLS handshake happens here.
const fingerprint = Array.from({ length: 32 }, () => 'AB').join(':');
const transport = [
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:abcdefghijklmnopqrstuvwx',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${fingerprint}`,
  'a=setup:actpass',
];
const offer = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  ...transport,
  'a=mid:0',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  ...transport,
  'a=mid:1',
  'a=sctp-port:5000',
  '',
].join('\r\n');

function startNet() {
  const child = spawn(worker, ['--network', '3', '4', '5', '6'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  const [control, replies, frames] = [child.stdio[3], child.stdio[4], child.stdio[5]];
  const messages = [];
  const waiters = [];
  createInterface({ input: replies }).on('line', (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  exited.finally(() => clearTimeout(timer));
  return {
    child,
    control,
    frames,
    exited,
    send: (message) => control.write(`${JSON.stringify(message)}\n`),
    async next(type) {
      for (;;) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve, reject) => {
          waiters.push(resolve);
          exited.then(() => reject(new Error(`media-net exited before ${type}`)));
        });
      }
    },
  };
}

test('media-net answers on loopback over POSIX pipes and owns its port', { skip }, async () => {
  const net = startNet();
  const ready = await net.next('net-ready');
  // Unsandboxed here, and it says so; phase 4's launcher applies the profile.
  assert.deepEqual(ready, { type: 'net-ready', tier: 'none', codeGuard: 'off' });
  net.send({ type: 'configure', video: false, audioChannels: 2 });
  net.send({ type: 'add-peer', peerId: 'peer-1', sdp: offer });
  const answer = await net.next('answer');
  assert.equal(answer.peerId, 'peer-1');
  const candidates = answer.sdp.split('\r\n').filter((line) => line.startsWith('a=candidate'));
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) assert.match(candidate, / UDP \d+ 127\.0\.0\.1 \d+ typ host/);
  const port = Number(/ 127\.0\.0\.1 (\d+) /.exec(candidates[0])[1]);
  const owners = execFileSync('lsof', ['-n', '-P', '-t', `-iUDP@127.0.0.1:${port}`], {
    encoding: 'utf8',
  });
  assert.deepEqual(owners.trim().split('\n'), [String(net.child.pid)]);
  net.send({ type: 'stop' });
  assert.equal(await net.exited, 0);
});

test('media-net ends when the worker closes its control pipe', { skip }, async () => {
  const net = startNet();
  await net.next('net-ready');
  net.control.end();
  assert.equal(await net.exited, 0);
});

test('a malformed frame record ends media-net', { skip }, async () => {
  const net = startNet();
  await net.next('net-ready');
  net.send({ type: 'configure', video: false, audioChannels: 2 });
  net.frames.write(Buffer.alloc(64, 0xff));
  assert.notEqual(await net.exited, null);
});
