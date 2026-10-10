// Where the media runtime lives on each platform, as pure functions of the platform, the
// environment and the home folder, so both platforms can be tested anywhere. runtime.mjs
// applies them to the running process. The server's settings use the same data directory
// (apps/server/src/paths.mjs re-exports dataDirectory from here).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The pinned GStreamer macOS framework, per-user or system-wide (docs/ARCHITECTURE.md).
const GSTREAMER_FRAMEWORK = 'Library/Frameworks/GStreamer.framework/Versions/1.0';

// Per-user mutable settings and logs, shared by the CLI server and the hosts.
export function dataDirectory({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  return platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'VidVNC')
    : path.join(home, 'Library', 'Application Support', 'VidVNC');
}

// The development worker build, `out/native/<platform>-<arch>/Release/` (CMakePresets.json).
export function defaultWorker(root, platform = process.platform) {
  return platform === 'win32'
    ? path.join(root, 'out/native/windows-x64/Release/media-worker.exe')
    : path.join(root, 'out/native/macos-arm64/Release/media-worker');
}

// The GStreamer root for development runs: GSTREAMER_ROOT, else the repository's SDK on
// Windows, and on macOS the per-user framework when it is installed, else the system one.
export function defaultGStreamerRoot({
  root,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
} = {}) {
  if (env.GSTREAMER_ROOT) return env.GSTREAMER_ROOT;
  if (platform === 'win32') return path.join(root, '.deps/gstreamer');
  const user = path.join(home, GSTREAMER_FRAMEWORK);
  return exists(user) ? user : path.join('/', GSTREAMER_FRAMEWORK);
}

// Every runtime path, from a loaded runtime manifest when there is one.
export function runtimePaths({
  root,
  manifest,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
}) {
  const userData = dataDirectory({ env, platform, home });
  return {
    userData,
    sdkRoot: path.resolve(
      manifest
        ? path.dirname(manifest.mediaBin)
        : defaultGStreamerRoot({ root, env, platform, home, exists }),
    ),
    executable: path.resolve(
      manifest?.worker || env.VIDVNC_MEDIA_WORKER || defaultWorker(root, platform),
    ),
    logDirectory: path.resolve(
      (manifest?.mode !== 'packaged' && env.VIDVNC_LOG_DIR) || path.join(userData, 'logs'),
    ),
  };
}
