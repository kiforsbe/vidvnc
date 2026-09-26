// Explicit Windows check for the media relay's sandbox: `media-worker.exe --sandbox` runs Node
// under the tier T1 restricted token (user SID deny-only, low integrity, job, own desktop).
//
// Usage: node relay-sandbox-check.mjs
//
// 1. A probe under the launcher (without Node's permission model, so it tests the token
//    alone): a file in %LOCALAPPDATA%\VidVNC must not be readable; a UDP socket on every
//    address must bind.
// 2. The real relay, from its bundle under the permission model, started the way the server
//    starts it: it must listen and forward an authenticated STUN check to a loopback socket.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executable, workerEnvironment } from '../runtime.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';
import { MediaRelay, sandboxedRelayLaunch } from '../../../apps/server/src/media-relay.mjs';
import { bindingRequest } from '../../../apps/server/tests/fixtures/stun-messages.mjs';

ensureJsDependencies();
ensureNativeWorker();

let failures = 0;
const report = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` - ${detail}` : ''}`);
};

// 1. The token.
const folder = path.join(process.env.LOCALAPPDATA ?? '', 'VidVNC');
const secret = path.join(folder, 'relay-sandbox-secret.txt');
mkdirSync(folder, { recursive: true });
writeFileSync(secret, 'secret');
const probe = `
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
const result = {};
try { readFileSync(${JSON.stringify(secret)}); result.secret = 'read'; }
catch (error) { result.secret = error.code ?? String(error); }
const socket = dgram.createSocket({ type: 'udp6', ipv6Only: false });
socket.once('error', (error) => { result.udp = error.code ?? String(error); done(); });
socket.bind(0, '::', () => { result.udp = 'bound ' + socket.address().port; socket.close(); done(); });
function done() { process.stdout.write(JSON.stringify(result) + '\\n'); }
`;
const output = await new Promise((resolve) => {
  const child = spawn(
    executable,
    ['--sandbox', '--', process.execPath, '--input-type=module', '-e', probe],
    { env: workerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 20000);
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});
rmSync(secret, { force: true });
let result = {};
try {
  result = JSON.parse(output.stdout.trim().split(/\r?\n/).at(-1));
} catch {
  console.log(
    `INFO: probe exit ${output.code}; stdout ${output.stdout.trim()}; stderr ${output.stderr.trim()}`,
  );
}
report('Node starts under the restricted token', output.code === 0 && result.secret !== undefined);
report(
  'a file in the user profile cannot be read',
  result.secret === 'EPERM' || result.secret === 'EACCES',
  String(result.secret),
);
report(
  'a UDP socket binds on every address',
  String(result.udp).startsWith('bound'),
  String(result.udp),
);

// 2. The real relay.
const worker = dgram.createSocket('udp4');
await new Promise((resolve) => worker.bind(0, '127.0.0.1', resolve));
const received = [];
worker.on('message', (message) => received.push(message));
const holder = dgram.createSocket('udp4');
await new Promise((resolve) => holder.bind(0, '127.0.0.1', resolve));
const port = holder.address().port;
holder.close();
let stderr = '';
const launch = sandboxedRelayLaunch({ executable, env: workerEnvironment() });
const relay = new MediaRelay({
  port: () => port,
  launch: () => {
    const child = launch();
    child.stderr.on('data', (data) => (stderr += data));
    return child;
  },
});
await relay.start();
report('the sandboxed relay listens', relay.state === 'listening', relay.reason ?? '');
if (relay.state === 'listening') {
  const registration = {
    streamId: 'sandbox-check',
    ufrag: 'wKr1',
    pwd: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    clientUfrag: 'Cli3',
    clientPwd: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    workerPort: worker.address().port,
    clientHint: '127.0.0.1',
    expiresMs: 15000,
  };
  await relay.allow(registration);
  const client = dgram.createSocket('udp4');
  await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
  client.send(bindingRequest('wKr1:Cli3', registration.pwd), port, '127.0.0.1');
  const deadline = Date.now() + 5000;
  while (!received.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  report('the sandboxed relay forwards an authenticated check', received.length === 1);
  client.close();
}
if (stderr.trim()) console.log(`INFO: relay stderr: ${stderr.trim()}`);
await relay.stop();
worker.close();
console.log(failures ? 'FAIL: relay sandbox check' : 'PASS: relay sandbox check');
process.exitCode = failures ? 1 : 0;
