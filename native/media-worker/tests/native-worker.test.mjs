import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { executable, workerEnvironment } from '../runtime.mjs';
function run(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: workerEnvironment(),
      windowsHide: true,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', reject);
    if (args.includes('--session'))
      child.stdin.end(
        JSON.stringify({ type: 'start', video: false, audioFormat: 'mono-32k', hostControl: true }) +
          '\n' +
          JSON.stringify({ type: 'add-peer', peerId: 'invalid', sdp: 'invalid' }) +
          '\n',
      );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Native check timed out'));
    }, 20000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
test('native preflight reports real primary display and required hardware plugins', async () => {
  const result = await run('--probe');
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.ok(info.width > 0 && info.height > 0);
  assert.equal(info.encoder, 'nvd3d11h264enc');
  assert.equal(info.capture, 'dxgi');
});
test('mobile encoder emits Level 3.1 and responds to force-key-unit', async () => {
  const result = await run('--self-test-mobile');
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.frames, 60);
  assert.equal(value.spsProfile, 66);
  assert.equal(value.spsLevel, 31);
  assert.ok(value.forceEvents >= 1);
  assert.ok(value.keyframes >= 5, JSON.stringify(value));
});
test('native session fails a malformed peer without failing its source or starting capture', async () => {
  const result = await run('--session');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)),
    [{ type: 'ready' }, { type: 'peer-failed', peerId: 'invalid', reason: 'Invalid SDP' }],
  );
});
test('native self-test captures and hardware-encodes sixty desktop frames', async () => {
  const result = await run('--self-test');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).frames, 60);
  const metrics = JSON.parse(result.stdout).metrics;
  assert.equal(metrics.captureFrames, 60);
  assert.equal(metrics.encoderInputFrames, 60);
  assert.equal(metrics.encodedFrames, 60);
  assert.ok(metrics.encodedBytes > 0);
  assert.ok(metrics.maxFrameBytes > 0);
  assert.ok(metrics.elapsedMs > 0);
});
