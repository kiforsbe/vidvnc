import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRuntimeManifest, packagedWorkerEnvironment } from '../runtime-manifest.mjs';

function fixture(t) {
  // realpath: macOS tmpdir() is under /var, a symlink to /private/var, and the loader resolves links.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vidvnc runtime å ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'plugins'));
  for (const name of ['node.exe', 'server.mjs', 'worker.exe'])
    writeFileSync(path.join(root, 'bin', name), 'fixture');
  const value = {
    schemaVersion: 1,
    mode: 'packaged',
    configuration: 'Release',
    architecture: 'x64',
    node: 'bin/node.exe',
    server: 'bin/server.mjs',
    worker: 'bin/worker.exe',
    mediaBin: 'bin',
    plugins: 'plugins',
  };
  const filename = path.join(root, 'runtime.json');
  return {
    root,
    value,
    load() {
      writeFileSync(filename, JSON.stringify(value));
      return loadRuntimeManifest(filename);
    },
  };
}

test('packaged paths resolve independently of cwd, including spaces and Unicode', (t) => {
  const f = fixture(t);
  const result = f.load();
  assert.equal(result.worker, path.join(f.root, 'bin', 'worker.exe'));
  assert.equal(result.root, f.root);
  assert.equal(result.scanner, undefined);
});

test('packaged manifests may omit node when Node.js is a prerequisite', (t) => {
  const f = fixture(t);
  delete f.value.node;
  assert.equal(f.load().node, undefined);
});

for (const [field, value] of [
  ['schemaVersion', 2],
  ['mode', 'other'],
  ['architecture', 'arm64'],
  ['configuration', 'debug'],
  ['worker', '../outside.exe'],
  ['worker', 'C:\\outside.exe'],
  ['worker', '/outside.exe'],
  ['worker', 'bin/missing.exe'],
  ['worker', 'plugins'],
  ['plugins', 'bin/node.exe'],
  ['node', ''],
  ['scanner', 'bin/missing-scanner.exe'],
]) {
  test(`rejects invalid ${field}: ${value}`, (t) => {
    const f = fixture(t);
    f.value[field] = value;
    assert.throws(() => f.load(), new RegExp(field));
  });
}

test('development permits explicit absolute paths without Release fallback', (t) => {
  const f = fixture(t);
  f.value.mode = 'development';
  f.value.configuration = 'Debug';
  f.value.worker = path.join(f.root, 'bin', 'worker.exe');
  assert.equal(f.load().worker, f.value.worker);
  f.value.worker = path.join(f.root, 'Debug', 'worker.exe');
  assert.throws(() => f.load(), /worker/);
});

test('packaged directory junctions cannot escape the bundle', (t) => {
  const f = fixture(t);
  const outside = fixture(t);
  symlinkSync(
    path.join(outside.root, 'bin'),
    path.join(f.root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  f.value.worker = 'linked/worker.exe';
  assert.throws(() => f.load(), /worker.*escapes/);
});

test('packaged worker isolates SDK discovery and executable overrides', (t) => {
  const f = fixture(t);
  const runtime = f.load();
  const env = packagedWorkerEnvironment(
    runtime,
    'C:\\User data\\VidVNC',
    {
      Path: 'C:\\foreign-sdk\\bin',
      SystemRoot: 'C:\\Windows',
      GST_PLUGIN_PATH: 'foreign',
      GST_PLUGIN_PATH_1_0: 'foreign',
      GST_PLUGIN_SCANNER: 'foreign.exe',
      GST_REGISTRY: 'foreign.cache',
      NODE_OPTIONS: '--require foreign.js',
      NODE_PATH: 'foreign',
      GSTREAMER_ROOT: 'foreign',
      VIDVNC_MEDIA_WORKER: 'foreign.exe',
    },
    'win32',
  );
  assert.equal(env.GST_PLUGIN_PATH_1_0, runtime.plugins);
  assert.equal(env.GST_PLUGIN_SYSTEM_PATH_1_0, '');
  assert.equal(env.GST_PLUGIN_SCANNER, undefined);
  assert.equal(env.GST_REGISTRY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.VIDVNC_MEDIA_WORKER, undefined);
  assert.equal(env.GSTREAMER_ROOT, undefined);
  assert.equal(env.Path, undefined);
  assert.ok(!env.PATH.includes('foreign'));
  assert.ok(env.PATH.includes(runtime.mediaBin));
  assert.ok(env.PATH.includes('System32'));
  assert.ok(env.GST_REGISTRY_1_0.includes('VidVNC'));
});

test('a manifest names its system, and one without it is a Windows manifest', (t) => {
  const f = fixture(t);
  assert.equal(f.load().os, 'windows');
  assert.equal(f.load().architecture, 'x64');
  f.value.os = 'windows';
  assert.equal(f.load().os, 'windows');
  f.value.os = 'macos';
  f.value.architecture = 'arm64';
  assert.equal(f.load().os, 'macos');
  assert.equal(f.load().architecture, 'arm64');
});

for (const [os, architecture] of [
  ['macos', 'x64'],
  ['windows', 'arm64'],
  [undefined, 'arm64'],
  ['linux', 'x64'],
  ['Windows', 'x64'],
]) {
  test(`rejects os ${os} with architecture ${architecture}`, (t) => {
    const f = fixture(t);
    f.value.os = os;
    f.value.architecture = architecture;
    assert.throws(() => f.load(), /Invalid runtime manifest (os|architecture)/);
  });
}

test('a manifest for another system is rejected where it is loaded', (t) => {
  const f = fixture(t);
  const filename = path.join(f.root, 'runtime.json');
  f.load();
  assert.equal(loadRuntimeManifest(filename, { platform: 'win32' }).os, 'windows');
  assert.throws(
    () => loadRuntimeManifest(filename, { platform: 'darwin' }),
    /windows cannot run on darwin/,
  );
  f.value.os = 'macos';
  f.value.architecture = 'arm64';
  f.load();
  assert.equal(loadRuntimeManifest(filename, { platform: 'darwin' }).os, 'macos');
  assert.throws(
    () => loadRuntimeManifest(filename, { platform: 'win32' }),
    /macos cannot run on win32/,
  );
});

test('the packaged macOS worker gets the package libraries and the system paths only', (t) => {
  const f = fixture(t);
  f.value.os = 'macos';
  f.value.architecture = 'arm64';
  const runtime = f.load();
  const userData = '/Users/u/Library/Application Support/VidVNC';
  const env = packagedWorkerEnvironment(
    runtime,
    userData,
    { PATH: '/opt/homebrew/bin:/usr/bin', GST_PLUGIN_PATH: 'foreign', HOME: '/Users/u' },
    'darwin',
  );
  assert.equal(env.PATH, [runtime.mediaBin, '/usr/bin', '/bin'].join(path.delimiter));
  assert.equal(env.GST_PLUGIN_PATH, undefined);
  assert.equal(env.GST_PLUGIN_PATH_1_0, runtime.plugins);
  assert.equal(env.HOME, '/Users/u');
  assert.ok(env.GST_REGISTRY_1_0.startsWith(path.join(userData, 'cache')));
  assert.equal(env.VIDVNC_NATIVE_LOG, path.join(userData, 'logs', 'native-worker.log'));
  // Windows still needs SystemRoot and never falls back to a POSIX path.
  assert.throws(() => packagedWorkerEnvironment(runtime, userData, {}, 'win32'), /SystemRoot/);
});
