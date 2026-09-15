// Explicit SDK-backed startup check. Isolated data/port; probes displays but never offers media.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
const directory = await mkdtemp(join(tmpdir(), 'vidvnc-runtime-start-'));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(process.execPath, ['apps/server/src/main.mjs', '--desktop'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    LOCALAPPDATA: directory,
    VIDVNC_LOG_DIR: join(directory, 'logs'),
    VIDVNC_MEDIA_WORKER: resolve('out/native/windows-x64/Debug/media-worker.exe'),
    VIDVNC_HOST: '127.0.0.1',
    VIDVNC_PORT: String(port),
  },
});
const messages = [];
let stderr = '';
child.stderr.on('data', (data) => {
  stderr += data;
});
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    messages.push(JSON.parse(line));
  } catch {}
});
const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = messages.find(predicate);
    if (result) return result;
    if (child.exitCode !== null) throw new Error(stderr || 'Server exited');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Server response timed out: ' + stderr);
}
try {
  const ready = await until((message) => message.type === 'ready');
  const instanceFile = join(directory, 'VidVNC', 'instances', `${child.pid}.json`);
  assert.equal(JSON.parse(await readFile(instanceFile, 'utf8')).mode, 'desktop');
  const post = (route, body, token) =>
    fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const first = await post('connect', { password: ready.password }).then((r) => r.json());
  assert.equal(first.mode, 'streams');
  assert.equal((await post('connect', { password: ready.password })).status, 201);
  const status = await until(
    (message) => message.type === 'status' && message.sessions.length === 2,
  );
  assert.equal(status.capabilities.hostControl, true);
  assert.equal(ready.access.defaultControl, 'approval');
  assert.equal(ready.access.connectionMode, 'session-key');
  child.stdin.write(
    JSON.stringify({
      type: 'access-set',
      requestId: 'access-check',
      revision: ready.access.revision,
      defaultControl: 'available',
    }) + '\n',
  );
  const savedAccess = await until(
    (message) => message.type === 'access-result' && message.requestId === 'access-check',
  );
  assert.equal(savedAccess.ok, true);
  assert.equal(savedAccess.access.defaultControl, 'available');
  child.stdin.write(
    JSON.stringify({
      type: 'access-set',
      requestId: 'connection-mode-check',
      revision: savedAccess.access.revision,
      defaultControl: savedAccess.access.defaultControl,
      connectionMode: 'one-time-keys',
    }) + '\n',
  );
  const savedMode = await until(
    (message) => message.type === 'access-result' && message.requestId === 'connection-mode-check',
  );
  assert.equal(savedMode.ok, true);
  assert.equal(savedMode.access.connectionMode, 'one-time-keys');
  assert.notEqual(savedMode.sessionKey, ready.password);
  assert.equal((await post('connect', { password: ready.password })).status, 401);
  child.stdin.write(
    JSON.stringify({ type: 'connection-once-create', requestId: 'once-check' }) + '\n',
  );
  const once = await until(
    (message) => message.type === 'connection-once-result' && message.requestId === 'once-check',
  );
  assert.equal(once.ok, true);
  assert.match(once.key, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal((await post('connection-key', { key: once.key })).status, 200);
  assert.equal(
    (await post('heartbeat', {}, first.sessionId)).status,
    200,
    'changing access defaults must not disconnect existing sessions',
  );
  assert.equal(
    (await post('access-set', { defaultControl: 'available' }, first.sessionId)).status,
    404,
    'access defaults are owner-pipe only',
  );
  child.stdin.write(
    JSON.stringify({
      type: 'session-command',
      requestId: 'check',
      action: 'grant',
      sessionId: first.sessionId,
    }) + '\n',
  );
  const reply = await until(
    (message) => message.type === 'session-result' && message.requestId === 'check',
  );
  assert.equal(reply.ok, false, 'a device without a video stream cannot acquire input');
  child.stdin.end('{"type":"stop"}\n');
  assert.equal(await exited, 0);
  await assert.rejects(readFile(instanceFile), { code: 'ENOENT' });
  assert.equal(stderr, '');
  console.log(
    'PASS: production startup admits two sessions, owns control commands and shuts down cleanly',
  );
} finally {
  if (child.exitCode === null) {
    child.stdin.end('{"type":"stop"}\n');
    const timer = setTimeout(() => child.kill(), 6000);
    await exited;
    clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}
