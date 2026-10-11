import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import {
  dataDirectory,
  defaultGStreamerRoot,
  defaultWorker,
  runtimePaths,
} from '../runtime-paths.mjs';

// Each platform's paths follow its own rules wherever the tests run.
const root = '/repo';
const windowsRoot = 'C:\\repo';
const windows = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } };
const macos = { platform: 'darwin', env: {}, home: '/Users/u', exists: () => false };

test('settings and logs live in the per-user data directory of each platform', () => {
  assert.equal(
    dataDirectory({ ...windows, home: 'C:\\Users\\u' }),
    win32.join('C:\\Users\\u\\AppData\\Local', 'VidVNC'),
  );
  assert.equal(dataDirectory(macos), posix.join('/Users/u', 'Library/Application Support/VidVNC'));
  const paths = runtimePaths({ root, ...macos });
  assert.equal(paths.userData, posix.resolve('/Users/u/Library/Application Support/VidVNC'));
  assert.equal(paths.logDirectory, posix.resolve(paths.userData, 'logs'));
});

test('the development worker is the platform build under out/native', () => {
  assert.equal(
    defaultWorker(windowsRoot, 'win32'),
    win32.join(windowsRoot, 'out/native/windows-x64/Release/media-worker.exe'),
  );
  assert.equal(
    defaultWorker(root, 'darwin'),
    posix.join(root, 'out/native/macos-arm64/Release/media-worker'),
  );
  assert.equal(
    runtimePaths({ root, ...macos }).executable,
    posix.resolve(root, 'out/native/macos-arm64/Release/media-worker'),
  );
  assert.equal(
    runtimePaths({ root, ...macos, env: { VIDVNC_MEDIA_WORKER: '/tmp/worker' } }).executable,
    posix.resolve('/tmp/worker'),
  );
});

test('GStreamer defaults to the repository SDK on Windows and the framework on macOS', () => {
  assert.equal(
    defaultGStreamerRoot({ root: windowsRoot, ...windows }),
    win32.join(windowsRoot, '.deps/gstreamer'),
  );
  const system = '/Library/Frameworks/GStreamer.framework/Versions/1.0';
  const user = posix.join('/Users/u', system);
  assert.equal(defaultGStreamerRoot({ root, ...macos }), system);
  assert.equal(defaultGStreamerRoot({ root, ...macos, exists: (p) => p === user }), user);
  for (const options of [windows, macos])
    assert.equal(
      defaultGStreamerRoot({ root, ...options, env: { ...options.env, GSTREAMER_ROOT: '/sdk' } }),
      '/sdk',
    );
  assert.equal(runtimePaths({ root, ...macos }).sdkRoot, posix.resolve(system));
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
  assert.equal(paths.executable, posix.resolve(manifest.worker));
  assert.equal(paths.sdkRoot, posix.resolve('/App/Contents/Frameworks'));
  assert.equal(paths.logDirectory, posix.resolve(paths.userData, 'logs'));
  const development = runtimePaths({
    root,
    manifest: { ...manifest, mode: 'development' },
    ...macos,
    env: { VIDVNC_LOG_DIR: '/dev-logs' },
  });
  assert.equal(development.logDirectory, posix.resolve('/dev-logs'));
});
