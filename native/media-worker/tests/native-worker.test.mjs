import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { executable, workerEnvironment } from '../runtime.mjs';
function run(...args) {
  let options = {};
  if (args.length && typeof args[args.length - 1] === 'object') {
    options = args.pop();
  }
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
    if (args.includes('--session')) {
      const stdin =
        options.stdin ??
        JSON.stringify({
          type: 'start',
          video: false,
          audioFormat: 'mono-32k',
          hostControl: true,
          codec: 'bogus',
        }) +
          '\n' +
          JSON.stringify({ type: 'add-peer', peerId: 'invalid', sdp: 'invalid' }) +
          '\n';
      child.stdin.end(stdin);
    }
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
  assert.ok(Array.isArray(info.codecs));
  assert.equal(info.codecs[0], 'h264');
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
test('video codec is validated against the codec table', async () => {
  const result = await run('--session', {
    stdin: JSON.stringify({ type: 'start', video: true, codec: 'bogus', hostControl: true }) + '\n',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid video codec/);
});
test('native self-test captures and hardware-encodes sixty desktop frames', async () => {
  const result = await run('--self-test');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).frames, 60);
  assert.equal(JSON.parse(result.stdout).bitrateMode, 'cbr');
  const metrics = JSON.parse(result.stdout).metrics;
  assert.equal(metrics.captureFrames, 60);
  assert.equal(metrics.encoderInputFrames, 60);
  assert.equal(metrics.encodedFrames, 60);
  assert.ok(metrics.encodedBytes > 0);
  assert.ok(metrics.maxFrameBytes > 0);
  assert.ok(metrics.elapsedMs > 0);
});
test('vbr self-test hardware-encodes desktop frames with the vbr encoder settings', async () => {
  const result = await run('--self-test-vbr', 'h264');
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.bitrateMode, 'vbr');
  assert.equal(value.quality, 'balanced');
  assert.ok(value.metrics.encodedFrames > 0, JSON.stringify(value));
});
test('h265 self-test hardware-encodes sixty desktop frames', async (t) => {
  const probe = JSON.parse((await run('--probe')).stdout);
  if (!probe.codecs.includes('h265')) {
    t.skip('GPU has no h265 encoder');
    return;
  }
  const result = await run('--self-test-codec', 'h265');
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.frames, 60);
  assert.equal(value.codec, 'h265');
  assert.ok(value.keyframes >= 2, JSON.stringify(value));
  assert.equal(value.metrics.encodedFrames, 60);
});
test('av1 self-test hardware-encodes sixty desktop frames', async (t) => {
  const probe = JSON.parse((await run('--probe')).stdout);
  if (!probe.codecs.includes('av1')) {
    t.skip('GPU has no av1 encoder');
    return;
  }
  const result = await run('--self-test-codec', 'av1');
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.frames, 60);
  assert.equal(value.codec, 'av1');
  assert.ok(value.keyframes >= 2, JSON.stringify(value));
  assert.equal(value.metrics.encodedFrames, 60);
});
