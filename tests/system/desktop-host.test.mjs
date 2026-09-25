import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isolatedDataDirectory } from './isolated-data.mjs';

test('desktop owner receives onboarding data and can shut down its server', async (t) => {
  const localAppData = await isolatedDataDirectory(t);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../apps/server/src/main.mjs', import.meta.url)), '--desktop'],
    {
      cwd: new URL('.', import.meta.url),
      env: {
        ...process.env,
        LOCALAPPDATA: localAppData,
        VIDVNC_PORT: '4389',
        VIDVNC_HOST: '127.0.0.1',
      },
      windowsHide: true,
    },
  );
  const timer = setTimeout(() => child.kill(), 7000);
  const reader = createInterface({ input: child.stdout });
  let ready;
  child.stderr.resume();
  for await (const line of reader) {
    try {
      const value = JSON.parse(line);
      if (value.type === 'ready') {
        ready = value;
        break;
      }
    } catch {}
  }
  if (ready) child.stdin.end('{"type":"stop"}\n');
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  assert.ok(ready, 'Desktop host must receive a ready message');
  // Codes use connection-keys.mjs's letters-and-digits alphabet (no 0, 1, I, L or O).
  assert.match(ready.password, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(ready.urls.includes('http://127.0.0.1:4389'));
  assert.equal(code, 0);
});
