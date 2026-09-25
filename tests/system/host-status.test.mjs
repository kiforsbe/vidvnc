import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isolatedDataDirectory } from './isolated-data.mjs';

test('owned host pipe reports real sessions and disconnects them without stopping sharing', async (t) => {
  const localAppData = await isolatedDataDirectory(t);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../apps/server/src/main.mjs', import.meta.url)), '--desktop'],
    {
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        VIDVNC_PORT: '4392',
        VIDVNC_HOST: '127.0.0.1',
      },
      windowsHide: true,
    },
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end('{"type":"stop"}\n');
    const kill = setTimeout(() => child.kill(), 5000);
    await closed;
    clearTimeout(kill);
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on('line', (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {}
  });
  async function waitFor(predicate) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const match = messages.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Host protocol message did not arrive');
  }
  const ready = await waitFor((m) => m.type === 'ready');
  // The standing password is accepted from loopback through the metered key start.
  const response = await fetch('http://127.0.0.1:4392/api/key-start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: ready.password }),
  });
  assert.equal(response.status, 201);
  const { sessionId } = await response.json();
  const status = await waitFor(
    (m) => m.type === 'status' && m.sessions.some((s) => s.id === sessionId),
  );
  // The stream runtime reports a session that has not subscribed to anything yet this way.
  assert.equal(status.sessions[0].health, 'No active streams');
  assert.equal(status.streamCount, 0);
  assert.ok(!JSON.stringify(status).includes(ready.password));
  messages.length = 0;
  child.stdin.write(JSON.stringify({ type: 'disconnect', id: sessionId }) + '\n');
  await waitFor((m) => m.type === 'status' && m.sessions.length === 0);
  assert.equal((await fetch('http://127.0.0.1:4392/api/info')).status, 200);
});
