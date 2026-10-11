import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRuntimeManifest } from '../../native/media-worker/runtime-manifest.mjs';
import { workerPath } from './host-build.mjs';

// `platform` picks the manifest's system: the Windows manifest has no `os` field, as before
// macOS support; the macOS one says `os: macos` and runs only there.
export function writeDevelopmentManifest({
  root,
  configuration,
  filename,
  node = process.execPath,
  sdk = path.join(root, '.deps/gstreamer'),
  platform = process.platform,
}) {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Invalid configuration');
  const manifest = {
    schemaVersion: 1,
    mode: 'development',
    configuration,
    ...(platform === 'darwin' ? { os: 'macos', architecture: 'arm64' } : { architecture: 'x64' }),
    node: path.resolve(node),
    server: path.resolve(root, 'apps/server/src/main.mjs'),
    worker: path.resolve(workerPath(root, configuration, platform)),
    mediaBin: path.resolve(sdk, 'bin'),
    plugins: path.resolve(sdk, 'lib/gstreamer-1.0'),
  };
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    loadRuntimeManifest(temporary);
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
  return manifest;
}
