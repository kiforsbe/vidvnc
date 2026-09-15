import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeManifest, packagedWorkerEnvironment } from './runtime-manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const runtimeManifest = process.env.VIDVNC_RUNTIME_MANIFEST
  ? loadRuntimeManifest(process.env.VIDVNC_RUNTIME_MANIFEST)
  : undefined;
const userData = path.join(
  process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'),
  'VidVNC',
);
export const sdkRoot = path.resolve(
  runtimeManifest
    ? path.dirname(runtimeManifest.mediaBin)
    : process.env.GSTREAMER_ROOT || path.join(root, '.deps/gstreamer'),
);
export const executable = path.resolve(
  runtimeManifest?.worker ||
    process.env.VIDVNC_MEDIA_WORKER ||
    path.join(root, 'out/native/windows-x64/Release/media-worker.exe'),
);
export const logDirectory = path.resolve(
  (runtimeManifest?.mode !== 'packaged' && process.env.VIDVNC_LOG_DIR) ||
    path.join(userData, 'logs'),
);

export function workerEnvironment() {
  mkdirSync(logDirectory, { recursive: true });
  if (runtimeManifest?.mode === 'packaged') {
    mkdirSync(path.join(userData, 'cache'), { recursive: true });
    return packagedWorkerEnvironment(runtimeManifest, userData);
  }
  return {
    ...process.env,
    PATH: `${path.join(sdkRoot, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
    VIDVNC_NATIVE_LOG: path.join(logDirectory, 'native-worker.log'),
  };
}
