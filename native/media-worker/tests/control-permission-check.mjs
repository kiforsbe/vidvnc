// Explicit SDK-backed check; no offer, desktop capture, audio capture or input injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { executable, workerEnvironment } from '../runtime.mjs';

test(
  'native owner pipe acknowledges bounded grant and revoke before clean shutdown',
  { timeout: 10000 },
  async (t) => {
    const child = spawn(executable, ['--session'], {
      env: workerEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    for (const [requestId, allowed] of [
      [1, true],
      [2, false],
    ]) {
      const response = once(lines, 'line');
      child.stdin.write(
        JSON.stringify({ type: 'control-permission', requestId, allowed, leaseMs: 5000 }) + '\n',
      );
      assert.deepEqual(JSON.parse((await response)[0]), {
        type: 'control-result',
        requestId,
        allowed,
      });
    }
    child.stdin.write('{"type":"stop"}\n');
    assert.equal((await exited)[0], 0, stderr);
  },
);
