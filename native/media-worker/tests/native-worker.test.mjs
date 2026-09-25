import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable, runtimeManifest, workerEnvironment } from '../runtime.mjs';
import { workerIsStale, workerPath } from '../../../tools/debug/host-build.mjs';

// These tests run the built worker, and nothing here rebuilds it. A worker older than its
// sources would test yesterday's code and fail in confusing ways, so say so up front. Only
// the default development build is checked; an explicit VIDVNC_MEDIA_WORKER or runtime
// manifest is the caller's choice.
const root = fileURLToPath(new URL('../../../', import.meta.url));
before(() => {
  if (runtimeManifest || process.env.VIDVNC_MEDIA_WORKER) return;
  if (path.resolve(executable) !== path.resolve(workerPath(root, 'Release'))) return;
  assert.ok(
    !workerIsStale(root, 'Release'),
    'media-worker.exe is older than native/ sources. Run `npm run build:native` first.',
  );
});
function run(...args) {
  let options = {};
  if (args.length && typeof args[args.length - 1] === 'object') {
    options = args.pop();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...workerEnvironment(), ...options.env },
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
  assert.equal(info.capture, 'dxgi');
  assert.ok(Array.isArray(info.codecs));
  assert.equal(info.codecs[0], 'h264');
  // `encoder` is now whichever element selection would choose here, not a constant.
  assert.ok(info.encoder.length > 0);
});
// Membership, not an exact set: this must still pass on a machine with different hardware.
test('probe reports the encoder backends this machine can actually encode with', async () => {
  const info = JSON.parse((await run('--probe')).stdout);
  assert.ok(Array.isArray(info.backends) && info.backends.length > 0);
  const ids = info.backends.map((backend) => backend.id);
  for (const backend of info.backends) {
    assert.ok(backend.id && backend.label);
    assert.ok(Array.isArray(backend.codecs) && backend.codecs.length > 0);
    assert.equal(typeof backend.onCaptureAdapter, 'boolean');
    for (const codec of backend.codecs) {
      const minimum = backend.minimums[codec];
      assert.ok(minimum.width > 0 && minimum.height > 0, `${backend.id} ${codec}`);
    }
  }
  // `codecs` is the union of what the backends offer, so existing server code keeps working.
  assert.deepEqual(
    [...info.codecs].sort(),
    [...new Set(info.backends.flatMap((backend) => backend.codecs))].sort(),
  );
  // Media Foundation has no AV1 encoder at all.
  const mediaFoundation = info.backends.find((backend) => backend.id === 'mediafoundation');
  if (mediaFoundation) assert.ok(!mediaFoundation.codecs.includes('av1'));
  const nvenc = info.backends.find((backend) => backend.id === 'nvenc');
  if (nvenc) {
    if (nvenc.codecs.includes('av1'))
      assert.deepEqual(nvenc.minimums.av1, { width: 192, height: 128 });
    if (nvenc.codecs.includes('h265'))
      assert.deepEqual(nvenc.minimums.h265, { width: 144, height: 48 });
  }
  assert.ok(ids.length === new Set(ids).size, 'backends are reported once each');
});
test('adapter affinity resolves the capture adapter and picks an encoder on it', async () => {
  const info = JSON.parse((await run('--probe')).stdout);
  const onCapture = info.backends.filter((backend) => backend.onCaptureAdapter);
  if (onCapture.length === 0) {
    // Only reachable where no encoder sits on the capturing GPU; the fixed order then decides.
    assert.ok(info.encoder.length > 0);
    return;
  }
  // Element name prefixes per backend (encoder-backend.hpp): NVENC uses nvd3d11*, Media
  // Foundation mf*; Quick Sync and AMF elements start with their backend id.
  const prefix = { nvenc: 'nvd3d11', mediafoundation: 'mf' };
  const chosen = info.backends.find((backend) =>
    info.encoder.startsWith(prefix[backend.id] ?? backend.id),
  );
  assert.ok(chosen, `no backend matches the chosen element ${info.encoder}`);
  assert.ok(chosen.onCaptureAdapter, 'selection preferred an encoder off the capture adapter');
});
test('self-test requires both a backend and a codec', async () => {
  const missing = await run('--self-test-codec', 'h264');
  assert.notEqual(missing.code, 0, 'the one-argument form must be rejected');
  const unknown = await run('--self-test-codec', 'nvidia', 'h264');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /backend/i);
  // Quick Sync is not present on this machine, so it must fail cleanly rather than hang.
  const absent = await run('--self-test-codec', 'qsv', 'h264');
  assert.notEqual(absent.code, 0);
});
test('every advertised backend really encodes desktop frames', async () => {
  const info = JSON.parse((await run('--probe')).stdout);
  for (const backend of info.backends) {
    const result = await run('--self-test-codec', backend.id, 'h264');
    assert.equal(result.code, 0, `${backend.id}: ${result.stderr}`);
    const value = JSON.parse(result.stdout);
    assert.equal(value.frames, 60, backend.id);
    assert.equal(value.codec, 'h264');
  }
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
test('a media port range is accepted, and a malformed one stops the worker before it starts', async () => {
  const valid = await run('--session', { env: { VIDVNC_ICE_PORTS: '41000-41049' } });
  assert.equal(valid.code, 0, valid.stderr);
  assert.deepEqual(
    valid.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)),
    [{ type: 'ready' }, { type: 'peer-failed', peerId: 'invalid', reason: 'Invalid SDP' }],
  );
  for (const value of ['41049-41000', '41000-41003', '80-100', 'any']) {
    const invalid = await run('--session', { env: { VIDVNC_ICE_PORTS: value } });
    assert.equal(invalid.code, 2, value);
    assert.match(invalid.stderr, /Invalid VIDVNC_ICE_PORTS/);
    assert.equal(invalid.stdout.trim(), '', 'nothing starts on a malformed range');
  }
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
  const backend = probe.backends.find((entry) => entry.codecs.includes('h265')).id;
  const result = await run('--self-test-codec', backend, 'h265');
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
  const backend = probe.backends.find((entry) => entry.codecs.includes('av1')).id;
  const result = await run('--self-test-codec', backend, 'av1');
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.frames, 60);
  assert.equal(value.codec, 'av1');
  assert.ok(value.keyframes >= 2, JSON.stringify(value));
  assert.equal(value.metrics.encodedFrames, 60);
});
