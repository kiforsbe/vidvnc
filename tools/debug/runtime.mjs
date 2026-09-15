import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRuntimeManifest } from '../../native/media-worker/runtime-manifest.mjs';

export function writeDevelopmentManifest({
  root,
  configuration,
  filename,
  node = process.execPath,
  sdk = path.join(root, '.deps/gstreamer'),
}) {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Invalid configuration');
  const manifest = {
    schemaVersion: 1,
    mode: 'development',
    configuration,
    architecture: 'x64',
    node: path.resolve(node),
    server: path.resolve(root, 'apps/server/src/main.mjs'),
    worker: path.resolve(root, 'out/native/windows-x64', configuration, 'media-worker.exe'),
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
