import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  dataDirectory,
  defaultGStreamerRoot,
  defaultWorker,
  runtimePaths,
} from '../runtime-paths.mjs';

const root = path.resolve('/repo');
const windows = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } };
const macos = { platform: 'darwin', env: {}, home: '/Users/u', exists: () => false };

test('settings and logs live in the per-user data directory of each platform', () => {
  assert.equal(
    dataDirectory({ ...windows, home: 'C:\\Users\\u' }),
    path.join('C:\\Users\\u\\AppData\\Local', 'VidVNC'),
  );
  assert.equal(dataDirectory(macos), path.join('/Users/u', 'Library/Application Support/VidVNC'));
  const paths = runtimePaths({ root, ...macos });
  assert.equal(paths.userData, path.resolve('/Users/u/Library/Application Support/VidVNC'));
  assert.equal(paths.logDirectory, path.resolve(paths.userData, 'logs'));
});

test('the development worker is the platform build under out/native', () => {
  assert.equal(
    defaultWorker(root, 'win32'),
    path.join(root, 'out/native/windows-x64/Release/media-worker.exe'),
  );
  assert.equal(
    defaultWorker(root, 'darwin'),
    path.join(root, 'out/native/macos-arm64/Release/media-worker'),
  );
  assert.equal(
    runtimePaths({ root, ...macos }).executable,
    path.resolve(root, 'out/native/macos-arm64/Release/media-worker'),
  );
  assert.equal(
    runtimePaths({ root, ...macos, env: { VIDVNC_MEDIA_WORKER: '/tmp/worker' } }).executable,
    path.resolve('/tmp/worker'),
  );
});

test('GStreamer defaults to the repository SDK on Windows and the framework on macOS', () => {
  assert.equal(defaultGStreamerRoot({ root, ...windows }), path.join(root, '.deps/gstreamer'));
  const system = '/Library/Frameworks/GStreamer.framework/Versions/1.0';
  const user = path.join('/Users/u', system);
  assert.equal(defaultGStreamerRoot({ root, ...macos }), system);
  assert.equal(defaultGStreamerRoot({ root, ...macos, exists: (p) => p === user }), user);
  for (const options of [windows, macos])
    assert.equal(
      defaultGStreamerRoot({ root, ...options, env: { ...options.env, GSTREAMER_ROOT: '/sdk' } }),
      '/sdk',
    );
  assert.equal(runtimePaths({ root, ...macos }).sdkRoot, path.resolve(system));
});

test('a packaged manifest decides the worker, SDK and log paths', () => {
  const manifest = {
    mode: 'packaged',
    worker: '/App/Contents/Helpers/media-worker',
    mediaBin: '/App/Contents/Frameworks/bin',
  };
  const paths = runtimePaths({
    root,
    manifest,
    ...macos,
    env: { VIDVNC_MEDIA_WORKER: '/foreign', VIDVNC_LOG_DIR: '/foreign-logs' },
  });
  assert.equal(paths.executable, path.resolve(manifest.worker));
  assert.equal(paths.sdkRoot, path.resolve('/App/Contents/Frameworks'));
  assert.equal(paths.logDirectory, path.resolve(paths.userData, 'logs'));
  const development = runtimePaths({
    root,
    manifest: { ...manifest, mode: 'development' },
    ...macos,
    env: { VIDVNC_LOG_DIR: '/dev-logs' },
  });
  assert.equal(development.logDirectory, path.resolve('/dev-logs'));
});
